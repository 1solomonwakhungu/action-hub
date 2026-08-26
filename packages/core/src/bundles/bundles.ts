import type { SearchOptions } from "../types.js";

/**
 * A named capability set scoped to a task or repository.
 *
 * Bundles narrow search to a relevant subset — for example, a "release" bundle
 * exposing only GitHub and Slack — which improves ranking precision without
 * disconnecting anything.
 */
export interface Bundle {
  id: string;
  displayName: string;
  description?: string;
  serverIds: string[];
}

export class BundleRegistry {
  readonly #bundles = new Map<string, Bundle>();
  #active?: string;

  constructor(bundles: readonly Bundle[] = []) {
    for (const bundle of bundles) this.#bundles.set(bundle.id, bundle);
  }

  add(bundle: Bundle): void {
    this.#bundles.set(bundle.id, bundle);
  }

  get(id: string): Bundle | undefined {
    return this.#bundles.get(id);
  }

  list(): Bundle[] {
    return [...this.#bundles.values()];
  }

  /** Passing undefined clears the scope and restores full-catalog search. */
  activate(id: string | undefined): void {
    if (id !== undefined && !this.#bundles.has(id)) {
      throw new Error(`Unknown bundle "${id}"`);
    }
    this.#active = id;
  }

  activeBundle(): Bundle | undefined {
    return this.#active ? this.#bundles.get(this.#active) : undefined;
  }

  /** Applies the active bundle's server scope unless the caller set its own. */
  applyScope(options: SearchOptions = {}): SearchOptions {
    const bundle = this.activeBundle();
    if (!bundle || options.serverIds) return options;
    return { ...options, serverIds: bundle.serverIds };
  }
}
