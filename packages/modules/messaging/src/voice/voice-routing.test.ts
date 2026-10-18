import type { PhoneNumberVoiceSettings } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { resolveInboundRoute } from './voice-routing.js';

const voice: PhoneNumberVoiceSettings = {
  recording: { enabled: false, announcement: { enabled: false, message: null } },
  routing: {
    primaryMemberId: 'primary',
    forwardTo: '+12025550103',
    useBusinessFallback: true,
    ringAlso: ['also'],
    ringTimeoutSeconds: 20,
    voicemailBackup: true,
  },
  advanced: {
    callConnectConfirmation: false,
    whisper: { enabled: false, message: null },
    forwardedCallerId: 'caller',
    preferContactOwner: true,
  },
};
const input = {
  number: {
    ownerId: 'owner',
    voice,
    e164: '+12025550101',
    status: 'active' as const,
    capabilities: ['voice'],
  },
  inbound: {
    preferAssignedUser: true,
    allowAnonymousCallers: true,
    fallbackNumber: '+12025550104',
  },
  caller: '+12025550102',
  contactOwnerMembershipId: 'contact_owner',
  connectionReady: true,
  members: new Map([
    ['contact_owner', 'contact_device'],
    ['owner', 'owner_device'],
    ['primary', 'primary_device'],
    ['also', 'also_device'],
  ]),
  ownNumbers: ['+12025550101', '+12025550105'],
};

describe('inbound call routing from saved settings', () => {
  it('orders contact owner, assigned owner, parallel group, external forward and fallback', () => {
    expect(resolveInboundRoute(input)).toEqual({
      outcome: 'route',
      voicemail: true,
      timeoutSeconds: 15,
      callerId: input.caller,
      steps: [
        [{ kind: 'client', address: 'contact_device', membershipId: 'contact_owner' }],
        [{ kind: 'client', address: 'owner_device', membershipId: 'owner' }],
        [
          { kind: 'client', address: 'primary_device', membershipId: 'primary' },
          { kind: 'client', address: 'also_device', membershipId: 'also' },
        ],
        [{ kind: 'number', address: '+12025550103' }],
        [{ kind: 'number', address: '+12025550104' }],
      ],
    });
  });
  it('rings each identity once, skips unavailable members and suppresses own-number loops', () => {
    const plan = resolveInboundRoute({
      ...input,
      contactOwnerMembershipId: 'owner',
      members: new Map([
        ['owner', 'same_device'],
        ['primary', 'same_device'],
        ['also', 'also_device'],
      ]),
      ownNumbers: [...input.ownNumbers, '+12025550103', '+12025550104'],
    });
    expect(plan).toMatchObject({
      outcome: 'route',
      steps: [
        [{ kind: 'client', address: 'same_device', membershipId: 'owner' }],
        [{ kind: 'client', address: 'also_device', membershipId: 'also' }],
      ],
    });
  });
  it('deduplicates external forwarding and falls back directly to voicemail without live devices', () => {
    expect(
      resolveInboundRoute({
        ...input,
        members: new Map(),
        inbound: { ...input.inbound, fallbackNumber: voice.routing.forwardTo },
      }),
    ).toMatchObject({
      outcome: 'route',
      steps: [[{ kind: 'number', address: voice.routing.forwardTo }]],
    });
    expect(
      resolveInboundRoute({
        ...input,
        members: new Map(),
        ownNumbers: [
          ...input.ownNumbers,
          voice.routing.forwardTo ?? '',
          input.inbound.fallbackNumber,
        ],
      }),
    ).toMatchObject({ outcome: 'route', steps: [], voicemail: true });
  });
  it.each(['paused', 'failing', 'disconnected'] as const)(
    'refuses a number in state %s',
    (status) => {
      expect(resolveInboundRoute({ ...input, number: { ...input.number, status } })).toEqual({
        outcome: 'refused',
        reason: 'number_unavailable',
      });
    },
  );
  it('refuses disconnected, texts-only and missing voice configuration', () => {
    expect(resolveInboundRoute({ ...input, connectionReady: false })).toMatchObject({
      outcome: 'refused',
    });
    expect(
      resolveInboundRoute({ ...input, number: { ...input.number, capabilities: ['sms'] } }),
    ).toMatchObject({ outcome: 'refused' });
    expect(
      resolveInboundRoute({ ...input, number: { ...input.number, voice: null } }),
    ).toMatchObject({ outcome: 'refused' });
  });
  it('enforces anonymous policy while allowing browser identities', () => {
    const anonymous = {
      ...input,
      caller: 'anonymous',
      inbound: { ...input.inbound, allowAnonymousCallers: false },
    };
    expect(resolveInboundRoute(anonymous)).toEqual({
      outcome: 'refused',
      reason: 'anonymous_caller',
    });
    expect(resolveInboundRoute({ ...anonymous, caller: 'client:trusted_device' })).toMatchObject({
      outcome: 'route',
      callerId: input.number.e164,
    });
    expect(resolveInboundRoute({ ...input, caller: 'unknown' })).toMatchObject({
      outcome: 'route',
      callerId: input.number.e164,
    });
  });
  it('honors disabled priorities, business caller ID, fallback and voicemail settings', () => {
    expect(
      resolveInboundRoute({
        ...input,
        inbound: { ...input.inbound, preferAssignedUser: false },
        number: {
          ...input.number,
          voice: {
            ...voice,
            advanced: {
              ...voice.advanced,
              preferContactOwner: false,
              forwardedCallerId: 'business_number',
            },
            routing: {
              ...voice.routing,
              useBusinessFallback: false,
              voicemailBackup: false,
              ringTimeoutSeconds: 5,
            },
          },
        },
      }),
    ).toMatchObject({
      outcome: 'route',
      timeoutSeconds: 5,
      callerId: input.number.e164,
      voicemail: false,
      steps: [
        [
          { kind: 'client', address: 'primary_device', membershipId: 'primary' },
          { kind: 'client', address: 'also_device', membershipId: 'also' },
        ],
        [{ kind: 'number', address: voice.routing.forwardTo }],
      ],
    });
  });
});
