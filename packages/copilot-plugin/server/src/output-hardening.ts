import { redactKnownSecretPrefixes } from "@action-hub/core";

/**
 * Output hardening for the action_hub tool (stress findings F1/F2).
 *
 * All limits live here so the response formatting layer stays declarative.
 * These caps apply ONLY to what the action_hub tool returns — nothing about
 * what gets indexed changes.
 */

/** Maximum bytes of any search-result summary returned to the model. */
export const SEARCH_SUMMARY_MAX_BYTES = 300;
/** Maximum bytes of a (tool) description returned by load. */
export const LOAD_DESCRIPTION_MAX_BYTES = 8 * 1024;
/** Maximum bytes of the serialized inputSchema returned by load. */
export const LOAD_SCHEMA_MAX_BYTES = 32 * 1024;
/** Maximum bytes of skill instructions returned by load. */
export const SKILL_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

const TRUNCATION_MARKER = "…[truncated by action_hub: dropped %d bytes]";

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
 * Redact known secret-shaped prefixes and cap the text at `maxBytes` bytes,
 * appending an explicit marker that says how many bytes were dropped.
 */
export function hardenText(text: string, maxBytes: number): string {
  const redacted = redactKnownSecretPrefixes(text);
  const { text: capped, droppedBytes } = truncateBytes(redacted, maxBytes);
  if (droppedBytes === 0) return capped;
  return `${capped}${TRUNCATION_MARKER.replace("%d", String(droppedBytes))}`;
}

/**
 * Return the schema object when it serializes within `maxBytes`; otherwise
 * return the truncated JSON string with an explicit dropped-bytes marker.
 */
export function hardenSchema(
  schema: unknown,
  maxBytes: number,
): unknown {
  const serialized = JSON.stringify(schema ?? {});
  const { text: capped, droppedBytes } = truncateBytes(serialized, maxBytes);
  if (droppedBytes === 0) return schema;
  return `${capped}${TRUNCATION_MARKER.replace("%d", String(droppedBytes))}`;
}
