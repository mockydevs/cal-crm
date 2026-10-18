import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  MAX_ASSOCIATION_LIMIT,
  associationEndpoints,
  createAssociationInput,
  createRelationInput,
  listAssociationsQuery,
  recordAssociationsQuery,
  relationEndpoints,
  updateAssociationInput,
} from './associations.js';

const uuid = (n: number) => `01890a5d-ac96-774b-bcce-b3020990${String(n).padStart(4, '0')}`;

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

describe('a relation between two records', () => {
  const associationId = toPublicId('link_type', uuid(1));
  const pet = toPublicId('custom', uuid(2));
  const contact = toPublicId('contact', uuid(3));

  it('names its association and two records of any kind, and maybe the primary', () => {
    expect(
      createRelationInput.parse({ associationId, firstRecordId: pet, secondRecordId: contact }),
    ).toEqual({ associationId, firstRecordId: pet, secondRecordId: contact });
    expect(
      createRelationInput.parse({
        associationId,
        firstRecordId: contact,
        secondRecordId: pet,
        primary: true,
      }),
    ).toMatchObject({ primary: true });
  });

  it.each([
    ['an id of no record', { secondRecordId: toPublicId('tag', uuid(4)) }, 'secondRecordId'],
    ['no association', { associationId: undefined }, 'associationId'],
    ['a record related to itself', { secondRecordId: pet }, 'secondRecordId'],
  ])('refuses %s', (_, changes, path) => {
    const result = createRelationInput.safeParse({
      associationId,
      firstRecordId: pet,
      secondRecordId: contact,
      ...changes,
    });
    expect(result.error?.issues.map((issue) => issue.path.join('/'))).toContain(path);
  });

  it('pages one side of one association at a time', () => {
    const after = toPublicId('record_link', uuid(5));
    expect(recordAssociationsQuery.parse({})).toEqual({});
    expect(recordAssociationsQuery.parse({ associationId, side: 'to', after })).toEqual({
      associationId,
      side: 'to',
      after,
    });
    const refused = (query: object) =>
      recordAssociationsQuery.safeParse(query).error?.issues.map((issue) => issue.path.join('/'));
    expect(refused({ side: 'to' })).toEqual(['associationId']);
    expect(refused({ associationId, after })).toEqual(['side']);
  });

  it('is served at the paths GoHighLevel’s relations API uses, under Records', () => {
    expect(
      relationEndpoints.map((endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.group}`),
    ).toEqual([
      'get /records/{id}/associations Records',
      'post /associations/relations Records',
      'delete /associations/relations/{relationId} Records',
    ]);
  });
});
