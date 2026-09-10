import { OAuthError } from "./errors.js";
import type { OAuthClientConfig } from "./types.js";

/**
 * Resolves `clientIdEnv` / `clientSecretEnv` against an environment map.
 *
 * Config files get committed, synced, and pasted into issues, so the shipped
 * examples reference environment variables rather than literals. The
 * environment is passed in rather than read from `process.env` to keep this
 * function pure and usable from any runtime.
 *
 * A literal value already present in the config wins, so an operator can still
 * inject a secret from a wrapper without editing the file.
 */
export function resolveOAuthConfigSecrets(
  config: OAuthClientConfig,
  env: Record<string, string | undefined>,
  serverId = "unknown",
): OAuthClientConfig {
  const resolved: OAuthClientConfig = { ...config };

  if (!resolved.clientSecret && config.clientSecretEnv) {
    const value = env[config.clientSecretEnv];
    if (value && value.length > 0) resolved.clientSecret = value;
  }

  if (config.clientIdEnv) {
    const value = env[config.clientIdEnv];
    if (value && value.length > 0) resolved.clientId = value;
  }

  if (!resolved.clientId || resolved.clientId.length === 0) {
    throw new OAuthError(
      "invalid_configuration",
      serverId,
      config.clientIdEnv
        ? `clientId is empty and environment variable ${config.clientIdEnv} is not set`
        : "clientId is required",
      { retryable: false },
    );
  }

  return resolved;
}

/**
 * Structural check for an OAuth block parsed out of untrusted JSON.
 *
 * Config arrives from hand-edited files and from imported third-party client
 * configs, so the shape is verified before it is handed to the client rather
 * than trusted from a cast.
 */
export function isOAuthClientConfig(value: unknown): value is OAuthClientConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record["type"] !== "oauth2") return false;
  if (typeof record["tokenUrl"] !== "string" || record["tokenUrl"].length === 0) return false;

  const hasClientId = typeof record["clientId"] === "string" && record["clientId"].length > 0;
  const hasClientIdEnv = typeof record["clientIdEnv"] === "string" && record["clientIdEnv"].length > 0;
  if (!hasClientId && !hasClientIdEnv) return false;

  const grant = record["grantType"];
  if (grant !== undefined && grant !== "authorization_code" && grant !== "client_credentials") {
    return false;
  }
  return true;
}
