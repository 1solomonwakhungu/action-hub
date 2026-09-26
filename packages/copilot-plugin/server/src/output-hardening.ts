import { redactKnownSecretPrefixes } from "@action-hub/core";

/**
 * Output hardening for the action_hub tool (stress findings F1/F2).
 *
 * All limits live here so the response formatting layer stays declarative.
 * These caps apply ONLY to what the action_hub tool returns — per intake
 * decision, indexing is unchanged.
 */

/** Maximum bytes of any search-result summary returned to the model. */
export const SEARCH_SUMMARY_MAX_BYTES = 300;
/** Maximum bytes of a (tool) description returned by load. */
export const LOAD_DESCRIPTION_MAX_BYTES = 8 * 1024;
/** Maximum bytes of the serialized inputSchema returned by load. */
export const LOAD_SCHEMA_MAX_BYTES = 32 * 1024;
/** Maximum bytes of skill instructions returned by load. */
export const SKILL_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

function truncationMarker(droppedBytes: number): string {
  return `…[truncated by action_hub: dropped ${droppedBytes} bytes]`;
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte character, and report how many bytes were dropped.
 */
export function truncateBytes(
  text: string,
  maxBytes: number,
): { text: string; droppedBytes: number } {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) return { text, droppedBytes: 0 };
  const buffer = Buffer.from(text, "utf8");
  let end = maxBytes;
  // Do not split a multi-byte sequence: back off to a codepoint boundary.
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return {
    text: buffer.subarray(0, end).toString("utf8"),
    droppedBytes: originalBytes - end,
  };
}

/**
 * Redact known secret-shaped prefixes and cap the text at `maxBytes` bytes.
 * The FINAL returned value — truncation marker included — is at most
 * `maxBytes` bytes; the marker itself states how many bytes were dropped.
 */
export function hardenText(text: string, maxBytes: number): string {
  const redacted = redactKnownSecretPrefixes(text);
  const originalBytes = Buffer.byteLength(redacted, "utf8");
  if (originalBytes <= maxBytes) return redacted;

  // Reserve room for the marker so the returned value never exceeds the cap.
  let keep = maxBytes;
  let dropped = originalBytes - keep;
  for (let i = 0; i < 8; i++) {
    const markerBytes = Buffer.byteLength(truncationMarker(dropped), "utf8");
    if (keep + markerBytes <= maxBytes) break;
    keep = Math.max(0, maxBytes - markerBytes);
    dropped = originalBytes - keep;
  }
  const { text: capped, droppedBytes } = truncateBytes(redacted, keep);
  return `${capped}${truncationMarker(droppedBytes)}`;
}

/**
 * Redact every string value inside a JSON structure (descriptions, defaults,
 * examples, enum members, ...) using the known-prefix rules, leaving ordinary
 * hashes and ids intact. Keys are structural and are left untouched.
 */
function redactSchemaStrings(value: unknown): unknown {
  if (typeof value === "string") return redactKnownSecretPrefixes(value);
  if (Array.isArray(value)) return value.map((item) => redactSchemaStrings(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSchemaStrings(item)]),
    );
  }
  return value;
}

/**
 * Return the schema object (with string values redacted) when it serializes
 * within `maxBytes`; otherwise return a structured truncation object with
 * truthful guidance. The returned value is ALWAYS a valid JSON value — never
 * a partial-JSON string advertised as a schema.
 */
export function hardenSchema(schema: unknown, maxBytes: number): unknown {
  const redacted = redactSchemaStrings(schema);
  const serialized = JSON.stringify(redacted ?? {});
  const { droppedBytes } = truncateBytes(serialized, maxBytes);
  if (droppedBytes === 0) return redacted;
  return {
    truncated: true,
    original_bytes: Buffer.byteLength(serialized, "utf8"),
    note: `This input schema exceeded the ${maxBytes}-byte response cap (${droppedBytes} bytes dropped) and is not included. Pass arguments from the upstream tool's own documentation, or ask the server owner for a slimmer schema.`,
  };
}
