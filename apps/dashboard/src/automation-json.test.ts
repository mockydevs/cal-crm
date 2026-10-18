import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH, pointerParts, positionOf, readJson, spanOf } from './automation-json';

const valid = [
  '{}',
  '[]',
  ' { "a" : [ 1 , -2.5e3 , 0 , 1E+2 , "x\\n\\u00e9\\"" , true , false , null ] } ',
  '{"a":{"b":{"c":[[],{}]}},"d":"","e":-0}',
  '"just text"',
  '12',
  'null',
  '{"a":1,"a":2}',
];

const invalid = [
  '',
  '   ',
  '{',
  '{"a":}',
  '{"a" 1}',
  '{"a":1,}',
  '[1,]',
  "{'a':1}",
  '{a:1}',
  '01',
  '1.',
  '-',
  '"abc',
  '"tab\there"',
  '"bad \\x escape"',
  '{"a":1}x',
  'nul',
  'undefined',
  '[1 2]',
];

describe('readJson', () => {
  it.each(valid)('reads %s as JSON.parse does', (text) => {
    const read = readJson(text);
    expect(read.ok).toBe(true);
    expect(read.ok && read.value).toEqual(JSON.parse(text));
  });

  it.each(invalid)('refuses %j, as JSON.parse does', (text) => {
    expect(() => JSON.parse(text) as unknown).toThrow();
    expect(readJson(text).ok).toBe(false);
  });

  it('says where the text goes wrong, by line and column', () => {
    const read = readJson('{\n  "name": "Follow-up",\n  "steps": ,\n}');
    expect(read).toEqual({
      ok: false,
      problem: { kind: 'unexpected', offset: 36, line: 3, column: 12, found: ',' },
    });
  });

  it('points at the character inside a string that does not belong', () => {
    const tab = readJson('{"a": "one\ttwo"}');
    expect(!tab.ok && tab.problem).toMatchObject({ kind: 'unexpected', column: 11, found: '\t' });
    const escape = readJson('["fine", "bad \\x escape"]');
    expect(!escape.ok && escape.problem).toMatchObject({ kind: 'unexpected', column: 15 });
    const open = readJson('{"a": "never closed}');
    expect(!open.ok && open.problem).toMatchObject({ kind: 'ended_early', column: 21 });
  });

  it('tells text that stops early from text with something extra', () => {
    const early = readJson('{"a": [1, 2');
    expect(!early.ok && early.problem).toMatchObject({ kind: 'ended_early', line: 1, column: 12 });
    const extra = readJson('{"a": 1}\n}');
    expect(!extra.ok && extra.problem).toMatchObject({ kind: 'extra_text', line: 2, column: 1 });
    const empty = readJson(' \n ');
    expect(!empty.ok && empty.problem.kind).toBe('empty');
  });

  it('refuses text nested deeper than any automation rather than overflowing', () => {
    const deep = '['.repeat(MAX_JSON_DEPTH + 2) + ']'.repeat(MAX_JSON_DEPTH + 2);
    const read = readJson(deep);
    expect(!read.ok && read.problem.kind).toBe('too_deep');
    const fine = '['.repeat(MAX_JSON_DEPTH) + ']'.repeat(MAX_JSON_DEPTH);
    expect(readJson(fine).ok).toBe(true);
  });

  it('keeps a member named __proto__ as a member', () => {
    const read = readJson('{"__proto__": {"polluted": true}}');
    expect(read.ok && Object.keys(read.value as object)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('knows where each value is in the text', () => {
    const text = '{\n  "steps": {\n    "a/b": { "type": "wait" },\n    "list": [10, 20]\n  }\n}';
    const read = readJson(text);
    if (!read.ok) throw new Error('The text is valid.');
    const slice = (pointer: string): string | undefined => {
      const span = read.spans.get(pointer);
      return span === undefined ? undefined : text.slice(span.start, span.end);
    };
    expect(slice('')).toBe(text);
    expect(slice('/steps/a~1b')).toBe('{ "type": "wait" }');
    expect(slice('/steps/a~1b/type')).toBe('"wait"');
    expect(slice('/steps/list/1')).toBe('20');
  });
});

describe('spanOf', () => {
  it('points at the nearest thing that is there', () => {
    const text = '{"steps": {"a": {"config": {}}}}';
    const read = readJson(text);
    if (!read.ok) throw new Error('The text is valid.');
    const config = read.spans.get('/steps/a/config');
    expect(spanOf(read.spans, '/steps/a/config/tag')).toEqual(config);
    expect(spanOf(read.spans, '/nothing/here')).toEqual({ start: 0, end: text.length });
  });
});

describe('positions and pointers', () => {
  it('counts lines and columns from 1', () => {
    expect(positionOf('ab\ncd', 0)).toEqual({ line: 1, column: 1 });
    expect(positionOf('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
  });

  it('unescapes a pointer', () => {
    expect(pointerParts('/steps/a~1b/c~0d')).toEqual(['steps', 'a/b', 'c~d']);
    expect(pointerParts('')).toEqual([]);
  });
});
