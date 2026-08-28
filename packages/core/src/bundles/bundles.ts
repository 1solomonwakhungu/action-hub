import type { ActionRecord, SearchOptions } from "../types.js";
import type { Catalog } from "../catalog/catalog.js";

/**
 * A named capability set scoped to a task, workflow, or repository.
 *
 * Bundles can specify constituent `serverIds` (all tools from those servers),
 * specific `actionIds` (individual curated actions across servers), or both.
 */
export interface Bundle {
  id: string;
  displayName: string;
  description?: string;
  serverIds?: string[];
  actionIds?: string[];
  tags?: string[];
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
    if (!bundle || options.serverIds || !bundle.serverIds || bundle.serverIds.length === 0) {
      return options;
    }
    return { ...options, serverIds: bundle.serverIds };
  }

  /** Resolves all action records belonging to a bundle from a catalog. */
  resolveActions(bundleId: string, catalog: Catalog): ActionRecord[] {
    const bundle = this.#bundles.get(bundleId);
    if (!bundle) throw new Error(`Unknown bundle "${bundleId}"`);

    const result = new Map<string, ActionRecord>();

    if (bundle.serverIds && bundle.serverIds.length > 0) {
      for (const serverId of bundle.serverIds) {
        for (const action of catalog.listByServer(serverId)) {
          result.set(action.id, action);
        }
      }
    }

    if (bundle.actionIds && bundle.actionIds.length > 0) {
      for (const actionId of bundle.actionIds) {
        const action = catalog.get(actionId);
        if (action) {
          result.set(action.id, action);
        }
      }
    }

    return [...result.values()];
  }

  /** Simple search across bundle names, descriptions, and tags. */
  search(query: string): Bundle[] {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return this.list();

    return this.list().filter((bundle) => {
      const text = `${bundle.id} ${bundle.displayName} ${bundle.description ?? ""} ${(bundle.tags ?? []).join(" ")}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }
}
