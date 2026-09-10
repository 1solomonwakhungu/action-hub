import type { Bundle } from "../bundles/bundles.js";
import type {
  DiscoveredPlugin,
  DiscoveredServer,
  DiscoveredSkill,
  MigrationPlan,
  ServerConfig,
  SkillConfig,
  TrustTier,
} from "../types.js";

export interface MigrationOptions {
  types?: Array<"mcps" | "skills" | "plugins">;
  overwrite?: boolean;
  defaultTrust?: TrustTier;
  enableDiscovered?: boolean;
}

export interface MigrationPlanParams {
  existingServers: ServerConfig[];
  existingSkills?: SkillConfig[];
  existingBundles?: Bundle[];
  discovered: {
    servers: DiscoveredServer[];
    skills: DiscoveredSkill[];
    plugins: DiscoveredPlugin[];
  };
  options?: MigrationOptions;
}

export interface ExecuteMigrationResult {
  plan: MigrationPlan;
  mergedServers: ServerConfig[];
  mergedSkills: SkillConfig[];
  mergedBundles: Bundle[];
}

/**
 * Plans a capability migration by comparing discovered MCP servers, skills,
 * and plugins against existing configurations.
 */
export function planMigration(params: MigrationPlanParams): MigrationPlan {
  const { existingServers, existingSkills = [], existingBundles = [], discovered, options = {} } = params;
  const types = options.types ?? ["mcps", "skills", "plugins"];
  const overwrite = options.overwrite === true;
  const defaultTrust = options.defaultTrust ?? "untrusted";
  const enableDiscovered = options.enableDiscovered !== false;

  const serversToAdd: ServerConfig[] = [];
  const serversToUpdate: ServerConfig[] = [];
  const skillsToAdd: SkillConfig[] = [];
  const skillsToUpdate: SkillConfig[] = [];
  const bundlesToAdd: Bundle[] = [];
  const conflicts: MigrationPlan["conflicts"] = [];

  const existingServerMap = new Map(existingServers.map((s) => [s.id, s]));
  const existingSkillMap = new Map(existingSkills.map((s) => [s.id, s]));
  const existingBundleMap = new Map(existingBundles.map((b) => [b.id, b]));

  const candidateServers = new Map<string, ServerConfig>();
  const candidateSkills = new Map<string, SkillConfig>();

  // 1. Process Standalone MCP Servers
  if (types.includes("mcps")) {
    for (const server of discovered.servers) {
      candidateServers.set(server.id, {
        id: server.id,
        displayName: server.displayName ?? server.id,
        transport: server.transport,
        trust: server.trust ?? defaultTrust,
        enabled: server.enabled !== undefined ? server.enabled : enableDiscovered,
        allowTools: server.allowTools,
        denyTools: server.denyTools,
        timeoutMs: server.timeoutMs,
      });
    }
  }

  // 2. Process Standalone Skills
  if (types.includes("skills")) {
    for (const skill of discovered.skills) {
      candidateSkills.set(skill.id, {
        id: skill.id,
        name: skill.name,
        summary: skill.summary,
        description: skill.description,
        tags: skill.tags,
        trust: skill.trust ?? "trusted",
        sourcePath: skill.sourcePath,
        sourceClient: skill.sourceClient,
      });
    }
  }

  // 3. Process Plugins (unpacking servers, skills, and creating bundles)
  if (types.includes("plugins")) {
    for (const plugin of discovered.plugins) {
      for (const server of plugin.servers) {
        if (!candidateServers.has(server.id)) {
          candidateServers.set(server.id, {
            id: server.id,
            displayName: server.displayName ?? server.id,
            transport: server.transport,
            trust: server.trust ?? defaultTrust,
            enabled: server.enabled !== undefined ? server.enabled : enableDiscovered,
          });
        }
      }

      for (const skill of plugin.skills) {
        if (!candidateSkills.has(skill.id)) {
          candidateSkills.set(skill.id, {
            id: skill.id,
            name: skill.name,
            summary: skill.summary,
            description: skill.description,
            tags: skill.tags,
            trust: skill.trust ?? "trusted",
            sourcePath: skill.sourcePath,
            sourceClient: skill.sourceClient,
          });
        }
      }

      // Generate a Bundle if plugin has capabilities
      if (plugin.servers.length > 0 || plugin.skills.length > 0) {
        const bundleId = `plugin:${plugin.id}`;
        if (!existingBundleMap.has(bundleId)) {
          bundlesToAdd.push({
            id: bundleId,
            displayName: plugin.name,
            description: plugin.description ?? `Imported bundle for plugin ${plugin.name}`,
            serverIds: plugin.servers.map((s) => s.id),
            actionIds: plugin.skills.map((s) => s.id),
          });
        }
      }
    }
  }

  // 4. Resolve Server Conflicts
  for (const [id, server] of candidateServers) {
    if (existingServerMap.has(id)) {
      if (overwrite) {
        serversToUpdate.push(server);
      } else {
        conflicts.push({
          type: "server",
          id,
          reason: `Server "${id}" already exists in configuration`,
        });
      }
    } else {
      serversToAdd.push(server);
    }
  }

  // 5. Resolve Skill Conflicts
  for (const [id, skill] of candidateSkills) {
    if (existingSkillMap.has(id)) {
      if (overwrite) {
        skillsToUpdate.push(skill);
      } else {
        conflicts.push({
          type: "skill",
          id,
          reason: `Skill "${id}" already exists in configuration`,
        });
      }
    } else {
      skillsToAdd.push(skill);
    }
  }

  return {
    serversToAdd,
    serversToUpdate,
    skillsToAdd,
    skillsToUpdate,
    bundlesToAdd,
    conflicts,
    summary: {
      mcpsDiscovered: discovered.servers.length,
      mcpsAdded: serversToAdd.length,
      skillsDiscovered: discovered.skills.length,
      skillsAdded: skillsToAdd.length,
      pluginsDiscovered: discovered.plugins.length,
      bundlesAdded: bundlesToAdd.length,
    },
  };
}

/**
 * Applies a migration plan to existing configs and produces merged configurations.
 */
export function executeMigration(
  params: MigrationPlanParams,
): ExecuteMigrationResult {
  const plan = planMigration(params);
  const { existingServers, existingSkills = [], existingBundles = [] } = params;

  // Merge Servers
  const serverMap = new Map(existingServers.map((s) => [s.id, s]));
  for (const s of plan.serversToAdd) {
    serverMap.set(s.id, s);
  }
  for (const s of plan.serversToUpdate) {
    serverMap.set(s.id, s);
  }

  // Merge Skills
  const skillMap = new Map(existingSkills.map((s) => [s.id, s]));
  for (const s of plan.skillsToAdd) {
    skillMap.set(s.id, s);
  }
  for (const s of plan.skillsToUpdate) {
    skillMap.set(s.id, s);
  }

  // Merge Bundles
  const bundleMap = new Map(existingBundles.map((b) => [b.id, b]));
  for (const b of plan.bundlesToAdd) {
    bundleMap.set(b.id, b);
  }

  return {
    plan,
    mergedServers: [...serverMap.values()],
    mergedSkills: [...skillMap.values()],
    mergedBundles: [...bundleMap.values()],
  };
}
