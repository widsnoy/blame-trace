// Shared requests outlive individual cursor subscriptions. Clearing the service
// aborts its controller, so an old authentication generation cannot refill it.
export class SquashCache {
  private readonly entries = new Map<string, { expires: number; bytes: number; value: unknown }>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private generation = 0;

  async get<T>(key: string, load: () => Promise<T>, ttl: (value: T) => number = () => 600_000): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > Date.now()) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value as T;
    }
    this.entries.delete(key);
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const generation = this.generation;
    const promise = load().then(value => {
      if (generation === this.generation) {
        const bytes = Buffer.isBuffer(value) ? value.length : Buffer.byteLength(JSON.stringify(value) ?? '');
        this.entries.set(key, { value, bytes, expires: Date.now() + ttl(value) });
        let size = [...this.entries.values()].reduce((sum, item) => sum + item.bytes, 0);
        while (this.entries.size > 128 || size > 16 * 1024 * 1024) {
          const oldest = this.entries.keys().next().value!;
          size -= this.entries.get(oldest)!.bytes;
          this.entries.delete(oldest);
        }
      }
      return value;
    }).finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); });
    this.pending.set(key, promise);
    return promise;
  }

  clear(): void { this.generation++; this.entries.clear(); this.pending.clear(); }
}
