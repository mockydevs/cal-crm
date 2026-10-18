// @vitest-environment jsdom
import { EMPTY_PAGE_DOCUMENT } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { smallPage } from './fixtures';
import {
  browserStorage,
  clearDraft,
  draftKey,
  isRestorable,
  readDraft,
  sameDocument,
  writeDraft,
  type DraftStorage,
  type LocalDraft,
} from './local-draft';

function memory(): DraftStorage & { readonly kept: Map<string, string> } {
  const kept = new Map<string, string>();
  return {
    kept,
    getItem: (key) => kept.get(key) ?? null,
    setItem: (key, value) => {
      kept.set(key, value);
    },
    removeItem: (key) => {
      kept.delete(key);
    },
  };
}
const refusing: DraftStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('quota');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

const key = draftKey('biz_1', 'spg_1');
const draft: LocalDraft = {
  baseVersion: 3,
  savedAt: '2026-10-12T10:00:00.000Z',
  document: smallPage,
};

describe('a draft kept in the browser', () => {
  it('is kept per business and page, and read back as it was written', () => {
    expect(key).toBe('crm.site-draft.biz_1.spg_1');
    expect(draftKey('biz_2', 'spg_1')).not.toBe(key);
    const storage = memory();
    expect(writeDraft(storage, key, draft)).toBe(true);
    expect(readDraft(storage, key)).toStrictEqual(draft);
    clearDraft(storage, key);
    expect(readDraft(storage, key)).toBeNull();
    expect(storage.kept.size).toBe(0);
  });

  it('changes nothing else when the browser refuses storage', () => {
    expect(writeDraft(refusing, key, draft)).toBe(false);
    expect(readDraft(refusing, key)).toBeNull();
    expect(() => {
      clearDraft(refusing, key);
    }).not.toThrow();
    expect(writeDraft(null, key, draft)).toBe(false);
    expect(readDraft(null, key)).toBeNull();
    expect(() => {
      clearDraft(null, key);
    }).not.toThrow();
  });

  it('reads nothing from what is not a draft of this editor', () => {
    const storage = memory();
    const kept = (value: unknown): LocalDraft | null => {
      storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      return readDraft(storage, key);
    };
    expect(kept('not json')).toBeNull();
    expect(kept(null)).toBeNull();
    expect(kept([draft])).toBeNull();
    expect(kept({ ...draft, baseVersion: 0 })).toBeNull();
    expect(kept({ ...draft, baseVersion: 1.5 })).toBeNull();
    expect(kept({ ...draft, baseVersion: '3' })).toBeNull();
    expect(kept({ ...draft, savedAt: 'yesterday' })).toBeNull();
    expect(kept({ ...draft, savedAt: 5 })).toBeNull();
    expect(kept({ ...draft, document: null })).toBeNull();
    expect(kept({ ...draft, document: { mode: 'code', files: [] } })).toBeNull();
    expect(kept({ ...draft, document: { mode: 'visual', sections: [] } })).toBeNull();
    expect(kept({ ...draft, document: { mode: 'visual', sections: {}, popups: [] } })).toBeNull();
    expect(kept(draft)).toStrictEqual(draft);
  });

  it('finds the browser’s own storage', () => {
    expect(browserStorage()).toBe(window.localStorage);
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('denied');
      },
    });
    try {
      expect(browserStorage()).toBeNull();
    } finally {
      if (real !== undefined) Object.defineProperty(window, 'localStorage', real);
    }
  });
});

describe('sameDocument', () => {
  it('compares what two documents say, whatever order their keys are in', () => {
    expect(sameDocument({ a: 1, b: [{ c: 2, d: 3 }] }, { b: [{ d: 3, c: 2 }], a: 1 })).toBe(true);
    expect(sameDocument({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(sameDocument({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameDocument([1, 2], [2, 1])).toBe(false);
    expect(sameDocument(undefined, null)).toBe(true);
    expect(sameDocument('a', 'a')).toBe(true);
    expect(sameDocument(smallPage, structuredClone(smallPage))).toBe(true);
    expect(sameDocument(smallPage, EMPTY_PAGE_DOCUMENT)).toBe(false);
  });
});

describe('isRestorable', () => {
  const server = {
    currentVersion: 3,
    updatedAt: '2026-10-12T09:00:00.000Z',
    document: EMPTY_PAGE_DOCUMENT,
  };

  it('offers nothing when nothing was kept, or what was kept is what the server holds', () => {
    expect(isRestorable(null, server)).toBe(false);
    expect(isRestorable({ ...draft, document: EMPTY_PAGE_DOCUMENT }, server)).toBe(false);
    expect(isRestorable(draft, { ...server, document: structuredClone(smallPage) })).toBe(false);
  });

  it('offers back a draft made on the version the server still has', () => {
    expect(isRestorable(draft, server)).toBe(true);
    // Whatever the clocks say: it was made on the newest version, so it is newer.
    expect(isRestorable({ ...draft, savedAt: '2020-01-01T00:00:00.000Z' }, server)).toBe(true);
  });

  it('offers a draft made on an older version only if it was written after the server’s', () => {
    const moved = { ...server, currentVersion: 5, updatedAt: '2026-10-12T09:30:00.000Z' };
    expect(isRestorable(draft, moved)).toBe(true);
    expect(isRestorable({ ...draft, savedAt: '2026-10-12T09:00:00.000Z' }, moved)).toBe(false);
    expect(isRestorable({ ...draft, savedAt: moved.updatedAt }, moved)).toBe(false);
  });

  it('offers nothing that names a version the server never had', () => {
    expect(isRestorable({ ...draft, baseVersion: 9 }, server)).toBe(false);
  });
});
