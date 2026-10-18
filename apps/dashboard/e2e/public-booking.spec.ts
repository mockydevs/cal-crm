import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import {
  BOOKING_NOTIFICATION_WORDING,
  bookingTextWording,
  publicBookingInput,
  type PublicBookingInput,
} from '@repo/contracts';
import { createChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/pbkdf2';
import { choose } from './select';

test.use({ timezoneId: 'America/Los_Angeles' });

/** The "Text me reminders" words as the server renders them, naming the business that sends. */
const SHOWN_TEXT_WORDING = bookingTextWording('Waterfront Events');

/** A new calendar's look: the Neo widget in the standard colours, the page's own button words. */
const standardLook = {
  style: 'neo',
  primaryColor: '#178af6',
  backgroundColor: '#ffffff',
  buttonText: '',
  logoUrl: null,
  coverUrl: null,
} as const;

// The smallest PNG there is, for a calendar's logo and cover.
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

for (const look of [
  {
    name: 'Neo in dark colours',
    appearance: {
      style: 'neo',
      primaryColor: '#ffe14d',
      backgroundColor: '#101828',
      buttonText: 'Book my tour',
    },
    button: 'Book my tour',
  },
  {
    name: 'Neo in light colours that need help to read',
    appearance: {
      style: 'neo',
      primaryColor: '#7dd3fc',
      backgroundColor: '#fef9c3',
      buttonText: 'Reserve',
    },
    button: 'Reserve',
  },
  {
    name: 'Classic',
    appearance: {
      style: 'classic',
      primaryColor: '#ffe14d',
      backgroundColor: '#101828',
      buttonText: 'Book my tour',
    },
    button: 'Book appointment',
  },
] as const)
  test(`draws the calendar's look (${look.name}) readably, with its logo and cover`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 960 });
    const base = '/api/v1/public/book/agency/events/venue-tour';
    await page.route('**/m/*/*.png', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: pixel }),
    );
    await page.route(`**${base}**`, async (route) => {
      if (new URL(route.request().url()).pathname.endsWith('/slots')) {
        await route.fulfill({
          json: { slots: [{ startsAt: '2030-10-01T00:30:00Z', endsAt: '2030-10-01T01:00:00Z' }] },
        });
        return;
      }
      await route.fulfill({
        json: {
          name: 'Venue tour',
          description: 'Visit the waterfront venue.',
          timezone: 'UTC',
          slotMinutes: 30,
          durations: [30],
          renderToken: `1790000000000.${'a'.repeat(43)}`,
          notificationWording: BOOKING_NOTIFICATION_WORDING,
          appearance: {
            ...look.appearance,
            logoUrl: 'http://127.0.0.1:4173/m/AbCdEfGhIjKlMnOpQrStUv/logo.png',
            coverUrl: 'http://127.0.0.1:4173/m/BbCdEfGhIjKlMnOpQrStUv/cover.png',
          },
        },
      });
    });
    await page.goto('/book/agency/events/venue-tour');
    await expect(page.getByRole('heading', { name: 'Venue tour', exact: true })).toBeVisible();
    await page.getByLabel('Appointment date', { exact: true }).fill('2030-10-01');
    await page.getByRole('radio', { name: /00:30/ }).check();
    await page.getByLabel('Email', { exact: true }).fill('lead@example.test');
    await page.getByRole('checkbox', { name: BOOKING_NOTIFICATION_WORDING }).check();
    const button = page.getByRole('button', { name: look.button, exact: true });
    await expect(button).toBeEnabled();
    await expect(page.getByTestId('booking-logo')).toHaveJSProperty('naturalWidth', 1);
    await expect(page.getByTestId('booking-cover')).toHaveJSProperty('naturalWidth', 1);
    const widget = page.getByTestId('booking-widget');
    if (look.appearance.style === 'neo') {
      // The widget is drawn on the calendar's background, and its button in the primary
      // colour, each moved only as far as reading needs (axe checks every word below).
      const [background, fill] = await Promise.all([
        widget.evaluate((element) => getComputedStyle(element).backgroundColor),
        button.evaluate((element) => getComputedStyle(element).backgroundColor),
      ]);
      expect(background).toBe(
        look.appearance.backgroundColor === '#101828' ? 'rgb(16, 24, 40)' : 'rgb(254, 249, 195)',
      );
      expect(fill).toBe(
        look.appearance.primaryColor === '#ffe14d' ? 'rgb(255, 225, 77)' : 'rgb(125, 211, 252)',
      );
    } else {
      // Classic keeps the page's own colours and words, as GoHighLevel's does.
      await expect(widget).toHaveCount(0);
    }
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

for (const width of [360, 1440]) {
  test(`books publicly with explicit consent and safe request retry at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 960 });
    const inputs: PublicBookingInput[] = [];
    const base = '/api/v1/public/book/agency/events/venue-tour';
    await page.route(`**${base}**`, async (route) => {
      expect(route.request().headers()['business-id']).toBeUndefined();
      const url = new URL(route.request().url());
      if (route.request().method() === 'POST') {
        inputs.push(publicBookingInput.parse(route.request().postDataJSON()));
        if (inputs.length === 1) {
          await route.fulfill({
            status: 503,
            json: {
              type: 'about:blank',
              title: 'Booking temporarily unavailable',
              status: 503,
              detail: 'Try again with the same details.',
            },
          });
        } else {
          await route.fulfill({
            json: {
              status: 'booked',
              startsAt: '2030-10-01T00:30:00Z',
              endsAt: '2030-10-01T01:00:00Z',
              managementUrl: `http://127.0.0.1:4173/appointments/manage/${'A'.repeat(43)}`,
            },
          });
        }
        return;
      }
      if (url.pathname.endsWith('/slots')) {
        await route.fulfill({
          json: { slots: [{ startsAt: '2030-10-01T00:30:00Z', endsAt: '2030-10-01T01:00:00Z' }] },
        });
        return;
      }
      await route.fulfill({
        json: {
          name: 'Venue tour',
          description: 'Visit the waterfront venue.',
          timezone: 'UTC',
          slotMinutes: 30,
          durations: [30],
          renderToken: `1790000000000.${'a'.repeat(43)}`,
          notificationWording: BOOKING_NOTIFICATION_WORDING,
          appearance: standardLook,
        },
      });
    });
    await page.goto('/book/agency/events/venue-tour');
    await expect(page.getByRole('heading', { name: 'Venue tour', exact: true })).toBeVisible();
    await page.getByLabel('Appointment date', { exact: true }).fill('2030-10-01');
    await page.getByRole('radio', { name: /00:30/ }).check();
    await page.getByLabel('First name', { exact: true }).fill('Jordan');
    await page.getByLabel('Email', { exact: true }).fill('lead@example.test');
    await choose(page.getByLabel('Your time zone', { exact: true }), 'America/New_York');
    const consent = page.getByRole('checkbox', { name: BOOKING_NOTIFICATION_WORDING });
    await expect(consent).not.toBeChecked();
    await expect(
      page.getByRole('button', { name: 'Book appointment', exact: true }),
    ).toBeDisabled();
    await consent.check();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.getByRole('button', { name: 'Book appointment', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Try again with the same details.');
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue('lead@example.test');
    await page.getByRole('button', { name: 'Book appointment', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Appointment booked', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Booking receipt', exact: true })).toContainText(
      'Tuesday, October 1, 2030',
    );
    await expect(
      page.getByText('A confirmation is on its way to your email, with a calendar invite.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Manage appointment', exact: true }),
    ).toHaveAttribute('href', `http://127.0.0.1:4173/appointments/manage/${'A'.repeat(43)}`);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toEqual(inputs[0]);
    expect(inputs[0]).toMatchObject({
      contact: { firstName: 'Jordan', email: 'lead@example.test' },
      contactTimezone: 'America/New_York',
      notificationConsent: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

for (const width of [360, 1440]) {
  test(`offers "Text me reminders" beside the phone number, never ticked, at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 960 });
    const inputs: PublicBookingInput[] = [];
    const base = '/api/v1/public/book/agency/events/venue-tour';
    await page.route(`**${base}**`, async (route) => {
      if (route.request().method() === 'POST') {
        inputs.push(publicBookingInput.parse(route.request().postDataJSON()));
        await route.fulfill({
          json: {
            status: 'booked',
            startsAt: '2030-10-01T00:30:00Z',
            endsAt: '2030-10-01T01:00:00Z',
            managementUrl: `http://127.0.0.1:4173/appointments/manage/${'A'.repeat(43)}`,
          },
        });
        return;
      }
      if (new URL(route.request().url()).pathname.endsWith('/slots')) {
        await route.fulfill({
          json: { slots: [{ startsAt: '2030-10-01T00:30:00Z', endsAt: '2030-10-01T01:00:00Z' }] },
        });
        return;
      }
      await route.fulfill({
        json: {
          name: 'Venue tour',
          description: 'Visit the waterfront venue.',
          timezone: 'UTC',
          slotMinutes: 30,
          durations: [30],
          renderToken: `1790000000000.${'a'.repeat(43)}`,
          notificationWording: BOOKING_NOTIFICATION_WORDING,
          textWording: SHOWN_TEXT_WORDING,
          appearance: standardLook,
        },
      });
    });
    const book = async (phone: string, tick: boolean) => {
      await page.goto('/book/agency/events/venue-tour');
      await page.getByLabel('Appointment date', { exact: true }).fill('2030-10-01');
      await page.getByRole('radio', { name: /00:30/ }).check();
      await page.getByLabel('Email', { exact: true }).fill('lead@example.test');
      const texts = page.getByRole('checkbox', { name: SHOWN_TEXT_WORDING });
      // Only once there is a number to text.
      await expect(texts).toHaveCount(0);
      await page.getByLabel('Phone (optional)', { exact: true }).fill(phone);
      await expect(texts).toBeVisible();
      await expect(texts).not.toBeChecked();
      if (tick) await texts.check();
      await page.getByRole('checkbox', { name: BOOKING_NOTIFICATION_WORDING }).check();
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByRole('button', { name: 'Book appointment', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Appointment booked', exact: true }),
      ).toBeVisible();
    };
    await book('+1 212 555 0123', false);
    await book('+1 212 555 0123', true);
    expect(inputs).toHaveLength(2);
    // Unticked: nothing said about texts. Ticked: for the number typed beside it. Only the
    // tick is sent, never the words: the server renders them (publicBookingInput is strict).
    expect(inputs[0]?.textConsent).toBeUndefined();
    expect(inputs[1]).toMatchObject({
      contact: { phone: '+1 212 555 0123' },
      textConsent: true,
    });
  });
}

test('keeps the cancellation receipt when the link stops opening the cancelled appointment', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 960 });
  const token = 'B'.repeat(43);
  let cancelled = false;
  let reads = 0;
  await page.route(`**/api/v1/public/appointments/${token}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/slots')) {
      await route.fulfill({ json: { slots: [] } });
    } else if (path.endsWith('/cancel')) {
      cancelled = true;
      await route.fulfill({
        json: {
          status: 'cancelled',
          startsAt: '2030-10-01T10:00:00Z',
          endsAt: '2030-10-01T10:30:00Z',
        },
      });
    } else if (cancelled) {
      // A reminder's link: once cancelled it opens nothing.
      reads += 1;
      await route.fulfill({
        status: 404,
        json: { type: 'about:blank', title: 'Appointment unavailable', status: 404 },
      });
    } else {
      await route.fulfill({
        json: {
          status: 'booked',
          startsAt: '2030-10-01T10:00:00Z',
          endsAt: '2030-10-01T10:30:00Z',
          calendarName: 'Venue tour',
          timezone: 'UTC',
          revision: 'a'.repeat(64),
        },
      });
    }
  });
  await page.goto(`/appointments/manage/${token}`);
  await page.getByRole('button', { name: 'Cancel appointment', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Appointment cancelled', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Cancellation recorded.', { exact: true })).toBeVisible();
  expect(reads).toBe(0);
});

test('tells someone whose time was just taken, takes it off the list and books the next one', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 960 });
  const inputs: PublicBookingInput[] = [];
  const first = { startsAt: '2030-10-01T00:30:00Z', endsAt: '2030-10-01T01:00:00Z' };
  const second = { startsAt: '2030-10-01T01:00:00Z', endsAt: '2030-10-01T01:30:00Z' };
  let taken = false;
  const base = '/api/v1/public/book/agency/events/venue-tour';
  await page.route(`**${base}**`, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') {
      const input = publicBookingInput.parse(route.request().postDataJSON());
      inputs.push(input);
      if (new Date(input.startsAt).getTime() === new Date(first.startsAt).getTime()) {
        // Someone else booked it between the list and this request.
        taken = true;
        await route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          json: {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            detail: 'That slot is taken, or the appointment has changed. Reload and try again.',
          },
        });
        return;
      }
      await route.fulfill({ json: { status: 'booked', ...second } });
      return;
    }
    if (url.pathname.endsWith('/slots')) {
      await route.fulfill({ json: { slots: taken ? [second] : [first, second] } });
      return;
    }
    await route.fulfill({
      json: {
        name: 'Venue tour',
        description: '',
        timezone: 'UTC',
        slotMinutes: 30,
        durations: [30],
        renderToken: `1790000000000.${'a'.repeat(43)}`,
        notificationWording: BOOKING_NOTIFICATION_WORDING,
        appearance: standardLook,
      },
    });
  });
  await page.goto('/book/agency/events/venue-tour');
  await page.getByLabel('Appointment date', { exact: true }).fill('2030-10-01');
  await page.getByRole('radio', { name: /^00:30/ }).check();
  await page.getByLabel('Email', { exact: true }).fill('second@example.test');
  await page.getByRole('checkbox', { name: BOOKING_NOTIFICATION_WORDING }).check();
  await page.getByRole('button', { name: 'Book appointment', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('That slot is taken');
  // The taken time is gone from the list, the details are kept, and nothing can be sent
  // until another time is chosen.
  await expect(page.getByRole('radio', { name: /^00:30/ })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /^01:00/ })).toBeVisible();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('second@example.test');
  await expect(page.getByRole('button', { name: 'Book appointment', exact: true })).toBeDisabled();
  await page.getByRole('radio', { name: /^01:00/ }).check();
  await page.getByRole('button', { name: 'Book appointment', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Appointment booked', exact: true }),
  ).toBeVisible();
  // A different time is a different request: it does not reuse the refused one's id.
  expect(inputs).toHaveLength(2);
  expect(inputs[1]?.bookingRequestId).not.toBe(inputs[0]?.bookingRequestId);
});

test('keeps cancellation available when rescheduling is unavailable and reloads a stale revision', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 960 });
  const token = 'A'.repeat(43);
  let revision = 'a'.repeat(64);
  let status = 'booked';
  const operations: { operationRequestId: string; revision: string }[] = [];
  await page.route(`**/api/v1/public/appointments/${token}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/slots')) {
      await route.fulfill({
        status: 404,
        json: { type: 'about:blank', title: 'Rescheduling unavailable', status: 404 },
      });
    } else if (path.endsWith('/cancel')) {
      const { publicCancellationInput } = await import('@repo/contracts');
      operations.push(publicCancellationInput.parse(route.request().postDataJSON()));
      if (operations.length === 1) {
        revision = 'b'.repeat(64);
        await route.fulfill({
          status: 409,
          json: {
            type: 'about:blank',
            title: 'Appointment changed',
            status: 409,
            detail: 'Reload before continuing.',
          },
        });
      } else {
        status = 'cancelled';
        revision = 'c'.repeat(64);
        await route.fulfill({
          json: { status, startsAt: '2030-10-01T10:00:00Z', endsAt: '2030-10-01T10:30:00Z' },
        });
      }
    } else {
      await route.fulfill({
        json: {
          status,
          startsAt: '2030-10-01T10:00:00Z',
          endsAt: '2030-10-01T10:30:00Z',
          calendarName: 'Venue tour',
          timezone: 'UTC',
          revision,
        },
      });
    }
  });
  await page.goto(`/appointments/manage/${token}`);
  await expect(
    page.getByRole('heading', { name: 'Manage appointment', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Rescheduling times are unavailable.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel appointment', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Reload before continuing.');
  await page.getByRole('button', { name: 'Reload appointment', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel appointment', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Appointment cancelled', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Cancellation recorded.', { exact: true })).toBeVisible();
  expect(operations.map((operation) => operation.revision)).toEqual([
    'a'.repeat(64),
    'b'.repeat(64),
  ]);
  expect(operations[1]?.operationRequestId).not.toBe(operations[0]?.operationRequestId);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('reschedules with a stable operation request on an unchanged retry', async ({ page }) => {
  const token = 'A'.repeat(43);
  let startsAt = '2030-10-01T10:00:00Z';
  let endsAt = '2030-10-01T10:30:00Z';
  let revision = 'a'.repeat(64);
  const operations: { operationRequestId: string; revision: string; startsAt: string }[] = [];
  await page.route(`**/api/v1/public/appointments/${token}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/slots')) {
      await route.fulfill({
        json: { slots: [{ startsAt: '2030-10-01T11:00:00Z', endsAt: '2030-10-01T11:30:00Z' }] },
      });
    } else if (path.endsWith('/reschedule')) {
      const { publicRescheduleInput } = await import('@repo/contracts');
      operations.push(publicRescheduleInput.parse(route.request().postDataJSON()));
      if (operations.length === 1) {
        await route.fulfill({
          status: 503,
          json: {
            type: 'about:blank',
            title: 'Try again',
            status: 503,
            detail: 'Try the same change again.',
          },
        });
      } else {
        startsAt = '2030-10-01T11:00:00Z';
        endsAt = '2030-10-01T11:30:00Z';
        revision = 'b'.repeat(64);
        await route.fulfill({ json: { status: 'booked', startsAt, endsAt } });
      }
    } else {
      await route.fulfill({
        json: {
          status: 'booked',
          startsAt,
          endsAt,
          calendarName: 'Venue tour',
          timezone: 'UTC',
          revision,
        },
      });
    }
  });
  await page.goto(`/appointments/manage/${token}`);
  await expect(
    page.getByRole('heading', { name: 'Manage appointment', exact: true }),
  ).toBeVisible();
  await page.getByRole('radio', { name: /11:00/ }).check();
  await page.getByRole('button', { name: 'Reschedule appointment', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Try the same change again.');
  await page.getByRole('button', { name: 'Reschedule appointment', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Appointment rescheduled', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Email delivery may be deferred.', { exact: true })).toBeVisible();
  expect(operations).toHaveLength(2);
  expect(operations[1]).toEqual(operations[0]);
});

// A business's booking requests go through a short line on the server; one that finds it
// full is answered 429 with Retry-After (apps/server/src/intake-gate.ts). The calendar is
// fine and the link is right, so the page says it is busy and asks again by itself.
for (const width of [360, 1440]) {
  test(`waits and asks again by itself when the server is busy at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 960 });
    const base = '/api/v1/public/book/agency/events/venue-tour';
    const asked = { calendar: 0, slots: 0 };
    const inputs: PublicBookingInput[] = [];
    const busy = {
      status: 429,
      headers: { 'retry-after': '1' },
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Too many requests',
        status: 429,
        detail: 'This business is receiving many requests. Try again shortly.',
      }),
    };
    await page.route(`**${base}**`, async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === 'POST') {
        inputs.push(publicBookingInput.parse(route.request().postDataJSON()));
        // Busy twice, then the booking is taken.
        if (inputs.length <= 2) return route.fulfill(busy);
        return route.fulfill({
          json: {
            status: 'booked',
            startsAt: '2030-10-01T00:30:00Z',
            endsAt: '2030-10-01T01:00:00Z',
          },
        });
      }
      if (url.pathname.endsWith('/slots')) {
        asked.slots += 1;
        // Every date but one stays busy however often it is asked.
        if (url.searchParams.get('date') !== '2030-10-01') return route.fulfill(busy);
        return route.fulfill({
          json: { slots: [{ startsAt: '2030-10-01T00:30:00Z', endsAt: '2030-10-01T01:00:00Z' }] },
        });
      }
      asked.calendar += 1;
      if (asked.calendar === 1) return route.fulfill(busy);
      return route.fulfill({
        json: {
          name: 'Venue tour',
          description: 'Visit the waterfront venue.',
          timezone: 'UTC',
          slotMinutes: 30,
          durations: [30],
          renderToken: `1790000000000.${'a'.repeat(43)}`,
          notificationWording: BOOKING_NOTIFICATION_WORDING,
          appearance: standardLook,
        },
      });
    });
    const notice = page.getByTestId('booking-busy');
    const accessible = async (): Promise<void> => {
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
    };

    // The calendar: busy is said politely, never "unavailable", and the page opens by itself.
    await page.goto('/book/agency/events/venue-tour');
    await expect(notice).toHaveText('This page is busy. Trying again…');
    await expect(notice).toHaveAttribute('role', 'status');
    await expect(page.getByText(/This calendar is unavailable/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
    await accessible();
    await expect(page.getByRole('heading', { name: 'Venue tour', exact: true })).toBeVisible();
    expect(asked.calendar).toBe(2);

    // The times of today's date are busy, and stay so: after a few tries the visitor is
    // told the page is still busy, with the button, and not that the times are lost.
    await expect(page.getByRole('alert')).toHaveText(
      'This page is still busy. Try again in a moment.',
      { timeout: 15_000 },
    );
    await expect(page.getByText('Available times could not be loaded.')).toHaveCount(0);
    expect(asked.slots).toBe(4);
    await expect(page.getByRole('button', { name: 'Reload times', exact: true })).toBeVisible();
    await accessible();

    // Another date answers.
    await page.getByLabel('Appointment date', { exact: true }).fill('2030-10-01');
    await page.getByRole('radio', { name: /00:30/ }).check();
    await page.getByLabel('First name', { exact: true }).fill('Jordan');
    await page.getByLabel('Email', { exact: true }).fill('lead@example.test');
    await page.getByRole('checkbox', { name: BOOKING_NOTIFICATION_WORDING }).check();

    // The booking: sent again by itself, the same request each time, the details kept.
    await page.getByRole('button', { name: 'Book appointment', exact: true }).click();
    await expect(notice).toHaveText('This page is busy. Trying again…');
    await expect(page.getByRole('button', { name: 'Booking…', exact: true })).toBeDisabled();
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue('lead@example.test');
    await accessible();
    await expect(
      page.getByRole('heading', { name: 'Appointment booked', exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    expect(inputs).toHaveLength(3);
    // One booking, asked for three times: the server knows it by its id and stores it once.
    expect(inputs[1]).toEqual(inputs[0]);
    expect(inputs[2]).toEqual(inputs[0]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test('solves the bot check of a calendar that asks for one, says so politely, and books with the proof', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 960 });
  // A real ALTCHA challenge with little work, solved by the page's own solver in the browser.
  const challenge = await createChallenge({
    algorithm: 'PBKDF2/SHA-256',
    cost: 1,
    counter: 5,
    deriveKey,
    data: { render: 'a'.repeat(43) },
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    hmacSignatureSecret: 'a-test-only-signature-secret',
    hmacKeySignatureSecret: 'a-test-only-key-secret',
  });
  const solverLoads: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('public-booking-solver')) solverLoads.push(request.url());
  });
  const inputs: PublicBookingInput[] = [];
  const base = '/api/v1/public/book/agency/events/venue-tour';
  await page.route(`**${base}**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/challenge')) {
      expect(route.request().postDataJSON()).toEqual({
        renderToken: `1790000000000.${'a'.repeat(43)}`,
      });
      await route.fulfill({ json: { kind: 'altcha', challenge } });
      return;
    }
    if (route.request().method() === 'POST') {
      inputs.push(publicBookingInput.parse(route.request().postDataJSON()));
      await route.fulfill({
        json: {
          status: 'booked',
          startsAt: '2030-10-01T00:30:00Z',
          endsAt: '2030-10-01T01:00:00Z',
        },
      });
      return;
    }
    if (url.pathname.endsWith('/slots')) {
      await route.fulfill({
        json: { slots: [{ startsAt: '2030-10-01T00:30:00Z', endsAt: '2030-10-01T01:00:00Z' }] },
      });
      return;
    }
    await route.fulfill({
      json: {
        name: 'Venue tour',
        description: 'Visit the waterfront venue.',
        timezone: 'UTC',
        slotMinutes: 30,
        durations: [30],
        renderToken: `1790000000000.${'a'.repeat(43)}`,
        notificationWording: null,
        appearance: standardLook,
        botProtection: 'altcha',
      },
    });
  });
  await page.goto('/book/agency/events/venue-tour');
  await expect(page.getByRole('heading', { name: 'Venue tour', exact: true })).toBeVisible();
  const check = page.getByRole('status').filter({ hasText: 'Check complete.' });
  await expect(check).toBeVisible();
  expect(solverLoads).toHaveLength(1);
  await page.getByLabel('Appointment date', { exact: true }).fill('2030-10-01');
  await page.getByRole('radio', { name: /00:30/ }).check();
  await page.getByLabel('Email', { exact: true }).fill('lead@example.test');
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  // Nothing to see or do: the button is the only thing between the visitor and the booking.
  await page.getByRole('button', { name: 'Book appointment', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Appointment booked', exact: true }),
  ).toBeVisible();
  expect(inputs).toHaveLength(1);
  expect(inputs[0]?.botProof).toMatchObject({ kind: 'altcha', solution: { counter: 5 } });
});
