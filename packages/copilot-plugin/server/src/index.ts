#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ActionHub, ActionHubError } from "@action-hub/core";
import { defaultConfigPath, loadConfig } from "./config.js";
import { createSdkClientFactory } from "./sdk-client.js";
import { writeSnapshot } from "./snapshot.js";

const TOOL_DESCRIPTION = `Search, load, and run capabilities from every connected MCP server and installed skill.

Use this whenever a task needs an integration that is not already among your visible tools, or when you are unsure whether a capability exists.

Always follow three steps in order:
1. search — describe the task in natural language. Returns ranked candidates without schemas.
2. load — pass an action_id from search. Returns the full JSON Schema for its arguments.
3. execute — pass the same action_id plus arguments matching the loaded schema.

Never execute an action you have not loaded in this conversation; argument names cannot be reliably guessed from an action name.`;

const inputShape = {
  operation: z
    .enum(["search", "load", "execute"])
    .describe("search finds candidates, load returns one action's schema, execute runs it"),
  query: z
    .string()
    .optional()
    .describe("Natural-language description of the task. Required for search; ignored otherwise."),
  action_id: z
    .string()
    .optional()
    .describe("Identifier returned by search. Required for load and execute."),
  arguments: z
    .record(z.unknown())
    .optional()
    .describe("Arguments for execute, matching the schema returned by load."),
  server_id: z.string().optional().describe("Restrict a search to one server."),
  limit: z.number().int().min(1).max(50).optional().describe("Max search results. Default 10."),
} as const;

async function main(): Promise<void> {
  const configPath = defaultConfigPath();
  const config = await loadConfig(configPath);

  const hub = new ActionHub({
    servers: config.servers,
    clientFactory: createSdkClientFactory(),
    policy: { autoApproveAtOrAbove: config.autoApproveAtOrAbove },
  });

  const indexed = await hub.indexAll();
  for (const result of indexed) {
    if (result.error) {
      // stdout is the MCP channel; diagnostics must go to stderr.
      process.stderr.write(`action-hub: failed to index "${result.serverId}": ${result.error}\n`);
    }
  }

  await writeSnapshot(hub);

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
        return text(await dispatch(hub, input));
      } catch (cause) {
        const message =
          cause instanceof ActionHubError || cause instanceof Error
            ? cause.message
            : String(cause);
        return { ...text({ ok: false, error: message }), isError: true };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    void hub.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

type ToolInput = {
  operation: "search" | "load" | "execute";
  query?: string;
  action_id?: string;
  arguments?: Record<string, unknown>;
  server_id?: string;
  limit?: number;
};

async function dispatch(hub: ActionHub, input: ToolInput): Promise<unknown> {
  switch (input.operation) {
    case "search": {
      const hits = await hub.search(input.query ?? "", {
        limit: input.limit ?? 10,
        serverIds: input.server_id ? [input.server_id] : undefined,
      });
      return {
        ok: true,
        count: hits.length,
        results: hits.map((hit) => ({
          action_id: hit.id,
          name: hit.name,
          server: hit.serverId,
          kind: hit.kind,
          summary: hit.summary,
        })),
        next: hits.length > 0 ? "Call load with an action_id to get its argument schema." : undefined,
      };
    }

    case "load": {
      const actionId = requireActionId(input, "load");
      const action = hub.load(actionId);
      return {
        ok: true,
        action_id: action.id,
        name: action.name,
        server: action.serverId,
        kind: action.kind,
        trust: action.trust,
        description: action.description ?? action.summary,
        input_schema: action.inputSchema,
        next:
          action.kind === "skill"
            ? "This is a skill. Follow its instructions; do not execute it."
            : "Call execute with this action_id and arguments matching input_schema.",
      };
    }

    case "execute": {
      const actionId = requireActionId(input, "execute");
      const result = await hub.execute(actionId, input.arguments ?? {});
      // Refreshes server activation state and invocation history for the canvas.
      void writeSnapshot(hub);
      return {
        ok: result.ok,
        action_id: result.actionId,
        content: result.content,
        error: result.error,
        duration_ms: result.durationMs,
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

main().catch((cause: unknown) => {
  process.stderr.write(`action-hub: fatal: ${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exit(1);
});
