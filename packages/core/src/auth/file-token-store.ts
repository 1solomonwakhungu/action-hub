import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { coerceTokenSet } from "./token-store.js";
import type { TokenSet, TokenStore } from "./types.js";

/**
 * Resolves the credential file, honouring `XDG_STATE_HOME` before falling back
 * to `~/.local/state`. `ACTION_HUB_CREDENTIALS` overrides both and points at
 * the file itself, which is what the tests use.
 *
 * State, not cache: losing this file costs the user a re-authorization, so it
 * must not sit somewhere a cleaner is entitled to delete.
 */
export function defaultCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["ACTION_HUB_CREDENTIALS"];
  if (explicit && explicit.length > 0) return explicit;

  const xdg = env["XDG_STATE_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : resolve(homedir(), ".local", "state");
  return resolve(base, "action-hub", "credentials.json");
}

export interface FileTokenStoreOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
  onWarning?: (message: string) => void;
}

const mutationChains = new Map<string, Promise<unknown>>();

/**
 * Credential persistence backed by a mode-0600 file.
 *
 * This is a default, not a mandate. `TokenStore` is the contract; a desktop
 * host is expected to inject a platform keychain instead, and core never
 * learns the difference. A file is the right *default* for a headless hub: it
 * works over SSH and in CI, where a keychain either does not exist or would
 * block on an interactive unlock. It lives beside `CatalogCache`, which makes
 * the same trade-off for the same reason.
 *
 * Everything about the file is defensive:
 *
 *  - Directory `0700` and file `0600`, re-applied on every write, so a
 *    permissive umask cannot widen it.
 *  - Written to a unique temp path and renamed into place, so a concurrent
 *    reader never sees a half-written credential set.
 *  - Writes are serialised per credential path and guarded by an exclusive
 *    lock file, so threads and processes cannot lose each other's update.
 *  - Reads never throw: an unreadable or corrupt file degrades into "no stored
 *    credentials", which prompts a re-authorization rather than crashing the
 *    MCP server an agent session depends on.
 */
export class FileTokenStore implements TokenStore {
  readonly path: string;
  readonly #warn: (message: string) => void;

  constructor(options: FileTokenStoreOptions = {}) {
    this.path = options.path ?? defaultCredentialsPath(options.env);
    this.#warn = options.onWarning ?? (() => {});
  }

  async get(key: string): Promise<TokenSet | undefined> {
    const all = await this.#readAll();
    return coerceTokenSet(all[key]);
  }

  async set(key: string, tokens: TokenSet): Promise<void> {
    await this.#mutate((all) => {
      all[key] = tokens;
    });
  }

  async delete(key: string): Promise<void> {
    await this.#mutate((all) => {
      delete all[key];
    });
  }

  /** Server ids with stored credentials. Never returns token values. */
  async keys(): Promise<string[]> {
    return Object.keys(await this.#readAll()).sort();
  }

  async #readAll(): Promise<Record<string, unknown>> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#warn(`could not read credentials at ${this.path}: ${message(cause)}`);
      }
      return {};
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      return parsed as Record<string, unknown>;
    } catch {
      this.#warn(`credentials at ${this.path} are not valid JSON; ignoring them`);
      return {};
    }
  }

  /** Read-modify-write, serialised so concurrent refreshes do not clobber. */
  #mutate(apply: (all: Record<string, unknown>) => void): Promise<void> {
    const prior = mutationChains.get(this.path) ?? Promise.resolve();
    const run = prior.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const release = await acquireFileLock(`${this.path}.lock`);
      try {
        const all = await this.#readAll();
        apply(all);
        await this.#writeAll(all);
      } finally {
        await release();
      }
    });
    const tail = run.catch(() => undefined);
    mutationChains.set(this.path, tail);
    void tail.finally(() => {
      if (mutationChains.get(this.path) === tail) mutationChains.delete(this.path);
    });
    return run;
  }

  async #writeAll(all: Record<string, unknown>): Promise<void> {
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.path);
      // `rename` preserves the temp file's mode, but an existing destination
      // created by an older build could be wider. Re-assert it.
      await chmod(this.path, 0o600).catch(() => {});
    } catch (cause) {
      this.#warn(`could not write credentials to ${this.path}: ${message(cause)}`);
      await unlink(temp).catch(() => {});
    }
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function acquireFileLock(path: string): Promise<() => Promise<void>> {
  const owner = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(owner, "utf8");
      return async () => {
        await handle.close();
        try {
          if ((await readFile(path, "utf8")) === owner) await unlink(path);
        } catch {
          // Another process may already have recovered a stale lock.
        }
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const staleOwner = await readLockOwner(path);
      if (staleOwner && !processAlive(staleOwner.pid)) {
        try {
          if ((await readFile(path, "utf8")) === staleOwner.raw) await unlink(path);
        } catch {
          // The lock changed between inspection and cleanup; retry normally.
        }
      } else if (!staleOwner) {
        await removeAbandonedEmptyLock(path);
      }
      await new Promise((done) => setTimeout(done, 10));
    }

    async function removeAbandonedEmptyLock(path: string): Promise<void> {
      try {
        const before = await stat(path);
        if (Date.now() - before.mtimeMs < 1_000) return;
        const after = await stat(path);
        if (before.ino === after.ino && before.mtimeMs === after.mtimeMs) await unlink(path);
      } catch {
        // The lock disappeared or changed while it was inspected.
      }
    }
  }

  throw new Error(`Timed out waiting for credential lock at ${path}`);
}

async function readLockOwner(path: string): Promise<{ pid: number; raw: string } | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const pid = Number.parseInt(raw.split(":")[0] ?? "", 10);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid, raw } : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}
