import { expect, it } from 'vitest';
import {
  choiceDisplaysOf,
  choiceKeyOf,
  choiceKeysOf,
  createFieldInput,
  fieldChoiceDisplays,
  fieldDefinition,
  listCustomFieldsQuery,
  updateFieldInput,
  parseInput,
} from './index.js';
const option = {
  key: 'lighting',
  label: 'Lighting',
  description: 'Lighting service',
  archived: false,
};
const input = {
  objectKey: 'deal',
  key: 'services',
  label: ' Services ',
  description: ' Services requested. ',
  valueType: 'multi_choice',
  options: [option],
  currency: null,
  aiFillSources: ['forms'],
  aiOverwrite: 'ask',
  archived: false,
};
it('trims field descriptions and labels while preserving stable keys', () => {
  expect(parseInput(createFieldInput, input)).toMatchObject({
    label: 'Services',
    description: 'Services requested.',
    key: 'services',
    options: [option],
  });
});
it.each([
  { options: [option, option] },
  { options: [option, { ...option, key: 'other', label: ' LIGHTING ' }] },
  { aiFillSources: ['forms', 'forms'] },
  { key: 'Changed-Key' },
  { description: '  ' },
  { valueType: 'money', options: [] },
  { valueType: 'text' },
  { currency: 'KES' },
])('rejects ambiguous or inconsistent definitions: %j', (change) => {
  expect(() => parseInput(createFieldInput, { ...input, ...change })).toThrow();
});
it('allows archived duplicate labels but never duplicate option keys', () => {
  expect(
    createFieldInput.safeParse({
      ...input,
      options: [option, { ...option, key: 'old', archived: true }],
    }).success,
  ).toBe(true);
  expect(
    createFieldInput.safeParse({ ...input, options: [{ ...option, archived: true }, option] })
      .success,
  ).toBe(false);
});
it('does not accept changes to field keys, objects or types', () => {
  const edit = {
    label: 'New label',
    description: 'What it means.',
    options: [],
    aiFillSources: [],
    aiOverwrite: 'never',
    archived: false,
    revision: 'a'.repeat(64),
  };
  expect(updateFieldInput.safeParse(edit).success).toBe(true);
  for (const key of ['key', 'objectKey', 'valueType'])
    expect(updateFieldInput.safeParse({ ...edit, [key]: 'changed' }).success).toBe(false);
});
it('takes a folder and placeholder text when given, and neither when left out', () => {
  const folderId = 'ffld_01h455vb4pex5vsknk084sn02q';
  const edit = {
    label: 'Budget',
    description: 'What they plan to spend.',
    options: [],
    aiFillSources: [],
    aiOverwrite: 'ask',
    archived: false,
    revision: 'a'.repeat(64),
  };
  const single = { ...input, valueType: 'text', options: [] };
  const created = parseInput(createFieldInput, single);
  expect('folderId' in created || 'placeholder' in created).toBe(false);
  expect(
    parseInput(createFieldInput, { ...single, folderId, placeholder: '  e.g. 5,000  ' }),
  ).toMatchObject({ folderId, placeholder: 'e.g. 5,000' });
  expect(parseInput(updateFieldInput, { ...edit, folderId, placeholder: '' })).toMatchObject({
    folderId,
    placeholder: '',
  });
  for (const change of [
    { folderId: 'fld_01h455vb4pex5vsknk084sn02q' },
    { folderId: null },
    { placeholder: 'x'.repeat(201) },
    { placeholder: 5 },
  ]) {
    expect(createFieldInput.safeParse({ ...single, ...change }).success).toBe(false);
    expect(updateFieldInput.safeParse({ ...edit, ...change }).success).toBe(false);
  }
});
it('still reads a field answer saved before folders, placeholders and merge keys existed', () => {
  const before = {
    id: 'fld_01h455vb4pex5vsknk084sn02q',
    objectKey: 'contact',
    key: 'guest_count',
    label: 'Guest count',
    description: 'The latest expected number of guests.',
    valueType: 'number',
    currency: null,
    options: [],
    aiFillSources: [],
    aiOverwrite: 'ask',
    archived: false,
    revision: 'a'.repeat(64),
  };
  expect(fieldDefinition.parse(before)).toEqual(before);
  const now = {
    ...before,
    folderId: 'ffld_01h455vb4pex5vsknk084sn02q',
    placeholder: 'How many?',
    mergeKey: 'contact.guest_count',
    createdAt: '2026-10-10T09:30:00.000Z',
    source: 'user',
  };
  expect(fieldDefinition.parse(now)).toEqual(now);
  expect(fieldDefinition.parse({ ...now, mergeKey: null }).mergeKey).toBeNull();
  expect(fieldDefinition.safeParse({ ...now, source: 'robot' }).success).toBe(false);
});
it('shows a single choice as a dropdown or radio buttons, a multiple choice as a dropdown or checkboxes, and nothing else as either', () => {
  expect(fieldChoiceDisplays).toEqual(['dropdown', 'radio', 'checkbox']);
  expect(choiceDisplaysOf).toEqual({
    single_choice: ['dropdown', 'radio'],
    multi_choice: ['dropdown', 'checkbox'],
  });
  const accepted = (change: Record<string, unknown>): boolean =>
    createFieldInput.safeParse({ ...input, ...change }).success;
  expect(accepted({})).toBe(true);
  expect(accepted({ display: 'checkbox' })).toBe(true);
  expect(accepted({ display: 'dropdown' })).toBe(true);
  expect(accepted({ display: 'radio' })).toBe(false);
  expect(accepted({ valueType: 'single_choice', display: 'radio' })).toBe(true);
  expect(accepted({ valueType: 'single_choice', display: 'checkbox' })).toBe(false);
  expect(accepted({ valueType: 'text', options: [], display: 'dropdown' })).toBe(false);
  expect(accepted({ display: 'slider' })).toBe(false);
  // Chosen once: a save has no such member, and the list can be asked for one.
  const {
    objectKey: _objectKey,
    key: _key,
    valueType: _valueType,
    currency: _currency,
    ...saved
  } = input;
  expect(updateFieldInput.safeParse({ ...saved, revision: 'a'.repeat(64) }).success).toBe(true);
  expect(
    updateFieldInput.safeParse({ ...saved, revision: 'a'.repeat(64), display: 'radio' }).success,
  ).toBe(false);
  expect(parseInput(listCustomFieldsQuery, { display: 'radio' })).toMatchObject({
    display: 'radio',
  });
  expect(listCustomFieldsQuery.safeParse({ display: 'slider' }).success).toBe(false);
});

it('reads a choice from text by its key or its label, never an archived one', () => {
  const options = [
    { key: 'dj', label: 'DJ', archived: false },
    { key: 'photo_video', label: 'Photo/Video', archived: false },
    { key: 'band', label: 'Live band', archived: true },
  ];
  expect(choiceKeyOf(options, 'dj')).toBe('dj');
  expect(choiceKeyOf(options, ' photo/video ')).toBe('photo_video');
  expect(choiceKeyOf(options, 'Photo/Video')).toBe('photo_video');
  expect(choiceKeyOf(options, 'band')).toBeUndefined();
  expect(choiceKeyOf(options, 'Live band')).toBeUndefined();
  expect(choiceKeyOf(options, 'Harp')).toBeUndefined();
  expect(choiceKeysOf(options, 'DJ, photo_video, dj')).toEqual(['dj', 'photo_video']);
  expect(choiceKeysOf(options, ['Photo/Video'])).toEqual(['photo_video']);
  expect(choiceKeysOf(options, 'DJ, Harp')).toBeUndefined();
  expect(choiceKeysOf(options, ' , ')).toBeUndefined();
});
it('makes only a single line, multi line, number or phone field unique, and only ever unmakes one', () => {
  const plain = { ...input, valueType: 'text', options: [], aiFillSources: [] };
  expect(parseInput(createFieldInput, { ...plain, unique: true })).toMatchObject({ unique: true });
  expect(createFieldInput.safeParse({ ...plain, valueType: 'email', unique: true }).success).toBe(
    false,
  );
  const saved = {
    label: 'Name',
    description: 'Its name.',
    options: [],
    aiFillSources: [],
    aiOverwrite: 'ask',
    archived: false,
    revision: 'a'.repeat(64),
  };
  expect(parseInput(updateFieldInput, { ...saved, unique: false })).toMatchObject({
    unique: false,
  });
  expect(updateFieldInput.safeParse({ ...saved, unique: true }).success).toBe(false);
});
