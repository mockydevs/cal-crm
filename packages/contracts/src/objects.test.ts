import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  MAX_SEARCHABLE_FIELDS,
  createObjectInput,
  deleteObjectInput,
  objectEndpoints,
  objectIcons,
  objectInternalName,
  updateObjectInput,
} from './objects.js';

const fieldId = (n: number) =>
  toPublicId('field', `01890a5d-ac96-774b-bcce-b3020990${String(n).padStart(4, '0')}`);

const created = (changes: Record<string, unknown> = {}) => ({
  singularLabel: ' Pet ',
  pluralLabel: 'Pets',
  primaryField: { label: 'Pet name', valueType: 'text' },
  ...changes,
});

describe('a custom object', () => {
  it('is made from its names and its primary field, and nothing else is needed', () => {
    expect(createObjectInput.parse(created())).toEqual({
      singularLabel: 'Pet',
      pluralLabel: 'Pets',
      description: '',
      icon: null,
      primaryField: { label: 'Pet name', valueType: 'text', unique: false },
    });
  });

  it('takes a key, an icon, a description and a unique primary field', () => {
    const input = createObjectInput.parse(
      created({
        key: 'pet',
        icon: 'paw-print',
        description: 'Animals we look after.',
        primaryField: { label: 'Tag number', key: 'tag_number', valueType: 'number', unique: true },
      }),
    );
    expect(input).toMatchObject({ key: 'pet', icon: 'paw-print' });
    expect(input.primaryField).toEqual({
      label: 'Tag number',
      key: 'tag_number',
      valueType: 'number',
      unique: true,
    });
  });

  it.each([
    ['a standard object’s key', { key: 'deal' }, 'key'],
    ['a key out of format', { key: 'Pet' }, 'key'],
    ['a long name', { pluralLabel: 'x'.repeat(61) }, 'pluralLabel'],
    ['an icon not in the set', { icon: 'unicorn' }, 'icon'],
    [
      'a primary field of another type',
      { primaryField: { label: 'Born', valueType: 'date' } },
      'primaryField/valueType',
    ],
    ['no primary field', { primaryField: undefined }, 'primaryField'],
  ])('refuses %s', (_, changes, path) => {
    const result = createObjectInput.safeParse(created(changes));
    expect(result.error?.issues.map((issue) => issue.path.join('/'))).toContain(path);
  });

  it('is named custom_objects.<key> inside, as GoHighLevel names it, and a standard one by its key', () => {
    expect(objectInternalName('custom', 'pet')).toBe('custom_objects.pet');
    expect(objectInternalName('contact', 'contact')).toBe('contact');
  });

  it('offers icons the dashboard draws, each named once', () => {
    expect(new Set(objectIcons).size).toBe(objectIcons.length);
    for (const icon of objectIcons) expect(icon).toMatch(/^[a-z0-9-]{1,40}$/);
  });

  it(`keeps at most ${String(MAX_SEARCHABLE_FIELDS)} searchable fields, each once`, () => {
    const update = (searchableFieldIds: string[]) =>
      updateObjectInput.safeParse({
        revision: 'a'.repeat(64),
        singularLabel: 'Pet',
        pluralLabel: 'Pets',
        description: '',
        icon: null,
        searchableFieldIds,
      }).success;
    expect(update([fieldId(1), fieldId(2), fieldId(3)])).toBe(true);
    expect(update([fieldId(1), fieldId(2), fieldId(3), fieldId(4)])).toBe(false);
    expect(update([fieldId(1), fieldId(1)])).toBe(false);
  });

  it('is deleted with its plural name typed out', () => {
    expect(deleteObjectInput.parse({ confirm: ' Pets ' })).toEqual({ confirm: 'Pets' });
    expect(deleteObjectInput.safeParse({}).success).toBe(false);
  });

  it('is served at the paths GoHighLevel’s objects API uses, under Objects', () => {
    expect(
      objectEndpoints.map((endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.group}`),
    ).toEqual([
      'get /objects Objects',
      'post /objects Objects',
      'get /objects/{key} Objects',
      'patch /objects/{key} Objects',
      'delete /objects/{key} Objects',
    ]);
  });
});
