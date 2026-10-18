import { describe, expect, it } from 'vitest';

import {
  MAX_ASSOCIATION_LIMIT,
  associationEndpoints,
  createAssociationInput,
  listAssociationsQuery,
  updateAssociationInput,
} from './associations.js';

const created = (changes: Record<string, unknown> = {}) => ({
  fromObjectKey: 'pet',
  toObjectKey: 'contact',
  label: ' Owner ',
  fromLimit: 1,
  toLimit: 1000,
  ...changes,
});

describe('an association', () => {
  it('takes one label for both sides when no second is given', () => {
    expect(createAssociationInput.parse(created())).toEqual({
      fromObjectKey: 'pet',
      toObjectKey: 'contact',
      label: 'Owner',
      reverseLabel: 'Owner',
      description: '',
      fromLimit: 1,
      toLimit: 1000,
    });
  });

  it('takes a pair of labels and a key', () => {
    expect(
      createAssociationInput.parse(created({ key: 'pet_owner', reverseLabel: 'Pet' })),
    ).toMatchObject({ key: 'pet_owner', label: 'Owner', reverseLabel: 'Pet' });
  });

  it.each([
    ['no records on a side', { fromLimit: 0 }, 'fromLimit'],
    ['more than GoHighLevel’s 1,000 a side', { toLimit: MAX_ASSOCIATION_LIMIT + 1 }, 'toLimit'],
    ['a fractional limit', { toLimit: 1.5 }, 'toLimit'],
    ['no label', { label: ' ' }, 'label'],
    ['a key out of format', { key: 'Pet Owner' }, 'key'],
  ])('refuses %s', (_, changes, path) => {
    const result = createAssociationInput.safeParse(created(changes));
    expect(result.error?.issues.map((issue) => issue.path.join('/'))).toContain(path);
  });

  it('changes its labels and limits only', () => {
    expect(
      updateAssociationInput.parse({ label: 'Owner', reverseLabel: 'Pet', fromLimit: 5 }),
    ).toEqual({ label: 'Owner', reverseLabel: 'Pet', fromLimit: 5 });
    expect(updateAssociationInput.safeParse({ label: 'Owner', toObjectKey: 'deal' }).success).toBe(
      false,
    );
  });

  it('lists every association, or those touching one object', () => {
    expect(listAssociationsQuery.parse({})).toEqual({});
    expect(listAssociationsQuery.parse({ objectKey: 'pet' })).toEqual({ objectKey: 'pet' });
  });

  it('is served at the paths GoHighLevel’s associations API uses, under Objects', () => {
    expect(
      associationEndpoints.map(
        (endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.group}`,
      ),
    ).toEqual([
      'get /associations Objects',
      'post /associations Objects',
      'get /associations/{id} Objects',
      'patch /associations/{id} Objects',
      'delete /associations/{id} Objects',
    ]);
  });
});
