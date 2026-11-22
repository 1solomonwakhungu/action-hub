import { homedir } from "node:os";
import {
  discoverAll,
  executeMigration,
  type DiscoveredPlugin,
  type DiscoveredServer,
  type DiscoveredSkill,
  type MigrationPlan,
  type ServerConfig,
} from "@action-hub/core";
import { loadCliConfig } from "../config-loader.js";
import {
  rawConfigDocument,
  validateRawCapabilityArrays,
  writeConfigAtomic,
} from "../config-writer.js";
import { doctorCommand } from "./doctor.js";
import {
  HARNESS_DEFS,
  SUPPORTED_HARNESSES,
  harnessCommand,
  type HarnessName,
} from "./harness.js";
import {
  MIGRATE_SOURCE_FILTERS,
  type MigrateSourceFilter,
} from "./migrate.js";

/**
 * `action-hub init` — single-command onboarding wizard.
 *
 * Chains the existing onboarding steps cleanly without duplicating discovery,
 * harness writing, or doctor probing logic:
 *   1. Capability migration (`discoverAll` + `executeMigration`, writing unless `--dry-run`)
 *   2. Harness installation (`harness <target> install --write`, or preview on `--dry-run`)
 *   3. Diagnostics & context savings summary (`doctor`)
 */

export interface InitOptions {
  harness?: string;
  daemon?: boolean;
  source?: MigrateSourceFilter | "all";
  configPath?: string;
  node?: string;
  dryRun?: boolean;
  skipMigrate?: boolean;
  skipDoctor?: boolean;
  json?: boolean;
}

interface DoctorMetrics {
  toolsIndexed?: number;
  eagerTokensEstimate?: number;
  hubTokensEstimate?: number;
  estimatedSavingsPercent?: number;
  healthyServers: number;
  unhealthyServers: number;
}

export interface InitSummary {
  dryRun: boolean;
  configPath: string;
  migrate: {
    skipped: boolean;
    written: boolean;
    discovered: {
      servers: number;
      skills: number;
      plugins: number;
    };
    added: {
      servers: number;
      skills: number;
      bundles: number;
    };
    updated: {
      servers: number;
      skills: number;
    };
    conflicts: number;
  };
  harness: {
    configured: boolean;
    target?: HarnessName;
    label?: string;
    mode?: "daemon" | "stdio";
    configPath?: string;
    written: boolean;
  };
  doctor: {
    skipped: boolean;
    exitCode?: number;
    healthy?: boolean;
    healthyServers?: number;
    unhealthyServers?: number;
    toolsIndexed?: number;
    contextSavings?: {
      eagerTokensEstimate: number;
      hubTokensEstimate: number;
      estimatedSavingsPercent: number;
    };
  };
  totals: {
    servers: number;
    skills: number;
    bundles: number;
    toolsIndexed?: number;
  };
  nextSteps: string[];
}

async function captureConsoleLog<T>(
  fn: () => Promise<T>,
  forwardToStdout: boolean,
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    lines.push(line);
    if (forwardToStdout) {
      origLog(...args);
    }
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = origLog;
  }
}

function parseDoctorOutput(lines: string[]): DoctorMetrics {
  let toolsIndexed: number | undefined;
  let eagerTokensEstimate: number | undefined;
  let hubTokensEstimate: number | undefined;
  let estimatedSavingsPercent: number | undefined;
  let healthyServers = 0;
  let unhealthyServers = 0;

  for (const line of lines) {
    const toolsMatch = line.match(/Total tools indexed:\s+(\d+)/);
    if (toolsMatch) toolsIndexed = Number.parseInt(toolsMatch[1]!, 10);

    const eagerMatch = line.match(/Eager tokens estimate:\s+(\d+)/);
    if (eagerMatch) eagerTokensEstimate = Number.parseInt(eagerMatch[1]!, 10);

    const hubMatch = line.match(/Hub tokens estimate:\s+(\d+)/);
    if (hubMatch) hubTokensEstimate = Number.parseInt(hubMatch[1]!, 10);

    const savingsMatch = line.match(/Estimated token savings per turn:\s+~?(-?\d+)%/);
    if (savingsMatch) estimatedSavingsPercent = Number.parseInt(savingsMatch[1]!, 10);

    if (/^\s+✔ \[.+\] \(.+\) \d+ tools indexed/.test(line)) {
      healthyServers++;
    } else if (/^\s+✖ \[.+\] \(.+\)/.test(line)) {
      unhealthyServers++;
    }
  }

  return {
    toolsIndexed,
    eagerTokensEstimate,
    hubTokensEstimate,
    estimatedSavingsPercent,
    healthyServers,
    unhealthyServers,
  };
}

function buildNextSteps(params: {
  dryRun: boolean;
  harnessTarget?: HarnessName;
  daemon: boolean;
  source?: MigrateSourceFilter | "all";
  configPath?: string;
  skipDoctor: boolean;
  doctorExitCode?: number;
}): string[] {
  const steps: string[] = [];

  if (params.dryRun) {
    const parts = ["action-hub", "init"];
    if (params.harnessTarget) parts.push("--harness", params.harnessTarget);
    if (params.daemon) parts.push("--daemon");
    if (params.source) parts.push("--source", params.source);
    if (params.configPath) parts.push("--config", params.configPath);
    steps.push(
      `Re-run without --dry-run to apply changes: ${parts.join(" ")}`,
    );
  }

  if (params.daemon) {
    steps.push(
      "Start the shared background daemon before launching your harness: action-hub daemon start",
    );
  }

  if (!params.harnessTarget) {
    const daemonSuffix = params.daemon ? " --daemon" : "";
    steps.push(
      `Connect an AI harness: action-hub harness <target> install --write${daemonSuffix} (supported: ${SUPPORTED_HARNESSES.join(", ")})`,
    );
  } else if (!params.dryRun) {
    const label = HARNESS_DEFS[params.harnessTarget].label;
    steps.push(
      params.daemon
        ? `Restart ${label} after starting the daemon to connect to Action Hub.`
        : `Restart ${label} to load Action Hub.`,
    );
  }

  if (params.skipDoctor) {
    steps.push("Verify server connectivity and context savings: action-hub doctor");
  } else if (params.doctorExitCode !== undefined && params.doctorExitCode !== 0) {
    steps.push(
      "Some downstream servers need attention. Run `action-hub doctor` (or `action-hub auth login <server>` for OAuth servers) to troubleshoot.",
    );
  }

  return steps;
}

export async function initCommand(options: InitOptions = {}): Promise<number> {
  const isJson = options.json === true;
  const dryRun = options.dryRun === true;
  const daemon = options.daemon === true;
  const skipMigrate = options.skipMigrate === true;
  const skipDoctor = options.skipDoctor === true;

  // Validate --harness up front before touching any files on disk.
  let harnessTarget: HarnessName | undefined;
  if (options.harness !== undefined) {
    if (!(SUPPORTED_HARNESSES as readonly string[]).includes(options.harness)) {
      console.error(`error: unknown harness "${options.harness}"`);
      console.error(`supported harnesses: ${SUPPORTED_HARNESSES.join(", ")}`);
      return 1;
    }
    harnessTarget = options.harness as HarnessName;
  }

  if (!isJson) {
    console.log(
      dryRun
        ? "Action Hub Onboarding Wizard (dry run — no files will be modified)\n"
        : "Action Hub Onboarding Wizard\n",
    );
  }

  // -------------------------------------------------------------------------
  // Step 1: Capability migration (uses core discoverAll + executeMigration)
  // -------------------------------------------------------------------------
  let migrationPlan: MigrationPlan | undefined;
  let migratedConfigPath: string | undefined;

  if (!skipMigrate) {
    const currentConfig = await loadCliConfig(options.configPath);
    migratedConfigPath = currentConfig.path;

    // Validate the existing config up front so malformed configs fail closed
    // before discovery or any write runs.
    const raw = rawConfigDocument(currentConfig);
    if (!dryRun) {
      validateRawCapabilityArrays(raw, currentConfig.path);
    }

    // Use only servers explicitly persisted in servers.json as the migration
    // baseline (loadCliConfig may also include auto-discovered servers when
    // autoDiscover !== false, which would otherwise appear as conflicts on a
    // fresh install).
    const existingRawServers: Record<string, unknown>[] = Array.isArray(raw["servers"])
      ? raw["servers"].filter(
          (s): s is Record<string, unknown> =>
            typeof s === "object" &&
            s !== null &&
            typeof (s as Record<string, unknown>)["id"] === "string",
        )
      : [];

    const allDiscovered = await discoverAll();
    const sourceFilter =
      options.source && options.source !== "all" ? options.source : undefined;
    // Exclude any pre-existing `action-hub` entry in harness configs so Action Hub
    // never migrates itself as a recursive downstream server.
    const externalServers = allDiscovered.servers.filter((s) => s.id !== "action-hub");
    const filteredServers: DiscoveredServer[] = sourceFilter
      ? externalServers.filter((s) => s.sourceClient === sourceFilter)
      : externalServers;
    const filteredSkills: DiscoveredSkill[] = sourceFilter
      ? allDiscovered.skills.filter((s) => s.sourceClient === sourceFilter)
      : allDiscovered.skills;
    const filteredPlugins: DiscoveredPlugin[] = allDiscovered.plugins;

    const migrationResult = executeMigration({
      existingServers: existingRawServers as unknown as ServerConfig[],
      existingSkills: currentConfig.skills,
      existingBundles: currentConfig.bundles,
      discovered: {
        servers: filteredServers,
        skills: filteredSkills,
        plugins: filteredPlugins,
      },
      options: {
        types: ["mcps", "skills", "plugins"],
        overwrite: false,
      },
    });

    const { plan, mergedSkills, mergedBundles } = migrationResult;
    migrationPlan = plan;

    if (!dryRun) {
      const serverEntries = [...existingRawServers];
      for (const toAdd of plan.serversToAdd) {
        if (!serverEntries.some((s) => s["id"] === toAdd.id)) {
          serverEntries.push({ ...toAdd });
        }
      }

      raw["servers"] = serverEntries;
      raw["skills"] = mergedSkills;
      raw["bundles"] = mergedBundles;
      if (raw["autoApproveAtOrAbove"] === undefined) {
        raw["autoApproveAtOrAbove"] = currentConfig.autoApproveAtOrAbove;
      }
      // Once init explicitly migrates capabilities into servers.json, disable
      // implicit autoDiscover unless the user already configured it, so writing
      // `action-hub` into Cursor/Codex/VS Code/Claude Desktop never causes
      // Action Hub to recursively auto-discover itself on doctor/start.
      if (raw["autoDiscover"] === undefined) {
        raw["autoDiscover"] = false;
      }

      await writeConfigAtomic(currentConfig.path, raw);
    }

    if (!isJson) {
      const { summary } = plan;
      const conflicts = plan.conflicts.length;

      console.log("Step 1: Capability Migration");
      console.log(
        `  Discovered: ${summary.mcpsDiscovered} MCP server(s), ${summary.skillsDiscovered} skill(s), ${summary.pluginsDiscovered} plugin(s)`,
      );
      console.log(
        `  Planned:    +${summary.mcpsAdded} server(s), +${summary.skillsAdded} skill(s), +${summary.bundlesAdded} bundle(s)${
          conflicts > 0 ? ` (${conflicts} conflict(s) skipped)` : ""
        }`,
      );
      console.log(
        `  Config:     ${currentConfig.path} (${dryRun ? "dry run — not written" : "saved"})`,
      );
      console.log();
    }
  } else if (!isJson) {
    console.log("Step 1: Capability Migration skipped (--skip-migrate).\n");
  }

  // -------------------------------------------------------------------------
  // Step 2: Harness configuration
  // -------------------------------------------------------------------------
  let harnessConfigPath: string | undefined;
  let harnessWritten = false;
  const harnessMode: "daemon" | "stdio" = daemon ? "daemon" : "stdio";

  if (harnessTarget) {
    const def = HARNESS_DEFS[harnessTarget];
    harnessConfigPath = def.configPath(homedir());

    if (!isJson) {
      console.log(`Step 2: Harness Configuration (${def.label} — ${harnessMode} mode)`);
    }

    if (dryRun) {
      const { result: harnessExitCode } = await captureConsoleLog(
        () =>
          harnessCommand(harnessTarget, {
            mode: "export",
            write: false,
            daemon,
            configPath: options.configPath,
            node: options.node,
          }),
        false,
      );
      if (harnessExitCode !== 0) {
        return harnessExitCode;
      }
      if (!isJson) {
        console.log(
          `  Would write Action Hub (${harnessMode} mode) to ${harnessConfigPath} for ${def.label} (dry run — not written).\n`,
        );
      }
    } else {
      const { result: harnessExitCode } = await captureConsoleLog(
        () =>
          harnessCommand(harnessTarget, {
            mode: "install",
            write: true,
            daemon,
            configPath: options.configPath,
            node: options.node,
          }),
        !isJson,
      );
      if (harnessExitCode !== 0) {
        return harnessExitCode;
      }
      harnessWritten = true;
      if (!isJson) {
        console.log();
      }
    }
  } else if (!isJson) {
    console.log("Step 2: Harness Configuration skipped (no --harness target specified).\n");
  }

  // -------------------------------------------------------------------------
  // Step 3: Diagnostics & context savings estimate
  // -------------------------------------------------------------------------
  let doctorExitCode: number | undefined;
  let doctorMetrics: DoctorMetrics | undefined;

  if (!skipDoctor) {
    if (!isJson) {
      console.log("Step 3: Diagnostics & Indexing");
    }
    const { result: code, lines: doctorLines } = await captureConsoleLog(
      () =>
        doctorCommand({
          configPath: options.configPath,
          checkConnectivity: true,
        }),
      !isJson,
    );
    doctorExitCode = code;
    doctorMetrics = parseDoctorOutput(doctorLines);
    if (!isJson) {
      console.log();
    }
  } else if (!isJson) {
    console.log("Step 3: Diagnostics skipped (--skip-doctor).\n");
  }

  // -------------------------------------------------------------------------
  // Build final summary
  // -------------------------------------------------------------------------
  const finalConfig = await loadCliConfig(options.configPath);
  const resolvedConfigPath = migratedConfigPath ?? finalConfig.path;

  let totalServers = finalConfig.servers.length;
  let totalSkills = finalConfig.skills.length;
  let totalBundles = finalConfig.bundles.length;

  if (dryRun && migrationPlan) {
    const serverIds = new Set(finalConfig.servers.map((s) => s.id));
    for (const s of migrationPlan.serversToAdd) {
      serverIds.add(s.id);
    }
    totalServers = serverIds.size;

    const skillIds = new Set(finalConfig.skills.map((s) => s.id));
    for (const sk of migrationPlan.skillsToAdd) {
      skillIds.add(sk.id);
    }
    totalSkills = skillIds.size;

    const bundleIds = new Set(finalConfig.bundles.map((b) => b.id));
    for (const b of migrationPlan.bundlesToAdd) {
      bundleIds.add(b.id);
    }
    totalBundles = bundleIds.size;
  }

  const contextSavings =
    doctorMetrics?.eagerTokensEstimate !== undefined &&
    doctorMetrics.hubTokensEstimate !== undefined
      ? {
          eagerTokensEstimate: doctorMetrics.eagerTokensEstimate,
          hubTokensEstimate: doctorMetrics.hubTokensEstimate,
          estimatedSavingsPercent: doctorMetrics.estimatedSavingsPercent ?? 0,
        }
      : undefined;

  const nextSteps = buildNextSteps({
    dryRun,
    harnessTarget,
    daemon,
    source: options.source,
    configPath: options.configPath,
    skipDoctor,
    doctorExitCode,
  });

  const summary: InitSummary = {
    dryRun,
    configPath: resolvedConfigPath,
    migrate: {
      skipped: skipMigrate,
      written: !skipMigrate && !dryRun,
      discovered: {
        servers: migrationPlan?.summary.mcpsDiscovered ?? 0,
        skills: migrationPlan?.summary.skillsDiscovered ?? 0,
        plugins: migrationPlan?.summary.pluginsDiscovered ?? 0,
      },
      added: {
        servers: migrationPlan?.summary.mcpsAdded ?? 0,
        skills: migrationPlan?.summary.skillsAdded ?? 0,
        bundles: migrationPlan?.summary.bundlesAdded ?? 0,
      },
      updated: {
        servers: migrationPlan?.serversToUpdate.length ?? 0,
        skills: migrationPlan?.skillsToUpdate.length ?? 0,
      },
      conflicts: migrationPlan?.conflicts.length ?? 0,
    },
    harness: {
      configured: harnessTarget !== undefined,
      ...(harnessTarget
        ? {
            target: harnessTarget,
            label: HARNESS_DEFS[harnessTarget].label,
            mode: harnessMode,
            configPath: harnessConfigPath,
          }
        : {}),
      written: harnessWritten,
    },
    doctor: {
      skipped: skipDoctor,
      ...(skipDoctor
        ? {}
        : {
            exitCode: doctorExitCode,
            healthy: doctorExitCode === 0,
            healthyServers: doctorMetrics?.healthyServers ?? 0,
            unhealthyServers: doctorMetrics?.unhealthyServers ?? 0,
            ...(doctorMetrics?.toolsIndexed !== undefined
              ? { toolsIndexed: doctorMetrics.toolsIndexed }
              : {}),
            ...(contextSavings ? { contextSavings } : {}),
          }),
    },
    totals: {
      servers: totalServers,
      skills: totalSkills,
      bundles: totalBundles,
      ...(doctorMetrics?.toolsIndexed !== undefined
        ? { toolsIndexed: doctorMetrics.toolsIndexed }
        : {}),
    },
    nextSteps,
  };

  if (isJson) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  // Human-readable crisp summary block
  console.log("Summary:");
  console.log(`  Config:          ${summary.configPath}`);
  const toolsPart =
    summary.totals.toolsIndexed !== undefined
      ? `, ${summary.totals.toolsIndexed} tool(s) indexed`
      : "";
  console.log(
    `  Capabilities:    ${summary.totals.servers} server(s), ${summary.totals.skills} skill(s), ${summary.totals.bundles} bundle(s)${toolsPart}`,
  );
  if (summary.harness.configured && summary.harness.label && summary.harness.configPath) {
    const dryNote = dryRun ? " (dry run — not written)" : "";
    console.log(
      `  Harness:         ${summary.harness.label} (${summary.harness.configPath}, ${summary.harness.mode} mode)${dryNote}`,
    );
  } else {
    console.log("  Harness:         Not configured");
  }
  if (contextSavings) {
    if (contextSavings.eagerTokensEstimate > contextSavings.hubTokensEstimate) {
      console.log(
        `  Context savings: ~${contextSavings.eagerTokensEstimate} eager tokens -> ~${contextSavings.hubTokensEstimate} hub tokens (~${contextSavings.estimatedSavingsPercent}% saved per turn)`,
      );
    } else {
      console.log(
        `  Context tokens:  ~${contextSavings.eagerTokensEstimate} eager tokens vs ~${contextSavings.hubTokensEstimate} hub tokens`,
      );
    }
  }
  if (!skipDoctor) {
    console.log(
      `  Diagnostics:     ${doctorExitCode === 0 ? "Healthy" : "Completed with warnings"}`,
    );
  }

  if (nextSteps.length > 0) {
    console.log("\nNext steps:");
    for (const step of nextSteps) {
      console.log(`  • ${step}`);
    }
  }

  return 0;
}

export function printInitHelp(): void {
  console.log(`action-hub init [options]

One-command onboarding wizard for Action Hub:
  1. Migrates existing MCP servers, agent skills, and plugins into Action Hub
  2. Optionally configures your AI harness (--harness <target>)
  3. Runs diagnostics to index tools and estimate context token savings

Options:
  --harness <target>  Configure an AI harness (${SUPPORTED_HARNESSES.join(", ")})
  --daemon            Configure the harness to connect to the shared background daemon
  --source <source>   Filter migration by source (${MIGRATE_SOURCE_FILTERS.join(", ")}, all)
  --config <path>     Path to custom Action Hub configuration file (servers.json)
  --node <path>       Override the node command written into harness snippets
  --dry-run           Preview migration and harness changes without writing any files
  --skip-migrate      Skip capability discovery and migration
  --skip-doctor       Skip connectivity diagnostics and tool indexing
  --json              Output structured JSON summary on stdout

Examples:
  action-hub init --dry-run
  action-hub init --harness claude-code
  action-hub init --harness codex --daemon
  action-hub init --harness cursor --source cursor --json
`);
}
