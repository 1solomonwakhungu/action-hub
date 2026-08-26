import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ActionHub } from "@action-hub/core";

export function defaultSnapshotPath(): string {
  return (
    process.env.ACTION_HUB_CACHE ?? resolve(homedir(), ".cache", "action-hub", "catalog.json")
  );
}

/**
 * Publishes the hub's state for the Capability Manager canvas, which reads this
 * file rather than connecting to anything itself.
 *
 * Writes are atomic (temp file + rename) because the canvas polls on a timer
 * and would otherwise be able to read a half-written file. Failures are
 * swallowed: a missing diagnostics snapshot must never take down the MCP
 * server the agent depends on.
 */
export async function writeSnapshot(hub: ActionHub, path = defaultSnapshotPath()): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(hub.snapshot(), null, 2), "utf8");
    await rename(temp, path);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`action-hub: could not write snapshot to ${path}: ${message}\n`);
  }
}
