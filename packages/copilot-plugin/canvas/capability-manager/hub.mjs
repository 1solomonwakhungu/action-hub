import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const REQUEST_TIMEOUT_MS = 10_000;

function controlPath() {
  const fromEnv = process.env.ACTION_HUB_CONTROL;
  if (fromEnv) return fromEnv;
  return resolve(homedir(), ".cache", "action-hub", "control.json");
}

/**
 * Locates the running hub's control endpoint.
 *
 * The hub publishes its port and a per-process token when it starts and removes
 * the file when it stops, so a missing or malformed file simply means "no hub
 * right now" — the canvas treats that as read-only mode rather than an error.
 */
async function readControl() {
  try {
    const parsed = JSON.parse(await readFile(controlPath(), "utf8"));
    if (typeof parsed?.url !== "string" || typeof parsed?.token !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Every canvas write goes through here, which is the whole point of the
 * design: the canvas never edits servers.json itself. It asks the live hub to
 * make the change, and the hub validates the input, updates its own connection
 * and catalog state, and persists the config. That keeps disk and memory from
 * drifting and keeps validation on the trusted side of the boundary.
 *
 * Returns a discriminated result instead of throwing so that both the canvas
 * actions and the in-page controls can render a failure inline.
 */
export async function hubRequest(path, body) {
  const control = await readControl();
  if (!control) {
    return { ok: false, unavailable: true, error: "Action Hub is not running." };
  }

  try {
    const response = await fetch(`${control.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${control.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        error: payload?.error ?? `Action Hub returned ${response.status}.`,
      };
    }
    return payload ?? { ok: true };
  } catch (cause) {
    // A published endpoint that refuses connections means the hub died without
    // cleaning up. That is indistinguishable from "not running" to the user.
    return {
      ok: false,
      unavailable: true,
      error: `Action Hub is unreachable: ${cause?.message ?? String(cause)}`,
    };
  }
}

export async function hubState() {
  const result = await hubRequest("/state");
  return result?.ok && result.state ? result.state : null;
}
