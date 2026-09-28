import { ActionHub } from "../dist/action-hub.js";

/**
 * F68: unit-test hub factory. Embeddings default to OFF — the SQ4 default
 * loads the WASM model and kicks a fire-and-forget background rebuild per
 * hub, which under a full parallel suite starves timers (it flipped the
 * execute-timeout race: expected false, got true). Tests that deliberately
 * exercise the embedding pipeline (embeddings.test.ts, index-yield.test.ts)
 * construct ActionHub directly instead of going through this factory.
 */
export function testActionHub(
  options: Partial<ConstructorParameters<typeof ActionHub>[0]>,
): ActionHub {
  return new ActionHub({ embeddings: null, ...options });
}
