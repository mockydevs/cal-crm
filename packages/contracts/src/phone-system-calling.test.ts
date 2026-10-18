import { toPublicId } from '@repo/kernel';
import { expect, it } from 'vitest';
import {
  callingSetup,
  callingSetupList,
  listCallingSetups,
  setUpCalling,
} from './phone-system-calling.js';
import { phoneSystemEndpoints, phoneSystemSettings } from './phone-system.js';

const connectionId = toPublicId('sms_connection', '01890a5d-ac96-774b-bcce-b302099a8057');
const at = '2026-10-17T12:00:00.000Z';
const account = {
  connectionId,
  label: 'Main',
  connectionStatus: 'connected',
  voiceNumbers: 1,
  canSetUp: false,
} as const;

it('shows an account never set up, one in progress, one ready and one that failed', () => {
  const states = [
    { ...account, setup: null, canSetUp: true },
    { ...account, setup: { status: 'creating', failure: null, requestedAt: at, finishedAt: null } },
    { ...account, setup: { status: 'ready', failure: null, requestedAt: at, finishedAt: at } },
    {
      ...account,
      canSetUp: true,
      setup: {
        status: 'failed',
        failure: {
          code: 'provider_rejected',
          providerErrorCode: 20003,
          message: 'Twilio refused.',
        },
        requestedAt: at,
        finishedAt: at,
      },
    },
  ];
  for (const state of states) expect(callingSetup.parse(state)).toEqual(state);
  expect(callingSetupList.parse({ data: states }).data).toHaveLength(4);
});

it('never names a key or its secret', () => {
  expect(
    callingSetup.safeParse({
      ...account,
      setup: { status: 'ready', failure: null, requestedAt: at, finishedAt: at, keySid: 'SK1' },
    }).success,
  ).toBe(false);
  expect(Object.keys(callingSetup.shape)).not.toContain('keySid');
});

it('refuses a status or a failure it does not know', () => {
  const base = { ...account, setup: { failure: null, requestedAt: at, finishedAt: null } };
  expect(
    callingSetup.safeParse({ ...base, setup: { ...base.setup, status: 'done' } }).success,
  ).toBe(false);
  expect(
    callingSetup.safeParse({
      ...base,
      setup: {
        ...base.setup,
        status: 'failed',
        failure: { code: 'timeout', providerErrorCode: null, message: 'x' },
      },
    }).success,
  ).toBe(false);
});

it('sets up on one connection, named by its id, and lists every account', () => {
  expect(setUpCalling.params.parse({ id: connectionId })).toEqual({ id: connectionId });
  expect(
    setUpCalling.params.safeParse({
      id: toPublicId('phone_number', '01890a5d-ac96-774b-bcce-b302099a8057'),
    }).success,
  ).toBe(false);
  expect(phoneSystemEndpoints).toContain(listCallingSetups);
  expect(phoneSystemEndpoints).toContain(setUpCalling);
});

it('says setting up is what is missing, in the order a business can act on it', () => {
  const settings = phoneSystemSettings.shape.calling.shape.unavailable.unwrap().shape.code.options;
  expect(settings).toEqual([
    'no_voice_number',
    'calling_not_set_up',
    'calling_setup_pending',
    'calling_setup_failed',
    'calling_setup_unknown',
  ]);
});
