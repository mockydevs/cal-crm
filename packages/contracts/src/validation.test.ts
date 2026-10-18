import { toPublicId, ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { createTagInput, parseInput, parseRecordId, publicId, recordId } from './index.js';

const uuid = '01890a5d-ac96-774b-bcce-b302099a8057';

function errorFrom(attempt: () => unknown): unknown {
  try {
    attempt();
  } catch (error) {
    return error;
  }
  throw new Error('expected the attempt to throw');
}

describe('publicId', () => {
  const tagId = publicId('tag');

  it('accepts an id of its kind', () => {
    expect(tagId.parse(toPublicId('tag', uuid))).toBe(toPublicId('tag', uuid));
  });

  it.each([
    ['an id of another kind', toPublicId('contact', uuid)],
    ['a bare UUID', uuid],
    ['something else', 'tag_not-an-id'],
  ])('refuses %s', (_case, value) => {
    expect(tagId.safeParse(value).success).toBe(false);
  });

  it('shows its format and an example in JSON Schema', () => {
    expect(z.toJSONSchema(tagId)).toMatchObject({
      type: 'string',
      pattern: '^tag_[0-7][0-9a-hjkmnp-tv-z]{25}$',
      examples: ['tag_01h455vb4pex5vsknk084sn02q'],
    });
  });

  it('reports a malformed id once', () => {
    expect(tagId.safeParse('tag_not-an-id').error?.issues).toHaveLength(1);
    expect(recordId.safeParse('tag_not-an-id').error?.issues).toHaveLength(1);
  });

  it('names its kind in plain English, an event as much as a tag', () => {
    const eventId = publicId('event');

    expect(eventId.safeParse('tag_not-an-id').error?.issues[0]?.message).toBe('Not an event id.');
    expect(z.toJSONSchema(eventId)).toMatchObject({
      description: 'An event id.',
      examples: ['evt_01h455vb4pex5vsknk084sn02q'],
    });
    expect(tagId.safeParse('evt_not-an-id').error?.issues[0]?.message).toBe('Not a tag id.');
    expect(publicId('api_key').safeParse('tag_not-an-id').error?.issues[0]?.message).toBe(
      'Not an api key id.',
    );
    expect(z.toJSONSchema(publicId('api_key'))).toMatchObject({
      description: 'An api key id.',
      examples: ['key_01h455vb4pex5vsknk084sn02q'],
    });
  });
});

describe('recordId', () => {
  it.each([
    ['contact', 'con_01h455vb4pex5vsknk084sn02q'],
    ['company', 'com_01h455vb4pex5vsknk084sn02q'],
    ['deal', 'deal_01h455vb4pex5vsknk084sn02q'],
  ])("accepts a %s's id, and says which kind it names", (kind, value) => {
    expect(recordId.parse(value)).toBe(value);
    expect(parseRecordId(value)).toEqual({ kind, id: uuid });
  });

  it.each([
    ['an id of something that is no record', 'tag_01h455vb4pex5vsknk084sn02q'],
    ['a bare UUID', uuid],
    ['something else', 'con_not-an-id'],
  ])('refuses %s', (_case, value) => {
    expect(recordId.safeParse(value).success).toBe(false);
    expect(parseRecordId(value)).toBeUndefined();
  });

  it('shows its format in JSON Schema', () => {
    expect(z.toJSONSchema(recordId)).toMatchObject({
      type: 'string',
      pattern: '^(con|com|deal)_[0-7][0-9a-hjkmnp-tv-z]{25}$',
    });
  });
});

describe('parseInput', () => {
  it('returns the parsed input', () => {
    expect(parseInput(createTagInput, { name: '  Hot lead ' })).toEqual({
      name: 'Hot lead',
      description: '',
    });
  });

  it('turns every problem into an issue with a JSON Pointer', () => {
    const error = errorFrom(() =>
      parseInput(createTagInput, { name: 'x'.repeat(61), description: 7, colour: 'red' }),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      issues: [
        { path: '/name', code: 'too_big', message: 'Use at most 60 characters.' },
        { path: '/description', code: 'invalid_type' },
        { path: '/colour', code: 'unrecognized_keys', message: "colour isn't a field here." },
      ],
    });
  });

  it('points at nested fields and array items', () => {
    const schema = z.object({ lines: z.array(z.object({ amount: z.number() })) });

    const error = errorFrom(() =>
      parseInput(schema, { lines: [{ amount: 1 }, { amount: 'two' }] }),
    );

    expect(error).toMatchObject({ issues: [{ path: '/lines/1/amount', code: 'invalid_type' }] });
  });

  it("takes a refinement's own code, so the schema and the server name a problem alike", () => {
    const schema = z.object({ name: z.string() }).superRefine((_input, context) => {
      context.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'Taken.',
        params: { code: 'taken' },
      });
      context.addIssue({ code: 'custom', path: [], message: 'Unnamed.' });
    });

    const error = errorFrom(() => parseInput(schema, { name: 'x' }));

    expect(error).toMatchObject({
      issues: [
        { path: '/name', code: 'taken', message: 'Taken.' },
        { path: '', code: 'custom', message: 'Unnamed.' },
      ],
    });
  });
});

describe('createTagInput', () => {
  it.each([
    ['an empty name', { name: '' }, 'Give the tag a name.'],
    ['a name of only spaces', { name: '   ' }, 'Give the tag a name.'],
    [
      'a long description',
      { name: 'VIP', description: 'x'.repeat(501) },
      'Use at most 500 characters.',
    ],
  ])('refuses %s', (_case, input, message) => {
    expect(() => parseInput(createTagInput, input)).toThrow(message);
  });
});
