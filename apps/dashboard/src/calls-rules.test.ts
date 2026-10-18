import type { Call, CallState } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  CALLS_PER_PAGE,
  callsQueryOf,
  canHangUp,
  durationOf,
  durationText,
  isLive,
  stateTone,
} from './calls-rules';

const callOf = (patch: Partial<Call> = {}): Call => ({
  id: 'call_01k8e2wzr0e008000000000001',
  direction: 'outbound',
  state: 'requested',
  outcome: null,
  failure: null,
  phoneNumberId: 'phn_01k8e2wzr0e008000000000001',
  localNumber: '+14155550123',
  remoteNumber: '+14155550199',
  contactId: null,
  contactIdentityId: null,
  membershipId: null,
  needsReconciliation: false,
  hangUpRequested: false,
  createdAt: '2026-10-15T10:00:00.000Z',
  connectedAt: null,
  endedAt: null,
  ...patch,
});

describe('which calls are still going', () => {
  const live: CallState[] = ['requested', 'reserved', 'unknown', 'dialing', 'ringing', 'connected'];
  const over: CallState[] = ['ended', 'refused', 'rejected', 'canceled'];

  it('counts a call as going until it reaches an end state', () => {
    for (const state of live) expect(isLive(state)).toBe(true);
    for (const state of over) expect(isLive(state)).toBe(false);
  });

  it('offers a hang-up only for a going call nobody asked to end yet', () => {
    expect(canHangUp(callOf({ state: 'requested' }))).toBe(true);
    expect(canHangUp(callOf({ state: 'unknown' }))).toBe(true);
    expect(canHangUp(callOf({ state: 'connected', hangUpRequested: true }))).toBe(false);
    expect(canHangUp(callOf({ state: 'ended', outcome: 'completed' }))).toBe(false);
  });

  it('draws a requested call as waiting, not as connected', () => {
    expect(stateTone('requested')).toBe('neutral');
    expect(stateTone('connected')).toBe('assistant');
    expect(stateTone('unknown')).toBe('attention');
    expect(stateTone('rejected')).toBe('attention');
    expect(stateTone('ended')).toBe('neutral');
  });
});

describe('how long a call lasted', () => {
  it('counts from the answer to the end, and nothing for a call never answered', () => {
    expect(
      durationOf(
        callOf({
          connectedAt: '2026-10-15T10:00:05.000Z',
          endedAt: '2026-10-15T10:01:10.400Z',
        }),
      ),
    ).toBe(65);
    expect(durationOf(callOf({ endedAt: '2026-10-15T10:01:10.000Z' }))).toBeNull();
    expect(durationOf(callOf({ connectedAt: '2026-10-15T10:00:05.000Z' }))).toBeNull();
  });

  it('writes it as minutes and seconds, with hours when there are any', () => {
    expect(durationText(0)).toBe('0:00');
    expect(durationText(65)).toBe('1:05');
    expect(durationText(3_725)).toBe('1:02:05');
  });
});

describe('what the list asks for', () => {
  it('asks for a page by its cursor, with the filters set', () => {
    expect(CALLS_PER_PAGE).toBe(25);
    expect(callsQueryOf({ direction: '', contactId: undefined }, undefined)).toEqual({
      limit: 25,
    });
    expect(
      callsQueryOf(
        { direction: 'inbound', contactId: 'con_01k8e2wzr0e008000000000001' },
        'call_01k8e2wzr0e008000000000009',
      ),
    ).toEqual({
      limit: 25,
      direction: 'inbound',
      contactId: 'con_01k8e2wzr0e008000000000001',
      after: 'call_01k8e2wzr0e008000000000009',
    });
  });
});
