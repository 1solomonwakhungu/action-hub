import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CliConfig } from "./config-loader.js";

/**
 * Persists a raw config document atomically with owner-only permissions.
 *
 * Mirrors the server's writeRawConfigFile (packages/copilot-plugin/server/src/config.ts):
 * temp file + rename so a concurrent reader can never observe a half-written
 * file, and mode 0o600 because configs can contain credentials.
 *
 * Kept local to the CLI rather than imported from the server package so the
 * standalone CLI binary does not have to pull in the whole MCP server surface.
 */
export async function writeConfigAtomic(
  path: string,
  config: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const serialized = JSON.stringify(config, null, 2) + "\n";
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
}

/**
 * Returns the existing raw config document as the merge base for a write.
 *
 * Malformed existing configs (valid JSON but not an object) are rejected so a
 * write can never silently replace them.
 */
export function rawConfigDocument(currentConfig: CliConfig): Record<string, unknown> {
  const raw = currentConfig.raw;
  if (raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
    throw new Error(
      `Malformed config at ${currentConfig.path}: expected a JSON object, refusing to overwrite`,
    );
  }
  return { ...raw };
}
