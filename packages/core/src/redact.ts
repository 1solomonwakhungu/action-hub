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
const SENSITIVE_NAME_RE = /(token|secret|pass(word|wd)?|pwd|api[-_]?key|auth|credential|cookie|session)/i;

const HEADER_FLAG_RE = /^-{1,2}h(?:eader)?$/i;

/** Matches `Name: value` header arguments; the name is kept, the value dropped. */
const BARE_HEADER_RE = /^([A-Za-z0-9-]+):\s+(.+)$/;

/** Extracts a header name from `Name: value` or `Name:value` (no URL ambiguity). */
const HEADER_NAME_RE = /^([A-Za-z0-9-]+):(?!\/\/)(.*)$/s;

/** Matches credential-bearing schemes in inline credential values. */
const CREDENTIAL_VALUE_RE = /\b(Bearer|Basic)\s+\S+/gi;

/** Known secret value prefixes (OpenAI, GitHub, Slack, AWS, GitLab). */
const KNOWN_PREFIX_RE = /(?:sk-|ghp_|gho_|github_pat_|xox|AKIA|glpat-)[A-Za-z0-9_\-.+/=]{6,}/g;

/** Long opaque runs that are plausible raw secrets. */
const RAW_SECRET_RUN_RE = /[A-Za-z0-9_\-.+/=]{24,}/g;

/** Fail-closed backstop: redact raw-secret-looking values without a flag. */
function redactRawSecrets(text: string): string {
  let out = text.replace(KNOWN_PREFIX_RE, REDACTED);
  out = out.replace(RAW_SECRET_RUN_RE, (run) => {
    // Keep URLs and file paths intact; everything else fails closed.
    if (run.includes("://") || run.startsWith("/") || run.startsWith("./") || run.startsWith("../")) {
      return run;
    }
    return REDACTED;
  });
  return out;
}

/**
 * Redact a header-style value while keeping the header name when one is
 * present (`X-API-Key: sk-...` -> `X-API-Key: [redacted]`).
 */
function redactHeaderValue(value: string): string {
  const bare = HEADER_NAME_RE.exec(value);
  const withName = bare && bare[1] !== undefined ? `${bare[1]}: ` : "";
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
    const value = redactCredentialValues(bare[2]);
    return `${bare[1]}: ${value === bare[2] ? REDACTED : redactRawSecrets(value)}`;
  }
  const eq = arg.indexOf("=");
  if (eq > 0 && SENSITIVE_NAME_RE.test(arg.slice(0, eq))) {
    return `${arg.slice(0, eq + 1)}${REDACTED}`;
  }
  return redactRawSecrets(redactCredentialValues(arg));
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
    const attachedShortHeader = /^-H([^=].*)$/s.exec(arg);
    if (attachedShortHeader && attachedShortHeader[1] !== undefined) {
      // Attached short-header form: -HName: value (value dropped, name kept).
      return `-H${redactHeaderValue(attachedShortHeader[1])}`;
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
      return redactRawSecrets(arg);
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
 * Collect every secret value present in a server config, for value-based
 * redaction of strings that may echo configuration (error messages, logs).
 */
export function collectServerSecrets(server: ServerConfig): string[] {
  const secrets: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) secrets.push(value);
  };
  /** Push a header-style value whole, plus its credential components. */
  const pushWithParts = (value: string): void => {
    push(value);
    const bearer = /\b(Bearer|Basic)\s+(\S+)/i.exec(value);
    if (bearer && bearer[2] !== undefined) push(bearer[2]);
    const colon = value.indexOf(":");
    if (colon >= 0) {
      const rest = value.slice(colon + 1).trim();
      if (rest.length > 0) push(rest);
    }
  };
  const transport = server.transport;
  if (transport.type === "stdio") {
    for (const value of Object.values(transport.env ?? {})) push(value);
    let redactNext = false;
    for (const arg of transport.args ?? []) {
      if (redactNext) {
        pushWithParts(arg);
        redactNext = false;
        continue;
      }
      const flag = /^(--?[^=\s]+)(?:=(.*))?$/s.exec(arg);
      if (flag && flag[1] !== undefined && (SENSITIVE_NAME_RE.test(flag[1]) || HEADER_FLAG_RE.test(flag[1]))) {
        if (flag[2] !== undefined) pushWithParts(flag[2]);
        else redactNext = true;
        continue;
      }
      const bearer = /^(?:[A-Za-z0-9-]+:\s*)?(?:Bearer|Basic)\s+(\S+)$/i.exec(arg);
      if (bearer && bearer[1] !== undefined) {
        pushWithParts(arg);
        continue;
      }
      const eq = arg.indexOf("=");
      if (eq > 0 && SENSITIVE_NAME_RE.test(arg.slice(0, eq))) push(arg.slice(eq + 1));
    }
  } else {
    // The whole URL is a secret carrier: an error echoing it verbatim would
    // leak userinfo/query values even after per-part redaction.
    push(transport.url);
    try {
      const parsed = new URL(transport.url);
      push(parsed.username);
      push(parsed.password);
      for (const value of parsed.searchParams.values()) push(value);
    } catch {
      // Unparseable URL was already collected whole.
    }
    for (const value of Object.values(transport.headers ?? {})) pushWithParts(value);
    if (transport.auth?.clientSecret) push(transport.auth.clientSecret);
  }
  return secrets;
}

/**
 * Sanitize a string that may echo a server's configuration (error messages,
 * diagnostics). Uses a dedicated exact-value replacement with a low floor of
 * 4 characters — config-derived credentials are known values, not
 * provider-response guesses, so the provider-response 8-character floor does
 * not apply. Secrets are replaced longest-first so that a value contained in
 * a longer collected secret is not partially replaced.
 */
export function sanitizeErrorForServer(server: ServerConfig, text: string): string {
  const secrets = collectServerSecrets(server)
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join(REDACTED);
  }
  return redactRawSecrets(out);
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
