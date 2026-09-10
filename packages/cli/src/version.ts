/**
 * The single source of truth for the CLI version string.
 *
 * It must stay in lockstep with `packages/cli/package.json`. Reading the
 * manifest at runtime is unreliable once the CLI is bundled into a standalone
 * single-file executable (there is no `package.json` on disk next to the
 * binary), so the value is inlined here and a unit test asserts the two match.
 */
export const VERSION = "0.1.0";
