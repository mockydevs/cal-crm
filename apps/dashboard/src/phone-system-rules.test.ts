import type { PhoneNumberSettings, PhoneSystemSettings } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  canRingMore,
  destinationOf,
  matchesSearch,
  numberDraftOf,
  numberInput,
  problemAt,
  problemsOf,
  sameDraft,
  systemDraftOf,
  systemInput,
  voiceNumbers,
  withPrimary,
  withRecording,
  MAX_RING_ALSO,
} from './phone-system-rules';

const revision = 'a'.repeat(64);
const dana = 'mem_01k8e2wzr0e008000000000001';
const lee = 'mem_01k8e2wzr0e008000000000002';

const voice = (): NonNullable<PhoneNumberSettings['voice']> => ({
  recording: { enabled: false, announcement: { enabled: false, message: null } },
  routing: {
    primaryMemberId: null,
    forwardTo: null,
    useBusinessFallback: false,
    ringAlso: [],
    ringTimeoutSeconds: 20,
    voicemailBackup: true,
  },
  advanced: {
    callConnectConfirmation: false,
    whisper: { enabled: false, message: null },
    forwardedCallerId: 'caller',
    preferContactOwner: false,
  },
});

const numberOf = (patch: Partial<PhoneNumberSettings> = {}): PhoneNumberSettings => ({
  id: 'phn_01k8e2wzr0e008000000000001',
  e164: '+14155550123',
  capabilities: ['sms', 'voice'],
  status: 'active',
  isDefault: false,
  name: 'Front desk',
  ownerId: null,
  voice: voice(),
  revision,
  warnings: [],
  ...patch,
});

const settingsOf = (patch: Partial<PhoneSystemSettings> = {}): PhoneSystemSettings => ({
  defaultNumberId: null,
  inbound: { preferAssignedUser: true, allowAnonymousCallers: true, fallbackNumber: null },
  outbound: {
    callerId: 'account_default',
    connectAgent: 'after_announcement',
    quietHoursWarning: true,
  },
  recording: { retentionDays: null, transcriptionEnabled: false },
  missedCallText: { enabled: false, message: null },
  revision,
  calling: {
    available: false,
    unavailable: { code: 'calling_not_set_up', message: 'Not yet.' },
  },
  ...patch,
});

describe('a number as its editor holds it', () => {
  it('keeps only what a save sends, and tells a change from none', () => {
    const number = numberOf();
    const draft = numberDraftOf(number);
    expect(draft).toEqual({ name: 'Front desk', ownerId: null, voice: number.voice });
    expect(sameDraft(draft, numberDraftOf(number))).toBe(true);
    expect(sameDraft(draft, { ...draft, name: 'Sales' })).toBe(false);
  });

  it('sends a blank message as none and the revision it was read with', () => {
    const base = voice();
    const checked = numberInput(
      {
        name: '  Sales line ',
        ownerId: null,
        voice: {
          ...base,
          advanced: { ...base.advanced, whisper: { enabled: false, message: '   ' } },
        },
      },
      revision,
    );
    expect(checked).toEqual({
      ok: true,
      input: { name: 'Sales line', ownerId: null, voice: base, revision },
    });
  });

  it('names each problem by where it is, as the server does', () => {
    const base = voice();
    const checked = numberInput(
      {
        name: '',
        ownerId: null,
        voice: {
          ...base,
          routing: { ...base.routing, forwardTo: '0712', ringTimeoutSeconds: 2 },
          advanced: { ...base.advanced, whisper: { enabled: true, message: '' } },
        },
      },
      revision,
    );
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(Object.keys(checked.problems).sort()).toEqual([
      '/name',
      '/voice/advanced/whisper/message',
      '/voice/routing/forwardTo',
      '/voice/routing/ringTimeoutSeconds',
    ]);
    expect(checked.problems['/voice/advanced/whisper/message']?.message).toBe(
      'Write the whisper the person answering hears.',
    );
  });

  it('keeps a number that cannot take calls without call settings', () => {
    expect(numberInput({ name: 'Texts only', ownerId: dana, voice: null }, revision)).toEqual({
      ok: true,
      input: { name: 'Texts only', ownerId: dana, voice: null, revision },
    });
  });
});

describe('the business settings as their editor holds them', () => {
  it('leaves out the revision and whether calls work, and sends the revision back', () => {
    const draft = systemDraftOf(settingsOf());
    expect(draft).not.toHaveProperty('revision');
    expect(draft).not.toHaveProperty('calling');
    expect(systemInput(draft, revision)).toEqual({ ok: true, input: { ...draft, revision } });
  });

  it('asks for the missed-call text when it is turned on', () => {
    const draft = systemDraftOf(settingsOf());
    const checked = systemInput(
      { ...draft, missedCallText: { enabled: true, message: ' ' } },
      revision,
    );
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems['/missedCallText/message']).toEqual({
      code: 'custom',
      message: 'Write the text a caller gets after a missed call.',
    });
  });
});

describe('problems from the server', () => {
  it('keeps the first problem for each place', () => {
    expect(
      problemsOf([
        { path: '/voice/routing/ringAlso/0', code: 'unavailable_member', message: 'Gone.' },
        { path: '/voice/routing/ringAlso/1', code: 'unavailable_member', message: 'Also gone.' },
        { path: '/voice/routing/ringAlso/0', code: 'other', message: 'Later.' },
        { path: '', code: 'conflict', message: 'Whole.' },
      ]),
    ).toEqual({
      '/voice/routing/ringAlso/0': { code: 'unavailable_member', message: 'Gone.' },
      '/voice/routing/ringAlso/1': { code: 'unavailable_member', message: 'Also gone.' },
      '': { code: 'conflict', message: 'Whole.' },
    });
  });

  it('finds the problem of a field or of anything under it', () => {
    const problems = problemsOf([
      { path: '/voice/routing/ringAlso/1', code: 'unavailable_member', message: 'Gone.' },
    ]);
    expect(problemAt(problems, '/voice/routing/ringAlso')).toEqual({
      code: 'unavailable_member',
      message: 'Gone.',
    });
    expect(problemAt(problems, '/voice/routing/ring')).toBeUndefined();
  });
});

describe('routing choices', () => {
  it('takes the new first person off the people rung beside them', () => {
    const routing = { ...voice().routing, ringAlso: [dana, lee] };
    expect(withPrimary(routing, dana)).toEqual({
      ...routing,
      primaryMemberId: dana,
      ringAlso: [lee],
    });
    expect(withPrimary(routing, null)).toEqual({ ...routing, primaryMemberId: null });
  });

  it('allows six more people and no more', () => {
    expect(MAX_RING_ALSO).toBe(6);
    expect(canRingMore(['a', 'b', 'c', 'd', 'e'])).toBe(true);
    expect(canRingMore(['a', 'b', 'c', 'd', 'e', 'f'])).toBe(false);
  });

  it('stops the announcement when recording stops', () => {
    const recording = { enabled: true, announcement: { enabled: true, message: 'Recorded.' } };
    expect(withRecording(recording, false)).toEqual({
      enabled: false,
      announcement: { enabled: false, message: 'Recorded.' },
    });
    expect(withRecording({ ...recording, enabled: false }, true)).toEqual({
      enabled: true,
      announcement: { enabled: true, message: 'Recorded.' },
    });
  });

  it('says where a call goes first', () => {
    const routing = voice().routing;
    expect(destinationOf(null)).toEqual({ kind: 'no_voice' });
    expect(destinationOf({ ...voice(), routing: { ...routing, primaryMemberId: dana } })).toEqual({
      kind: 'member',
      memberId: dana,
    });
    expect(
      destinationOf({ ...voice(), routing: { ...routing, forwardTo: '+14155550199' } }),
    ).toEqual({ kind: 'forward', e164: '+14155550199' });
    expect(
      destinationOf({ ...voice(), routing: { ...routing, useBusinessFallback: true } }),
    ).toEqual({ kind: 'fallback' });
    expect(destinationOf(voice())).toEqual({ kind: 'voicemail' });
    expect(destinationOf({ ...voice(), routing: { ...routing, voicemailBackup: false } })).toEqual({
      kind: 'nobody',
    });
  });
});

describe('the number list', () => {
  const owner = (id: string | null): string | undefined =>
    id === dana ? 'Dana Brooks' : undefined;

  it('finds a number by its name, its digits in any format or its owner', () => {
    const number = numberOf({ ownerId: dana });
    expect(matchesSearch(number, '', owner)).toBe(true);
    expect(matchesSearch(number, '  ', owner)).toBe(true);
    expect(matchesSearch(number, 'front', owner)).toBe(true);
    expect(matchesSearch(number, '(415) 555-0123', owner)).toBe(true);
    expect(matchesSearch(number, '5550', owner)).toBe(true);
    expect(matchesSearch(number, 'dana', owner)).toBe(true);
    expect(matchesSearch(number, 'sales', owner)).toBe(false);
    expect(matchesSearch(number, '999', owner)).toBe(false);
    expect(matchesSearch(numberOf(), 'dana', owner)).toBe(false);
  });

  it('offers as the default only numbers that take calls', () => {
    const texts = numberOf({
      id: 'phn_01k8e2wzr0e008000000000002',
      capabilities: ['sms'],
      voice: null,
    });
    const calls = numberOf();
    expect(voiceNumbers([texts, calls])).toEqual([calls]);
  });
});
