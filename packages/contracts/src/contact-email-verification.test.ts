// Email verification across the contact list: the bulk "Verify emails" action and the
// preview its confirm dialog reads, the "Email verification is …" filter, and the list's
// "Email verification" column.
import { describe, expect, it } from 'vitest';

import {
  bulkContactsInput,
  contactBulkActionKinds,
  contactBulkSkipCodes,
  contactEmailCheckPreview,
  previewContactEmailChecks,
  previewContactEmailChecksInput,
} from './contact-bulk.js';
import { contactFilterCondition, contactFilterFields } from './contact-filters.js';
import {
  contactListExtras,
  contactListExtrasOf,
  contactSummary,
  listContactsQuery,
} from './contacts.js';
import { contactEmailVerifications } from './email-verification-status.js';
import { contactColumnLayout, contactTableColumns } from './saved-views.js';

const selection = { ids: ['con_01h455vb4pex5vsknk084sn02q'] };

describe('bulk Verify emails', () => {
  it('is an action of its own that takes only the selection', () => {
    expect(contactBulkActionKinds).toContain('verify_emails');
    expect(bulkContactsInput.parse({ action: 'verify_emails', selection })).toEqual({
      action: 'verify_emails',
      selection,
    });
    expect(
      bulkContactsInput.safeParse({ action: 'verify_emails', selection, maxAgeDays: 7 }).success,
    ).toBe(false);
    expect(
      bulkContactsInput.safeParse({
        action: 'verify_emails',
        selection,
        delivery: { startAt: '2026-10-20T09:00:00Z' },
      }).success,
    ).toBe(false);
  });

  it('says why a contact was not checked', () => {
    expect(contactBulkSkipCodes).toEqual(
      expect.arrayContaining(['no_address', 'verification_excluded', 'daily_limit']),
    );
  });

  it('is previewed for a selection, by hand or a whole list', () => {
    expect(previewContactEmailChecks).toMatchObject({
      method: 'post',
      path: '/contacts/bulk/verify-emails/preview',
    });
    expect(previewContactEmailChecksInput.parse({ selection })).toEqual({ selection });
    expect(
      previewContactEmailChecksInput.parse({ selection: { all: true, q: 'maya' } }).selection,
    ).toEqual({ all: true, q: 'maya' });
    expect(previewContactEmailChecksInput.safeParse({}).success).toBe(false);
  });

  it('answers how many are free, how many are checked and how many call the provider', () => {
    const preview = {
      contacts: 120,
      noEmail: 5,
      excluded: 3,
      current: 40,
      checks: 72,
      providerCalls: 60,
      overLimit: 12,
      remainingToday: 60,
      provider: 'connected',
      enabled: true,
    };
    expect(contactEmailCheckPreview.parse(preview)).toEqual(preview);
    expect(
      contactEmailCheckPreview.parse({ ...preview, provider: null, remainingToday: null }),
    ).toMatchObject({ provider: null, remainingToday: null });
    expect(contactEmailCheckPreview.safeParse({ ...preview, checks: -1 }).success).toBe(false);
  });
});

describe('the Email verification filter', () => {
  it('is a choice of the six things verification can say', () => {
    expect(contactEmailVerifications).toEqual([
      'valid',
      'risky',
      'invalid',
      'unknown',
      'unchecked',
      'excluded',
    ]);
    expect(contactFilterFields.emailVerification).toBe('choice');
    for (const operator of ['any_of', 'none_of'])
      expect(
        contactFilterCondition.safeParse({
          field: 'emailVerification',
          operator,
          values: ['valid', 'risky'],
        }).success,
      ).toBe(true);
    for (const operator of ['is_empty', 'is_not_empty'])
      expect(
        contactFilterCondition.safeParse({ field: 'emailVerification', operator }).success,
      ).toBe(true);
    expect(
      contactFilterCondition.safeParse({
        field: 'emailVerification',
        operator: 'contains',
        value: 'val',
      }).success,
    ).toBe(false);
  });
});

describe('the Email verification column', () => {
  it('is read only when the list asks for it', () => {
    expect(contactListExtras).toContain('emailVerification');
    expect(contactListExtrasOf('tags,emailVerification')).toEqual(['tags', 'emailVerification']);
    expect(listContactsQuery.safeParse({ include: 'emailVerification' }).success).toBe(true);
  });

  it('can be saved with a list, among its columns and in its layout', () => {
    expect(contactTableColumns.parse(['name', 'emailVerification'])).toEqual([
      'name',
      'emailVerification',
    ]);
    expect(contactColumnLayout.parse(['name', 'emailVerification', 'tags'])).toHaveLength(3);
  });

  it('says what verification found of the primary address, or null without one', () => {
    const row = {
      id: 'con_01h455vb4pex5vsknk084sn02q',
      name: 'Maya',
      email: 'maya@example.test',
      phone: null,
      createdAt: '2026-10-18T07:00:00.000Z',
    };
    for (const emailVerification of [...contactEmailVerifications, null])
      expect(contactSummary.parse({ ...row, emailVerification })).toEqual({
        ...row,
        emailVerification,
      });
    expect(contactSummary.safeParse({ ...row, emailVerification: 'deliverable' }).success).toBe(
      false,
    );
  });
});
