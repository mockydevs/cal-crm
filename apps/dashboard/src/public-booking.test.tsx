// @vitest-environment jsdom
// The public booking page when the server says it is busy (429 with Retry-After): it says
// so, asks again by itself, and only then leaves trying again to the visitor. A booking is
// sent again with the same request id, so one that did arrive is stored once.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { BOOKING_NOTIFICATION_WORDING, publicBookingInput } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/pbkdf2';
import { PublicBookingPage } from './public-booking';
import { bookingTheme } from './public-booking-theme';

configure({ asyncUtilTimeout: 15000 });
vi.setConfig({ testTimeout: 40000 });

interface Sent {
  readonly method: string;
  readonly path: string;
  /** The query string, as `?date=…`, or empty. */
  readonly search: string;
  readonly body: unknown;
}
const sent: Sent[] = [];
/** What each request is answered with, by what it asks for; the newest rule first. */
let answerTo: (request: Sent, nth: number) => Response;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
// The server's own shortest wait: the page waits a second, not two, so the tests are quick.
const busy = (): Response =>
  json(
    429,
    { type: 'about:blank', title: 'Too many requests', status: 429, detail: 'Try again shortly.' },
    { 'retry-after': '1' },
  );
const calendar = {
  name: 'Venue tour',
  description: 'Visit the waterfront venue.',
  timezone: 'UTC',
  slotMinutes: 30,
  durations: [30],
  notificationWording: BOOKING_NOTIFICATION_WORDING as string | null,
  // The page's proof of when it was shown: sent back with the booking, unread by the page.
  renderToken: `1790000000000.${'a'.repeat(43)}`,
  // A new calendar's look: Neo, the standard colours, the page's own button words.
  appearance: {
    style: 'neo' as 'neo' | 'classic',
    primaryColor: '#178af6',
    backgroundColor: '#ffffff',
    buttonText: '',
    logoUrl: null as string | null,
    coverUrl: null as string | null,
  },
};
const slot = { startsAt: '2030-10-01T00:30:00Z', endsAt: '2030-10-01T01:00:00Z' };
const booked = { status: 'booked', startsAt: slot.startsAt, endsAt: slot.endsAt };
const kindOf = (request: Sent): 'calendar' | 'slots' | 'booking' | 'challenge' =>
  request.path.endsWith('/challenge')
    ? 'challenge'
    : request.method === 'POST'
      ? 'booking'
      : request.path.endsWith('/slots')
        ? 'slots'
        : 'calendar';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  sent.length = 0;
  answerTo = (request) =>
    kindOf(request) === 'calendar'
      ? json(200, calendar)
      : kindOf(request) === 'slots'
        ? json(200, { slots: [slot] })
        : json(200, booked);
  vi.stubGlobal(
    'fetch',
    vi.fn((address: string, init?: RequestInit) => {
      const request: Sent = {
        method: init?.method ?? 'GET',
        path: new URL(address, 'http://crm.test').pathname,
        search: new URL(address, 'http://crm.test').search,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      sent.push(request);
      const nth = sent.filter((each) => kindOf(each) === kindOf(request)).length;
      return Promise.resolve(answerTo(request, nth));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(): ReturnType<typeof userEvent.setup> {
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <PublicBookingPage
          params={{ agencySlug: 'agency', businessSlug: 'events', calendarSlug: 'venue-tour' }}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return userEvent.setup();
}
const count = (kind: ReturnType<typeof kindOf>): number =>
  sent.filter((each) => kindOf(each) === kind).length;

describe('the booking page, when the server is busy', () => {
  it('says the page is busy and opens by itself once the calendar is answered', async () => {
    answerTo = (request, nth) =>
      kindOf(request) === 'calendar'
        ? nth === 1
          ? busy()
          : json(200, calendar)
        : json(200, { slots: [slot] });
    show();
    const notice = await screen.findByTestId('booking-busy');
    expect(notice.textContent).toBe('This page is busy. Trying again…');
    // Told politely to whoever has the page read out, and never as a fault of the calendar.
    expect(notice.getAttribute('role')).toBe('status');
    expect(screen.queryByText(/This calendar is unavailable/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(await screen.findByRole('heading', { level: 1, name: 'Venue tour' })).toBeTruthy();
    expect(count('calendar')).toBe(2);
    expect(screen.queryByTestId('booking-busy')).toBeNull();
  });

  it('leaves trying again to the visitor only after a few tries, and still says busy, not gone', async () => {
    answerTo = (request) => (kindOf(request) === 'calendar' ? busy() : json(200, { slots: [] }));
    const user = show();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This page is still busy. Try again in a moment.',
    );
    expect(count('calendar')).toBe(4);
    expect(screen.queryByText(/This calendar is unavailable/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Booking page unavailable' })).toBeNull();
    answerTo = (request) =>
      kindOf(request) === 'calendar' ? json(200, calendar) : json(200, { slots: [slot] });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Venue tour' })).toBeTruthy();
  });

  it('still says a calendar that is not there is unavailable', async () => {
    answerTo = () => json(404, { type: 'about:blank', title: 'Not found', status: 404 });
    show();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This calendar is unavailable. Check the link or try again.',
    );
    expect(count('calendar')).toBe(1);
  });

  it('loads the times by itself after a busy answer, and says busy if it gives up', async () => {
    answerTo = (request, nth) =>
      kindOf(request) === 'slots'
        ? nth === 1
          ? busy()
          : json(200, { slots: [slot] })
        : json(200, calendar);
    const user = show();
    expect((await screen.findByTestId('booking-busy')).textContent).toBe(
      'This page is busy. Trying again…',
    );
    expect(await screen.findByRole('radio', { name: /00:30/ })).toBeTruthy();
    expect(count('slots')).toBe(2);
    expect(screen.queryByText('Available times could not be loaded.')).toBeNull();

    // Another date, and this time it stays busy.
    answerTo = (request) => (kindOf(request) === 'slots' ? busy() : json(200, calendar));
    fireEvent.change(screen.getByLabelText('Appointment date'), {
      target: { value: '2030-10-02' },
    });
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This page is still busy. Try again in a moment.',
    );
    expect(screen.queryByText('Available times could not be loaded.')).toBeNull();
    answerTo = (request) =>
      kindOf(request) === 'slots' ? json(200, { slots: [slot] }) : json(200, calendar);
    await user.click(screen.getByRole('button', { name: 'Reload times' }));
    expect(await screen.findByRole('radio', { name: /00:30/ })).toBeTruthy();
  });

  it('says times could not be loaded when that is what happened', async () => {
    answerTo = (request) =>
      kindOf(request) === 'slots'
        ? json(500, { type: 'about:blank', title: 'Error', status: 500 })
        : json(200, calendar);
    show();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Available times could not be loaded.',
    );
    expect(count('slots')).toBe(1);
  });

  const fill = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
    await user.click(await screen.findByRole('radio', { name: /00:30/ }));
    await user.type(screen.getByLabelText('Email'), 'dana@example.com');
    await user.type(screen.getByLabelText('First name'), 'Dana');
    await user.click(screen.getByRole('checkbox'));
  };
  const requestIds = (): unknown[] =>
    sent
      .filter((each) => kindOf(each) === 'booking')
      .map((each) => (each.body as { bookingRequestId: string }).bookingRequestId);

  it('sends a booking again by itself with the same request id, and keeps what was typed', async () => {
    answerTo = (request, nth) =>
      kindOf(request) === 'calendar'
        ? json(200, calendar)
        : kindOf(request) === 'slots'
          ? json(200, { slots: [slot] })
          : nth <= 2
            ? busy()
            : json(200, booked);
    const user = show();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    expect((await screen.findByTestId('booking-busy')).getAttribute('role')).toBe('status');
    // Nothing typed is lost, and it cannot be sent twice by hand meanwhile.
    expect(screen.getByLabelText('Email')).toHaveProperty('value', 'dana@example.com');
    expect(screen.getByRole('button', { name: 'Booking…' })).toHaveProperty('disabled', true);
    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeTruthy();
    expect(count('booking')).toBe(3);
    // One booking, asked for three times: the server knows it by its id and stores it once.
    expect(new Set(requestIds()).size).toBe(1);
    expect(sent.filter((each) => kindOf(each) === 'booking').map((each) => each.body)).toEqual(
      Array.from({ length: 3 }, () => sent.find((each) => kindOf(each) === 'booking')?.body),
    );
  });

  it('gives a booking back to the visitor after a few tries, details kept, and the same id goes again', async () => {
    answerTo = (request) =>
      kindOf(request) === 'calendar'
        ? json(200, calendar)
        : kindOf(request) === 'slots'
          ? json(200, { slots: [slot] })
          : busy();
    const user = show();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This page is still busy, so your booking is not recorded yet. Your details are kept: book again in a moment.',
    );
    expect(count('booking')).toBe(4);
    expect(screen.queryByTestId('booking-busy')).toBeNull();
    expect(screen.getByLabelText('Email')).toHaveProperty('value', 'dana@example.com');
    expect(screen.getByLabelText('First name')).toHaveProperty('value', 'Dana');
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /00:30/ }).checked).toBe(true);

    answerTo = (request) =>
      kindOf(request) === 'calendar'
        ? json(200, calendar)
        : kindOf(request) === 'slots'
          ? json(200, { slots: [slot] })
          : json(200, booked);
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeTruthy();
    await waitFor(() => {
      expect(count('booking')).toBe(5);
    });
    expect(new Set(requestIds()).size).toBe(1);
  });

  it('shows any other refusal of a booking in the server’s words, at once', async () => {
    answerTo = (request) =>
      kindOf(request) === 'calendar'
        ? json(200, calendar)
        : kindOf(request) === 'slots'
          ? json(200, { slots: [slot] })
          : json(409, {
              type: 'about:blank',
              title: 'Conflict',
              status: 409,
              detail: 'That time was just taken. Choose another.',
            });
    const user = show();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That time was just taken. Choose another.',
    );
    expect(count('booking')).toBe(1);
    expect(screen.queryByTestId('booking-busy')).toBeNull();
  });
});

// How the visitor arrived goes with the booking: the page's own address with its query, and
// only the origin of the site they came from, read once as the page opens, exactly as the
// form embed sends them.
describe('the booking page, sending how the visitor arrived', () => {
  const page = '/book/agency/events/venue-tour';
  const arrive = (address: string, referrer: string): void => {
    window.history.replaceState({}, '', address);
    Object.defineProperty(document, 'referrer', { configurable: true, value: referrer });
  };
  afterEach(() => {
    arrive('/', '');
  });
  const book = async (): Promise<ReturnType<typeof userEvent.setup>> => {
    const user = show();
    await user.click(await screen.findByRole('radio', { name: /00:30/ }));
    await user.type(screen.getByLabelText('Email'), 'dana@example.com');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    return user;
  };
  const visits = (): unknown[] =>
    sent
      .filter((each) => kindOf(each) === 'booking')
      .map((each) => (each.body as { visit?: unknown }).visit);

  it("carries the ad's labels and click id, and the origin of the referrer without its path", async () => {
    const ad = `${page}?utm_source=google&utm_medium=cpc&utm_campaign=spring&campaign_id=42&gclid=Cj0abc`;
    arrive(ad, 'https://www.google.com/aclk?sa=l&q=venue');
    await book();
    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeTruthy();
    expect(visits()).toEqual([
      { pageUrl: `${window.location.origin}${ad}`, referrer: 'https://www.google.com' },
    ]);
  });

  it('carries no ad parameters when the page was opened by a bare link', async () => {
    arrive(page, '');
    await book();
    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeTruthy();
    expect(visits()).toEqual([{ pageUrl: `${window.location.origin}${page}` }]);
  });

  it('keeps the visit it opened with, on every try of the same request', async () => {
    const ad = `${page}?utm_source=facebook&utm_medium=paid_social&fbclid=IwAR0abc`;
    arrive(ad, 'https://l.facebook.com/l.php?u=x');
    answerTo = (request, nth) =>
      kindOf(request) === 'calendar'
        ? json(200, calendar)
        : kindOf(request) === 'slots'
          ? json(200, { slots: [slot] })
          : nth <= 2
            ? busy()
            : json(200, booked);
    const user = show();
    await user.click(await screen.findByRole('radio', { name: /00:30/ }));
    await user.type(screen.getByLabelText('Email'), 'dana@example.com');
    await user.click(screen.getByRole('checkbox'));
    // The address changes after the page opened: what it opened with is what is sent.
    window.history.replaceState({}, '', `${page}?step=details`);
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeTruthy();
    expect(count('booking')).toBe(3);
    const bodies = sent.filter((each) => kindOf(each) === 'booking').map((each) => each.body);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(visits()[0]).toEqual({
      pageUrl: `${window.location.origin}${ad}`,
      referrer: 'https://l.facebook.com',
    });
  });

  it('writes nothing to a cookie or to the browser storage', async () => {
    arrive(`${page}?gclid=Cj0abc`, 'https://www.google.com/');
    await book();
    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeTruthy();
    expect(document.cookie).toBe('');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

// What the page sends and says besides the visitor's details: the proof of when it was
// shown and the field people cannot see, the box only when the calendar asks for it, the
// length when there is more than one, and whether a confirmation was emailed.
describe('the booking page, with what the calendar asks for', () => {
  const bookings = (): Record<string, unknown>[] =>
    sent
      .filter((each) => kindOf(each) === 'booking')
      .map((each) => each.body as Record<string, unknown>);
  const slotQueries = (): URLSearchParams[] =>
    sent.filter((each) => kindOf(each) === 'slots').map((each) => new URLSearchParams(each.search));
  const answer = (page: typeof calendar, receipt: Record<string, unknown> = booked): void => {
    answerTo = (request) =>
      kindOf(request) === 'calendar'
        ? json(200, page)
        : kindOf(request) === 'slots'
          ? json(200, { slots: [slot] })
          : json(200, receipt);
  };

  it('sends the page’s proof and the empty hidden field with the booking', async () => {
    const user = show();
    await user.click(await screen.findByRole('radio', { name: /00:30/ }));
    await user.type(screen.getByLabelText('Email'), 'dana@example.com');
    await user.click(screen.getByRole('checkbox', { name: BOOKING_NOTIFICATION_WORDING }));
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeTruthy();
    const [body] = bookings();
    expect(body).toMatchObject({
      renderToken: calendar.renderToken,
      trap: '',
      notificationConsent: true,
    });
    // One length only: none is chosen, so none is sent, and the times are asked without it.
    expect(body).not.toHaveProperty('minutes');
    expect(slotQueries().every((query) => !query.has('minutes'))).toBe(true);
    expect(screen.queryByLabelText('Length')).toBeNull();
    expect(publicBookingInput.parse(body)).toMatchObject({ renderToken: calendar.renderToken });
  });

  it('shows no consent box when the calendar asks for none, and still books', async () => {
    answer({ ...calendar, notificationWording: null });
    const user = show();
    await user.click(await screen.findByRole('radio', { name: /00:30/ }));
    await user.type(screen.getByLabelText('Email'), 'dana@example.com');
    expect(screen.queryByRole('checkbox')).toBeNull();
    const submit = screen.getByRole('button', { name: 'Book appointment' });
    expect(submit).toHaveProperty('disabled', false);
    await user.click(submit);
    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeTruthy();
    const [body] = bookings();
    expect(body).not.toHaveProperty('notificationConsent');
    expect(publicBookingInput.parse(body).notificationConsent).toBeUndefined();
  });

  it('keeps the booking closed until the box is ticked when the calendar asks for it', async () => {
    const user = show();
    await user.click(await screen.findByRole('radio', { name: /00:30/ }));
    await user.type(screen.getByLabelText('Email'), 'dana@example.com');
    expect(screen.getByRole('button', { name: 'Book appointment' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.click(screen.getByRole('checkbox', { name: BOOKING_NOTIFICATION_WORDING }));
    expect(screen.getByRole('button', { name: 'Book appointment' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('offers the lengths, asks for the times of the one chosen, and books it', async () => {
    answer({ ...calendar, durations: [30, 60] });
    const user = show();
    const length = await screen.findByRole('combobox', { name: 'Length' });
    expect(length.textContent).toContain('30 minutes');
    await screen.findByRole('radio', { name: /00:30/ });
    expect(slotQueries().map((query) => query.get('minutes'))).toEqual(['30']);

    await user.click(screen.getByRole('radio', { name: /00:30/ }));
    await user.click(length);
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      '30 minutes',
      '60 minutes',
    ]);
    await user.click(screen.getByRole('option', { name: '60 minutes' }));
    expect(length.textContent).toContain('60 minutes');
    await waitFor(() => {
      expect(slotQueries().map((query) => query.get('minutes'))).toEqual(['30', '60']);
    });
    // A time chosen for another length is not kept.
    expect(
      screen
        .queryAllByRole<HTMLInputElement>('radio', { name: /00:30/ })
        .some((each) => each.checked),
    ).toBe(false);
    await user.click(await screen.findByRole('radio', { name: /00:30/ }));
    await user.type(screen.getByLabelText('Email'), 'dana@example.com');
    await user.click(screen.getByRole('checkbox', { name: BOOKING_NOTIFICATION_WORDING }));
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeTruthy();
    expect(bookings()[0]).toMatchObject({ minutes: 60, startsAt: slot.startsAt });
  });

  it('says no email is sent when the receipt says none was, and to keep the link', async () => {
    answer(
      { ...calendar, notificationWording: null },
      { ...booked, emailed: false, managementUrl: 'https://crm.test/appointments/manage' },
    );
    const user = show();
    await user.click(await screen.findByRole('radio', { name: /00:30/ }));
    await user.type(screen.getByLabelText('Email'), 'dana@example.com');
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeTruthy();
    expect(
      screen.getByText(
        'No confirmation email is sent for this booking. Keep the link below to change or cancel it.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/A confirmation is on its way/)).toBeNull();
  });

  it('says a confirmation is on its way when the receipt says one was emailed', async () => {
    answer(calendar, { ...booked, emailed: true });
    const user = show();
    await user.click(await screen.findByRole('radio', { name: /00:30/ }));
    await user.type(screen.getByLabelText('Email'), 'dana@example.com');
    await user.click(screen.getByRole('checkbox', { name: BOOKING_NOTIFICATION_WORDING }));
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeTruthy();
    expect(
      screen.getByText('A confirmation is on its way to your email, with a calendar invite.'),
    ).toBeTruthy();
    expect(screen.queryByText(/No confirmation email is sent/)).toBeNull();
  });
});

describe('the booking page, in the calendar’s own look', () => {
  const look = (appearance: Partial<typeof calendar.appearance>): void => {
    answerTo = (request) =>
      kindOf(request) === 'calendar'
        ? json(200, { ...calendar, appearance: { ...calendar.appearance, ...appearance } })
        : kindOf(request) === 'slots'
          ? json(200, { slots: [slot] })
          : json(200, booked);
  };

  it('draws Neo in the calendar’s colours, kept readable, with its button words and pictures', async () => {
    look({
      primaryColor: '#ffe14d',
      backgroundColor: '#101828',
      buttonText: 'Book my tour',
      logoUrl: 'https://crm.test/m/AbCdEfGhIjKlMnOpQrStUv/logo.png',
      coverUrl: 'https://crm.test/m/BbCdEfGhIjKlMnOpQrStUv/cover.png',
    });
    show();
    const widget = await screen.findByTestId('booking-widget');
    const theme = bookingTheme('#ffe14d', '#101828');
    for (const [name, value] of Object.entries(theme))
      expect(widget.style.getPropertyValue(name), name).toBe(value);
    // Light words on the dark background, and readable words on the yellow button.
    expect(theme['--ink']).toBe('#FFFFFF');
    expect(theme['--accent-ink']).not.toBe('#FFFFFF');
    expect(widget.style.colorScheme).toBe('dark');
    expect(await screen.findByRole('button', { name: 'Book my tour' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Book appointment' })).toBeNull();
    expect(screen.getByTestId('booking-logo').getAttribute('src')).toBe(
      'https://crm.test/m/AbCdEfGhIjKlMnOpQrStUv/logo.png',
    );
    expect(screen.getByTestId('booking-cover').getAttribute('src')).toBe(
      'https://crm.test/m/BbCdEfGhIjKlMnOpQrStUv/cover.png',
    );
    // Both are only to look at: the name beside the logo says what it is.
    expect(screen.getByTestId('booking-logo').getAttribute('alt')).toBe('');
    expect(screen.getByRole('heading', { level: 1, name: 'Venue tour' })).toBeTruthy();
  });

  it('draws Classic in the page’s own colours and words, as GoHighLevel keeps its standard widget', async () => {
    look({
      style: 'classic',
      primaryColor: '#ffe14d',
      backgroundColor: '#101828',
      buttonText: 'Book my tour',
      logoUrl: 'https://crm.test/m/AbCdEfGhIjKlMnOpQrStUv/logo.png',
    });
    show();
    expect(await screen.findByRole('button', { name: 'Book appointment' })).toBeTruthy();
    expect(screen.queryByTestId('booking-widget')).toBeNull();
    expect(screen.getByTestId('booking-logo')).toBeTruthy();
    expect(screen.queryByTestId('booking-cover')).toBeNull();
  });

  it('shows no picture where the calendar has none public', async () => {
    show();
    await screen.findByTestId('booking-widget');
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByTestId('booking-logo')).toBeNull();
    expect(screen.queryByTestId('booking-cover')).toBeNull();
  });
});

describe('the booking page, when the calendar asks for bot protection', () => {
  const guarded = { ...calendar, botProtection: 'altcha' as const };
  // A real ALTCHA challenge with little work, solved by the page's own lazily loaded solver.
  const made = (): Promise<unknown> =>
    createChallenge({
      algorithm: 'PBKDF2/SHA-256',
      cost: 1,
      counter: 3,
      deriveKey,
      data: { render: calendar.renderToken.slice(14) },
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      hmacSignatureSecret: 'a-test-only-signature-secret',
      hmacKeySignatureSecret: 'a-test-only-key-secret',
    });
  const fillIn = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
    await user.click(await screen.findByRole('radio', { name: /00:30/ }));
    await user.type(screen.getByLabelText('Email'), 'dana@example.com');
    await user.click(screen.getByRole('checkbox'));
  };

  it('solves the challenge for this showing as the page opens, says so politely, and books with the proof', async () => {
    const challenge = await made();
    answerTo = (request) =>
      kindOf(request) === 'calendar'
        ? json(200, guarded)
        : kindOf(request) === 'slots'
          ? json(200, { slots: [slot] })
          : kindOf(request) === 'challenge'
            ? json(200, { kind: 'altcha', challenge })
            : json(200, booked);
    const user = show();
    const status = await screen.findByTestId('booking-check');
    expect(status.getAttribute('role')).toBe('status');
    await waitFor(() => {
      expect(status.textContent).toBe('Check complete.');
    });
    expect(sent.find((each) => kindOf(each) === 'challenge')?.body).toEqual({
      renderToken: calendar.renderToken,
    });
    await fillIn(user);
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeTruthy();
    const body = publicBookingInput.parse(sent.find((each) => kindOf(each) === 'booking')?.body);
    expect(body.botProof).toMatchObject({ kind: 'altcha', challenge });
    expect(body.botProof?.solution.counter).toBe(3);
  });

  it('says the check did not finish and books nothing, then tries again on the next press', async () => {
    const challenge = await made();
    answerTo = (request, nth) =>
      kindOf(request) === 'calendar'
        ? json(200, guarded)
        : kindOf(request) === 'slots'
          ? json(200, { slots: [slot] })
          : kindOf(request) === 'challenge'
            ? nth <= 2
              ? json(500, { type: 'about:blank', title: 'Error', status: 500 })
              : json(200, { kind: 'altcha', challenge })
            : json(200, booked);
    const user = show();
    await waitFor(() => {
      expect(screen.getByTestId('booking-check').textContent).toBe(
        "We couldn't finish checking that you're a person. Book again to retry.",
      );
    });
    await fillIn(user);
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      "We couldn't finish checking that you're a person. Book again to retry.",
    );
    expect(count('booking')).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeTruthy();
    expect(count('challenge')).toBe(3);
  });

  it('asks for no challenge on a calendar without it, and sends no proof', async () => {
    const user = show();
    await fillIn(user);
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    expect(await screen.findByRole('heading', { name: 'Appointment booked' })).toBeTruthy();
    expect(count('challenge')).toBe(0);
    expect(screen.queryByTestId('booking-check')).toBeNull();
    expect(sent.find((each) => kindOf(each) === 'booking')?.body).not.toHaveProperty('botProof');
  });
});
