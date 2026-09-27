import { ActionHub } from "@action-hub/core";

/**
 * F68: unit-test hub factory for cli tests — same rationale as
 * packages/core/test/test-hub.ts (background WASM rebuilds starve timers).
 */
export function testActionHub(
  options: Partial<ConstructorParameters<typeof ActionHub>[0]>,
): ActionHub {
  return new ActionHub({ embeddings: null, ...options });
}
