import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
 *  - Writes are serialised per instance, so two servers refreshing at once
 *    cannot lose each other's update.
 *  - Reads never throw: an unreadable or corrupt file degrades into "no stored
 *    credentials", which prompts a re-authorization rather than crashing the
 *    MCP server an agent session depends on.
 */
export class FileTokenStore implements TokenStore {
  readonly path: string;
  readonly #warn: (message: string) => void;
  #writeChain: Promise<unknown> = Promise.resolve();

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
    const run = this.#writeChain.then(async () => {
      const all = await this.#readAll();
      apply(all);
      await this.#writeAll(all);
    });
    this.#writeChain = run.catch(() => undefined);
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
