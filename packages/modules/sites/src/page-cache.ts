// What a server process keeps of the pages it rendered, so a visit to a page that has not
// changed renders nothing. A map with two bounds, how many and how large, that forgets what
// was used longest ago first. It lives in one process and is empty when the process starts:
// nothing here outlives a release, so a newer renderer never serves an older one's page.
//
// It holds values and knows nothing about pages: whether a kept page is still the page is
// decided by whoever reads it (public.ts), against the database, on every request.

export interface PageCacheLimits {
  /** The most values kept. Zero keeps none. */
  readonly maxEntries: number;
  /** The most bytes kept, as each value's own size says. Zero keeps none. */
  readonly maxBytes: number;
}

/** A process that serves pages keeps this many at most, and no more than this many bytes. */
export const DEFAULT_PAGE_CACHE: PageCacheLimits = { maxEntries: 500, maxBytes: 64 * 1024 * 1024 };

export class PageCache<Value> {
  readonly #limits: PageCacheLimits;
  // A Map lists its keys in the order they were set: the first is the one used longest ago.
  readonly #kept = new Map<string, { readonly value: Value; readonly bytes: number }>();
  #bytes = 0;

  constructor(limits: PageCacheLimits = DEFAULT_PAGE_CACHE) {
    for (const bound of [limits.maxEntries, limits.maxBytes])
      if (!Number.isSafeInteger(bound) || bound < 0)
        throw new Error('A page cache is bounded by whole numbers that are not negative.');
    this.#limits = limits;
  }

  /** How many values are kept, and their bytes together. */
  get size(): { readonly entries: number; readonly bytes: number } {
    return { entries: this.#kept.size, bytes: this.#bytes };
  }

  /** The value kept under the key, which is now the one used last. */
  get(key: string): Value | undefined {
    const found = this.#kept.get(key);
    if (found === undefined) return undefined;
    this.#kept.delete(key);
    this.#kept.set(key, found);
    return found.value;
  }

  delete(key: string): void {
    const found = this.#kept.get(key);
    if (found === undefined) return;
    this.#kept.delete(key);
    this.#bytes -= found.bytes;
  }

  /**
   * Keeps the value in place of whatever the key held, then forgets from the oldest until
   * both bounds hold. A value larger than the whole allowance is not kept at all.
   */
  set(key: string, value: Value, bytes: number): void {
    this.delete(key);
    if (!Number.isSafeInteger(bytes) || bytes < 0) return;
    if (this.#limits.maxEntries === 0 || bytes > this.#limits.maxBytes) return;
    this.#kept.set(key, { value, bytes });
    this.#bytes += bytes;
    for (const oldest of this.#kept.keys()) {
      if (this.#kept.size <= this.#limits.maxEntries && this.#bytes <= this.#limits.maxBytes) break;
      this.delete(oldest);
    }
  }
}
