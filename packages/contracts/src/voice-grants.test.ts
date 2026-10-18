import { toPublicId } from '@repo/kernel';
import { expect, it } from 'vitest';
import { voiceCallEndpoints } from './voice-calls.js';
import { getVoiceGrant, requestVoiceGrant, voiceGrant } from './voice-grants.js';

const id = toPublicId('voice_grant', '01890a5d-ac96-774b-bcce-b302099a8057');

it('answers a request, then the token until it expires, or why it failed', () => {
  const states = [
    { id, status: 'requested', token: null, expiresAt: null, failure: null },
    {
      id,
      status: 'issued',
      token: 'eyJ.a.b',
      expiresAt: '2026-10-17T12:10:00.000Z',
      failure: null,
    },
    {
      id,
      status: 'failed',
      token: null,
      expiresAt: null,
      failure: { code: 'member_unavailable', message: 'You can no longer make calls here.' },
    },
  ];
  for (const state of states) expect(voiceGrant.parse(state)).toEqual(state);
});

it('takes nothing from the browser: the server decides whose token it is and for which account', () => {
  expect('body' in requestVoiceGrant).toBe(false);
  expect(getVoiceGrant.params.safeParse({ id }).success).toBe(true);
  expect(
    getVoiceGrant.params.safeParse({
      id: toPublicId('call', '01890a5d-ac96-774b-bcce-b302099a8057'),
    }).success,
  ).toBe(false);
});

it('refuses a status or failure it does not know, and an empty token', () => {
  const base = { id, token: null, expiresAt: null, failure: null };
  expect(voiceGrant.safeParse({ ...base, status: 'delivered' }).success).toBe(false);
  expect(voiceGrant.safeParse({ ...base, status: 'issued', token: '' }).success).toBe(false);
  expect(
    voiceGrant.safeParse({
      ...base,
      status: 'failed',
      failure: { code: 'timeout', message: 'x' },
    }).success,
  ).toBe(false);
});

it('is among the calls endpoints', () => {
  expect(voiceCallEndpoints).toContain(requestVoiceGrant);
  expect(voiceCallEndpoints).toContain(getVoiceGrant);
});
