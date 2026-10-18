import { expect, it } from 'vitest';
import {
  CONSENT_NOTE_MAX,
  CONSENT_NOTE_MIN,
  consentChannels,
  consentPurposes,
  consentSources,
  contactConsent,
  getContactConsent,
  getMessagingSettings,
  messagingSettings,
  recordConsentInput,
  recordContactConsent,
  updateMessagingSettings,
  updateMessagingSettingsInput,
} from './consent.js';
import { parseInput } from './validation.js';

const change = {
  channel: 'email',
  purpose: 'marketing',
  status: 'granted',
  note: 'Asked at the front desk to get the newsletter.',
};

it('takes a consent change only with a note that says how it was obtained', () => {
  expect(recordConsentInput.parse(change)).toEqual({ ...change, replacesWithdrawal: false });
  expect(recordConsentInput.parse({ ...change, note: `  ${change.note}  ` }).note).toBe(
    change.note,
  );
  for (const note of [undefined, null, '', '   ', 'ok', ' '.repeat(40), 'x'.repeat(9)])
    expect(recordConsentInput.safeParse({ ...change, note }).success, String(note)).toBe(false);
  for (const length of [CONSENT_NOTE_MIN, CONSENT_NOTE_MAX])
    expect(recordConsentInput.safeParse({ ...change, note: 'x'.repeat(length) }).success).toBe(
      true,
    );
  expect(
    recordConsentInput.safeParse({ ...change, note: 'x'.repeat(CONSENT_NOTE_MAX + 1) }).success,
  ).toBe(false);
});

it('names the note when it is missing, so a form can show the problem under it', () => {
  expect(() => parseInput(recordConsentInput, { ...change, note: 'short' })).toThrow(
    expect.objectContaining({
      issues: [
        expect.objectContaining({
          path: '/note',
          message: 'Say how you know, in at least 10 characters.',
        }),
      ],
    }),
  );
});

it('refuses anything a caller could use to choose the source, the recorder or the time', () => {
  for (const extra of [
    { source: 'form' },
    { recordedAt: '2020-01-01T00:00:00Z' },
    { recordedBy: 'someone' },
    { proof: { ipAddress: '203.0.113.9' } },
    { contactId: 'con_01h455vb4pex5vsknk084sn02q' },
    { businessId: 'foreign' },
  ])
    expect(recordConsentInput.safeParse({ ...change, ...extra }).success).toBe(false);
  for (const patch of [
    { channel: 'fax' },
    { purpose: 'sales' },
    { status: 'unknown' },
    { status: 'pending' },
    { replacesWithdrawal: 'yes' },
  ])
    expect(recordConsentInput.safeParse({ ...change, ...patch }).success).toBe(false);
});

it('keeps the channels, purposes and sources the ledger table allows', () => {
  // messaging.consents: consents_channel_valid, consents_purpose_valid, consents_source_valid.
  expect(consentChannels).toEqual(['email', 'sms', 'whatsapp', 'call']);
  expect(consentPurposes).toEqual(['marketing', 'transactional']);
  expect(consentSources).toEqual([
    'form',
    'keyword',
    'unsubscribe_link',
    'booking',
    'import',
    'api',
    'user',
  ]);
});

const revision = 'a'.repeat(64);
const settings = {
  quietHoursEnabled: true,
  quietHoursStart: '21:00',
  quietHoursEnd: '08:00',
  contactDailyLimit: 10,
  revision,
};

it('takes quiet hours as 24-hour times and a bounded daily limit', () => {
  expect(updateMessagingSettingsInput.parse(settings)).toEqual(settings);
  for (const time of ['00:00', '23:59', '09:05'])
    expect(
      updateMessagingSettingsInput.safeParse({ ...settings, quietHoursStart: time }).success,
      time,
    ).toBe(true);
  for (const time of ['24:00', '9:00', '21:60', '21:00:00', '9pm', '', ' 21:00', '21.00', null])
    for (const field of ['quietHoursStart', 'quietHoursEnd'])
      expect(
        updateMessagingSettingsInput.safeParse({ ...settings, [field]: time }).success,
        `${field} ${String(time)}`,
      ).toBe(false);
  for (const contactDailyLimit of [0, -1, 1.5, 10_001, '10', null])
    expect(updateMessagingSettingsInput.safeParse({ ...settings, contactDailyLimit }).success).toBe(
      false,
    );
  for (const contactDailyLimit of [1, 10_000])
    expect(updateMessagingSettingsInput.safeParse({ ...settings, contactDailyLimit }).success).toBe(
      true,
    );
});

it('refuses a window that would hold every message all day, unless quiet hours are off', () => {
  const same = { ...settings, quietHoursStart: '09:00', quietHoursEnd: '09:00' };
  expect(() => parseInput(updateMessagingSettingsInput, same)).toThrow(
    expect.objectContaining({
      issues: [
        expect.objectContaining({
          path: '/quietHoursEnd',
          code: 'empty_window',
          message: "Quiet hours can't start and end at the same time.",
        }),
      ],
    }),
  );
  expect(
    updateMessagingSettingsInput.safeParse({ ...same, quietHoursEnabled: false }).success,
  ).toBe(true);
});

it('needs the revision that was read, and refuses fields outside the settings', () => {
  expect(updateMessagingSettingsInput.safeParse({ ...settings, revision: undefined }).success).toBe(
    false,
  );
  expect(updateMessagingSettingsInput.safeParse({ ...settings, revision: 'stale' }).success).toBe(
    false,
  );
  for (const extra of [{ businessId: 'foreign' }, { canManage: true }, { updatedAt: 'now' }])
    expect(updateMessagingSettingsInput.safeParse({ ...settings, ...extra }).success).toBe(false);
});

it('describes the four operations at their own paths', () => {
  expect(
    [getContactConsent, recordContactConsent, getMessagingSettings, updateMessagingSettings].map(
      (endpoint) => [
        endpoint.operationId,
        endpoint.method,
        endpoint.path,
        endpoint.response.status,
      ],
    ),
  ).toEqual([
    ['getContactConsent', 'get', '/contacts/{id}/consent', 200],
    ['recordContactConsent', 'post', '/contacts/{id}/consent', 201],
    ['getMessagingSettings', 'get', '/messaging-settings', 200],
    ['updateMessagingSettings', 'put', '/messaging-settings', 200],
  ]);
  expect(getContactConsent.params.safeParse({ id: 'tag_01h455vb4pex5vsknk084sn02q' }).success).toBe(
    false,
  );
  expect(getContactConsent.params.safeParse({ id: 'con_01h455vb4pex5vsknk084sn02q' }).success).toBe(
    true,
  );
});

it('reads a contact consent answer and the settings as the server sends them', () => {
  const answer = {
    canManage: true,
    doNotContact: false,
    timeZone: null,
    current: [
      { channel: 'email', purpose: 'marketing', status: 'unknown', source: null, recordedAt: null },
    ],
    suppressions: [
      {
        channel: 'email',
        address: 'maya@example.com',
        reason: 'hard_bounce',
        since: '2026-10-08T12:00:00.000Z',
        until: null,
      },
    ],
    history: [
      {
        channel: 'email',
        purpose: 'marketing',
        status: 'withdrawn',
        source: 'unsubscribe_link',
        recordedAt: '2026-10-08T12:00:00.000Z',
        recordedBy: { kind: 'contact', name: null, you: false },
        proof: {
          note: null,
          wording: null,
          keyword: null,
          ipAddress: null,
          pageUrl: null,
          linked: 'message',
        },
      },
    ],
    historyTruncated: false,
  };
  expect(contactConsent.parse(answer)).toEqual(answer);
  expect(
    contactConsent.safeParse({ ...answer, current: [{ ...answer.current[0], status: 'maybe' }] })
      .success,
  ).toBe(false);
  const saved = { ...settings, canManage: false, heldMessages: 3, contactsWithoutTimeZone: 12 };
  expect(messagingSettings.parse(saved)).toEqual(saved);
});
