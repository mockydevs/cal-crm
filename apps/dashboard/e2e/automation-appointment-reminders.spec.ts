// "Appointment reminders" from "Start from a recipe" (docs/AUTOMATIONS.md section 9): the
// recipe is picked from the list, or opened by the address a calendar's Notifications link
// to with that calendar chosen; the draft made is valid in the business, emails 24 hours and
// 1 hour before as transactional mail, and opens in the builder. The API is stood in for by
// the in-memory one in automation-api.ts.
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createAutomationInput, validateAutomation } from '@repo/contracts';
import {
  automationsApi,
  builderAt,
  expectNoSidewaysScroll,
  expectNoViolations,
  world,
  type World,
} from './automation-api';
import { harborSetup } from './automation-fixtures';
import { inHarbor, signedIn } from './session';

const shots = path.join(import.meta.dirname, '..', 'reports', 'appointment-reminders');
mkdirSync(shots, { recursive: true });
const shot = (name: string): string => path.join(shots, name);

// A calendar whose id the address can carry.
const TOUR = 'cal_01h455vb4pex5vsknk084sn02q';
const withTour = (): World =>
  world({
    automations: [],
    setup: {
      ...harborSetup,
      calendars: [...harborSetup.calendars, { id: TOUR, name: 'Venue tour' }],
    },
  });

const created = (state: World) =>
  createAutomationInput.parse(
    state.writes.find((write) => write.method === 'POST' && write.path === '')?.body,
  ).document;

for (const width of [360, 1440])
  test.describe(`appointment reminders at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 1000 } });

    test('picks the recipe, chooses a calendar and a text, and opens the draft', async ({
      page,
    }) => {
      const state = withTour();
      await signedIn(page);
      await automationsApi(page, state);
      await page.goto(inHarbor('/automations'));
      await page.getByRole('button', { name: 'Start from a recipe', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Start from a recipe', exact: true });
      await dialog.getByRole('button', { name: 'Appointment reminders', exact: true }).click();
      await expect(
        dialog.getByRole('heading', { name: 'Appointment reminders', exact: true }),
      ).toBeVisible();
      await expect(dialog.getByRole('listitem')).toHaveText([
        "Starts when an appointment is booked on the calendars you choose. The booking's own confirmation is not sent again.",
        'Waits until 24 hours before the appointment and emails a reminder. A booking made less than a day ahead skips this one.',
        'Waits until 1 hour before and emails again, with a text too if you choose.',
        'A reschedule moves both reminders; a cancellation or a no-show stops them.',
        'The reminders are transactional: they go to people who agreed to booking notifications, without a marketing footer.',
      ]);
      const calendars = dialog.getByRole('group', { name: 'Calendars it reminds for' });
      const consultation = calendars.getByRole('checkbox', { name: 'Consultation', exact: true });
      await expect(consultation).toBeFocused();
      await consultation.check();
      const text = dialog.getByRole('checkbox', { name: 'Also send a text an hour before' });
      await expect(text).toBeChecked();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`recipe-dialog-${String(width)}.png`) });

      await dialog.getByRole('button', { name: 'Create the draft', exact: true }).click();
      await expect(page).toHaveURL(builderAt());
      const document = created(state);
      expect(document['name']).toBe('Appointment reminders');
      expect(document['triggers']).toEqual([
        { id: 'booked', type: 'appointment.booked', config: { calendar: 'cal_consult' } },
      ]);
      expect(document['steps']).toMatchObject({
        wait_day_before: { type: 'wait.appointment', config: { offset: 'PT24H' } },
        email_day_before: { type: 'email.send', config: { purpose: 'transactional' } },
        wait_hour_before: { type: 'wait.appointment', config: { offset: 'PT1H' } },
        email_hour_before: { type: 'email.send', config: { purpose: 'transactional' } },
        text_hour_before: { type: 'sms.send', config: { purpose: 'transactional' } },
      });
      // Nothing for the person to fix before publishing.
      const checked = validateAutomation(document, state.setup);
      expect(checked.errors).toEqual([]);
      expect(checked.warnings).toEqual([]);
      await expect(page.getByTestId('automation-canvas')).toBeVisible();
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`recipe-draft-${String(width)}.png`), fullPage: true });
    });
  });

test('opens on the recipe from a calendar’s address, with that calendar chosen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = withTour();
  await signedIn(page);
  await automationsApi(page, state);
  await page.goto(inHarbor(`/automations?recipe=appointment_reminders&calendar=${TOUR}`));
  const dialog = page.getByRole('dialog', { name: 'Start from a recipe', exact: true });
  await expect(
    dialog.getByRole('heading', { name: 'Appointment reminders', exact: true }),
  ).toBeVisible();
  const calendars = dialog.getByRole('group', { name: 'Calendars it reminds for' });
  await expect(calendars.getByRole('checkbox', { name: 'Venue tour', exact: true })).toBeChecked();
  await expect(
    calendars.getByRole('checkbox', { name: 'Consultation', exact: true }),
  ).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Also send a text an hour before' }).uncheck();
  await dialog.getByRole('button', { name: 'Create the draft', exact: true }).click();
  await expect(page).toHaveURL(builderAt());
  const document = created(state);
  expect(document['triggers']).toEqual([
    { id: 'booked', type: 'appointment.booked', config: { calendar: TOUR } },
  ]);
  expect(Object.keys(document['steps'] as object)).not.toContain('text_hour_before');
  expect(validateAutomation(document, state.setup).errors).toEqual([]);

  // Closed without making anything, the address no longer names the recipe.
  await page.goto(inHarbor(`/automations?recipe=appointment_reminders&calendar=${TOUR}`));
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/recipe=/);
});
