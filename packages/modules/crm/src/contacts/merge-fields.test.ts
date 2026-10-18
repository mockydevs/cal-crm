import { describe, expect, it } from 'vitest';

import { combinedScore, oldest, sourceOf, strictestDnd } from './merge-fields.js';

const choice = (holders: string[], chosen?: string) => ({
  survivorId: 'kept',
  mergeIds: ['second', 'third'],
  holders: new Set(holders),
  chosen,
});

describe('which value a field keeps', () => {
  it("keeps the contact kept's own value when it has one", () => {
    expect(sourceOf(choice(['kept', 'second', 'third']))).toBe('kept');
  });

  it('takes the first value of the others, in the order named, when it has none', () => {
    expect(sourceOf(choice(['third', 'second']))).toBe('second');
    expect(sourceOf(choice(['third']))).toBe('third');
  });

  it('keeps nothing when no contact has a value', () => {
    expect(sourceOf(choice([]))).toBeNull();
  });

  it('keeps the value picked, even an empty one', () => {
    expect(sourceOf(choice(['kept', 'third'], 'third'))).toBe('third');
    expect(sourceOf(choice(['kept'], 'second'))).toBe('second');
    expect(sourceOf(choice(['kept', 'second'], 'kept'))).toBe('kept');
  });
});

describe('do not disturb', () => {
  it('keeps every opt-out of every contact', () => {
    expect(
      strictestDnd([
        { doNotContact: false, channels: ['sms'], inbound: false },
        { doNotContact: true, channels: ['whatsapp', 'email', 'sms'], inbound: false },
        { doNotContact: false, channels: [], inbound: true },
      ]),
    ).toEqual({ doNotContact: true, channels: ['email', 'sms', 'whatsapp'], inbound: true });
  });

  it('stays off when no contact opted out', () => {
    expect(
      strictestDnd([
        { doNotContact: false, channels: [], inbound: false },
        { doNotContact: false, channels: [], inbound: false },
      ]),
    ).toEqual({ doNotContact: false, channels: [], inbound: false });
  });
});

describe('creation', () => {
  it('is the oldest contact’s, the earlier id on a tie', () => {
    const at = (iso: string) => new Date(iso);
    expect(
      oldest([
        { id: 'b', createdAt: at('2026-05-01T00:00:00Z') },
        { id: 'c', createdAt: at('2026-01-01T00:00:00Z') },
        { id: 'a', createdAt: at('2026-03-01T00:00:00Z') },
      ]).id,
    ).toBe('c');
    expect(
      oldest([
        { id: 'b', createdAt: at('2026-01-01T00:00:00Z') },
        { id: 'a', createdAt: at('2026-01-01T00:00:00Z') },
      ]).id,
    ).toBe('a');
  });
});

describe('the score', () => {
  it('adds up what every contact scored, within its bounds', () => {
    expect(combinedScore([10, null, -3], 100)).toBe(7);
    expect(combinedScore([90, 40], 100)).toBe(100);
    expect(combinedScore([-90, -40], 100)).toBe(-100);
  });

  it('is none when no contact was scored', () => {
    expect(combinedScore([null, null], 100)).toBeNull();
  });
});
