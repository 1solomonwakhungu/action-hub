import { REDACTED, redactOAuthConfig } from "./auth/index.js";
import type { OAuthClientConfig } from "./auth/types.js";
import type { HttpTransport, ServerConfig } from "./types.js";

/**
 * Shared credential redaction helpers for displaying server configuration.
 *
 * Everything here is intentionally lossy: secret *values* are replaced with
 * the literal string `REDACTED` while non-secret structure (keys, flag names,
 * command paths) is preserved so output remains useful for debugging.
 */

const SENSITIVE_ARG_FLAGS = new Set([
  "--token",
  "--api-key",
  "--api_key",
  "--apikey",
  "--password",
  "--secret",
  "--header",
]);

const SENSITIVE_KEY_RE = /token|secret|password|api[-_]?key|auth/i;

/**
 * Redact a single command-line argument. Detects:
 * - `Bearer <token>` values
 * - `key=value` args whose key looks credential-like (token, key, secret,
 *   password, auth, api-key)
 */
export function redactArg(arg: string): string {
  if (/Bearer\s+\S+/i.test(arg)) {
    return arg.replace(/Bearer\s+\S+/i, `Bearer ${REDACTED}`);
  }
  const eq = arg.indexOf("=");
  if (eq > 0 && SENSITIVE_KEY_RE.test(arg.slice(0, eq))) {
    return `${arg.slice(0, eq + 1)}${REDACTED}`;
  }
  return arg;
}

/**
 * Redact an args array, honoring value-carrying flags: the argument
 * immediately following `--token`, `--api-key`, `--password`, `--secret`,
 * `--header`, or `-H` is replaced entirely.
 */
export function redactArgs(args?: string[]): string[] | undefined {
  if (!args) return undefined;
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED;
    }
    const lower = arg.toLowerCase();
    if (SENSITIVE_ARG_FLAGS.has(lower) || arg === "-H") {
      redactNext = true;
      return arg;
    }
    return redactArg(arg);
  });
}

/** Redact every value in a string map (env vars, headers), keeping keys. */
export function redactRecord(
  record?: Record<string, string>,
): Record<string, string> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, REDACTED]),
  );
}

/**
 * Redact query parameter values in a URL, keeping keys and the rest of the
 * URL intact. URLs that fail to parse are returned unchanged (callers should
 * not log unparseable URLs raw if they may contain secrets).
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const keys = [...parsed.searchParams.keys()];
    if (keys.length === 0) return url;
    for (const key of keys) {
      parsed.searchParams.set(key, REDACTED);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Produce a display-safe copy of a resolved ServerConfig: env values, stdio
 * args, header values, URL query values, and the entire OAuth auth block are
 * redacted.
 */
export function redactServerConfig(server: ServerConfig): ServerConfig {
  const transport = server.transport;
  if (transport.type === "stdio") {
    return {
      ...server,
      transport: {
        ...transport,
        args: redactArgs(transport.args),
        env: redactRecord(transport.env),
      },
    };
  }
  const out: HttpTransport = {
    ...transport,
    url: redactUrl(transport.url),
    headers: redactRecord(transport.headers),
  };
  if (transport.auth) {
    out.auth = redactOAuthConfig(transport.auth) as unknown as OAuthClientConfig;
  }
  return { ...server, transport: out };
}
