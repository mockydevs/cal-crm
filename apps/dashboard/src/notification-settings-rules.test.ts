import { describe, expect, it } from 'vitest';
import { reminderDraftOf, reminderMinutesOf } from './notification-settings-rules';

describe('a task reminder time', () => {
  it('reads in the largest unit it fills', () => {
    expect(reminderDraftOf(null)).toEqual({ amount: '', unit: 'minutes' });
    expect(reminderDraftOf(15)).toEqual({ amount: '15', unit: 'minutes' });
    expect(reminderDraftOf(90)).toEqual({ amount: '90', unit: 'minutes' });
    expect(reminderDraftOf(120)).toEqual({ amount: '2', unit: 'hours' });
    expect(reminderDraftOf(2880)).toEqual({ amount: '2', unit: 'days' });
  });

  it('is sent in minutes, none when empty, up to 30 days', () => {
    expect(reminderMinutesOf({ amount: '', unit: 'hours' })).toBeNull();
    expect(reminderMinutesOf({ amount: ' 30 ', unit: 'minutes' })).toBe(30);
    expect(reminderMinutesOf({ amount: '3', unit: 'hours' })).toBe(180);
    expect(reminderMinutesOf({ amount: '30', unit: 'days' })).toBe(43_200);
  });

  it('cannot be sent when it is not a whole number in range', () => {
    expect(reminderMinutesOf({ amount: '0', unit: 'minutes' })).toBeUndefined();
    expect(reminderMinutesOf({ amount: '1.5', unit: 'hours' })).toBeUndefined();
    expect(reminderMinutesOf({ amount: '31', unit: 'days' })).toBeUndefined();
    expect(reminderMinutesOf({ amount: 'soon', unit: 'days' })).toBeUndefined();
  });
});
