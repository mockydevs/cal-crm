import { expect, it } from 'vitest';

import { createSessionStore, type KeyValue } from './storage.js';

const KEY = 'k'.repeat(32);
const NOW = Date.parse('2026-10-09T12:00:00Z');
const session = { token: 't'.repeat(43), expiresAt: '2026-11-08T12:00:00.000Z', seen: 4 };

function memory(): KeyValue & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}
const store = (storage: KeyValue, key = KEY, now = NOW) =>
  createSessionStore(
    key,
    () => storage,
    () => now,
  );

it('keeps a session under a name that carries the widget key', () => {
  const storage = memory();
  store(storage).write(session);
  expect([...storage.data.keys()]).toEqual([`crm-webchat:${KEY}`]);
  expect(store(storage).read()).toEqual(session);
});

it('keeps one widget apart from another on the same website', () => {
  const storage = memory();
  store(storage).write(session);
  expect(store(storage, 'o'.repeat(32)).read()).toBeUndefined();
});

it('forgets a session when asked', () => {
  const storage = memory();
  const sessions = store(storage);
  sessions.write(session);
  sessions.clear();
  expect(sessions.read()).toBeUndefined();
  expect(storage.data.size).toBe(0);
});

it('does not return a session past its end', () => {
  const storage = memory();
  store(storage).write(session);
  expect(store(storage, KEY, Date.parse(session.expiresAt)).read()).toBeUndefined();
  expect(store(storage, KEY, Date.parse(session.expiresAt) - 1).read()).toEqual(session);
});

it.each([
  ['not JSON', '{'],
  ['not an object', '"text"'],
  ['null', 'null'],
  ['a token of the wrong length', JSON.stringify({ ...session, token: 'short' })],
  ['a token with a line break', JSON.stringify({ ...session, token: `${'t'.repeat(42)}\n` })],
  ['a token that is not text', JSON.stringify({ ...session, token: 42 })],
  ['no end time', JSON.stringify({ token: session.token })],
  ['an end time that is no date', JSON.stringify({ ...session, expiresAt: 'never' })],
  ['more than a session could be', JSON.stringify({ ...session, padding: 'x'.repeat(2000) })],
])('reads nothing from %s', (_why, stored) => {
  const storage = memory();
  storage.data.set(`crm-webchat:${KEY}`, stored);
  expect(store(storage).read()).toBeUndefined();
});

it('starts from zero when the place seen is not a whole number', () => {
  const storage = memory();
  for (const seen of [-1, 1.5, '3', null]) {
    storage.data.set(`crm-webchat:${KEY}`, JSON.stringify({ ...session, seen }));
    expect(store(storage).read()).toEqual({ ...session, seen: 0 });
  }
});

it('works for the life of the page when the browser refuses storage', () => {
  const refusing = (): KeyValue => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  const sessions = createSessionStore(KEY, refusing, () => NOW);
  expect(sessions.read()).toBeUndefined();
  sessions.write(session);
  expect(sessions.read()).toEqual(session);
  sessions.clear();
  expect(sessions.read()).toBeUndefined();
});

it('works when storage is full, and drops a memory-only session at its end', () => {
  let now = NOW;
  const full: KeyValue = {
    getItem: () => null,
    setItem: () => {
      throw new DOMException('Quota exceeded.', 'QuotaExceededError');
    },
    removeItem: () => undefined,
  };
  const sessions = createSessionStore(
    KEY,
    () => full,
    () => now,
  );
  sessions.write(session);
  expect(sessions.read()).toEqual(session);
  now = Date.parse(session.expiresAt);
  expect(sessions.read()).toBeUndefined();
});
