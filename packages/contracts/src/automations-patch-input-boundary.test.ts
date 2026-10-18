// JSON Patch (RFC 6902) and JSON Pointer (RFC 6901) at their input boundaries: the RFC 6901
// section 5 examples, escaped and empty tokens, array index edges, JSON equality across types,
// hostile unknown input, and that a refused patch leaves nothing changed.
import { describe, expect, it } from 'vitest';

import {
  applyJsonPatch,
  diffJson,
  MAX_PATCH_OPERATIONS,
  type JsonValue,
  type PatchError,
  type PatchOptions,
} from './automations-patch.js';

const ok = (document: unknown, patch: unknown, options?: PatchOptions) => {
  const result = applyJsonPatch(document, patch, options);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.document;
};
const failed = (document: unknown, patch: unknown, options?: PatchOptions) => {
  const result = applyJsonPatch(document, patch, options);
  if (result.ok) throw new Error('The patch applied.');
  return result.error;
};

describe('RFC 6901 pointers', () => {
  // RFC 6901 section 5, transcribed.
  const example = {
    foo: ['bar', 'baz'],
    '': 0,
    'a/b': 1,
    'c%d': 2,
    'e^f': 3,
    'g|h': 4,
    'i\\j': 5,
    'k"l': 6,
    ' ': 7,
    'm~n': 8,
  };

  it('resolves every section 5 example to its value', () => {
    const tests: [string, JsonValue][] = [
      ['', example],
      ['/foo', ['bar', 'baz']],
      ['/foo/0', 'bar'],
      ['/', 0],
      ['/a~1b', 1],
      ['/c%d', 2],
      ['/e^f', 3],
      ['/g|h', 4],
      ['/i\\j', 5],
      ['/k"l', 6],
      ['/ ', 7],
      ['/m~0n', 8],
    ];
    expect(
      ok(
        example,
        tests.map(([path, value]) => ({ op: 'test', path, value })),
      ),
    ).toEqual(example);
  });

  it.each([
    ['/~10', { '/0': 'slash zero' }, 'slash zero'],
    ['/~0~1', { '~/': 'tilde slash' }, 'tilde slash'],
    ['//', { '': { '': 'empty in empty' } }, 'empty in empty'],
    ['/0', { '0': 'member zero' }, 'member zero'],
    ['/-', { '-': 'member dash' }, 'member dash'],
  ])('reads %s by its decoded member name', (path, document, value) => {
    expect(ok(document, [{ op: 'test', path, value }])).toEqual(document);
  });

  it('does not decode a pointer twice or treat it as a nested path', () => {
    expect(failed({ 'a/b': 1 }, [{ op: 'test', path: '/a/b', value: 1 }])).toMatchObject({
      code: 'path_not_found',
    });
    expect(failed({ '0': 'a' }, [{ op: 'test', path: '/00', value: 'a' }])).toMatchObject({
      code: 'path_not_found',
    });
  });

  it('writes to escaped member names without creating nested members', () => {
    expect(ok({}, [{ op: 'add', path: '/x~1y', value: 1 }])).toEqual({ 'x/y': 1 });
    expect(ok({ 'a/b': 1 }, [{ op: 'move', from: '/a~1b', path: '/c~0d' }])).toEqual({
      'c~d': 1,
    });
    expect(ok({}, [{ op: 'add', path: '/-', value: 'dash' }])).toEqual({ '-': 'dash' });
  });

  it.each(['#/a', '/~', '/a~', '/~~0', '/a/~b'])('refuses the malformed pointer %j', (path) => {
    expect(failed({ a: {} }, [{ op: 'add', path, value: 1 }])).toMatchObject({
      index: 0,
      code: 'invalid_pointer',
    });
  });

  it('refuses a malformed from pointer', () => {
    expect(failed({ a: 1 }, [{ op: 'copy', from: 'a', path: '/b' }])).toMatchObject({
      code: 'invalid_pointer',
    });
  });
});

describe('array and scalar boundaries', () => {
  const document = { arr: [1, 2] };

  it('adds at the index equal to the length, which appends', () => {
    expect(ok(document, [{ op: 'add', path: '/arr/2', value: 3 }])).toEqual({ arr: [1, 2, 3] });
    expect(ok({ arr: [] }, [{ op: 'add', path: '/arr/0', value: 'first' }])).toEqual({
      arr: ['first'],
    });
  });

  it.each([
    { op: 'replace', path: '/arr/2', value: 3 },
    { op: 'remove', path: '/arr/2' },
    { op: 'test', path: '/arr/2', value: null },
    { op: 'replace', path: '/arr/-', value: 3 },
    { op: 'test', path: '/arr/-', value: 2 },
    { op: 'copy', from: '/arr/-', path: '/x' },
  ])('refuses %j, which names the element past the end', (operation) => {
    expect(failed(document, [operation])).toMatchObject({ index: 0, code: 'path_not_found' });
  });

  it.each(['-1', '+1', '1.0', '1e0', ' 1', '1 ', '0x1', 'one', ''])(
    'refuses %j as an array index',
    (token) => {
      expect(failed(document, [{ op: 'add', path: `/arr/${token}`, value: 0 }])).toMatchObject({
        code: 'invalid_index',
      });
    },
  );

  it('refuses an index far past the end without growing the array', () => {
    expect(
      failed(document, [{ op: 'add', path: '/arr/99999999999999999999', value: 0 }]),
    ).toMatchObject({ code: 'index_out_of_range' });
  });

  it.each([
    ['a string', { s: 'abc' }, { op: 'test', path: '/s/0', value: 'a' }],
    ['a number', { n: 1 }, { op: 'add', path: '/n/x', value: 1 }],
    ['null', { z: null }, { op: 'add', path: '/z/x', value: 1 }],
    ['a boolean', { t: true }, { op: 'remove', path: '/t/x' }],
  ])('never reaches inside %s', (_, scalar, operation) => {
    expect(failed(scalar, [operation])).toMatchObject({ code: 'path_not_found' });
  });

  it('applies operations in order, so indexes shift between them', () => {
    expect(
      ok({ arr: ['a', 'b', 'c'] }, [
        { op: 'remove', path: '/arr/0' },
        { op: 'remove', path: '/arr/0' },
      ]),
    ).toEqual({ arr: ['c'] });
    expect(ok({ arr: [1, 2, 3] }, [{ op: 'move', from: '/arr/0', path: '/arr/-' }])).toEqual({
      arr: [2, 3, 1],
    });
  });

  it('moves a value onto its own location as a no-op', () => {
    expect(ok({ a: 1, b: 2 }, [{ op: 'move', from: '/a', path: '/a' }])).toEqual({ a: 1, b: 2 });
  });

  it('judges a move into a child token by token, not by string prefix', () => {
    expect(ok({ a: 1, ab: {} }, [{ op: 'move', from: '/a', path: '/ab/c' }])).toEqual({
      ab: { c: 1 },
    });
  });

  it('copies a value into its own child as a copy, never a cycle', () => {
    const result = ok({ a: { k: 1 } }, [{ op: 'copy', from: '/a', path: '/a/self' }]);
    expect(JSON.stringify(result)).toBe('{"a":{"k":1,"self":{"k":1}}}');
  });
});

describe('JSON equality in test', () => {
  const different: [string, JsonValue, JsonValue][] = [
    ['true and 1', true, 1],
    ['false and 0', false, 0],
    ['null and false', null, false],
    ['null and 0', null, 0],
    ['null and the empty string', null, ''],
    ['the string true and true', 'true', true],
    ['an empty array and an empty object', [], {}],
    ['an array and an object with index keys', [1], { '0': 1 }],
    ['an empty object and null', {}, null],
    ['arrays in another order', [1, 2], [2, 1]],
    ['arrays of different length', [1], [1, 1]],
    ['a null element and no element', [null], []],
    ['a null member and no member', { a: null }, {}],
    ['an extra tested member', { a: 1 }, { a: 1, b: 1 }],
    ['an extra document member', { a: 1, b: 1 }, { a: 1 }],
    ['same member count, other names', { a: null, b: 1 }, { b: 1, c: null }],
    ['strings differing only in case', 'a', 'A'],
    ['composed and decomposed é', 'é', 'é'],
  ];

  it.each(different)('tells apart %s', (_, actual, tested) => {
    expect(failed({ v: actual }, [{ op: 'test', path: '/v', value: tested }])).toMatchObject({
      index: 0,
      code: 'test_failed',
    });
  });

  it('treats zero and negative zero as numerically equal', () => {
    expect(ok({ v: 0 }, [{ op: 'test', path: '/v', value: -0 }])).toEqual({ v: 0 });
  });

  it('tells a present null apart from an absent member', () => {
    expect(ok({ a: null }, [{ op: 'test', path: '/a', value: null }])).toEqual({ a: null });
    expect(failed({}, [{ op: 'test', path: '/a', value: null }])).toMatchObject({
      code: 'path_not_found',
    });
  });
});

describe('hostile input at the unknown boundary', () => {
  it.each([null, 'add', { length: 1, 0: { op: 'add', path: '/a', value: 1 } }])(
    'refuses %j as a patch',
    (patch) => {
      expect(failed({}, patch)).toMatchObject({ index: 0, code: 'invalid_patch' });
    },
  );

  const inheritedValue: unknown = Object.assign(Object.create({ value: 1 }) as object, {
    op: 'add',
    path: '/a',
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an array', []],
    ['a string', 'add'],
    ['a number', 42],
    ['an op in the wrong case', { op: 'Add', path: '/a', value: 1 }],
    ['no op', { path: '/a', value: 1 }],
    ['a numeric path', { op: 'add', path: 1, value: 1 }],
    ['a null path', { op: 'add', path: null, value: 1 }],
    ['a test without a value', { op: 'test', path: '/a' }],
    ['a replace without a value', { op: 'replace', path: '/a' }],
    ['a copy with a numeric from', { op: 'copy', from: 1, path: '/a' }],
    ['a value only inherited from a prototype', inheritedValue],
  ])('refuses %s as an operation', (_, operation) => {
    expect(failed({ a: 0 }, [operation])).toMatchObject({ index: 0, code: 'invalid_operation' });
  });

  it('accepts an explicit null value and ignores from on add', () => {
    expect(ok({}, [{ op: 'add', path: '/a', value: null }])).toEqual({ a: null });
    expect(ok({}, [{ op: 'add', path: '/a', value: 1, from: '/missing' }])).toEqual({ a: 1 });
  });

  it.each([
    ['a BigInt', 1n],
    ['a symbol', Symbol('s')],
    ['a function', () => 1],
    ['a boxed string', Object('a') as unknown],
    ['an array with holes', new Array<JsonValue>(2)],
  ])('refuses %s as not JSON', (_, value) => {
    expect(failed({ a: value }, [])).toMatchObject({ index: 0, code: 'invalid_value' });
    expect(failed({}, [{ op: 'add', path: '/a', value }])).toMatchObject({
      code: 'invalid_value',
    });
  });

  it('keeps a parsed __proto__ member as data and never touches a prototype', () => {
    const document: unknown = JSON.parse('{"__proto__":{"x":1},"a":1}');
    const result = ok(document, [{ op: 'replace', path: '/a', value: 2 }]);
    expect(JSON.stringify(result)).toBe('{"__proto__":{"x":1},"a":2}');
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty('x');
  });

  it('sees only own members, never inherited ones', () => {
    expect(failed({}, [{ op: 'remove', path: '/toString' }])).toMatchObject({
      code: 'path_not_found',
    });
    expect(failed({}, [{ op: 'replace', path: '/constructor', value: 1 }])).toMatchObject({
      code: 'path_not_found',
    });
    expect(failed({}, [{ op: 'test', path: '/hasOwnProperty', value: null }])).toMatchObject({
      code: 'path_not_found',
    });
    expect(JSON.stringify(ok({}, [{ op: 'add', path: '/constructor', value: 1 }]))).toBe(
      '{"constructor":1}',
    );
    expect(Object.prototype.constructor).toBe(Object);
  });
});

describe('atomicity and isolation', () => {
  it('reports the failing operation and leaves the document as it was', () => {
    const document = { list: [{ k: 1 }], kept: 'yes' };
    const before = JSON.stringify(document);
    const error: PatchError = failed(document, [
      { op: 'copy', from: '/list/0', path: '/list/-' },
      { op: 'move', from: '/kept', path: '/moved' },
      { op: 'test', path: '/list/1/k', value: 2 },
    ]);
    expect(error).toMatchObject({ index: 2, code: 'test_failed' });
    expect(JSON.stringify(document)).toBe(before);
  });

  it('returns a copy for an empty patch, not the given document', () => {
    const document = { a: [1] };
    const result = ok(document, []);
    expect(result).toEqual(document);
    expect(result).not.toBe(document);
  });

  it('never shares an inserted value with the patch or with another insertion', () => {
    const value = { x: [1] };
    const result = ok({}, [
      { op: 'add', path: '/a', value },
      { op: 'add', path: '/b', value },
      { op: 'add', path: '/a/x/-', value: 2 },
    ]);
    expect(result).toEqual({ a: { x: [1, 2] }, b: { x: [1] } });
    expect(value).toEqual({ x: [1] });
    value.x.push(9);
    expect(result).toEqual({ a: { x: [1, 2] }, b: { x: [1] } });
  });

  it('accepts exactly the most operations a patch may hold', () => {
    const tests = Array.from({ length: MAX_PATCH_OPERATIONS }, () => ({
      op: 'test',
      path: '',
      value: {},
    }));
    expect(ok({}, tests)).toEqual({});
  });
});

describe('the size limit at its edge', () => {
  // The documented weight: characters of keys and strings, plus one per value.
  it('takes a document that weighs exactly the limit and refuses one more', () => {
    expect(ok('abc', [], { maxSize: 4 })).toBe('abc');
    expect(failed('abc', [], { maxSize: 3 })).toMatchObject({ index: 0, code: 'too_large' });
    expect(ok({ ab: 'c' }, [], { maxSize: 5 })).toEqual({ ab: 'c' });
    expect(failed({ ab: 'c' }, [], { maxSize: 4 })).toMatchObject({ code: 'too_large' });
  });

  it('charges nothing for test, which stores nothing, but charges an insertion', () => {
    const document = { a: 'x'.repeat(40) };
    const tests = Array.from({ length: 10 }, () => ({
      op: 'test',
      path: '/a',
      value: 'x'.repeat(40),
    }));
    expect(ok(document, tests, { maxSize: 43 })).toEqual(document);
    expect(
      failed(document, [...tests, { op: 'add', path: '/b', value: 'y' }], { maxSize: 43 }),
    ).toMatchObject({ index: 10, code: 'too_large' });
  });
});

describe('diffing at the boundaries', () => {
  it('escapes ~ before /, so every key names itself', () => {
    const to = { '~1': 1, '/': 2, '': 3, '~/': 4 };
    const patch = diffJson({}, to);
    expect(patch).toEqual([
      { op: 'add', path: '/~01', value: 1 },
      { op: 'add', path: '/~1', value: 2 },
      { op: 'add', path: '/', value: 3 },
      { op: 'add', path: '/~0~1', value: 4 },
    ]);
    expect(ok({}, patch)).toEqual(to);
  });

  it('replaces a value whose JSON type changed, even when it looks alike', () => {
    const from = { a: false, b: null, c: [], d: '1' };
    const to = { a: 0, b: {}, c: {}, d: 1 };
    const patch = diffJson(from, to);
    expect(patch).toEqual([
      { op: 'replace', path: '/a', value: 0 },
      { op: 'replace', path: '/b', value: {} },
      { op: 'replace', path: '/c', value: {} },
      { op: 'replace', path: '/d', value: 1 },
    ]);
    expect(ok(from, patch)).toEqual(to);
  });

  it('tells a null member apart from a missing one', () => {
    expect(diffJson({ a: null }, {})).toEqual([{ op: 'remove', path: '/a' }]);
    expect(diffJson({}, { a: null })).toEqual([{ op: 'add', path: '/a', value: null }]);
  });

  it('replaces a changed root and leaves equal roots alone', () => {
    expect(diffJson(1, '1')).toEqual([{ op: 'replace', path: '', value: '1' }]);
    expect(diffJson('é', 'é')).toEqual([{ op: 'replace', path: '', value: 'é' }]);
    expect(diffJson(0, -0)).toEqual([]);
    expect(diffJson(null, null)).toEqual([]);
  });

  it('reaches into same-length arrays under an empty key', () => {
    const from = { '': [[1]] };
    const to = { '': [[2]] };
    const patch = diffJson(from, to);
    expect(patch).toEqual([{ op: 'replace', path: '//0/0', value: 2 }]);
    expect(ok(from, patch)).toEqual(to);
    expect(from).toEqual({ '': [[1]] });
  });
});
