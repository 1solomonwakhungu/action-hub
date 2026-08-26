import type { ActionRecord, ActionKind, TrustTier } from "../types.js";

/**
 * In-memory index of every known action.
 *
 * The catalog deliberately stores full schemas but exposes them only through
 * `get`. Search operates on a lightweight projection so that returning a
 * hundred results stays cheap.
 */
export class Catalog {
  readonly #byId = new Map<string, ActionRecord>();
  readonly #byServer = new Map<string, Set<string>>();

  static actionId(serverId: string, name: string): string {
    return `${serverId}:${name}`;
  }

  add(record: ActionRecord): void {
    this.#byId.set(record.id, record);
    let ids = this.#byServer.get(record.serverId);
    if (!ids) {
      ids = new Set();
      this.#byServer.set(record.serverId, ids);
    }
    ids.add(record.id);
  }

  addAll(records: readonly ActionRecord[]): void {
    for (const record of records) this.add(record);
  }

  get(id: string): ActionRecord | undefined {
    return this.#byId.get(id);
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  /** Drops every action belonging to a server. Used when reindexing. */
  removeServer(serverId: string): number {
    const ids = this.#byServer.get(serverId);
    if (!ids) return 0;
    for (const id of ids) this.#byId.delete(id);
    this.#byServer.delete(serverId);
    return ids.size;
  }

  listByServer(serverId: string): ActionRecord[] {
    const ids = this.#byServer.get(serverId);
    if (!ids) return [];
    const out: ActionRecord[] = [];
    for (const id of ids) {
      const record = this.#byId.get(id);
      if (record) out.push(record);
    }
    return out;
  }

  all(): ActionRecord[] {
    return [...this.#byId.values()];
  }

  get size(): number {
    return this.#byId.size;
  }

  countByServer(serverId: string): number {
    return this.#byServer.get(serverId)?.size ?? 0;
  }

  serverIds(): string[] {
    return [...this.#byServer.keys()];
  }

  /** Filtered view used by the search layer before ranking. */
  filter(options: {
    serverIds?: string[];
    kind?: ActionKind;
    minTrust?: TrustTier;
  }): ActionRecord[] {
    const allowed = options.serverIds ? new Set(options.serverIds) : undefined;
    const floor = options.minTrust ? trustRank(options.minTrust) : undefined;

    return this.all().filter((record) => {
      if (allowed && !allowed.has(record.serverId)) return false;
      if (options.kind && record.kind !== options.kind) return false;
      if (floor !== undefined && trustRank(record.trust) < floor) return false;
      return true;
    });
  }
}

const TRUST_RANK: Record<TrustTier, number> = {
  blocked: 0,
  untrusted: 1,
  trusted: 2,
};

export function trustRank(tier: TrustTier): number {
  return TRUST_RANK[tier];
}
