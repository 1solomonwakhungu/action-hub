const NODE_BINARIES = new Set(["node", "nodejs"]);
const NODE_WRAPPERS = new Set(["npx", "npm", "yarn", "pnpm", "tsx", "ts-node"]);
const FLAG = "--max-old-space-size";
const FLAG_PATTERN = /(?:^|\s)--max-old-space-size(?:=|\s|$)/;

export interface NodeMemoryLimitResult {
  command: string;
  args: string[];
  env: Record<string, string> | undefined;
  applied: boolean;
  detail: string;
}

/**
 * Adds `--max-old-space-size` for Node stdio servers without touching other
 * commands or duplicating an existing flag / NODE_OPTIONS value.
 *
 * Direct `node`/`nodejs` invocations get the V8 flag as argv. Wrappers such as
 * `npx` get `NODE_OPTIONS`, because their own argv is not forwarded to V8.
 */
export function applyNodeMemoryLimit(
  command: string,
  args: readonly string[] = [],
  env: Record<string, string> | undefined,
  maxOldSpaceSizeMb: number | undefined,
): NodeMemoryLimitResult {
  const nextArgs = [...args];
  const nextEnv = env ? { ...env } : undefined;
  const base = {
    command,
    args: nextArgs,
    env: nextEnv,
  };

  if (maxOldSpaceSizeMb === undefined) {
    return { ...base, applied: false, detail: "no memory limit configured" };
  }
  if (!Number.isFinite(maxOldSpaceSizeMb) || maxOldSpaceSizeMb < 1) {
    return { ...base, applied: false, detail: "invalid memory limit" };
  }

  const mb = Math.floor(maxOldSpaceSizeMb);
  const kind = nodeCommandKind(command);
  if (!kind) {
    return { ...base, applied: false, detail: "non-node command" };
  }

  if (hasArgvFlag(nextArgs) || hasNodeOptionsFlag(nextEnv)) {
    return { ...base, applied: false, detail: "flag already present" };
  }

  const flag = `${FLAG}=${mb}`;
  if (kind === "binary") {
    nextArgs.unshift(flag);
    return {
      command,
      args: nextArgs,
      env: nextEnv,
      applied: true,
      detail: `injected ${flag}`,
    };
  }

  const merged = nextEnv ?? {};
  const existing = merged["NODE_OPTIONS"]?.trim();
  merged["NODE_OPTIONS"] = existing ? `${existing} ${flag}` : flag;
  return {
    command,
    args: nextArgs,
    env: merged,
    applied: true,
    detail: `set NODE_OPTIONS ${flag}`,
  };
}

export function isNodeStdioCommand(command: string): boolean {
  return nodeCommandKind(command) !== undefined;
}

function nodeCommandKind(command: string): "binary" | "wrapper" | undefined {
  const base = commandBase(command);
  if (NODE_BINARIES.has(base)) return "binary";
  if (NODE_WRAPPERS.has(base)) return "wrapper";
  return undefined;
}

function commandBase(command: string): string {
  const normalized = command.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const file = slash === -1 ? normalized : normalized.slice(slash + 1);
  return file.replace(/\.exe$/i, "").toLowerCase();
}

function hasArgvFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === FLAG || arg.startsWith(`${FLAG}=`));
}

function hasNodeOptionsFlag(env: Record<string, string> | undefined): boolean {
  const value = env?.["NODE_OPTIONS"];
  return typeof value === "string" && FLAG_PATTERN.test(value);
}
