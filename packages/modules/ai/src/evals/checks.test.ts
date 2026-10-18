import { describe, expect, it } from 'vitest';

import { MAX_SUBJECT_LENGTH, scoreChecks, type CheckResult } from './checks.js';
import type { Check } from './types.js';

const output = {
  text: 'Hello Amina, we have Saturday at 10.',
  label: 'lead',
  fields: { budget: 1200, tags: ['wedding', 'june'], notes: null },
  toolCalls: [
    {
      name: 'find_contacts',
      input: { query: 'wedding in June', limit: 5, filter: { open: true } },
    },
    { name: 'count_deals', input: {} },
  ],
};

function one(check: Check, scored: Readonly<Record<string, unknown>> = output): CheckResult {
  const [result] = scoreChecks(scored, [check]);
  if (result === undefined) throw new Error('No result.');
  return result;
}

const MISSING = 'nothing is at this path';
const DIFFERENT = 'the value is not the one expected';

describe('scoring an output', () => {
  it('gives one result for each check, in order, with what it looked at', () => {
    expect(
      scoreChecks(output, [
        { type: 'equals', path: 'label', value: 'lead' },
        { type: 'tool_called', name: 'send_email' },
      ]),
    ).toEqual([
      { type: 'equals', target: 'label', pass: true, reason: 'ok' },
      { type: 'tool_called', target: 'send_email', pass: false, reason: 'the tool was not called' },
    ]);
  });

  it.each<[string, Check, boolean, string]>([
    ['equals text', { type: 'equals', path: 'label', value: 'lead' }, true, 'ok'],
    ['equals a number', { type: 'equals', path: 'fields.budget', value: 1200 }, true, 'ok'],
    ['equals null', { type: 'equals', path: 'fields.notes', value: null }, true, 'ok'],
    [
      'equals an object whatever its key order',
      {
        type: 'equals',
        path: 'toolCalls.0.input',
        value: { limit: 5, filter: { open: true }, query: 'wedding in June' },
      },
      true,
      'ok',
    ],
    [
      'equals a list',
      { type: 'equals', path: 'fields.tags', value: ['wedding', 'june'] },
      true,
      'ok',
    ],
    [
      'equals a list in another order',
      { type: 'equals', path: 'fields.tags', value: ['june', 'wedding'] },
      false,
      DIFFERENT,
    ],
    [
      'equals another type',
      { type: 'equals', path: 'fields.budget', value: '1200' },
      false,
      DIFFERENT,
    ],
    [
      'equals at a missing path',
      { type: 'equals', path: 'fields.phone', value: null },
      false,
      MISSING,
    ],
    ['a path through text', { type: 'equals', path: 'label.length', value: 4 }, false, MISSING],
    [
      'a path past the end of a list',
      { type: 'equals', path: 'fields.tags.2', value: 'x' },
      false,
      MISSING,
    ],
    [
      'a path that is not an index',
      { type: 'equals', path: 'fields.tags.first', value: 'x' },
      false,
      MISSING,
    ],
    [
      'an inherited name',
      { type: 'equals', path: 'fields.constructor', value: 'x' },
      false,
      MISSING,
    ],
    ['contains', { type: 'contains', path: 'text', value: 'Saturday' }, true, 'ok'],
    [
      'contains in another case',
      { type: 'contains', path: 'text', value: 'saturday' },
      false,
      'the text does not contain what was expected',
    ],
    [
      'contains, ignoring case',
      { type: 'contains', path: 'text', value: 'SATURDAY', caseInsensitive: true },
      true,
      'ok',
    ],
    [
      'contains on a number',
      { type: 'contains', path: 'fields.budget', value: '12' },
      false,
      'the value is not text',
    ],
    ['not_contains', { type: 'not_contains', path: 'text', value: 'Sunday' }, true, 'ok'],
    [
      'not_contains what is there',
      { type: 'not_contains', path: 'text', value: 'Amina' },
      false,
      'the text contains what it must not',
    ],
    [
      'not_contains, ignoring case',
      { type: 'not_contains', path: 'text', value: 'amina', caseInsensitive: true },
      false,
      'the text contains what it must not',
    ],
    [
      'not_contains on a missing value',
      { type: 'not_contains', path: 'summary', value: 'x' },
      false,
      MISSING,
    ],
    ['matches', { type: 'matches', path: 'text', pattern: 'at \\d+\\.$' }, true, 'ok'],
    [
      'matches with flags',
      { type: 'matches', path: 'text', pattern: '^hello', flags: 'i' },
      true,
      'ok',
    ],
    [
      'does not match',
      { type: 'matches', path: 'text', pattern: '^hello' },
      false,
      'the text does not match the pattern',
    ],
    [
      'matches on a list',
      { type: 'matches', path: 'fields.tags', pattern: 'june' },
      false,
      'the value is not text',
    ],
    ['one_of', { type: 'one_of', path: 'label', values: ['lead', 'customer'] }, true, 'ok'],
    [
      'one_of with objects',
      { type: 'one_of', path: 'toolCalls.1.input', values: [1, {}] },
      true,
      'ok',
    ],
    [
      'none of',
      { type: 'one_of', path: 'label', values: ['spam', 'customer'] },
      false,
      'the value is none of those expected',
    ],
    ['a tool was called', { type: 'tool_called', name: 'count_deals' }, true, 'ok'],
    [
      'a tool was called with part of its input',
      { type: 'tool_called', name: 'find_contacts', input: { limit: 5, filter: { open: true } } },
      true,
      'ok',
    ],
    [
      'a tool was called with another input',
      { type: 'tool_called', name: 'find_contacts', input: { limit: 10 } },
      false,
      'the tool was called, but not with the input expected',
    ],
    [
      'a tool input that is deeper than what was sent',
      { type: 'tool_called', name: 'find_contacts', input: { query: { text: 'x' } } },
      false,
      'the tool was called, but not with the input expected',
    ],
    [
      'a text of at most its length',
      { type: 'length_at_most', path: 'label', value: 4 },
      true,
      'ok',
    ],
    [
      'a text that is too long',
      { type: 'length_at_most', path: 'label', value: 3 },
      false,
      'it is longer than allowed',
    ],
    [
      'a list of at most its length',
      { type: 'length_at_most', path: 'toolCalls', value: 2 },
      true,
      'ok',
    ],
    [
      'a list that is too long',
      { type: 'length_at_most', path: 'fields.tags', value: 1 },
      false,
      'it is longer than allowed',
    ],
    [
      'the length of a number',
      { type: 'length_at_most', path: 'fields.budget', value: 9 },
      false,
      'the value is neither text nor a list',
    ],
  ])('%s', (_name, check, pass, reason) => {
    expect(one(check)).toMatchObject({ pass, reason });
  });

  it('finds no tool in an output that carries none', () => {
    const check: Check = { type: 'tool_called', name: 'find_contacts' };
    expect(one(check, { text: 'Hello' })).toMatchObject({
      pass: false,
      reason: 'the tool was not called',
    });
    expect(one(check, { toolCalls: 'find_contacts' }).pass).toBe(false);
    expect(one(check, { toolCalls: ['find_contacts', { name: 7 }] }).pass).toBe(false);
    expect(
      one({ ...check, input: { a: 1 } }, { toolCalls: [{ name: 'find_contacts' }] }),
    ).toMatchObject({
      pass: false,
      reason: 'the tool was called, but not with the input expected',
    });
    expect(one({ ...check, input: {} }, { toolCalls: [{ name: 'find_contacts' }] }).pass).toBe(
      true,
    );
  });

  it('does not run a pattern over a text too long to be safe', () => {
    const long = { text: 'a'.repeat(MAX_SUBJECT_LENGTH + 1) };
    expect(one({ type: 'matches', path: 'text', pattern: 'a' }, long)).toMatchObject({
      pass: false,
      reason: 'the text is too long to match against a pattern',
    });
    const longest = { text: 'a'.repeat(MAX_SUBJECT_LENGTH) };
    expect(one({ type: 'matches', path: 'text', pattern: '^a+$' }, longest).pass).toBe(true);
  });

  it('never puts the output or the expected value in a reason', () => {
    const results = scoreChecks(output, [
      { type: 'contains', path: 'text', value: 'a secret word' },
      { type: 'equals', path: 'label', value: 'another secret' },
    ]);
    expect(JSON.stringify(results)).not.toContain('secret');
    expect(JSON.stringify(results)).not.toContain('Amina');
  });
});
