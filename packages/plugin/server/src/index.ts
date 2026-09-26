#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import {
  ActionHub,
  ActionHubError,
  CatalogCache,
  bootstrapCatalog,
  discoverSkillsFromDirectory,
} from "@action-hub/core";
import { defaultConfigPath, loadConfig } from "./config.js";
import { createSdkClientFactory } from "./sdk-client.js";
import { warn, writeSnapshot, SnapshotDebouncer } from "./snapshot.js";
import {
  LOAD_DESCRIPTION_MAX_BYTES,
  LOAD_SCHEMA_MAX_BYTES,
  SEARCH_SUMMARY_MAX_BYTES,
  SKILL_INSTRUCTIONS_MAX_BYTES,
  hardenSchema,
  hardenText,
} from "./output-hardening.js";

/** One hardened formatter for every bundle-load response path. */
function hardenedBundlePayload(loaded: {
  id: string;
  displayName: string;
  description?: string;
  actions: Array<{ id: string; name: string; serverId: string; trust: string; summary: string; inputSchema?: unknown }>;
  tokensSaved: number;
}) {
  return {
    ok: true,
    bundle_id: loaded.id,
    display_name: hardenText(loaded.displayName, SEARCH_SUMMARY_MAX_BYTES),
    description: hardenText(loaded.description ?? "", LOAD_DESCRIPTION_MAX_BYTES),
    actions_count: loaded.actions.length,
    actions: loaded.actions.map((act) => ({
      action_id: act.id,
      name: hardenText(act.name, SEARCH_SUMMARY_MAX_BYTES),
      server: act.serverId,
      trust: act.trust,
      summary: hardenText(act.summary, SEARCH_SUMMARY_MAX_BYTES),
      input_schema: hardenSchema(act.inputSchema, LOAD_SCHEMA_MAX_BYTES),
    })),
    tokens_saved: loaded.tokensSaved,
    next: "All actions in this bundle are loaded. Call execute with any action_id and matching arguments.",
  };
}

const TOOL_DESCRIPTION = `Search, load, and run capabilities from every connected MCP server and installed skill.

Use this whenever a task needs an integration that is not already among your visible tools, or when you are unsure whether a capability exists.

Always follow three steps in order:
1. search — describe the task in natural language. Returns ranked candidates without schemas.
2. load — pass an action_id from search. Returns the full JSON Schema for its arguments.
3. execute — pass the same action_id plus arguments matching the loaded schema.

Never execute an action you have not loaded in this conversation; argument names cannot be reliably guessed from an action name.

Some actions are gated. If execute returns status "approval_required", it did NOT run. Show the user the server, action, and arguments, ask them to confirm, and only if they agree repeat the identical execute call with approval_token set to the returned token. The token is single-use, expires quickly, and is only valid for those exact arguments. Never approve on the user's behalf.`;

const inputShape = {
  operation: z
    .enum(["search", "load", "execute", "load_bundle", "search_bundles"])
    .describe("search finds candidates, load returns one action's schema, execute runs it, load_bundle loads a compound bundle of actions"),
  query: z
    .string()
    .optional()
    .describe("Natural-language description of the task. Required for search; ignored otherwise."),
  action_id: z
    .string()
    .optional()
    .describe("Identifier returned by search. Required for load and execute."),
  bundle_id: z
    .string()
    .optional()
    .describe("Identifier of a bundle to load. Required for load_bundle, or load when loading a bundle."),
  arguments: z
    .record(z.unknown())
    .optional()
    .describe("Arguments for execute, matching the schema returned by load."),
  server_id: z.string().optional().describe("Restrict a search to one server."),
  limit: z.number().int().min(1).max(50).optional().describe("Max search results. Default 10."),
  include_schema: z
    .boolean()
    .optional()
    .describe("When true, returns the inputSchema for matched actions directly in search results, saving a load round-trip."),
  approval_token: z
    .string()
    .optional()
    .describe(
      "Token from a prior approval_required response. Pass it on an identical execute call, only after the user has explicitly confirmed. Single-use, short-lived, and bound to these exact arguments.",
    ),
} as const;

export interface HubRuntime {
  hub: ActionHub;
  cache: CatalogCache;
  configHash: string;
  configPath: string;
  /**
   * Resolves when the authoritative re-index has completed and been written
   * back. With the deferred startup refresh this stays pending until
   * `startRefresh()` is called; `close()` awaits it only once started.
   */
  refreshed: Promise<unknown>;
  /**
   * Starts the deferred re-index exactly once (subsequent calls return the
   * same promise). Hosts call this after the MCP transport is connected so
   * the re-index cannot steal the event loop before the server answers its
   * first request (stress finding F23).
   */
  startRefresh(): Promise<unknown>;
  /**
   * Coalesces the post-execute snapshot writes (F18 part 2). Optional so
   * lightweight test runtimes can omit it; dispatch falls back to the
   * per-execute write when absent.
   */
  snapshotDebouncer?: Pick<SnapshotDebouncer, "markDirty" | "flush">;
  close(): Promise<void>;
}

export async function createHubRuntime(): Promise<HubRuntime> {
  const configPath = defaultConfigPath();
  const config = await loadConfig(configPath);

  const hub = new ActionHub({
    servers: config.servers,
    bundles: config.bundles,
    clientFactory: createSdkClientFactory({ onWarning: warn }),
    policy: { autoApproveAtOrAbove: config.autoApproveAtOrAbove },
    approvals: { ttlMs: config.approvalTtlMs },
  });

  // Skills are local and cheap, so they are treated as always-live: after the
  // catalog is restored from the warm cache (which may contain stale skill
  // records), the entire skill set is replaced with the current config +
  // skills-directory set — including removals.
  const skillsDir = process.env["ACTION_HUB_SKILLS_DIR"] ?? resolve(homedir(), ".action-hub", "skills");
  const dirSkills = await discoverSkillsFromDirectory(skillsDir);
  const configSkillIds = new Set((config.skills ?? []).map((s) => s.id));
  const skillRecords = [
    ...(config.skills ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      serverId: s.sourceClient ?? "skills",
      summary: s.summary,
      description: s.description,
      tags: s.tags,
      trust: s.trust ?? "trusted",
    })),
    ...dirSkills
      .filter((s) => {
        if (configSkillIds.has(s.id)) {
          warn(
            `skill "${s.id}" is defined in both ${configPath} and ${skillsDir}; the config entry wins`,
          );
          return false;
        }
        return true;
      })
      .map((s) => ({
        id: s.id,
        name: s.name,
        serverId: s.sourceClient ?? "skills",
        summary: s.summary,
        description: s.description,
        tags: s.tags,
        trust: s.trust ?? "trusted",
      })),
  ];

  const cache = new CatalogCache({ onWarning: warn });

  // A warm cache makes the hub answerable immediately. The authoritative
  // re-index is DEFERRED (F23): starting it here monopolises the event loop
  // before the MCP server answers initialize, which measured ~2 s of added
  // first-response latency at 15K actions and erased the warm-start win.
  // connectMcpClient starts it once the transport is connected.
  const bootstrap = await bootstrapCatalog(hub, {
    servers: config.servers,
    cache,
    onWarning: warn,
    deferRefresh: true,
  });

  hub.replaceSkills(skillRecords);

  // F18 part 2: coalesce the post-execute snapshot writes into at most one
  // per interval instead of rewriting the whole catalog after every execute.
  const snapshotDebouncer = new SnapshotDebouncer(() => writeSnapshot(hub, bootstrap.configHash, cache));

  let startedRefresh: Promise<unknown> | undefined;
  const startRefresh = (): Promise<unknown> => {
    startedRefresh ??= bootstrap.startRefresh().then(
      (results) => {
        for (const result of results) {
          if (result.error) warn(`failed to index "${result.serverId}": ${result.error}`);
        }
        return results;
      },
      (cause: unknown) => {
        warn(`re-index failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        return [];
      },
    );
    return startedRefresh;
  };

  return {
    hub,
    cache,
    configHash: bootstrap.configHash,
    configPath,
    refreshed: bootstrap.refreshed,
    startRefresh,
    snapshotDebouncer,
    close: async () => {
      // Await only a refresh that was actually started; a runtime that never
      // connected must not force a full re-index at shutdown.
      if (startedRefresh) await startedRefresh.catch(() => undefined);
      await snapshotDebouncer.dispose();
      await hub.close();
    },
  };
}

export { startHttpServer, HUB_HTTP_TOKEN_ENV_VAR, type HttpServerOptions, type HttpServerHandle } from "./http-server.js";

export function createMcpServer(runtime: HubRuntime): McpServer {
  const server = new McpServer({ name: "action-hub", version: "0.1.0" });

  server.registerTool(
    "action_hub",
    {
      title: "Action Hub",
      description: TOOL_DESCRIPTION,
      inputSchema: inputShape,
    },
    async (input) => {
      try {
        return text(await dispatch(runtime.hub, input, runtime.configHash, runtime.cache, runtime.snapshotDebouncer));
      } catch (cause) {
        const message =
          cause instanceof ActionHubError || cause instanceof Error
            ? cause.message
            : String(cause);
        return { ...text({ ok: false, error: message }), isError: true };
      }
    },
  );

  return server;
}

export async function connectMcpClient(runtime: HubRuntime, transport: Transport): Promise<McpServer> {
  const server = createMcpServer(runtime);
  await server.connect(transport);
  // The server can answer now; the authoritative re-index may contend for the
  // event loop behind it. Memoised in the runtime, so repeated connects (HTTP,
  // daemon) start it at most once.
  runtime.startRefresh();
  return server;
}

export async function runDaemonServer(): Promise<void> {
  const { runDaemon } = await import("./daemon.js");
  await runDaemon();
}

/**
 * Boots the Action Hub meta-MCP server on stdio and resolves on transport
 * close or a termination signal.
 */
export async function runServer(): Promise<void> {
  const runtime = await createHubRuntime();
  const transport = new StdioServerTransport();
  await connectMcpClient(runtime, transport);

  await new Promise<void>((resolveShutdown) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void runtime.close()
        .catch(() => undefined)
        .finally(() => resolveShutdown());
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    transport.onclose = shutdown;
  });
}

type ToolInput = {
  operation: "search" | "load" | "execute" | "load_bundle" | "search_bundles";
  query?: string;
  action_id?: string;
  bundle_id?: string;
  arguments?: Record<string, unknown>;
  server_id?: string;
  limit?: number;
  include_schema?: boolean;
  approval_token?: string;
};

async function dispatch(
  hub: ActionHub,
  input: ToolInput,
  configHash: string,
  cache: CatalogCache,
  snapshots?: Pick<SnapshotDebouncer, "markDirty" | "flush">,
): Promise<unknown> {
  switch (input.operation) {
    case "search": {
      const includeSchema = input.include_schema === true;
      const hits = await hub.search(input.query ?? "", {
        limit: input.limit ?? 10,
        serverIds: input.server_id ? [input.server_id] : undefined,
        includeSchema,
      });
      const matchingBundles = hub.searchBundles(input.query ?? "");
      return {
        ok: true,
        count: hits.length,
        results: hits.map((hit) => ({
          action_id: hit.id,
          name: hardenText(hit.name, SEARCH_SUMMARY_MAX_BYTES),
          server: hit.serverId,
          kind: hit.kind,
          summary: hardenText(hit.summary, SEARCH_SUMMARY_MAX_BYTES),
          ...(hit.inputSchema ? { input_schema: hardenSchema(hit.inputSchema, LOAD_SCHEMA_MAX_BYTES) } : {}),
        })),
        ...(matchingBundles.length > 0
          ? {
              bundles: matchingBundles.map((b) => ({
                bundle_id: b.id,
                display_name: hardenText(b.displayName, SEARCH_SUMMARY_MAX_BYTES),
                description: hardenText(b.description ?? "", SEARCH_SUMMARY_MAX_BYTES),
              })),
            }
          : {}),
        next: hits.length > 0
          ? includeSchema
            ? "You can directly call execute with the action_id and arguments."
            : "Call load with an action_id to get its argument schema, or execute directly if you already have the schema."
          : undefined,
      };
    }

    case "search_bundles": {
      const bundles = hub.searchBundles(input.query ?? "");
      return {
        ok: true,
        count: bundles.length,
        bundles: bundles.map((b) => ({
          bundle_id: b.id,
          display_name: hardenText(b.displayName, SEARCH_SUMMARY_MAX_BYTES),
          description: hardenText(b.description ?? "", SEARCH_SUMMARY_MAX_BYTES),
          server_ids: b.serverIds,
          action_ids: b.actionIds,
        })),
        next: "Call load_bundle with bundle_id to load all tools in a bundle.",
      };
    }

    case "load_bundle": {
      const bundleId = input.bundle_id ?? input.action_id;
      if (!bundleId) throw new Error(`"bundle_id" is required for operation "load_bundle".`);
      return hardenedBundlePayload(hub.loadBundle(bundleId));
    }

    case "load": {
      if (input.bundle_id) {
        return hardenedBundlePayload(hub.loadBundle(input.bundle_id));
      }
      const actionId = requireActionId(input, "load");
      const action = hub.load(actionId);
      const descriptionLimit =
        action.kind === "skill" ? SKILL_INSTRUCTIONS_MAX_BYTES : LOAD_DESCRIPTION_MAX_BYTES;
      return {
        ok: true,
        action_id: action.id,
        name: hardenText(action.name, SEARCH_SUMMARY_MAX_BYTES),
        server: action.serverId,
        kind: action.kind,
        trust: action.trust,
        description: hardenText(action.description ?? action.summary, descriptionLimit),
        input_schema: hardenSchema(action.inputSchema, LOAD_SCHEMA_MAX_BYTES),
        next:
          action.kind === "skill"
            ? "This is a skill. Follow its instructions; do not execute it."
            : "Call execute with this action_id and arguments matching input_schema.",
      };
    }

    case "execute": {
      const actionId = requireActionId(input, "execute");
      const result = await hub.execute(
        actionId,
        input.arguments ?? {},
        input.approval_token ? { approvalToken: input.approval_token } : {},
      );
      // Marks the on-disk snapshot stale instead of rewriting the whole
      // persisted catalog after every execute (F18 part 2); the debouncer
      // coalesces bursts and flushes on close. Falls back to the per-execute
      // write when the runtime provides no debouncer (lightweight tests).
      if (snapshots) snapshots.markDirty();
      else void writeSnapshot(hub, configHash, cache);

      if (result.approval) {
        const approval = result.approval;
        return {
          ok: false,
          status: "approval_required",
          action_id: approval.actionId,
          server: approval.serverId,
          name: hardenText(approval.name, SEARCH_SUMMARY_MAX_BYTES),
          trust: approval.trust,
          reason: approval.reason,
          arguments_summary: approval.argumentsSummary,
          argument_keys: approval.argumentKeys,
          approval_token: approval.approvalToken,
          expires_at: approval.expiresAt,
          expires_in_seconds: Math.round(approval.ttlMs / 1000),
          executed: false,
          next: approval.instructions,
          duration_ms: result.durationMs,
        };
      }

      return {
        ok: result.ok,
        action_id: result.actionId,
        content: result.content,
        error: result.error,
        duration_ms: result.durationMs,
        cached: result.cached === true,
      };
    }
  }
}

function requireActionId(input: ToolInput, operation: string): string {
  if (!input.action_id) {
    throw new Error(`"action_id" is required for operation "${operation}". Run a search first.`);
  }
  return input.action_id;
}

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function isRunAsEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isRunAsEntryPoint()) {
  const launch = process.argv.includes("--daemon")
    ? runDaemonServer()
    : runServer();

  launch.then(
    () => process.exit(0),
    (cause: unknown) => {
      process.stderr.write(
        `action-hub: fatal: ${cause instanceof Error ? cause.stack : String(cause)}\n`,
      );
      process.exit(1);
    },
  );
}
