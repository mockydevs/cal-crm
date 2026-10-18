import { describe, expect, it } from 'vitest';
import {
  bodyOf,
  dndOf,
  emptyAddDraft,
  isReadyToAdd,
  labelsOf,
  takenLabels,
  type AddDraft,
} from './contact-add-rules';

const draft: AddDraft = {
  ...emptyAddDraft(),
  firstName: ' Maya ',
  lastName: 'Thompson',
  emails: [
    { key: 'e1', value: 'maya@example.com' },
    { key: 'e2', value: '' },
    { key: 'e3', value: 'maya.work@example.com' },
  ],
  primaryEmail: 'e3',
  phones: [
    { key: 'p1', value: '0712 345678', label: 'mobile' },
    { key: 'p2', value: '0733 000111', label: null },
    { key: 'p3', value: ' ', label: 'home' },
  ],
  primaryPhone: 'p2',
};

describe('what the Add Contact panel sends', () => {
  it('puts the primary of each kind first and leaves blank rows out', () => {
    expect(bodyOf(draft)).toEqual({
      firstName: ' Maya ',
      lastName: 'Thompson',
      emails: ['maya.work@example.com', 'maya@example.com'],
      phones: ['0733 000111', '0712 345678'],
    });
  });

  it('names each label by the place of its number in what was sent', () => {
    expect(labelsOf(draft)).toEqual([{ index: 1, label: 'mobile' }]);
    expect(labelsOf(emptyAddDraft())).toEqual([]);
  });

  it('offers each label once: a row cannot take one another row has', () => {
    expect(takenLabels(draft, 'p2')).toEqual(['mobile', 'home']);
    expect(takenLabels(draft, 'p1')).toEqual(['home']);
  });

  it('is ready once there is a first name, and a reason when do not disturb is on', () => {
    expect(isReadyToAdd(emptyAddDraft())).toBe(false);
    expect(isReadyToAdd(draft)).toBe(true);
    expect(isReadyToAdd({ ...draft, firstName: '  ' })).toBe(false);
    expect(isReadyToAdd({ ...draft, dndChannels: ['email'] })).toBe(false);
    expect(isReadyToAdd({ ...draft, dndChannels: ['email'], dndReason: 'too short' })).toBe(false);
    expect(
      isReadyToAdd({ ...draft, dndAll: true, dndReason: 'Asked by phone not to be contacted.' }),
    ).toBe(true);
  });

  it('sends do not disturb only when something is switched on', () => {
    expect(dndOf(draft)).toBeUndefined();
    expect(
      dndOf({ ...draft, dndChannels: ['sms', 'email'], dndReason: ' Asked by phone today. ' }),
    ).toEqual({ all: false, channels: ['email', 'sms'], reason: 'Asked by phone today.' });
    expect(dndOf({ ...draft, dndAll: true, dndReason: 'Asked by phone today.' })).toEqual({
      all: true,
      channels: [],
      reason: 'Asked by phone today.',
    });
  });
});
