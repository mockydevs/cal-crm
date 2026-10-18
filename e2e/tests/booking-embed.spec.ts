// The booking page on a business's own website, on the whole product: the "Booking day"
// install (global-setup.ts), its built server, dashboard and booking embed script, over a
// migrated Postgres. The team copies a calendar's embed code in Settings → Calendars; the
// code goes on a website of the test's own, on another origin, under a strict
// Content-Security-Policy that names the CRM only in script-src and frame-src. A visitor on
// a phone books inside the frame, through the page's render token and ALTCHA's proof of
// work, and the frame grows and shrinks with the page. Every other page of the CRM is
// refused in the same website's frame by the browser itself.
//
// Nothing of the product is stood in for. The calendar asks for no consent box, so no mail
// is sent (booking without a mailbox): nothing leaves this machine.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { newTeamMember, stay, stayQuery as query } from '../booking-day.js';
import { address, asClient, bookingDay } from '../servers.js';
import { signInByLink } from '../signing-in.js';

test.use(asClient('203.0.113.180'));

interface Website {
  readonly origin: string;
  /** Sets the page's code: what the business pasted. */
  show(code: string): void;
  close(): Promise<void>;
}

/**
 * The business's own website on its own origin: /visit holds what the business pasted,
 * /sign-in-here frames the CRM's sign-in page. Its policy allows the CRM only as a script
 * and as a frame, and nothing inline at all, so even the code's own style attribute is
 * refused: the embed script styles and sizes the frame by itself.
 */
async function startWebsite(): Promise<Website> {
  const crm = address('bookingDay');
  let code = '';
  const page = (body: string): string =>
    [
      '<!doctype html>',
      '<html lang="en">',
      '<head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>Juniper Hall</title></head>',
      `<body><main><h1>Visit Juniper Hall</h1>${body}<p>Thank you for visiting.</p></main></body>`,
      '</html>',
    ].join('\n');
  const server: Server = createServer((request, response) => {
    const path = request.url?.split('?')[0];
    const body =
      path === '/visit'
        ? code
        : path === '/sign-in-here'
          ? `<iframe data-crm-booking src="${crm}/sign-in" title="Sign in"></iframe>`
          : undefined;
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src ${crm}; frame-src ${crm}; base-uri 'none'; form-action 'none'`,
      })
      .end(page(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const listening = server.address();
  if (listening === null || typeof listening === 'string') throw new Error('No port.');
  return {
    origin: `http://127.0.0.1:${String(listening.port)}`,
    show(next) {
      code = next;
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

/** The frame's height on the website, and the booking page's own height inside it. */
async function heights(site: Page): Promise<{ frame: number; page: number }> {
  const frame = await site
    .locator('iframe[data-crm-booking]')
    .evaluate((element) => element.getBoundingClientRect().height);
  const inner = site.frames().find((each) => each.url().includes('/book/'));
  if (inner === undefined) throw new Error('The booking page is not in a frame.');
  const page = await inner.evaluate(() =>
    Math.ceil(document.documentElement.getBoundingClientRect().height),
  );
  return { frame, page };
}

test('a visitor books from the calendar embedded on the business’s own website', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const crm = address('bookingDay');
  const suffix = randomUUID().slice(0, 8);
  const calendarName = `Garden tour ${suffix}`;
  const calendarSlug = `garden-tour-${suffix}`;
  const lead = { first: `Rosa ${suffix}`, email: `rosa-${suffix}@example.test` };
  // Two days from now, all day, in UTC, as in checkpoint-1d.spec.ts: a slot is never less
  // than an hour ahead, and UTC has no clock changes.
  const day = new Date(Date.now() + 2 * 86_400_000);
  const date = day.toISOString().slice(0, 10);

  // The team: someone signs in, and their calendar is made through the API the dashboard
  // uses, with ALTCHA's proof of work switched on.
  const person = await newTeamMember();
  await page.goto(`${crm}/sign-in`);
  await signInByLink(page, person.email, 1);
  const me = (await (await page.request.get(`${crm}/api/v1/me`)).json()) as {
    businesses: { id: string; slug: string }[];
  };
  const businessId = me.businesses.find((each) => each.slug === bookingDay.business.slug)?.id;
  if (businessId === undefined) throw new Error('The team member has no Juniper Hall.');
  const users = (await (
    await page.request.get(`${crm}/api/v1/users?type=account&limit=100`, {
      headers: { 'business-id': businessId },
    })
  ).json()) as { items: { email: string; membershipId: string | null }[] };
  const membershipId = users.items.find((each) => each.email === person.email)?.membershipId;
  if (membershipId === undefined || membershipId === null)
    throw new Error('The team member has no membership.');
  const created = await page.request.post(`${crm}/api/v1/calendars`, {
    headers: { 'business-id': businessId, origin: crm },
    data: {
      name: calendarName,
      kind: 'personal',
      timezone: 'UTC',
      bookingSlug: calendarSlug,
      isActive: true,
      consentEnabled: false,
      botProtection: 'altcha',
      members: [{ membershipId, weight: 1 }],
      weeklyHours: [{ weekday: day.getUTCDay(), startTime: '00:00', endTime: '24:00' }],
      dateOverrides: [],
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  // The embed code, as Settings → Calendars shows it.
  await page.goto(stay('/settings/calendars'));
  await page.getByRole('button', { name: `Actions for ${calendarName}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Embed code', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Embed code', exact: true });
  const code = await dialog.getByLabel(`Code for ${calendarName}`, { exact: true }).inputValue();
  const [agency] = await query<{ slug: string }>(
    `select a.slug from tenancy.agencies a join tenancy.businesses b on b.agency_id = a.id
     where b.slug = $1`,
    [bookingDay.business.slug],
  );
  if (agency === undefined) throw new Error('The business has no agency.');
  const bookingPage = `${crm}/book/${agency.slug}/${bookingDay.business.slug}/${calendarSlug}`;
  expect(code).toBe(
    [
      `<iframe src="${bookingPage}" title="${calendarName}" data-crm-booking width="100%" height="860" style="border:0;width:100%" loading="lazy"></iframe>`,
      `<script async src="${crm}/calendars/embed.js"></script>`,
    ].join('\n'),
  );
  website.show(code);

  // The visitor, on a phone, with no session.
  const phone = await browser.newContext({
    viewport: { width: 360, height: 760 },
    timezoneId: 'America/Los_Angeles',
    extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.181' },
  });
  try {
    const site = await phone.newPage();
    const refused: string[] = [];
    site.on('console', (message) => {
      if (message.type() === 'error') refused.push(message.text());
    });
    await site.goto(`${website.origin}/visit?utm_source=newsletter`);
    const booking = site.frameLocator('iframe[data-crm-booking]');
    await expect(booking.getByRole('heading', { name: calendarName, exact: true })).toBeVisible();
    // The frame is as tall as the page in it, so the page never scrolls inside the frame.
    await expect
      .poll(async () => {
        const now = await heights(site);
        return Math.abs(now.frame - now.page);
      })
      .toBeLessThanOrEqual(1);
    await booking.getByLabel('Appointment date', { exact: true }).fill(date);
    const times = booking.getByRole('radio');
    await expect(times).toHaveCount(48);
    await times.last().check();
    await booking.getByLabel('First name', { exact: true }).fill(lead.first);
    await booking.getByLabel('Email', { exact: true }).fill(lead.email);
    // ALTCHA's proof of work, found by the visitor's browser while they type.
    await expect(booking.getByTestId('booking-check')).toHaveText('Check complete.', {
      timeout: 60_000,
    });
    const before = await heights(site);
    expect(Math.abs(before.frame - before.page)).toBeLessThanOrEqual(1);
    expect(await site.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (
        await new AxeBuilder({ page: site })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await site.screenshot({ path: testInfo.outputPath('embedded.png'), fullPage: true });
    // Booked less than two seconds after the page was shown, the page waits and sends the
    // same booking again by itself (the render token).
    await booking.getByRole('button', { name: 'Book appointment', exact: true }).click();
    await expect(
      booking.getByRole('heading', { name: 'Appointment booked', exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    // Its own link opens on its own: that page is never shown in a website's frame.
    await expect(booking.getByRole('link', { name: 'Manage appointment' })).toHaveAttribute(
      'target',
      '_blank',
    );
    // The receipt is shorter than the form, and the frame follows it down.
    await expect.poll(async () => (await heights(site)).frame).toBeLessThan(before.frame - 100);
    const after = await heights(site);
    expect(Math.abs(after.frame - after.page)).toBeLessThanOrEqual(1);
    await site.screenshot({ path: testInfo.outputPath('booked.png'), fullPage: true });
    // The website's policy was enough for the frame and the script; only the code's own
    // style attribute was refused, and the script made up for it.
    expect(refused.filter((text) => /Refused to (frame|load the script)/.test(text))).toEqual([]);

    // The booking is stored once, with the showing of the page it was made from.
    const stored = await query<{ marked: boolean; email: string }>(
      `select a.render_mark is not null as marked, i.value_normalized as email
       from calendar.appointments a
       join calendar.calendars k on k.id = a.calendar_id
       join crm.contact_identities i on i.contact_id = a.contact_id and i.kind = 'email'
       where k.booking_slug = $1`,
      [calendarSlug],
    );
    expect(stored).toEqual([{ marked: true, email: lead.email }]);

    // Any other page of the CRM is refused in the website's frame, by the browser itself.
    const other = await phone.newPage();
    const ancestors = other.waitForEvent('console', {
      predicate: (message) => message.text().includes('frame-ancestors'),
    });
    await other.goto(`${website.origin}/sign-in-here`);
    expect((await ancestors).text()).toContain("frame-ancestors 'self'");
  } finally {
    await phone.close();
  }
});
