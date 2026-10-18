import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  MAX_CONTACT_MERGE_CUSTOM_FIELDS,
  MAX_CONTACTS_IN_MERGE,
  contactMergeEndpoints,
  contactMergePreviewQuery,
  mergeContactsCommandInput,
  mergeContactsInput,
} from './contact-merge.js';

const revision = 'a'.repeat(64);
const contactId = (n: number) =>
  toPublicId('contact', `01890a5d-ac96-774b-bcce-b3020990${String(n).padStart(4, '0')}`);
const [kept, other, third] = [contactId(1), contactId(2), contactId(3)];

/** The body a caller sends: the contact kept is in the path. */
const body = (changes: Record<string, unknown> = {}) => ({
  mergeIds: [other],
  revisions: { [kept]: revision, [other]: revision },
  ...changes,
});
/** The merge as its command takes it, with the contact kept. */
const request = (changes: Record<string, unknown> = {}) => ({ id: kept, ...body(changes) });

/** Where the body is refused: the path of each issue, so a test names the rule it proves. */
const refusedAt = (input: unknown) =>
  mergeContactsInput.safeParse(input).error?.issues.map((issue) => issue.path.join('/')) ?? [];

const codesOf = (input: unknown) =>
  mergeContactsCommandInput.safeParse(input).error?.issues.map((issue) => ({
    path: issue.path.join('/'),
    code: (issue as { params?: { code?: string } }).params?.code ?? issue.code,
  })) ?? [];

describe('merging contacts', () => {
  it('takes the contacts merged away, picked values, primary addresses and revisions', () => {
    const input = mergeContactsCommandInput.parse(
      request({
        fields: { firstName: other, owner: kept },
        customFields: { favourite_colour: other },
        primaryEmail: ' Maya@Example.com ',
        primaryPhone: '+254712345678',
      }),
    );
    expect(input).toMatchObject({
      fields: { firstName: other, owner: kept },
      customFields: { favourite_colour: other },
      primaryEmail: 'maya@example.com',
      primaryPhone: '+254712345678',
    });
  });

  it('merges at most ten contacts, each named once, the one kept not among the others', () => {
    const tooMany = Array.from({ length: MAX_CONTACTS_IN_MERGE }, (_, n) => contactId(n + 10));
    expect(refusedAt(body({ mergeIds: tooMany }))).toEqual(['mergeIds']);
    expect(refusedAt(body({ mergeIds: [] }))).toEqual(['mergeIds']);
    expect(refusedAt(body({ mergeIds: [other, other] }))).toEqual(['mergeIds']);
    expect(refusedAt(body())).toEqual([]);
    expect(codesOf(request({ mergeIds: [kept], revisions: { [kept]: revision } }))).toEqual([
      { path: 'mergeIds', code: 'merges_itself' },
    ]);
  });

  it('refuses a value picked from a contact not in the merge', () => {
    expect(codesOf(request({ fields: { lastName: third } }))).toEqual([
      { path: 'fields/lastName', code: 'not_merged' },
    ]);
    expect(codesOf(request({ customFields: { notes: third } }))).toEqual([
      { path: 'customFields/notes', code: 'not_merged' },
    ]);
  });

  it("needs every contact's revision, and only theirs", () => {
    expect(codesOf(request({ revisions: { [kept]: revision } }))).toEqual([
      { path: `revisions/${other}`, code: 'revision_missing' },
    ]);
    expect(
      codesOf(request({ revisions: { [kept]: revision, [other]: revision, [third]: revision } })),
    ).toEqual([{ path: `revisions/${third}`, code: 'not_merged' }]);
    // A body is held to as many revisions as a merge has contacts, before they are checked.
    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_CONTACTS_IN_MERGE + 1 }, (_, n) => [contactId(n + 10), revision]),
    );
    expect(refusedAt(body({ revisions: tooMany }))).toEqual(['revisions']);
  });

  it('refuses an unknown field, a bad custom field key, too many fields and a bad phone', () => {
    expect(refusedAt(body({ fields: { email: other } }))).toEqual(['fields']);
    expect(refusedAt(body({ customFields: { 'Not a key': other } }))).toEqual([
      'customFields/Not a key',
    ]);
    const many = Object.fromEntries(
      Array.from({ length: MAX_CONTACT_MERGE_CUSTOM_FIELDS + 1 }, (_, n) => [
        `f${String(n)}`,
        kept,
      ]),
    );
    expect(refusedAt(body({ customFields: many }))).toEqual(['customFields']);
    expect(refusedAt(body({ primaryPhone: '0712 345678' }))).toEqual(['primaryPhone']);
  });

  it('reads the contacts to preview as a comma-separated list', () => {
    expect(contactMergePreviewQuery.parse({ mergeIds: `${other},${third}` })).toEqual({
      mergeIds: [other, third],
    });
    expect(contactMergePreviewQuery.safeParse({ mergeIds: `${other},${other}` }).success).toBe(
      false,
    );
  });

  it('describes its two endpoints under Contacts', () => {
    expect(contactMergeEndpoints.map((endpoint) => [endpoint.method, endpoint.path])).toEqual([
      ['get', '/contacts/{id}/merge-preview'],
      ['post', '/contacts/{id}/merge'],
    ]);
  });
});
