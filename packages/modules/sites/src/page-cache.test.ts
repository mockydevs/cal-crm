import { describe, expect, it } from 'vitest';

import { DEFAULT_PAGE_CACHE, PageCache } from './page-cache.js';

describe('PageCache', () => {
  it('keeps a value under its key until it is deleted or replaced', () => {
    const cache = new PageCache<string>({ maxEntries: 10, maxBytes: 100 });
    expect(cache.get('a')).toBeUndefined();
    cache.set('a', 'one', 3);
    cache.set('b', 'two', 4);
    expect(cache.get('a')).toBe('one');
    expect(cache.size).toEqual({ entries: 2, bytes: 7 });
    cache.set('a', 'uno', 10);
    expect(cache.get('a')).toBe('uno');
    expect(cache.size).toEqual({ entries: 2, bytes: 14 });
    cache.delete('a');
    cache.delete('never there');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toEqual({ entries: 1, bytes: 4 });
  });

  it('forgets the value used longest ago when there are too many', () => {
    const cache = new PageCache<number>({ maxEntries: 2, maxBytes: 1000 });
    cache.set('a', 1, 1);
    cache.set('b', 2, 1);
    // Reading a makes b the one used longest ago.
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3, 1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toEqual({ entries: 2, bytes: 2 });
  });

  it('forgets from the oldest until the bytes fit, and never keeps what cannot fit', () => {
    const cache = new PageCache<string>({ maxEntries: 100, maxBytes: 10 });
    cache.set('a', 'a', 4);
    cache.set('b', 'b', 4);
    cache.set('c', 'c', 6);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('b');
    expect(cache.get('c')).toBe('c');
    expect(cache.size).toEqual({ entries: 2, bytes: 10 });
    // Larger than everything allowed: not kept, and what the key held is gone too.
    cache.set('c', 'huge', 11);
    expect(cache.get('c')).toBeUndefined();
    expect(cache.size).toEqual({ entries: 1, bytes: 4 });
    cache.set('d', 'odd', Number.NaN);
    cache.set('e', 'odd', -1);
    expect(cache.size.entries).toBe(1);
  });

  it('keeps nothing when it is given no room', () => {
    for (const limits of [
      { maxEntries: 0, maxBytes: 100 },
      { maxEntries: 100, maxBytes: 0 },
    ]) {
      const cache = new PageCache<string>(limits);
      cache.set('a', 'a', 1);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.size).toEqual({ entries: 0, bytes: 0 });
    }
    // A value of no size at all fits in no bytes; it is still one entry too many of none.
    expect(new PageCache<string>({ maxEntries: 0, maxBytes: 0 }).size.entries).toBe(0);
  });

  it('is bounded by default, and refuses bounds that are not whole numbers', () => {
    expect(DEFAULT_PAGE_CACHE).toEqual({ maxEntries: 500, maxBytes: 64 * 1024 * 1024 });
    expect(new PageCache<string>().size).toEqual({ entries: 0, bytes: 0 });
    expect(() => new PageCache({ maxEntries: -1, maxBytes: 1 })).toThrow(/bounded/);
    expect(() => new PageCache({ maxEntries: 1, maxBytes: 1.5 })).toThrow(/bounded/);
  });
});
