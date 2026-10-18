import { describe, expect, it } from 'vitest';

import { isRecord, countAt, listAt, parseJson, recordAt, sortKeys, stringAt } from './json.js';
import { readSse, type SseEvent } from './sse.js';

async function* pieces(...texts: readonly string[]): AsyncGenerator<Uint8Array> {
  for (const text of texts) yield await Promise.resolve(new TextEncoder().encode(text));
}

async function events(...texts: readonly string[]): Promise<SseEvent[]> {
  const found: SseEvent[] = [];
  for await (const event of readSse(pieces(...texts))) found.push(event);
  return found;
}

describe('server-sent events', () => {
  it('reads named and unnamed events, whichever way their lines end', async () => {
    expect(
      await events('event: ping\ndata: {"a":1}\n\n', 'data: one\r\n\r\n', 'data: two\r\r'),
    ).toEqual([
      { event: 'ping', data: '{"a":1}' },
      { event: undefined, data: 'one' },
      { event: undefined, data: 'two' },
    ]);
  });

  it('joins the data lines of one event and skips comments and fields it has no use for', async () => {
    expect(await events(': keep-alive\nid: 7\nretry: 10\ndata: a\ndata:b\ndata\n\n')).toEqual([
      { event: undefined, data: 'a\nb\n' },
    ]);
  });

  it('puts together an event, a line ending and a character that arrive in pieces', async () => {
    const bytes = new TextEncoder().encode('data: café\r\n\r\ndata: next\n\n');
    const cut = bytes.indexOf(0xc3) + 1;
    const found: SseEvent[] = [];
    async function* split(): AsyncGenerator<Uint8Array> {
      yield await Promise.resolve(bytes.subarray(0, cut));
      // The CR of the first CRLF ends this piece; its LF starts the next.
      yield bytes.subarray(cut, cut + 2);
      yield bytes.subarray(cut + 2);
    }
    for await (const event of readSse(split())) found.push(event);
    expect(found).toEqual([
      { event: undefined, data: 'café' },
      { event: undefined, data: 'next' },
    ]);
  });

  it('drops an event the stream ended in the middle of, and an event with no data', async () => {
    expect(await events('event: lonely\n\ndata: whole\n\ndata: cut off')).toEqual([
      { event: undefined, data: 'whole' },
    ]);
  });
});

describe('reading JSON from a provider', () => {
  it('tells objects from everything else', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('text')).toBe(false);
    expect(parseJson('{"a":[1]}')).toEqual({ a: [1] });
    expect(parseJson('{"a":')).toBeUndefined();
  });

  it('reads a field only when it is what was asked for', () => {
    const value = { name: 'x', count: 3, minus: -1, part: 1.5, big: 2 ** 60, list: [1], inner: {} };
    expect(stringAt(value, 'name')).toBe('x');
    expect(stringAt(value, 'count')).toBeUndefined();
    expect(stringAt('text', 'length')).toBeUndefined();
    expect(countAt(value, 'count')).toBe(3);
    expect(countAt(value, 'minus')).toBeUndefined();
    expect(countAt(value, 'part')).toBeUndefined();
    expect(countAt(value, 'big')).toBeUndefined();
    expect(countAt(value, 'name')).toBeUndefined();
    expect(countAt(null, 'count')).toBeUndefined();
    expect(listAt(value, 'list')).toEqual([1]);
    expect(listAt(value, 'inner')).toBeUndefined();
    expect(listAt(7, 'list')).toBeUndefined();
    expect(recordAt(value, 'inner')).toEqual({});
    expect(recordAt(value, 'list')).toBeUndefined();
    expect(recordAt(undefined, 'inner')).toBeUndefined();
  });

  it('writes the same value as the same bytes, whatever order its keys came in', () => {
    const one = { b: [{ d: 1, c: 2 }], a: 'x' };
    const other = { a: 'x', b: [{ c: 2, d: 1 }] };
    expect(JSON.stringify(sortKeys(one))).toBe('{"a":"x","b":[{"c":2,"d":1}]}');
    expect(JSON.stringify(sortKeys(other))).toBe(JSON.stringify(sortKeys(one)));
    expect(sortKeys(null)).toBeNull();
    expect(sortKeys('text')).toBe('text');
  });
});
