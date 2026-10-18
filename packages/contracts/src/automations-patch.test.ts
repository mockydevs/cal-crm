// JSON Patch (RFC 6902) and JSON Pointer (RFC 6901), checked against the RFC's own
// examples (RFC 6902 Appendix A, transcribed) and its normative rules.
import { describe, expect, it } from 'vitest';

import {
  applyJsonPatch,
  diffJson,
  MAX_PATCH_DEPTH,
  MAX_PATCH_OPERATIONS,
  type JsonValue,
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

describe('RFC 6902 Appendix A', () => {
  it('A.1 adds an object member', () => {
    expect(ok({ foo: 'bar' }, [{ op: 'add', path: '/baz', value: 'qux' }])).toEqual({
      baz: 'qux',
      foo: 'bar',
    });
  });
  it('A.2 adds an array element', () => {
    expect(ok({ foo: ['bar', 'baz'] }, [{ op: 'add', path: '/foo/1', value: 'qux' }])).toEqual({
      foo: ['bar', 'qux', 'baz'],
    });
  });
  it('A.3 removes an object member', () => {
    expect(ok({ baz: 'qux', foo: 'bar' }, [{ op: 'remove', path: '/baz' }])).toEqual({
      foo: 'bar',
    });
  });
  it('A.4 removes an array element', () => {
    expect(ok({ foo: ['bar', 'qux', 'baz'] }, [{ op: 'remove', path: '/foo/1' }])).toEqual({
      foo: ['bar', 'baz'],
    });
  });
  it('A.5 replaces a value', () => {
    expect(ok({ baz: 'qux', foo: 'bar' }, [{ op: 'replace', path: '/baz', value: 'boo' }])).toEqual(
      {
        baz: 'boo',
        foo: 'bar',
      },
    );
  });
  it('A.6 moves a value', () => {
    expect(
      ok({ foo: { bar: 'baz', waldo: 'fred' }, qux: { corge: 'grault' } }, [
        { op: 'move', from: '/foo/waldo', path: '/qux/thud' },
      ]),
    ).toEqual({ foo: { bar: 'baz' }, qux: { corge: 'grault', thud: 'fred' } });
  });
  it('A.7 moves an array element', () => {
    expect(
      ok({ foo: ['all', 'grass', 'cows', 'eat'] }, [
        { op: 'move', from: '/foo/1', path: '/foo/3' },
      ]),
    ).toEqual({
      foo: ['all', 'cows', 'eat', 'grass'],
    });
  });
  it('A.8 tests values successfully', () => {
    const document = { baz: 'qux', foo: ['a', 2, 'c'] };
    expect(
      ok(document, [
        { op: 'test', path: '/baz', value: 'qux' },
        { op: 'test', path: '/foo/1', value: 2 },
      ]),
    ).toEqual(document);
  });
  it('A.9 fails a test', () => {
    expect(failed({ baz: 'qux' }, [{ op: 'test', path: '/baz', value: 'bar' }])).toMatchObject({
      index: 0,
      code: 'test_failed',
    });
  });
  it('A.10 adds a nested member object', () => {
    expect(ok({ foo: 'bar' }, [{ op: 'add', path: '/child', value: { grandchild: {} } }])).toEqual({
      foo: 'bar',
      child: { grandchild: {} },
    });
  });
  it('A.11 ignores unrecognized members', () => {
    expect(ok({ foo: 'bar' }, [{ op: 'add', path: '/baz', value: 'qux', xyz: 123 }])).toEqual({
      foo: 'bar',
      baz: 'qux',
    });
  });
  it('A.12 refuses to add to a nonexistent target', () => {
    expect(failed({ foo: 'bar' }, [{ op: 'add', path: '/baz/bat', value: 'qux' }])).toMatchObject({
      code: 'path_not_found',
    });
  });
  it('A.14 decodes ~01 as ~1, not /', () => {
    const document = { '/': 9, '~1': 10 };
    expect(ok(document, [{ op: 'test', path: '/~01', value: 10 }])).toEqual(document);
  });
  it('A.15 compares strings and numbers as different', () => {
    expect(failed({ '/': 9, '~1': 10 }, [{ op: 'test', path: '/~01', value: '10' }])).toMatchObject(
      { code: 'test_failed' },
    );
  });
  it('A.16 appends an array value with -', () => {
    expect(ok({ foo: ['bar'] }, [{ op: 'add', path: '/foo/-', value: ['abc', 'def'] }])).toEqual({
      foo: ['bar', ['abc', 'def']],
    });
  });
});

describe('the normative rules', () => {
  it('is atomic: a failing operation leaves the document as it was', () => {
    const document = { a: 1, b: [1, 2] };
    const before = JSON.stringify(document);
    failed(document, [
      { op: 'replace', path: '/a', value: 2 },
      { op: 'remove', path: '/missing' },
    ]);
    expect(JSON.stringify(document)).toBe(before);
  });

  it('never changes the given document, even on success', () => {
    const document = { a: { b: 1 } };
    ok(document, [{ op: 'replace', path: '/a/b', value: 2 }]);
    expect(document).toEqual({ a: { b: 1 } });
  });

  it('copies deeply: a later change to the copy leaves the source alone', () => {
    expect(
      ok({ a: { x: 1 } }, [
        { op: 'copy', from: '/a', path: '/b' },
        { op: 'replace', path: '/b/x', value: 2 },
      ]),
    ).toEqual({ a: { x: 1 }, b: { x: 2 } });
  });

  it('replaces the whole document at the root', () => {
    expect(ok({ a: 1 }, [{ op: 'replace', path: '', value: ['x'] }])).toEqual(['x']);
    expect(ok({ a: 1 }, [{ op: 'add', path: '', value: 7 }])).toBe(7);
  });

  it.each([
    [{ op: 'move', from: '/a', path: '/a/b' }, 'move_into_child'],
    [{ op: 'remove', path: '/arr/-' }, 'path_not_found'],
    [{ op: 'add', path: '/arr/01', value: 1 }, 'invalid_index'],
    [{ op: 'add', path: '/arr/3', value: 1 }, 'index_out_of_range'],
    [{ op: 'replace', path: '/missing', value: 1 }, 'path_not_found'],
    [{ op: 'add', path: 'a', value: 1 }, 'invalid_pointer'],
    [{ op: 'add', path: '/a~2', value: 1 }, 'invalid_pointer'],
    [{ op: 'add', path: '/x' }, 'invalid_operation'],
    [{ op: 'jump', path: '/x' }, 'invalid_operation'],
    [{ op: 'move', path: '/x' }, 'invalid_operation'],
  ])('refuses %j as %s', (operation, code) => {
    expect(failed({ a: { b: 1 }, arr: [1, 2] }, [operation])).toMatchObject({ index: 0, code });
  });

  it('refuses a patch that is not an array of operations', () => {
    expect(failed({}, { op: 'add', path: '/a', value: 1 })).toMatchObject({
      code: 'invalid_patch',
    });
  });

  it('compares objects regardless of member order in test', () => {
    expect(
      ok({ a: { x: 1, y: [1, { z: 2 }] } }, [
        { op: 'test', path: '/a', value: { y: [1, { z: 2 }], x: 1 } },
      ]),
    ).toEqual({
      a: { x: 1, y: [1, { z: 2 }] },
    });
  });
});

describe('the safety limits', () => {
  it('refuses __proto__ in a pointer, so no prototype is ever reached', () => {
    expect(
      failed({}, [{ op: 'add', path: '/__proto__', value: { polluted: true } }]),
    ).toMatchObject({
      code: 'invalid_pointer',
    });
    expect(failed({ a: {} }, [{ op: 'copy', from: '/__proto__', path: '/a/b' }])).toMatchObject({
      code: 'invalid_pointer',
    });
  });

  it('stops a patch that doubles the document, without building it', () => {
    const document = { a: 'x'.repeat(1000) };
    const doubling = Array.from({ length: 64 }, (_, position) => ({
      op: 'copy',
      from: '',
      path: `/copy${String(position)}`,
    }));
    expect(failed(document, doubling)).toMatchObject({ code: 'too_large' });
    expect(document).toEqual({ a: 'x'.repeat(1000) });
  });

  it('counts every inserted value against the size limit', () => {
    expect(
      failed({}, [{ op: 'add', path: '/a', value: 'x'.repeat(100) }], { maxSize: 50 }),
    ).toMatchObject({ index: 0, code: 'too_large' });
    expect(ok({}, [{ op: 'add', path: '/a', value: 'x'.repeat(20) }], { maxSize: 50 })).toEqual({
      a: 'x'.repeat(20),
    });
  });

  it('refuses values nested past the depth limit, before any recursion can overflow', () => {
    let deep: JsonValue = 1;
    for (let level = 0; level < 100_000; level += 1) deep = [deep];
    expect(failed({}, [{ op: 'add', path: '/a', value: deep }])).toMatchObject({
      code: 'too_deep',
    });
    expect(failed(deep, [])).toMatchObject({ index: 0, code: 'too_deep' });
    let fine: JsonValue = 1;
    for (let level = 0; level < MAX_PATCH_DEPTH - 1; level += 1) fine = [fine];
    expect(ok({}, [{ op: 'add', path: '/a', value: fine }])).toEqual({ a: fine });
  });

  it('refuses a move that would nest a value past the depth limit', () => {
    let near: JsonValue = 1;
    for (let level = 0; level < MAX_PATCH_DEPTH - 2; level += 1) near = [near];
    expect(
      failed({ a: near, b: { c: {} } }, [{ op: 'move', from: '/a', path: '/b/c/d' }]),
    ).toMatchObject({ code: 'too_deep' });
  });

  it.each([
    ['undefined', { a: undefined }],
    ['NaN', { a: Number.NaN }],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['a Date', { a: new Date(0) }],
    ['a class instance', { a: new Map() }],
  ])('refuses %s as not JSON, in the document or a value', (_, value) => {
    expect(failed(value, [])).toMatchObject({ index: 0, code: 'invalid_value' });
    expect(failed({}, [{ op: 'add', path: '/x', value }])).toMatchObject({ code: 'invalid_value' });
    expect(failed({}, [{ op: 'test', path: '', value }])).toMatchObject({ code: 'invalid_value' });
  });

  it('takes objects without a prototype, as JSON.parse never makes but callers might', () => {
    const bare: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    bare['a'] = 1;
    expect(ok(bare, [])).toEqual({ a: 1 });
  });

  it('refuses a patch with more operations than the limit', () => {
    const tests = Array.from({ length: MAX_PATCH_OPERATIONS + 1 }, () => ({
      op: 'test',
      path: '',
      value: {},
    }));
    expect(failed({}, tests)).toMatchObject({ code: 'invalid_patch' });
  });
});

describe('diffing two documents', () => {
  const cases: [string, JsonValue, JsonValue][] = [
    ['equal documents', { a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }],
    ['an added member', { a: 1 }, { a: 1, b: { c: 2 } }],
    ['a removed member', { a: 1, b: 2 }, { a: 1 }],
    ['a changed nested value', { a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }],
    ['a changed type', { a: [1] }, { a: { 0: 1 } }],
    ['arrays of one length', { a: [1, 2, 3] }, { a: [1, 5, 3] }],
    ['a longer array', { a: [1, 2] }, { a: [1, 2, 3] }],
    ['a shorter array', { a: [1, 2, 3] }, { a: [2] }],
    ['keys needing escapes', { 'a/b': 1, 'c~d': 2 }, { 'a/b': 3, 'e~/f': 4 }],
    ['different roots', { a: 1 }, ['a']],
  ];

  it.each(cases)('turns one into the other: %s', (_, from, to) => {
    expect(ok(from, diffJson(from, to))).toEqual(to);
  });

  it('is empty for equal documents, whatever their member order', () => {
    expect(diffJson({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toEqual(
      [],
    );
  });

  it('names exactly what changed', () => {
    expect(
      diffJson(
        { name: 'Welcome', steps: { a: { type: 'wait' }, b: { type: 'tag.add' } } },
        { name: 'Welcome back', steps: { a: { type: 'wait' }, c: { type: 'sms.send' } } },
      ),
    ).toEqual([
      { op: 'replace', path: '/name', value: 'Welcome back' },
      { op: 'remove', path: '/steps/b' },
      { op: 'add', path: '/steps/c', value: { type: 'sms.send' } },
    ]);
    expect(diffJson({ 'a/b': 1 }, { 'a/b': 2, '~': 3 })).toEqual([
      { op: 'replace', path: '/a~1b', value: 2 },
      { op: 'add', path: '/~0', value: 3 },
    ]);
  });
});
