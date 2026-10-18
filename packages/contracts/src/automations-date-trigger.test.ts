import { describe, expect, it } from 'vitest';

import { automationStep, automationTrigger } from './automations.js';
import { validateAutomation, type AutomationSetup } from './automations-validate.js';
import { harborLights } from './automations-validate.test.js';

const trigger = (config: unknown) =>
  automationTrigger.safeParse({ id: 'the_day', type: 'date.reached', config });

describe('the date trigger', () => {
  it('comes round every year unless told otherwise', () => {
    expect(trigger({ field: 'contact.custom.birthday' }).data?.config).toEqual({
      field: 'contact.custom.birthday',
      direction: 'before',
      repeat: 'yearly',
    });
  });

  it('fires for the date itself only when repeat is never', () => {
    expect(
      trigger({ field: 'contact.custom.wedding_date', offset: 'P7D', repeat: 'never' }).data
        ?.config,
    ).toEqual({
      field: 'contact.custom.wedding_date',
      offset: 'P7D',
      direction: 'before',
      repeat: 'never',
    });
  });

  it('refuses a repeat it does not know', () => {
    const parsed = trigger({ field: 'contact.custom.birthday', repeat: 'monthly' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('/'))).toEqual(['config/repeat']);
  });

  it('leaves waiting until a date as it was: a wait happens once', () => {
    const wait = (config: unknown) => automationStep.safeParse({ type: 'wait.until', config });
    expect(wait({ field: 'contact.custom.wedding_date' }).success).toBe(true);
    expect(wait({ field: 'contact.custom.wedding_date', repeat: 'yearly' }).success).toBe(false);
  });
});

describe('the date trigger, checked against a business', () => {
  // Harbor Lights with a date and time field beside its date, and nothing unavailable.
  const setup: AutomationSetup = {
    ...harborLights,
    fields: {
      ...harborLights.fields,
      contact: [
        ...harborLights.fields.contact,
        { key: 'viewing_at', aliases: [], type: 'datetime', options: [] },
      ],
    },
    unavailableTriggers: [],
  };
  const check = (config: unknown, settings: unknown = { reEnrollment: 'after_finished' }) =>
    validateAutomation(
      {
        name: 'Reminder',
        triggers: [{ id: 'the_day', type: 'date.reached', config }],
        start: 'pause',
        steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
        settings,
      },
      setup,
    );

  it('accepts a date that comes round every year, in an automation a contact may go through again', () => {
    const result = check({ field: 'contact.event_date', offset: 'P3D', time: '09:00' });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.document?.triggers[0]?.config).toEqual({
      field: 'contact.custom.event_date',
      offset: 'P3D',
      direction: 'before',
      time: '09:00',
      repeat: 'yearly',
    });
  });

  it('warns that a yearly date enrols a contact once ever when the automation never takes one twice', () => {
    const result = check({ field: 'contact.custom.event_date' }, {});
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([
      {
        path: '/triggers/0/config/repeat',
        code: 'repeats_but_enrols_once',
        message:
          'This date comes round every year, but the automation takes a contact once ever. Let contacts go through again (settings.reEnrollment: after_finished), or set repeat to never.',
      },
    ]);
    expect(check({ field: 'contact.custom.event_date', repeat: 'never' }, {}).warnings).toEqual([]);
  });

  it('refuses a time of day and a yearly repeat on a date and time, which fires at its own instant once', () => {
    const result = check({ field: 'contact.custom.viewing_at', time: '09:00' });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        path: '/triggers/0/config/time',
        code: 'time_not_allowed',
        message: 'contact.custom.viewing_at is a date and time, which fires at its own time.',
        suggestion: 'Remove time, or move it with offset.',
      },
      {
        path: '/triggers/0/config/repeat',
        code: 'repeat_not_allowed',
        message: 'contact.custom.viewing_at is a date and time, which fires once.',
        suggestion: 'Set repeat to never.',
      },
    ]);
    expect(
      check({ field: 'contact.custom.viewing_at', offset: 'PT2H', repeat: 'never' }).errors,
    ).toEqual([]);
  });
});
