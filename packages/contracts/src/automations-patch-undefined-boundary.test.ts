import { expect, it } from 'vitest';

import { applyJsonPatch } from './automations-patch.js';

it.each(['add', 'replace', 'test'])('refuses an own undefined value in %s', (op) => {
  expect(applyJsonPatch({ x: null }, [{ op, path: '/x', value: undefined }])).toEqual({
    ok: false,
    error: { index: 0, code: 'invalid_value', message: 'Only JSON values can be stored.' },
  });
});

it.each(['add', 'replace', 'test'])('refuses undefined at the root in %s', (op) => {
  expect(applyJsonPatch(null, [{ op, path: '', value: undefined }])).toEqual({
    ok: false,
    error: { index: 0, code: 'invalid_value', message: 'Only JSON values can be stored.' },
  });
});

it.each(['add', 'replace', 'test'])('keeps explicit null valid in %s', (op) => {
  expect(applyJsonPatch({ x: null }, [{ op, path: '/x', value: null }])).toEqual({
    ok: true,
    document: { x: null },
  });
});

it('refuses undefined atomically after an earlier valid mutation', () => {
  const document = { x: 0 };
  expect(
    applyJsonPatch(document, [
      { op: 'replace', path: '/x', value: 1 },
      { op: 'add', path: '/y', value: undefined },
    ]),
  ).toEqual({
    ok: false,
    error: { index: 1, code: 'invalid_value', message: 'Only JSON values can be stored.' },
  });
  expect(document).toEqual({ x: 0 });
});
