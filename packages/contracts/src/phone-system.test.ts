import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import type * as z from 'zod';
import * as publicContracts from './index.js';

import {
  listPhoneSystemMembers,
  phoneSystemMemberList,
  phoneNumberSettings,
  phoneSystemEndpoints,
  phoneSystemSettings,
  updatePhoneNumberSettingsInput,
  updatePhoneSystemSettingsInput,
} from './phone-system.js';

it('bounds eligible-member pages and validates membership cursors', () => {
  expect(listPhoneSystemMembers.query.parse({})).toEqual({ limit: 100 });
  for (const query of [{ limit: 0 }, { limit: 101 }, { after: 'invalid' }])
    expect(listPhoneSystemMembers.query.safeParse(query).success).toBe(false);
  expect(phoneSystemMemberList.safeParse({ data: [], nextCursor: null }).success).toBe(true);
});

const UUID = '01890a5d-ac96-774b-bcce-b302099a8057';
const OTHER = '01890a5d-ac96-774b-bcce-b302099a8058';
const REVISION = 'a'.repeat(64);
const member = toPublicId('membership', UUID);
const otherMember = toPublicId('membership', OTHER);

const businessInput = {
  defaultNumberId: toPublicId('phone_number', UUID),
  inbound: {
    preferAssignedUser: true,
    allowAnonymousCallers: false,
    fallbackNumber: '+14155550123',
  },
  outbound: {
    callerId: 'local_presence',
    connectAgent: 'after_announcement',
    quietHoursWarning: true,
  },
  recording: { retentionDays: 90, transcriptionEnabled: true },
  missedCallText: { enabled: true, message: ' Sorry we missed you. ' },
  revision: REVISION,
};

const voice = {
  recording: { enabled: true, announcement: { enabled: true, message: 'This call is recorded.' } },
  routing: {
    primaryMemberId: member,
    forwardTo: '+14155550199',
    useBusinessFallback: true,
    ringAlso: [otherMember],
    ringTimeoutSeconds: 20,
    voicemailBackup: true,
  },
  advanced: {
    callConnectConfirmation: true,
    whisper: { enabled: true, message: 'Call from the website number.' },
    forwardedCallerId: 'caller',
    preferContactOwner: false,
  },
};
const numberInput = { name: ' Main line ', ownerId: member, voice, revision: REVISION };

const codes = (result: z.ZodSafeParseResult<unknown>): unknown[] =>
  (result.error?.issues ?? []).map((issue) => {
    const params: unknown = Reflect.get(issue, 'params');
    const code: unknown =
      typeof params === 'object' && params !== null ? Reflect.get(params, 'code') : undefined;
    return code;
  });

describe('phone system settings', () => {
  it('takes the calling defaults, trimming the missed-call text', () => {
    expect(updatePhoneSystemSettingsInput.parse(businessInput).missedCallText.message).toBe(
      'Sorry we missed you.',
    );
  });

  it('needs the missed-call text when the text is on, and not when it is off', () => {
    const missing = { ...businessInput, missedCallText: { enabled: true, message: null } };
    expect(codes(updatePhoneSystemSettingsInput.safeParse(missing))).toEqual(['message_required']);
    expect(
      updatePhoneSystemSettingsInput.safeParse({
        ...businessInput,
        missedCallText: { enabled: false, message: null },
      }).success,
    ).toBe(true);
  });

  it('refuses a fallback that is no full international number, and retention out of range', () => {
    for (const change of [
      { inbound: { ...businessInput.inbound, fallbackNumber: '0712345678' } },
      { recording: { retentionDays: 0, transcriptionEnabled: false } },
      { recording: { retentionDays: 3651, transcriptionEnabled: false } },
      { outbound: { ...businessInput.outbound, callerId: 'random' } },
    ])
      expect(
        updatePhoneSystemSettingsInput.safeParse({ ...businessInput, ...change }).success,
      ).toBe(false);
  });

  it('answers whether calls can be made, with a reason when they cannot', () => {
    const { revision: _revision, ...fields } = businessInput;
    expect(
      phoneSystemSettings.parse({
        ...updatePhoneSystemSettingsInput.parse(businessInput),
        ...fields,
        missedCallText: { enabled: true, message: 'Sorry we missed you.' },
        revision: REVISION,
        calling: {
          available: false,
          unavailable: { code: 'calling_not_set_up', message: 'Not yet.' },
        },
      }).calling.available,
    ).toBe(false);
  });
});

describe('phone number settings', () => {
  it('takes a number’s name, owner and call handling', () => {
    expect(updatePhoneNumberSettingsInput.parse(numberInput).name).toBe('Main line');
    expect(
      updatePhoneNumberSettingsInput.safeParse({ ...numberInput, voice: null, ownerId: null })
        .success,
    ).toBe(true);
  });

  it('refuses an announcement without recording, and messages that are turned on but empty', () => {
    const cases: [unknown, string][] = [
      [
        { ...voice, recording: { enabled: false, announcement: voice.recording.announcement } },
        'recording_required',
      ],
      [
        { ...voice, recording: { enabled: true, announcement: { enabled: true, message: null } } },
        'message_required',
      ],
      [
        { ...voice, advanced: { ...voice.advanced, whisper: { enabled: true, message: null } } },
        'message_required',
      ],
    ];
    for (const [changed, code] of cases)
      expect(
        codes(updatePhoneNumberSettingsInput.safeParse({ ...numberInput, voice: changed })),
      ).toEqual([code]);
  });

  it('rings each person once, the first person included, and at most six more', () => {
    const routing = (ringAlso: string[]) => ({
      ...numberInput,
      voice: { ...voice, routing: { ...voice.routing, ringAlso } },
    });
    expect(
      codes(updatePhoneNumberSettingsInput.safeParse(routing([otherMember, otherMember]))),
    ).toEqual(['duplicate_member']);
    expect(codes(updatePhoneNumberSettingsInput.safeParse(routing([member])))).toEqual([
      'duplicate_member',
    ]);
    const seven = Array.from({ length: 7 }, (_, index) =>
      toPublicId('membership', `01890a5d-ac96-774b-bcce-b302099a80${String(60 + index)}`),
    );
    expect(updatePhoneNumberSettingsInput.safeParse(routing(seven)).success).toBe(false);
    expect(updatePhoneNumberSettingsInput.safeParse(routing(seven.slice(0, 6))).success).toBe(true);
  });

  it('keeps the ring timeout between 5 and 120 seconds', () => {
    for (const [seconds, valid] of [
      [4, false],
      [5, true],
      [120, true],
      [121, false],
    ] as const)
      expect(
        updatePhoneNumberSettingsInput.safeParse({
          ...numberInput,
          voice: { ...voice, routing: { ...voice.routing, ringTimeoutSeconds: seconds } },
        }).success,
      ).toBe(valid);
  });

  it('describes a number with its warnings', () => {
    const { revision: _revision, ...fields } = numberInput;
    expect(
      phoneNumberSettings.parse({
        ...fields,
        name: 'Main line',
        id: toPublicId('phone_number', UUID),
        e164: '+14155550100',
        capabilities: ['sms', 'voice'],
        status: 'active',
        isDefault: true,
        revision: REVISION,
        warnings: ['member_left'],
      }).warnings,
    ).toEqual(['member_left']);
  });
});

describe('phone system endpoints', () => {
  it('are published once each in one group, through the canonical package', () => {
    for (const endpoint of phoneSystemEndpoints) {
      expect(publicContracts).toHaveProperty(endpoint.operationId, endpoint);
      expect(
        publicContracts.endpoints.filter((each) => each.operationId === endpoint.operationId),
      ).toEqual([endpoint]);
    }
    expect(
      publicContracts.endpoints
        .filter((endpoint) => endpoint.group === 'Phone System')
        .map((endpoint) => endpoint.operationId),
    ).toEqual(phoneSystemEndpoints.map((endpoint) => endpoint.operationId));
    const paths = phoneSystemEndpoints.map((each) => `${each.method} ${each.path}`);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('read and save settings and set up calling: nothing buys, releases or calls', () => {
    expect(phoneSystemEndpoints.map((each) => each.method)).toEqual([
      'get',
      'get',
      'put',
      'get',
      'get',
      'put',
      'get',
      'post',
    ]);
    expect(
      phoneSystemEndpoints.filter((each) => each.method === 'post').map((each) => each.path),
    ).toEqual(['/sms-connections/{id}/calling-setup']);
  });
});
