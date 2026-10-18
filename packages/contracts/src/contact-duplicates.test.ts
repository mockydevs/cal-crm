import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  CONTACT_DUPLICATE_GROUP_PAGE,
  MAX_DUPLICATE_GROUP_CONTACTS,
  contactDuplicateEndpoints,
  duplicateGroupList,
  duplicateLookupQuery,
  duplicateSettings,
  listDuplicateGroupsQuery,
  rejectDuplicateGroupInput,
  updateDuplicateSettingsInput,
} from './contact-duplicates.js';

const revision = 'a'.repeat(64);
const contactId = (n: number) =>
  toPublicId('contact', `01890a5d-ac96-774b-bcce-b3020990${String(n).padStart(4, '0')}`);

describe('duplicate settings', () => {
  it('takes a primary match field and an optional, different secondary one', () => {
    expect(
      updateDuplicateSettingsInput.parse({ primary: 'phone', secondary: 'email', revision }),
    ).toEqual({ primary: 'phone', secondary: 'email', revision });
    expect(
      updateDuplicateSettingsInput.parse({ primary: 'email', secondary: null, revision }),
    ).toEqual({ primary: 'email', secondary: null, revision });
  });

  it('refuses the same field twice, an unknown field and a missing revision', () => {
    const same = updateDuplicateSettingsInput.safeParse({
      primary: 'email',
      secondary: 'email',
      revision,
    });
    expect(same.success).toBe(false);
    expect(same.error?.issues[0]?.path).toEqual(['secondary']);
    expect(
      updateDuplicateSettingsInput.safeParse({ primary: 'name', secondary: null, revision })
        .success,
    ).toBe(false);
    expect(
      updateDuplicateSettingsInput.safeParse({ primary: 'email', secondary: null }).success,
    ).toBe(false);
  });

  it('answers with what may be changed', () => {
    expect(
      duplicateSettings.parse({ primary: 'email', secondary: null, revision, canManage: false }),
    ).toMatchObject({ canManage: false });
  });
});

describe('the duplicate lookup', () => {
  it('takes an email address, a phone number or both, and refuses neither', () => {
    expect(duplicateLookupQuery.parse({ email: ' Maya@Example.com ' })).toEqual({
      email: 'maya@example.com',
    });
    expect(duplicateLookupQuery.parse({ phone: '+1 212 555 0142' })).toEqual({
      phone: '+1 212 555 0142',
    });
    const neither = duplicateLookupQuery.safeParse({});
    expect(neither.success).toBe(false);
    expect(duplicateLookupQuery.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });
});

describe('duplicate groups', () => {
  it('pages by email, phone or name, email by default', () => {
    expect(listDuplicateGroupsQuery.parse({})).toEqual({ by: 'email' });
    expect(listDuplicateGroupsQuery.parse({ by: 'name', limit: '5' })).toEqual({
      by: 'name',
      limit: 5,
    });
    expect(listDuplicateGroupsQuery.safeParse({ by: 'company' }).success).toBe(false);
    expect(
      listDuplicateGroupsQuery.safeParse({ limit: CONTACT_DUPLICATE_GROUP_PAGE + 1 }).success,
    ).toBe(false);
    expect(listDuplicateGroupsQuery.safeParse({ cursor: 'x'.repeat(2000) }).success).toBe(false);
  });

  it('describes each group: its contacts, how many share the key, and why', () => {
    const parsed = duplicateGroupList.parse({
      items: [
        {
          by: 'email',
          valueKey: 'janedoe@gmail.com',
          reasons: ['email'],
          weak: false,
          total: 2,
          contacts: [1, 2].map((n) => ({
            id: contactId(n),
            name: 'Jane Doe',
            emails: ['jane.doe@gmail.com'],
            phones: [],
            createdAt: '2026-10-18T01:00:00.000Z',
          })),
        },
      ],
      next: null,
    });
    expect(parsed.items[0]?.contacts).toHaveLength(2);
  });
});

describe('rejecting a group', () => {
  const ids = [contactId(2), contactId(1)];

  it('takes the group as it was shown: its mode, key and contacts', () => {
    expect(
      rejectDuplicateGroupInput.parse({ by: 'phone', valueKey: '2125550142', contactIds: ids }),
    ).toEqual({ by: 'phone', valueKey: '2125550142', contactIds: ids });
  });

  it('needs two different contacts, and no more than a group shows', () => {
    const one = rejectDuplicateGroupInput.safeParse({
      by: 'email',
      valueKey: 'a@example.com',
      contactIds: [contactId(1)],
    });
    expect(one.success).toBe(false);
    const repeated = rejectDuplicateGroupInput.safeParse({
      by: 'email',
      valueKey: 'a@example.com',
      contactIds: [contactId(1), contactId(1)],
    });
    expect(repeated.success).toBe(false);
    const many = rejectDuplicateGroupInput.safeParse({
      by: 'email',
      valueKey: 'a@example.com',
      contactIds: Array.from({ length: MAX_DUPLICATE_GROUP_CONTACTS + 1 }, (_, n) => contactId(n)),
    });
    expect(many.success).toBe(false);
    expect(
      rejectDuplicateGroupInput.safeParse({ by: 'email', valueKey: '', contactIds: ids }).success,
    ).toBe(false);
  });
});

it('publishes six operations under Contacts', () => {
  expect(contactDuplicateEndpoints.map((endpoint) => endpoint.operationId).sort()).toEqual([
    'findDuplicateContact',
    'getDuplicateSettings',
    'listDuplicateGroups',
    'listPossibleDuplicates',
    'rejectDuplicateGroup',
    'updateDuplicateSettings',
  ]);
  for (const endpoint of contactDuplicateEndpoints) expect(endpoint.group).toBe('Contacts');
});
