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
 * Validates the shape of an existing raw config's `servers` array.
 *
 * The write path merges into this array by id, so it must actually be a
 * well-formed list: an array of objects with non-empty string ids and no
 * duplicates. Anything else fails closed — the caller must exit without
 * touching the original bytes rather than coercing or replacing them.
 */
export function validateRawServersShape(
  raw: Record<string, unknown>,
  path: string,
): void {
  const value = raw["servers"];
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error(`Malformed config at ${path}: "servers" must be an array, refusing to overwrite`);
  }
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const label = `"servers"[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Malformed config at ${path}: ${label} must be an object, refusing to overwrite`);
    }
    const id = entry["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`Malformed config at ${path}: ${label}.id must be a non-empty string, refusing to overwrite`);
    }
    if (seen.has(id)) {
      throw new Error(`Malformed config at ${path}: duplicate server id "${id}", refusing to overwrite`);
    }
    seen.add(id);
  }
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
