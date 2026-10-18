// The recipe "Appointment reminders", the appointment's merge fields, the transactional
// purpose of a workflow message and the second version of wait.appointment, as the
// validator and the catalog see them.
import { describe, expect, it } from 'vitest';

import {
  APPOINTMENT_REMINDERS_RECIPE_NAME,
  appointmentRemindersRecipe,
  MAX_REMINDER_CALENDARS,
} from './automations-recipes.js';
import { automationStepTypes } from './automations-catalog.js';
import { automationCatalog } from './automations.js';
import {
  AUTOMATION_APPOINTMENT_STATUSES,
  automationAppointmentFields,
  validateAutomation,
  type AutomationSetup,
} from './automations-validate.js';
import { appointmentStatuses } from './calendar-events.js';

it('offers the statuses the calendar keeps, each once', () => {
  expect(AUTOMATION_APPOINTMENT_STATUSES.map((status) => status.key)).toEqual([
    ...appointmentStatuses,
  ]);
});

const setup: AutomationSetup = {
  fields: { contact: [], deal: [] },
  forms: [{ id: 'form_enquiry', name: 'Enquiry' }],
  emailTemplates: [],
  whatsappTemplates: [],
  mailboxes: [],
  phoneNumbers: [],
  calendars: [
    { id: 'cal_visits', name: 'Visits' },
    { id: 'cal_calls', name: 'Calls' },
  ],
  pipelines: [],
  lostReasons: [],
  tags: [],
  users: [],
  automations: [],
  values: [],
  channels: { email: true, sms: true, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
  postalAddress: false,
};

const booked = { id: 'booked', type: 'appointment.booked', config: {} };

const document = (steps: Record<string, unknown>, triggers: readonly unknown[] = [booked]) => ({
  name: 'Reminders',
  triggers,
  start: Object.keys(steps)[0],
  steps,
});

const codes = (result: ReturnType<typeof validateAutomation>) =>
  result.errors.map((issue) => [issue.path, issue.code]);

describe('the recipe "Appointment reminders"', () => {
  it('waits for 24 hours and 1 hour before, and emails each time, as transactional mail', () => {
    const result = validateAutomation(appointmentRemindersRecipe(), setup);
    expect(result.errors).toEqual([]);
    // A transactional email is not marketing: no postal address is asked of it.
    expect(result.warnings).toEqual([]);
    const made = result.document;
    expect(made?.name).toBe(APPOINTMENT_REMINDERS_RECIPE_NAME);
    expect(made?.triggers).toEqual([{ id: 'booked', type: 'appointment.booked', config: {} }]);
    expect(made?.settings.reEnrollment).toBe('after_finished');
    expect(Object.keys(made?.steps ?? {})).toEqual([
      'wait_day_before',
      'email_day_before',
      'wait_hour_before',
      'email_hour_before',
    ]);
    expect(made?.steps['wait_day_before']).toMatchObject({
      type: 'wait.appointment',
      typeVersion: 2,
      config: { offset: 'PT24H', direction: 'before' },
      // Booked less than a day ahead: no late first reminder, on to the hour before.
      next: { reached: 'email_day_before', passed: 'wait_hour_before' },
    });
    expect(made?.steps['wait_hour_before']).toMatchObject({
      config: { offset: 'PT1H', direction: 'before' },
      next: { reached: 'email_hour_before' },
    });
    for (const key of ['email_day_before', 'email_hour_before'])
      expect(made?.steps[key]).toMatchObject({
        type: 'email.send',
        onFailure: 'continue',
        config: { purpose: 'transactional' },
      });
    const body = String((made?.steps['email_day_before']?.config as { body?: unknown }).body);
    expect(body).toContain('{{appointment.startTime}}');
    expect(body).toContain('{{appointment.title}}');
    expect(body).toContain('{{appointment.location | default: "as in your booking confirmation"}}');
    // The booking's own confirmation is not sent again.
    expect(JSON.stringify(made?.steps)).not.toMatch(/is booked/);
  });

  it('starts for the calendars chosen, one trigger each, by their ids', () => {
    const result = validateAutomation(
      appointmentRemindersRecipe({ name: 'Visit reminders', calendars: ['Visits', 'cal_calls'] }),
      setup,
    );
    expect(result.errors).toEqual([]);
    expect(result.document?.name).toBe('Visit reminders');
    expect(result.document?.triggers).toEqual([
      { id: 'booked', type: 'appointment.booked', config: { calendar: 'cal_visits' } },
      { id: 'booked_2', type: 'appointment.booked', config: { calendar: 'cal_calls' } },
    ]);
    const many = appointmentRemindersRecipe({
      calendars: Array.from(
        { length: MAX_REMINDER_CALENDARS + 5 },
        (_, index) => `c${String(index)}`,
      ),
    });
    expect(many.triggers).toHaveLength(MAX_REMINDER_CALENDARS);
    expect(appointmentRemindersRecipe({ calendars: ['a', 'a'] }).triggers).toHaveLength(1);
  });

  it('adds a text an hour before only when asked, for a contact with a phone number', () => {
    const result = validateAutomation(appointmentRemindersRecipe({ text: true }), setup);
    expect(result.errors).toEqual([]);
    const steps = result.document?.steps ?? {};
    expect(steps['email_hour_before']?.next).toBe('has_phone');
    expect(steps['has_phone']).toMatchObject({
      type: 'condition',
      config: { if: { field: 'contact.phone', operator: 'is_set' } },
      next: { yes: 'text_hour_before' },
    });
    expect(steps['text_hour_before']).toMatchObject({
      type: 'sms.send',
      onFailure: 'continue',
      config: { purpose: 'transactional' },
    });
    expect(String((steps['text_hour_before']?.config as { message?: unknown }).message)).toMatch(
      /STOP/,
    );
    expect(appointmentRemindersRecipe({ text: false }).steps['text_hour_before']).toBeUndefined();
    // Without a number that can text, the text step could never send: the dialog offers it
    // only when one is connected, and the validator says so of a draft that has it anyway.
    const noNumber = validateAutomation(appointmentRemindersRecipe({ text: true }), {
      ...setup,
      channels: { ...setup.channels, sms: false },
    });
    expect(codes(noNumber)).toEqual([['/steps/text_hour_before', 'no_provider']]);
  });
});

describe('a transactional workflow message', () => {
  const email = {
    type: 'email.send',
    config: { purpose: 'transactional', subject: 'Soon', body: 'See you.' },
  };
  const text = { type: 'sms.send', config: { purpose: 'transactional', message: 'See you.' } };

  it('is allowed only when every trigger is about an appointment', () => {
    expect(validateAutomation(document({ email }), setup).errors).toEqual([]);
    expect(
      validateAutomation(
        document({ text }, [
          booked,
          { id: 'changed', type: 'appointment.status_changed', config: {} },
        ]),
        setup,
      ).errors,
    ).toEqual([]);
    const form = { id: 'sent', type: 'form.submitted', config: {} };
    expect(codes(validateAutomation(document({ email }, [booked, form]), setup))).toEqual([
      ['/steps/email/config/purpose', 'transactional_needs_appointment'],
    ]);
    // Started only by another workflow, a run is about no appointment.
    expect(codes(validateAutomation(document({ text }, []), setup))).toEqual([
      ['/steps/text/config/purpose', 'transactional_needs_appointment'],
    ]);
  });

  it('is marketing when the purpose is left out, as every workflow message was', () => {
    const marketing = validateAutomation(
      document({ email: { type: 'email.send', config: { subject: 'Hi', body: 'Hello.' } } }),
      setup,
    );
    expect(marketing.errors).toEqual([]);
    expect(marketing.warnings.map((issue) => issue.code)).toEqual([
      'no_postal_address',
      'no_follow_up',
    ]);
    expect(
      validateAutomation(
        document({ email: { ...email, config: { ...email.config, purpose: 'promotional' } } }),
        setup,
      ).valid,
    ).toBe(false);
  });
});

describe('the appointment’s merge fields', () => {
  const sending = (body: string) =>
    validateAutomation(
      document({ text: { type: 'sms.send', config: { purpose: 'transactional', message: body } } }),
      setup,
    );

  it('are read in messages and conditions, and never written', () => {
    expect(Object.keys(automationAppointmentFields)).toEqual([
      'title',
      'startTime',
      'startsAt',
      'calendar',
      'location',
      'status',
      'manageUrl',
    ]);
    expect(
      sending(
        '{{appointment.title}} {{appointment.startTime}} {{appointment.calendar}} {{appointment.location}} {{appointment.startsAt}} {{appointment.status}} {{appointment.manageUrl | default: "reply here"}}',
      ).errors,
    ).toEqual([]);
    const typo = sending('{{appointment.startTim}}');
    expect(typo.errors).toMatchObject([
      {
        code: 'unknown_merge_field',
        message: 'appointment.startTim is not a field.',
        suggestion: 'Did you mean appointment.startTime?',
      },
    ]);
    expect(sending('{{appointment.calendar.name}}').errors.map((issue) => issue.code)).toEqual([
      'unknown_merge_field',
    ]);
    const condition = validateAutomation(
      document({
        check: {
          type: 'condition',
          config: { if: { field: 'appointment.status', operator: 'equals', value: 'no_show' } },
          next: { yes: 'wait' },
        },
        wait: { type: 'wait', config: { duration: 'PT1H' } },
      }),
      setup,
    );
    expect(condition.errors).toEqual([]);
    const badStatus = validateAutomation(
      document({
        check: {
          type: 'condition',
          config: { if: { field: 'appointment.status', operator: 'equals', value: 'showed' } },
        },
      }),
      setup,
    );
    expect(badStatus.valid).toBe(false);
    const written = validateAutomation(
      document({
        set: { type: 'contact.update', config: { fields: { 'appointment.title': 'Nope' } } },
      }),
      setup,
    );
    expect(written.valid).toBe(false);
  });
});

describe('wait.appointment, version 2', () => {
  it('is at version 2 and says that a no-show ends the wait as a cancellation does', () => {
    expect(automationStepTypes['wait.appointment'].version).toBe(2);
    const listed = automationCatalog().steps.find((each) => each.type === 'wait.appointment');
    expect(listed?.description).toMatch(/cancelled, marked no-show or invalid/);
  });
});
