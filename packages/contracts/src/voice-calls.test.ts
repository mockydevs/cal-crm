import { toPublicId } from '@repo/kernel';
import { expect, it } from 'vitest';

import { endpoints } from './api.js';
import { apiKeyReadGroups, apiKeyScopes } from './api-keys.js';
import * as publicContracts from './index.js';
import { builtInPermissions, permissionCatalog } from './permissions.js';
import {
  call,
  callDetail,
  callRequestRefusalCodes,
  getCallingAvailability,
  listCalls,
  requestCallInput,
  voiceCallEndpoints,
} from './voice-calls.js';

const UUID = '01890a5d-ac96-774b-bcce-b302099a8057';
const PRESS = 'press-0001-abcdefgh';

const record = {
  id: toPublicId('call', UUID),
  direction: 'outbound',
  state: 'requested',
  outcome: null,
  failure: null,
  phoneNumberId: toPublicId('phone_number', UUID),
  localNumber: '+14155550100',
  remoteNumber: '+14155550123',
  contactId: toPublicId('contact', UUID),
  contactIdentityId: toPublicId('contact_identity', UUID),
  membershipId: toPublicId('membership', UUID),
  needsReconciliation: false,
  hangUpRequested: false,
  createdAt: '2026-10-15T12:00:00.000Z',
  connectedAt: null,
  endedAt: null,
};

it('takes a contact phone identity and an idempotency key, the number defaulting to the business default', () => {
  const contactIdentityId = toPublicId('contact_identity', UUID);
  expect(requestCallInput.parse({ contactIdentityId, idempotencyKey: PRESS })).toEqual({
    contactIdentityId,
    phoneNumberId: null,
    idempotencyKey: PRESS,
  });
  for (const input of [
    { contactIdentityId, idempotencyKey: 'short' },
    { contactIdentityId, idempotencyKey: PRESS, to: '+14155550123' },
    { contactIdentityId: toPublicId('contact', UUID), idempotencyKey: PRESS },
  ])
    expect(requestCallInput.safeParse(input).success).toBe(false);
});

it('pages strictly by call id, at most 50 a page', () => {
  expect(listCalls.query.parse({})).toEqual({ limit: 25 });
  expect(listCalls.query.parse({ limit: '50' })).toEqual({ limit: 50 });
  for (const query of [
    { limit: 0 },
    { limit: 51 },
    { after: toPublicId('message', UUID) },
    { cursor: 'x' },
    { direction: 'both' },
  ])
    expect(listCalls.query.safeParse(query).success).toBe(false);
});

it('describes a requested call that has not connected, and a detail with its legs', () => {
  expect(call.parse(record)).toEqual(record);
  expect(call.safeParse({ ...record, state: 'connecting' }).success).toBe(false);
  expect(call.safeParse({ ...record, providerCallId: 'CA' }).success).toBe(false);
  const leg = {
    id: toPublicId('call_leg', UUID),
    parentId: null,
    party: 'remote',
    membershipId: null,
    status: 'unknown',
    providerDirection: null,
    providerCallId: null,
    durationSeconds: null,
    conflict: false,
    answeredAt: null,
    endedAt: null,
  };
  expect(callDetail.parse({ ...record, legs: [leg] }).legs).toEqual([leg]);
});

it('refuses requests with codes that never claim provider rejection', () => {
  expect(callRequestRefusalCodes).toContain('calling_unavailable');
  expect(callRequestRefusalCodes).not.toContain('provider_rejected');
});

it('publishes the call endpoints under their own group and permissions', () => {
  for (const endpoint of voiceCallEndpoints) {
    expect(endpoints).toContain(endpoint);
    expect(endpoint.group).toBe('Calls');
  }
  expect(apiKeyReadGroups).toContain('Calls');
  expect(publicContracts.requestCall).toBe(voiceCallEndpoints[2]);
  expect(permissionCatalog['calls.read'].scope).toBe('business');
  expect(permissionCatalog['calls.place'].scope).toBe('business');
  expect(apiKeyScopes).toEqual(expect.arrayContaining(['calls.read', 'calls.place']));
  // Calling contacts is daily work; reading the business's call log comes with it.
  for (const role of ['owner', 'admin', 'member'])
    expect(builtInPermissions.business[role]).toEqual(
      expect.arrayContaining(['calls.read', 'calls.place']),
    );
  expect(builtInPermissions.business['viewer']).not.toContain('calls.read');
});

it('describes calling availability as whether calls can be made now', () => {
  expect(getCallingAvailability.method).toBe('get');
  expect(getCallingAvailability.path).toBe('/calls/availability');
  expect(getCallingAvailability.group).toBe('Calls');
  expect(voiceCallEndpoints).toContain(getCallingAvailability);
});
