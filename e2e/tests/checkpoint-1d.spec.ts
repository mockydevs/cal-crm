// Checkpoint 1D: a lead books through the booking page and fills in a form; both land on
// the contact. The whole product, on an install of its own (global-setup.ts, "Booking
// day"): the built server with its worker, the built dashboard and the built form embed
// over a migrated Postgres, and a business's website on another origin under a strict
// Content-Security-Policy.
//
// The team connects a mailbox and sets the calendar and the form up in the dashboard, as
// they would. The lead uses a phone-sized browser with no session: the public booking
// page, then the form on the business's website. Nothing of the product is stood in for.
// The world outside it is local: the mail server is the test run's GreenMail, where the
// confirmation is read once the worker has sent it. No message leaves this machine.
//
// The mailbox is connected once on its install, so this file is not written to be repeated
// against the same servers.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { newTeamMember, stay, stayQuery as query } from '../booking-day.js';
import { mailDeliveredTo, mailServer } from '../inbox-day.js';
import { choose } from '../select.js';
import { address, asClient, bookingDay } from '../servers.js';
import { signInByLink } from '../signing-in.js';

test.use(asClient('203.0.113.170'));

const PAGE = readFileSync(fileURLToPath(new URL('./form-test-page.html', import.meta.url)), 'utf8');

interface Website {
  readonly origin: string;
  /** Sets the form key the page carries. */
  show(key: string): void;
  close(): Promise<void>;
}

/**
 * A business's own website, on its own origin, with a policy a careful website has:
 * scripts and connections only to the CRM, and no inline script or style.
 */
async function startWebsite(): Promise<Website> {
  const crm = address('bookingDay');
  let key = '';
  const server: Server = createServer((request, response) => {
    if (request.url?.split('?')[0] !== '/enquire') {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src ${crm}; connect-src ${crm}; base-uri 'none'; form-action 'none'`,
      })
      .end(PAGE.replaceAll('{{CRM}}', crm).replaceAll('{{KEY}}', key));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const listening = server.address();
  if (listening === null || typeof listening === 'string') throw new Error('No port.');
  return {
    origin: `http://127.0.0.1:${String(listening.port)}`,
    show(next) {
      key = next;
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

let website: Website;
test.beforeEach(async () => {
  website = await startWebsite();
});
test.afterEach(async () => {
  await website.close();
});

const audit = async (page: Page): Promise<unknown[]> =>
  (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze())
    .violations;
const fits = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/** The mailbox of the test run's mail server, which every address at its domain reaches. */
const MAILBOX = 'fixture@localhost.test';

test('a lead books through the booking page and fills in a form, and both land on one contact', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const suffix = randomUUID().slice(0, 8);
  const lead = { first: `Maya ${suffix}`, email: `maya-${suffix}@example.test` };
  const calendarName = `Venue tour ${suffix}`;
  const calendarSlug = `venue-tour-${suffix}`;
  const formName = `Wedding enquiry ${suffix}`;
  const senderName = 'Bookings desk';
  const mail = mailServer();
  // This synthetic recipient is delivered by our local mail server, not public DNS.
  // Keep verification enabled and give the confirmation a current, known valid result.
  const checked = await query<{ business_id: string }>(
    `insert into messaging.email_verifications
       (business_id,address_normalized,status,depth,checked_at)
     select id,$1,'valid','mailbox',now() from tenancy.businesses where slug=$2
     returning business_id`,
    [lead.email, bookingDay.business.slug],
  );
  expect(checked).toHaveLength(1);

  // The team: someone signs in and connects the mailbox confirmations are sent from.
  const person = await newTeamMember();
  await page.goto(`${address('bookingDay')}/sign-in`);
  await signInByLink(page, person.email, 1);
  await page.goto(stay('/settings/email'));
  await page.getByRole('button', { name: 'Add a mailbox', exact: true }).click();
  await page.getByLabel('Email address', { exact: true }).fill(MAILBOX);
  await page.getByLabel('Mailbox name', { exact: true }).fill(senderName);
  await page.getByLabel('Sender name', { exact: true }).fill(bookingDay.business.name);
  for (const [protocol, port] of [
    ['SMTP', mail.smtpPort],
    ['IMAP', mail.imapPort],
  ] as const) {
    const group = page.getByRole('group', { name: protocol, exact: true });
    await group.getByLabel('Server', { exact: true }).fill('localhost');
    await group.getByLabel('Port', { exact: true }).fill(String(port));
    await group.getByLabel('Username', { exact: true }).fill(mail.username);
    await group.getByLabel('Password or app password').fill(mail.password);
  }
  await page.getByRole('button', { name: 'Test and connect', exact: true }).click();
  await expect(page.getByText('Mailbox connected.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('heading', { name: senderName, exact: true })).toBeVisible();
  // This venue writes at any hour. With quiet hours on, as they are by default (21:00 to
  // 08:00 where the contact is), a confirmation to a lead on Pacific time rightly waits
  // for their morning, and this test would pass or fail by the hour it was run at.
  await page.getByLabel('Hold messages during quiet hours').uncheck();
  await page.getByRole('button', { name: 'Save quiet hours', exact: true }).click();
  await expect(page.getByText('Quiet hours saved.', { exact: true })).toBeVisible();

  // Then a calendar that is open, two days from now, from midnight until midnight. Two
  // days, not one: a calendar offers nothing less than an hour ahead, so tomorrow's first
  // slots are gone in the last hour of today, and tomorrow becomes today if midnight
  // passes while the test runs. The calendar keeps UTC, which has no clock changes.
  const day = new Date(Date.now() + 2 * 86_400_000);
  const date = day.toISOString().slice(0, 10);
  // Calendars are set up in one place, Settings.
  await page.goto(stay('/settings/calendars'));
  // "New calendar" asks for the type first, then for the few things a draft needs.
  // "Advanced settings" hands what was typed to the full editor, unsaved.
  await page.getByRole('button', { name: 'New calendar', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Choose calendar type', exact: true })
    .getByRole('button', { name: /^Personal booking/ })
    .click();
  const modal = page.getByRole('dialog', { name: 'New calendar', exact: true });
  await modal.getByLabel('Calendar name', { exact: true }).fill(calendarName);
  // The person signing in is the host.
  const hostName = person.name;
  await choose(modal.getByRole('combobox', { name: 'Select team member', exact: true }), {
    label: hostName,
  });
  await modal.getByRole('button', { name: 'Advanced settings', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Create', exact: true })).toBeVisible();
  await expect(page.getByLabel('Calendar name', { exact: true })).toHaveValue(calendarName);
  await page.getByLabel('Custom URL', { exact: true }).fill(calendarSlug);
  await page.getByLabel('Time zone', { exact: true }).fill('UTC');
  const active = page.getByRole('switch', { name: 'Active', exact: true });
  await active.click();
  await expect(active).toHaveAttribute('aria-checked', 'true');
  const section = async (name: string, heading: string): Promise<void> => {
    await page.getByRole('tab', { name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: heading, exact: true })).toBeVisible();
  };
  await section('Staff & location', 'Staff & meeting location');
  await expect(
    page.getByRole('combobox', { name: 'Select staff & assign meeting location', exact: true }),
  ).toContainText(hostName);
  // A new calendar starts with the weekdays, 08:00 to 17:00. This one keeps one day only.
  await section('Availability', 'Availability schedule');
  const weekly = page.getByRole('region', { name: 'Weekly opening hours', exact: true });
  await expect(weekly.getByRole('group')).toHaveCount(5);
  for (let left = 5; left > 1; left -= 1)
    await weekly.getByRole('button', { name: 'Remove opening hours 2', exact: true }).click();
  await expect(weekly.getByRole('group')).toHaveCount(1);
  await choose(weekly.getByLabel('Day', { exact: true }), String(day.getUTCDay()));
  await weekly.getByLabel('Start time', { exact: true }).fill('00:00');
  // The whole day, to its very end: the last slot of the day is one a lead can take.
  await weekly.getByRole('checkbox', { name: 'Open until midnight', exact: true }).check();
  await page.getByRole('button', { name: 'Advanced settings', exact: true }).click();
  await section('Notifications & policies', 'Notifications');
  await choose(page.getByLabel('Confirmation sender', { exact: true }), {
    label: `${senderName} · ${MAILBOX}`,
  });
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('main').getByRole('status').filter({ hasText: 'Calendar created.' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/calendars\/cal_[0-9a-z]+$/);
  // What was saved is what a reload reads back from the server.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: calendarName })).toBeVisible();
  await expect(page.getByLabel('Custom URL', { exact: true })).toHaveValue(calendarSlug);
  await expect(page.getByLabel('Time zone', { exact: true })).toHaveValue('UTC');
  await expect(active).toHaveAttribute('aria-checked', 'true');
  await section('Availability', 'Availability schedule');
  await expect(weekly.getByRole('group')).toHaveCount(1);
  await expect(
    weekly.getByRole('checkbox', { name: 'Open until midnight', exact: true }),
  ).toBeChecked();

  // And a form for the business's website, with a box for marketing email.
  await page.goto(stay('/settings/business'));
  await page.getByRole('link', { name: 'Go Back', exact: true }).click();
  await page.getByRole('link', { name: 'Sites', exact: true }).click();
  // Sites opens on Funnels; Forms is one of its tabs.
  await page
    .getByRole('navigation', { name: 'Sites', exact: true })
    .getByRole('link', { name: 'Forms', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Forms' })).toBeVisible();
  await page.getByRole('button', { name: 'Add a form', exact: true }).click();
  await page.getByLabel('Name of the new form', { exact: true }).fill(formName);
  await page.getByRole('button', { name: 'Add the form', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: formName })).toBeVisible();
  // With a path, as someone copies it from the address bar, it is refused: a website is
  // its address and nothing after it.
  await page
    .getByLabel('Websites that may show this form', { exact: true })
    .fill(`${website.origin}/enquire`);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText(/Enter a website address with nothing after the host/)).toBeVisible();
  await page.getByLabel('Websites that may show this form', { exact: true }).fill(website.origin);
  await page.getByLabel('Heading', { exact: true }).fill('Plan your day with us');
  await page.getByRole('button', { name: 'Add a consent box', exact: true }).click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Published. Websites now show this version.' }),
  ).toBeVisible();
  const code = await page
    .getByRole('region', { name: 'Code for your website', exact: true })
    .getByText(/^<script async src=/)
    .textContent();
  const key = /data-form-key="([A-Za-z0-9_-]{32})"/.exec(code ?? '')?.[1];
  if (key === undefined) throw new Error(`No key in the code shown: ${code ?? ''}`);
  expect(code).toContain(`src="${address('bookingDay')}/forms/embed.js"`);
  website.show(key);

  // The lead, on a phone, with no session and no part in the team's browser.
  const [agency] = await query<{ slug: string }>(
    `select a.slug from tenancy.agencies a join tenancy.businesses b on b.agency_id = a.id
     where b.slug = $1`,
    [bookingDay.business.slug],
  );
  if (agency === undefined) throw new Error('The business has no agency.');
  const phone = await browser.newContext({
    viewport: { width: 360, height: 760 },
    timezoneId: 'America/Los_Angeles',
    extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.171' },
  });
  const contexts = [phone];
  try {
    const booking = await phone.newPage();
    await booking.goto(
      `${address('bookingDay')}/book/${agency.slug}/${bookingDay.business.slug}/${calendarSlug}`,
    );
    await expect(booking.getByRole('heading', { name: calendarName, exact: true })).toBeVisible();
    await booking.getByLabel('Appointment date', { exact: true }).fill(date);
    // Every half hour of the day is on offer, the last one ending at midnight.
    const times = booking.getByRole('radio');
    await expect(times).toHaveCount(48);
    await expect(times.last()).toHaveAccessibleName(/^23:30/);
    await times.last().check();
    await booking.getByLabel('First name', { exact: true }).fill(lead.first);
    await booking.getByLabel('Email', { exact: true }).fill(lead.email);
    await booking
      .getByRole('checkbox', { name: 'Email me confirmations and updates for this appointment.' })
      .check();
    expect(await audit(booking)).toEqual([]);
    expect(await fits(booking)).toBe(true);
    await booking.getByRole('button', { name: 'Book appointment', exact: true }).click();
    await expect(
      booking.getByRole('heading', { name: 'Appointment booked', exact: true }),
    ).toBeVisible();
    await expect(booking.getByRole('link', { name: 'Manage appointment' })).toBeVisible();
    expect(await audit(booking)).toEqual([]);
    await booking.screenshot({ path: testInfo.outputPath('booked.png'), fullPage: true });

    // Then the form on the business's website: another origin, under its own strict policy.
    // A context with no X-Forwarded-For of the test's: a header added to the embed's
    // cross-origin requests would need the server's leave in a preflight, which a real
    // visitor's browser never asks for. So the install sees this machine's own address.
    const browsing = await browser.newContext({
      extraHTTPHeaders: {},
      viewport: { width: 360, height: 760 },
    });
    contexts.push(browsing);
    const site = await browsing.newPage();
    const blocked: string[] = [];
    site.on('console', (message) => {
      if (message.type() === 'error') blocked.push(message.text());
    });
    await site.goto(`${website.origin}/enquire?utm_source=newsletter&utm_campaign=spring`);
    const form = site.getByRole('region', { name: 'Form', exact: true });
    await expect(form.getByRole('heading', { name: 'Plan your day with us' })).toBeVisible();
    const shownAt = Date.now();
    // The same person, typing their address a little differently.
    await form.getByLabel('First name').fill(`${lead.first} Jane`);
    await form.getByLabel('Email (required)').fill(`  ${lead.email.toUpperCase()} `);
    const consent = form.getByRole('checkbox', { name: 'Email me news and offers.' });
    await expect(consent).not.toBeChecked();
    await consent.check();
    expect(await audit(site)).toEqual([]);
    expect(await fits(site)).toBe(true);
    await site.screenshot({ path: testInfo.outputPath('form-on-website.png'), fullPage: true });
    // A form that was on the page for under two seconds is asked to wait, and what was
    // typed stays: a person is rarely that quick, a test may be.
    const send = form.getByRole('button', { name: 'Send', exact: true });
    const thanks = form.getByText('Thank you. We have your details.');
    const slowDown = form.getByText('Please wait a moment, then send again.');
    await send.click();
    await expect(thanks.or(slowDown)).toBeVisible();
    if (await slowDown.isVisible()) {
      await expect(form.getByLabel('First name')).toHaveValue(`${lead.first} Jane`);
      await site.waitForTimeout(Math.max(0, 2500 - (Date.now() - shownAt)));
      await send.click();
    }
    await expect(thanks).toBeVisible();
    // The website's policy was enough: nothing of the form was refused by the browser.
    expect(blocked.filter((text) => /Content Security Policy|CSP/i.test(text))).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }

  // Back with the team: the submission is on the form, attached to a contact.
  await page.getByRole('button', { name: /^Submissions \(/ }).click();
  const submission = page
    .getByRole('list', { name: 'Submissions, newest first', exact: true })
    .getByRole('article');
  await expect(submission).toHaveCount(1);
  await expect(submission.getByText(lead.email, { exact: true })).toBeVisible();
  await expect(submission.getByText('Consent recorded')).toBeVisible();
  // The booking made the contact; the form found that contact and did not make another.
  await submission.getByRole('link', { name: 'Open the contact', exact: true }).click();
  await expect(page).toHaveURL(/\/contacts\/con_[0-9a-z]+$/);
  // A public form never changes a name the contact has: the booking's stays, and the form's
  // other name is a note for the team.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(lead.first);
  const activity = page.getByRole('region', { name: 'Activity', exact: true });
  await expect(activity.getByText('Appointment booked', { exact: true })).toBeVisible();
  const submitted = activity.getByRole('listitem').filter({ hasText: 'Form submitted' });
  await expect(submitted).toHaveCount(1);
  // The form acted in its own name.
  await expect(submitted.getByText(formName, { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('contact.png'), fullPage: true });

  // What the database holds: one contact for the address, with both on it.
  const contacts = await query<{ id: string; first_name: string }>(
    `select c.id, c.first_name from crm.contact_identities i
     join crm.contacts c on c.business_id = i.business_id and c.id = i.contact_id
     where i.kind = 'email' and i.value_normalized = $1`,
    [lead.email],
  );
  expect(contacts.map((contact) => contact.first_name)).toEqual([lead.first]);
  const contactId = contacts[0]?.id;
  const notes = await query<{ body_text: string }>(
    'select body_text from crm.notes where record_id = $1',
    [contactId],
  );
  // One note, from the form, naming the name it did not apply.
  expect(notes).toHaveLength(1);
  const [review = { body_text: '' }] = notes;
  expect(review.body_text).toMatch(
    /^A form submission sent details that were not applied to this contact:\n/,
  );
  expect(review.body_text.split('\n')).toContain(
    `- First name given: "${lead.first} Jane" (the contact has "${lead.first}").`,
  );
  const appointments = await query<{ status: string; starts: string; ends: string; id: string }>(
    `select id, status, to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as starts,
            to_char(ends_at at time zone 'UTC', 'HH24:MI') as ends
     from calendar.appointments where contact_id = $1`,
    [contactId],
  );
  expect(appointments.map(({ status, starts, ends }) => ({ status, starts, ends }))).toEqual([
    { status: 'booked', starts: `${date} 23:30`, ends: '00:00' },
  ]);
  // The confirmation went through the outbound pipeline, as a transactional email.
  const confirmations = await query<{ purpose: string; lane: string; channel: string }>(
    `select d.purpose, d.lane, m.channel from messaging.messages m
     join messaging.outbound_dispatch d on d.business_id = m.business_id and d.id = m.id
     where m.idempotency_key = $1`,
    [`calendar:book:${appointments[0]?.id ?? ''}`],
  );
  expect(confirmations).toEqual([
    { purpose: 'transactional', lane: 'transactional', channel: 'email' },
  ]);
  // And the worker sent it through the connected mailbox: the mail server holds one
  // message for the lead, from the mailbox's address, with the link to manage the booking.
  // While it has not come, the wait says where the pipeline has it and why.
  const confirmationState = async (): Promise<string> => {
    const count = (await mailDeliveredTo(lead.email)).length;
    if (count > 0) return `delivered: ${String(count)}`;
    const held = await query<{ state: string }>(
      `select status || coalesce(': ' || error_code, '') as state from messaging.messages
       where idempotency_key = $1`,
      [`calendar:book:${appointments[0]?.id ?? ''}`],
    );
    return `not delivered; in the pipeline as ${held.map((each) => each.state).join(', ')}`;
  };
  await expect.poll(confirmationState, { timeout: 60_000 }).toBe('delivered: 1');
  const [delivered] = await mailDeliveredTo(lead.email);
  expect(delivered?.subject).toBe('Your appointment is booked');
  // Long lines are folded with "=" at the break (quoted-printable, RFC 2045 6.7).
  const body = delivered?.raw.replaceAll(/=\r?\n/g, '');
  expect(body).toContain(`From: ${bookingDay.business.name} <${MAILBOX}>`);
  expect(body).toContain(`${address('bookingDay')}/appointments/manage/`);
  // With a calendar invite for the appointment (RFC 6047): a request, whose UID is the
  // appointment's id at the install's own host.
  expect(body).toMatch(/text\/calendar;[^\r\n]*method=REQUEST/i);
  expect(body).toContain(`UID:${appointments[0]?.id ?? ''}@`);
  const submissions = await query<{
    outcome: string;
    origin: string;
    page_url: string;
    ip: string;
    utm: unknown;
  }>(
    `select contact_outcome as outcome, origin, page_url, host(ip) as ip, utm
     from forms.submissions where contact_id = $1`,
    [contactId],
  );
  expect(submissions).toEqual([
    {
      outcome: 'updated',
      origin: website.origin,
      page_url: `${website.origin}/enquire`,
      // The address the install saw the website's visitor come from: this machine.
      ip: '127.0.0.1',
      utm: { source: 'newsletter', campaign: 'spring' },
    },
  ]);
  // Consent, each with its proof: for the appointment's emails, and for marketing.
  const consents = await query<{
    purpose: string;
    source: string;
    wording: string;
    ip: string;
    form: boolean;
  }>(
    `select purpose, source, proof->>'wording' as wording, proof->>'ipAddress' as ip,
            proof ? 'formId' and proof ? 'submissionId' as form
     from messaging.consents where contact_id = $1 and channel = 'email' and status = 'granted'
     order by recorded_at`,
    [contactId],
  );
  expect(consents).toEqual([
    {
      purpose: 'transactional',
      source: 'booking',
      wording: 'Email me confirmations and updates for this appointment.',
      ip: '203.0.113.171',
      form: false,
    },
    {
      purpose: 'marketing',
      source: 'form',
      wording: 'Email me news and offers.',
      ip: '127.0.0.1',
      form: true,
    },
  ]);
  // Both are on the contact's timeline, and an automation that listens for either was told.
  const events = await query<{ type: string }>(
    `select e.type from crm.timeline_entries t join events.events e on e.id = t.event_id
     where t.record_id = $1 and e.type in ('appointment.booked', 'form.submitted')
     order by e.recorded_at`,
    [contactId],
  );
  expect(events).toEqual([{ type: 'appointment.booked' }, { type: 'form.submitted' }]);
});

test('a website that is not listed gets no form, and a listed one gets none once it is unpublished', async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const suffix = randomUUID().slice(0, 8);
  const formName = `Open day ${suffix}`;
  const person = await newTeamMember();
  await page.goto(`${address('bookingDay')}/sign-in`);
  await signInByLink(page, person.email, 1);
  await page.goto(stay('/settings/forms'));
  await page.getByRole('button', { name: 'Add a form', exact: true }).click();
  await page.getByLabel('Name of the new form', { exact: true }).fill(formName);
  await page.getByRole('button', { name: 'Add the form', exact: true }).click();
  // Listed for another website, not the one that will show it.
  await page
    .getByLabel('Websites that may show this form', { exact: true })
    .fill('https://www.harborlights.example');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const code = await page
    .getByRole('region', { name: 'Code for your website', exact: true })
    .getByText(/^<script async src=/)
    .textContent();
  const key = /data-form-key="([A-Za-z0-9_-]{32})"/.exec(code ?? '')?.[1];
  if (key === undefined) throw new Error('No key in the code shown.');
  website.show(key);

  // No X-Forwarded-For of the test's, as above.
  const visitor = await browser.newContext({
    extraHTTPHeaders: {},
    viewport: { width: 360, height: 760 },
  });
  try {
    const site = await visitor.newPage();
    // The refusal carries no leave for this website to read it, so the browser hands the
    // page a failed request and no answer at all.
    const refused: string[] = [];
    site.on('requestfailed', (request) => {
      if (request.url().includes('/api/v1/public/forms/')) refused.push(request.method());
    });
    await site.goto(`${website.origin}/enquire`);
    const form = site.getByRole('region', { name: 'Form', exact: true });
    await expect(
      form.getByText('This form is not available right now. Please try again later.'),
    ).toBeVisible();
    await expect(form.getByRole('textbox')).toHaveCount(0);
    expect(refused).toEqual(['GET']);
    // Asked without a browser in between, the install says why: this website is not listed.
    const direct = await visitor.request.get(
      `${address('bookingDay')}/api/v1/public/forms/${key}`,
      {
        headers: { origin: website.origin },
      },
    );
    expect(direct.status()).toBe(403);
    expect(direct.headers()['access-control-allow-origin']).toBeUndefined();
    expect(await audit(site)).toEqual([]);

    // The team lists the website: the same page now shows the form.
    await page
      .getByLabel('Websites that may show this form', { exact: true })
      .fill(`https://www.harborlights.example\n${website.origin}`);
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    await site.reload();
    await expect(form.getByLabel('Email (required)')).toBeVisible();

    // Unpublished while the visitor has it open: what they send is not taken.
    await form.getByLabel('Email (required)').fill(`late-${suffix}@example.test`);
    await page.getByRole('button', { name: 'Unpublish', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'The form no longer accepts submissions.' }),
    ).toBeVisible();
    await form.getByRole('button', { name: 'Send', exact: true }).click();
    // The refusal is the one an unlisted website gets, which a browser keeps from the
    // page: the form can only say that it could not send, and keeps what was typed.
    await expect(form.getByRole('alert')).toHaveText(
      'Could not send the form. Check your connection and try again.',
    );
    await expect(form.getByLabel('Email (required)')).toHaveValue(`late-${suffix}@example.test`);
    await site.reload();
    await expect(
      form.getByText('This form is not available right now. Please try again later.'),
    ).toBeVisible();
    expect(
      await query('select 1 from crm.contact_identities where value_normalized = $1', [
        `late-${suffix}@example.test`,
      ]),
    ).toEqual([]);
  } finally {
    await visitor.close();
  }
});
