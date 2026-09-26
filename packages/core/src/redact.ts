import { REDACTED, redactOAuthConfig } from "./auth/index.js";
import type { OAuthClientConfig } from "./auth/types.js";
import type { HttpTransport, ServerConfig } from "./types.js";

/**
 * Shared credential redaction helpers for displaying server configuration.
 *
 * Everything here is intentionally lossy and fails closed: secret *values* are
 * replaced with the existing `[redacted]` marker while non-secret structure
 * (keys, flag names, command paths) is preserved so output remains useful for
 * debugging. Anything that cannot be confidently parsed as secret-free is
 * redacted wholesale.
 */

/** A flag name (with leading dashes) that carries a credential value. */
const SENSITIVE_NAME_RE = /(token|secret|pass(word|wd)?|api[-_]?key|auth|credential|cookie|session)/i;

const HEADER_FLAG_RE = /^-{1,2}h(?:eader)?$/i;

/** Matches `Name: value` header arguments; the name is kept, the value dropped. */
const BARE_HEADER_RE = /^([A-Za-z0-9-]+):\s*(.+)$/;

/** Matches credential-bearing schemes in inline credential values. */
const CREDENTIAL_VALUE_RE = /\b(Bearer|Basic)\s+\S+/gi;

/**
 * Redact a header-style value while keeping the header name when one is
 * present (`X-API-Key: sk-...` -> `X-API-Key: [redacted]`).
 */
function redactHeaderValue(value: string): string {
  const bare = BARE_HEADER_RE.exec(value);
  const withName = bare ? `${bare[1]}: ` : "";
  return `${withName}${REDACTED}`;
}

/** Redact Bearer/Basic credential values appearing anywhere in a string. */
function redactCredentialValues(text: string): string {
  return text.replace(CREDENTIAL_VALUE_RE, (_match, scheme: string) => `${scheme} ${REDACTED}`);
}

/**
 * Redact a single command-line argument:
 * - bare `Name: value` header args keep the name, drop the value
 * - `Bearer <token>` / `Basic <token>` values are redacted anywhere
 * - `key=value` args whose key looks credential-like are redacted
 */
export function redactArg(arg: string): string {
  const bare = BARE_HEADER_RE.exec(arg);
  if (bare && bare[1] !== undefined && bare[2] !== undefined) {
    return `${bare[1]}: ${redactCredentialValues(bare[2]) === bare[2] ? REDACTED : redactCredentialValues(bare[2])}`;
  }
  const eq = arg.indexOf("=");
  if (eq > 0 && SENSITIVE_NAME_RE.test(arg.slice(0, eq))) {
    return `${arg.slice(0, eq + 1)}${REDACTED}`;
  }
  return redactCredentialValues(arg);
}

/**
 * Redact an args array. Any flag whose name looks credential-like
 * (`--token`, `--api-key`, `--github-token`, `--password`, `--session`, ...)
 * or a header flag (`--header`, `-H`) redacts its value — whether the value
 * is a separate argument (`--token abc`) or inline (`--token=abc`).
 */
export function redactArgs(args?: string[]): string[] | undefined {
  if (!args) return undefined;
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      // A pending header flag value keeps its header name; credential
      // schemes inside the value are still redacted.
      if (BARE_HEADER_RE.test(arg)) {
        return redactArg(arg);
      }
      return REDACTED;
    }
    const flag = /^(--?[^=\s]+)(?:=(.*))?$/s.exec(arg);
    if (flag && flag[1] !== undefined) {
      const name = flag[1];
      const inlineValue = flag[2];
      if (SENSITIVE_NAME_RE.test(name) || HEADER_FLAG_RE.test(name)) {
        if (inlineValue !== undefined) {
          return HEADER_FLAG_RE.test(name)
            ? `${name}=${redactHeaderValue(inlineValue)}`
            : `${name}=${REDACTED}`;
        }
        redactNext = true;
      }
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
    Object.entries(record).map(([key, _value]) => [key, REDACTED]),
  );
}

/**
 * Redact userinfo (username/password) and every query parameter value in a
 * URL, keeping keys and the rest of the URL intact. URLs that fail to parse
 * fail closed: the whole string is replaced with `[redacted]`.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return REDACTED;
  }
  if (parsed.username) parsed.username = "redacted";
  if (parsed.password) parsed.password = "redacted";
  for (const key of [...parsed.searchParams.keys()]) {
    parsed.searchParams.set(key, REDACTED);
  }
  return parsed.toString();
}

/**
 * Produce a display-safe copy of a resolved ServerConfig: env values, stdio
 * args, header values, URL userinfo/query values, and the OAuth auth block
 * are redacted.
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
