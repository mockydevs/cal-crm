import { contactMergeFields } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  builtInSamples,
  insertMergeField,
  isChanged,
  mergeFieldsOf,
  previewDraft,
  reapply,
  sampleValuesOf,
  savedChanges,
  unknownFields,
} from './template-text';

const draft = {
  name: 'Pricing guide',
  subject: 'Your guide, {{contact.firstName}}',
  body: 'Hi {{contact.firstName}},\nWe cover {{contact.custom.services}}.',
};
const samples = builtInSamples({ firstName: 'Ada', lastName: 'Lovelace' });
const fields = [
  { objectKey: 'contact', key: 'services', label: 'Services', archived: false },
  { objectKey: 'contact', key: 'old_notes', label: 'Old notes', archived: true },
  { objectKey: 'deal', key: 'budget', label: 'Budget', archived: false },
];

describe('the fields an author can insert', () => {
  it('are the built-in contact fields, then the live custom contact fields', () => {
    expect(mergeFieldsOf(fields)).toEqual([
      ...contactMergeFields.map((path) => ({ path, label: undefined })),
      { path: 'contact.custom.services', label: 'Services' },
    ]);
  });

  it('have a sample for every built-in field, and only for those', () => {
    expect(Object.keys(samples)).toEqual([...contactMergeFields]);
    expect(samples).toMatchObject({
      'contact.firstName': 'Ada',
      'contact.lastName': 'Lovelace',
      'contact.name': 'Ada Lovelace',
    });
  });
});

describe('inserting a merge field', () => {
  it('puts it at the caret and moves the caret past it', () => {
    expect(insertMergeField('Hi ,', { start: 3, end: 3 }, 'contact.firstName')).toEqual({
      text: 'Hi {{contact.firstName}},',
      caret: 24,
    });
  });

  it('replaces what was selected', () => {
    expect(insertMergeField('Hi NAME!', { start: 3, end: 7 }, 'contact.name')).toEqual({
      text: 'Hi {{contact.name}}!',
      caret: 19,
    });
  });

  it('goes at the end when the selection is past the text, and never splits it backwards', () => {
    expect(insertMergeField('Hi', { start: 99, end: 120 }, 'contact.name').text).toBe(
      'Hi{{contact.name}}',
    );
    expect(insertMergeField('Hi', { start: 2, end: 0 }, 'contact.name').text).toBe(
      'Hi{{contact.name}}',
    );
    expect(insertMergeField('Hi', { start: -4, end: -1 }, 'contact.name').text).toBe(
      '{{contact.name}}Hi',
    );
  });
});

describe('a changed form', () => {
  it('is one whose name, subject or body differs, spaces included', () => {
    expect(isChanged(draft, { ...draft })).toBe(false);
    expect(isChanged({ ...draft, name: 'Other' }, draft)).toBe(true);
    expect(isChanged({ ...draft, subject: 'Other' }, draft)).toBe(true);
    expect(isChanged({ ...draft, body: `${draft.body} ` }, draft)).toBe(true);
  });
});

describe('fields a send could never fill in', () => {
  const known = mergeFieldsOf(fields);

  it('are none when every field is a contact field of the business', () => {
    expect(unknownFields(draft, known)).toEqual([]);
  });

  it('are misspelled, archived, other-object and account-value fields', () => {
    expect(
      unknownFields(
        {
          ...draft,
          body: '{{contact.firstname}} {{contact.custom.old_notes}} {{deal.name}} {{values.reel}} {{contact.email}}',
        },
        known,
      ),
    ).toEqual(['contact.firstname', 'contact.custom.old_notes', 'deal.name', 'values.reel']);
  });

  it("leave custom fields alone when the business's fields couldn't be read", () => {
    expect(
      unknownFields(
        { ...draft, body: '{{contact.custom.anything}} {{contact.firstname}} {{deal.name}}' },
        undefined,
      ),
    ).toEqual(['contact.firstname', 'deal.name']);
  });
});

describe('the preview', () => {
  it('fills built-in fields from samples and names a custom field with no value', () => {
    expect(sampleValuesOf(draft, {}, samples)).toEqual({
      'contact.firstName': 'Ada',
      'contact.custom.services': '',
    });
    expect(previewDraft(draft, {}, samples)).toEqual({
      ok: false,
      code: 'missing_values',
      fields: ['contact.custom.services'],
    });
  });

  it('uses what the author typed, over the sample', () => {
    expect(
      previewDraft(
        draft,
        { 'contact.firstName': 'Maya', 'contact.custom.services': 'Video' },
        samples,
      ),
    ).toEqual({
      ok: true,
      subject: 'Your guide, Maya',
      body: 'Hi Maya,\nWe cover Video.',
    });
  });

  it('treats a sample the author cleared as no value, rather than falling back', () => {
    expect(
      previewDraft(draft, { 'contact.firstName': '', 'contact.custom.services': 'x' }, samples),
    ).toEqual({ ok: false, code: 'missing_values', fields: ['contact.firstName'] });
  });

  it('keeps markup as the text it is', () => {
    expect(
      previewDraft(
        { name: 'n', subject: 's', body: '<b>{{contact.firstName}}</b>' },
        { 'contact.firstName': '<i>Ada</i>' },
        samples,
      ),
    ).toEqual({ ok: true, subject: 's', body: '<b><i>Ada</i></b>' });
  });
});

describe("someone else's save", () => {
  const base = draft;
  const saved = { ...draft, subject: 'Their subject', body: 'Their body' };

  it('is shown part by part, marking the parts this form changed too', () => {
    const mine = { ...draft, name: 'My name', body: 'My body' };
    expect(savedChanges(base, saved, mine)).toEqual([
      { field: 'subject', before: draft.subject, saved: 'Their subject', clashes: false },
      { field: 'body', before: draft.body, saved: 'Their body', clashes: true },
    ]);
  });

  it('is no clash where both typed the same thing', () => {
    expect(savedChanges(base, saved, { ...draft, body: 'Their body' })).toEqual([
      { field: 'subject', before: draft.subject, saved: 'Their subject', clashes: false },
      { field: 'body', before: draft.body, saved: 'Their body', clashes: false },
    ]);
  });

  it('is nothing to show when they changed nothing the form holds', () => {
    expect(savedChanges(base, { ...base }, { ...draft, name: 'Mine' })).toEqual([]);
  });

  it('is reapplied by taking their parts and keeping the parts typed here', () => {
    expect(reapply(base, saved, { ...draft, name: 'My name', body: 'My body' })).toEqual({
      name: 'My name',
      subject: 'Their subject',
      body: 'My body',
    });
    expect(reapply(base, saved, draft)).toEqual(saved);
  });
});
