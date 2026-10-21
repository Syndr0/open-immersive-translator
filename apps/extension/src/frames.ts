interface SessionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Frame ownership survives MV3 worker suspension, but is discarded with the browser session. */
export class FrameRegistry {
  private memory = new Map<number, number[]>();
  constructor(private storage: SessionStorage) {}
  private key(tabId: number): string { return `oit:frames:${tabId}`; }
  async remember(tabId: number, frameIds: number[]): Promise<void> {
    const unique = [...new Set(frameIds)];
    this.memory.set(tabId, unique);
    await this.storage.set({ [this.key(tabId)]: unique });
  }
  async get(tabId: number): Promise<number[]> {
    const existing = this.memory.get(tabId);
    if (existing) return existing;
    const stored = (await this.storage.get(this.key(tabId)))[this.key(tabId)];
    const frameIds = Array.isArray(stored) ? stored.filter((id): id is number => Number.isInteger(id) && Number(id) >= 0) : [];
    const value = frameIds.length ? frameIds : [0];
    this.memory.set(tabId, value);
    return value;
  }
  async forget(tabId: number): Promise<void> {
    this.memory.delete(tabId);
    await this.storage.remove(this.key(tabId));
  }
}
