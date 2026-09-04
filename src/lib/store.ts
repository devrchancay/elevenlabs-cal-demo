/**
 * In-memory store with expiry. Good enough for a single-instance MVP.
 *
 * It holds two things:
 *  · the options offered to a conversation, so that booking only needs an
 *    `optionId` and never a timestamp built by the model;
 *  · the result of each booking keyed by `bookingKey`, which is what makes a
 *    second call to /tools/book return the existing appointment instead of
 *    creating another one.
 *
 * Once there is more than one instance this gets swapped for Redis and nothing
 * else changes: the interface is the same.
 */

export interface TtlStoreOptions {
  ttlMs: number;
  /** Injectable for tests: nothing here depends on the real clock. */
  now?: () => number;
  /** Cap on live entries, so a burst cannot consume memory without bound. */
  maxEntries?: number;
}

export interface TtlStore<T> {
  set(key: string, value: T): void;
  get(key: string): T | undefined;
  has(key: string): boolean;
  delete(key: string): void;
  /** Number of entries that have not expired. */
  size(): number;
  purge(): void;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export function createTtlStore<T>(options: TtlStoreOptions): TtlStore<T> {
  const now = options.now ?? (() => Date.now());
  const maxEntries = options.maxEntries ?? 5_000;
  const entries = new Map<string, Entry<T>>();

  function purge(): void {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(key);
    }
  }

  return {
    set(key, value) {
      if (entries.size >= maxEntries) {
        purge();
        if (entries.size >= maxEntries) {
          // Map preserves insertion order, so the oldest entry goes first.
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
      }
      entries.set(key, { value, expiresAt: now() + options.ttlMs });
    },

    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },

    has(key) {
      return this.get(key) !== undefined;
    },

    delete(key) {
      entries.delete(key);
    },

    size() {
      purge();
      return entries.size;
    },

    purge,
  };
}
