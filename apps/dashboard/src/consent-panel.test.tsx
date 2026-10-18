// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  consentChannels,
  consentPurposes,
  type ConsentChange,
  type ConsentState,
  type ContactConsent,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ConsentPanel } from './consent-panel';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const contactId = 'con_01m4bd188ff82s0add91b7pz63';
const at = '2026-10-08T12:00:00.000Z';

function consentOf(
  patch: Partial<ContactConsent> = {},
  states: Readonly<Record<string, ConsentState['status']>> = {},
): ContactConsent {
  return {
    canManage: true,
    doNotContact: false,
    timeZone: 'Africa/Nairobi',
    current: consentChannels.flatMap((channel) =>
      consentPurposes.map((purpose): ConsentState => {
        const status = states[`${channel}:${purpose}`] ?? 'unknown';
        return {
          channel,
          purpose,
          status,
          source: status === 'unknown' ? null : 'user',
          recordedAt: status === 'unknown' ? null : at,
        };
      }),
    ),
    suppressions: [],
    history: [],
    historyTruncated: false,
    ...patch,
  };
}

const noProof = {
  note: null,
  wording: null,
  keyword: null,
  ipAddress: null,
  pageUrl: null,
  linked: null,
};
const changeOf = (patch: Partial<ConsentChange>): ConsentChange => ({
  channel: 'email',
  purpose: 'marketing',
  status: 'granted',
  source: 'user',
  recordedAt: at,
  recordedBy: { kind: 'user', name: 'Dana Brooks', you: false },
  proof: noProof,
  ...patch,
});

function open(props: { readOnly?: boolean } = {}): ReturnType<typeof userEvent.setup> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <ConsentPanel contactId={contactId} {...props} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  // Keys follow one another with no timer between them (user-event's `delay`). Every key
  // is still its own events and its own render; what goes is a wait per character, which
  // on a busy machine took a long test past its five seconds.
  return userEvent.setup({ delay: null });
}

const row = async (name: string): Promise<HTMLElement> => {
  const item = (await screen.findByRole('heading', { name, level: 3 })).closest('li');
  if (item === null) throw new Error(`No row for ${name}.`);
  return item;
};
const records = (): unknown[] =>
  server.calls
    .filter((call) => call.operation === 'recordContactConsent')
    .map((call) => call.input);

it('says in plain words what may be sent, for email and texts', async () => {
  server.answer = () =>
    consentOf({}, { 'email:marketing': 'granted', 'sms:marketing': 'withdrawn' });
  open();
  const email = await row('Marketing email');
  expect(within(email).getByText('Consent given')).toBeDefined();
  expect(within(email).getByText('These can be sent.')).toBeDefined();
  expect(within(email).getByText(/A team member/)).toBeDefined();
  const texts = await row('Marketing texts');
  expect(within(texts).getByText('Consent withdrawn')).toBeDefined();
  expect(within(texts).getByText("These aren't sent.")).toBeDefined();
  const service = await row('Service email');
  expect(within(service).getByText('No consent recorded')).toBeDefined();
  expect(within(service).getByText("These aren't sent until consent is recorded.")).toBeDefined();
  expect(screen.getByRole('heading', { name: 'Consent', level: 2 })).toBeDefined();
  // Channels nothing is sent on yet stay out of the way until something is recorded.
  expect(screen.queryByRole('heading', { name: /WhatsApp/ })).toBeNull();
  expect(screen.queryByRole('heading', { name: /calls/ })).toBeNull();
  expect(server.calls).toEqual([
    { operation: 'getContactConsent', input: { params: { id: contactId } } },
  ]);
});

it('shows what stops every message before the consent itself', async () => {
  server.answer = () =>
    consentOf(
      {
        doNotContact: true,
        timeZone: null,
        suppressions: [
          {
            channel: 'email',
            address: 'maya@example.com',
            reason: 'hard_bounce',
            since: at,
            until: null,
          },
        ],
      },
      { 'email:marketing': 'granted', 'whatsapp:marketing': 'granted' },
    );
  open();
  expect(await screen.findByText(/Do not contact is on\./)).toBeDefined();
  expect(
    screen.getByText("maya@example.com can't be sent to: a message to it bounced."),
  ).toBeDefined();
  expect(screen.getByText(/This contact has no time zone\./)).toBeDefined();
  const email = await row('Marketing email');
  expect(within(email).getByText('Consent given')).toBeDefined();
  expect(within(email).getByText("These aren't sent: do not contact is on.")).toBeDefined();
  expect(await row('Marketing WhatsApp messages')).toBeDefined();
});

it('names a blocked address as the reason when nothing else stops the message', async () => {
  server.answer = () =>
    consentOf(
      {
        suppressions: [
          {
            channel: 'email',
            address: 'maya@example.com',
            reason: 'complaint',
            since: at,
            until: null,
          },
        ],
      },
      { 'email:marketing': 'granted', 'sms:marketing': 'granted' },
    );
  open();
  expect(
    within(await row('Marketing email')).getByText(
      "These aren't sent: the address can't be sent to.",
    ),
  ).toBeDefined();
  expect(within(await row('Marketing texts')).getByText('These can be sent.')).toBeDefined();
});

it.each([
  ['without the permission', consentOf({ canManage: false }, { 'email:marketing': 'granted' }), {}],
  [
    'for a contact in the trash',
    consentOf({}, { 'email:marketing': 'granted' }),
    { readOnly: true },
  ],
])('is read-only %s', async (_label, consent, props) => {
  server.answer = () => consent;
  open(props);
  expect(within(await row('Marketing email')).getByText('Consent given')).toBeDefined();
  expect(screen.queryByRole('button', { name: /consent/i })).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('records consent from the keyboard, with a note, and keeps the keyboard on the row', async () => {
  let consent = consentOf();
  server.answer = (operation) => {
    if (operation === 'recordContactConsent') {
      consent = consentOf(
        {
          history: [
            changeOf({ channel: 'sms', proof: { ...noProof, note: 'Asked by phone today.' } }),
          ],
        },
        { 'sms:marketing': 'granted' },
      );
    }
    return consent;
  };
  const user = open();
  const button = await screen.findByRole('button', { name: 'Record consent for Marketing texts' });
  button.focus();
  await user.keyboard('{Enter}');
  const note = await screen.findByRole('textbox', { name: 'How do you know?' });
  expect(document.activeElement).toBe(note);
  expect(screen.getByRole('group', { name: 'Record consent for Marketing texts' })).toBeDefined();

  // Nothing is sent without a note that says how.
  await user.keyboard('{Tab}{Enter}');
  expect(await screen.findByText('Say how you know, in at least 10 characters.')).toBeDefined();
  await user.type(note, 'ok');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(records()).toEqual([]);

  await user.clear(note);
  await user.type(note, 'Asked by phone today.');
  await user.keyboard('{Tab}{Enter}');
  await waitFor(() => {
    expect(records()).toEqual([
      {
        params: { id: contactId },
        body: {
          channel: 'sms',
          purpose: 'marketing',
          status: 'granted',
          note: 'Asked by phone today.',
          replacesWithdrawal: false,
        },
      },
    ]);
  });
  expect(await screen.findByRole('status')).toHaveProperty(
    'textContent',
    'Consent recorded for Marketing texts.',
  );
  const next = await screen.findByRole('button', { name: 'Withdraw consent for Marketing texts' });
  await waitFor(() => {
    expect(document.activeElement).toBe(next);
  });
  expect(within(await row('Marketing texts')).getByText('Consent given')).toBeDefined();
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('withdraws consent with a note and no confirmation', async () => {
  let consent = consentOf({}, { 'email:marketing': 'granted' });
  server.answer = (operation) => {
    if (operation === 'recordContactConsent')
      consent = consentOf({}, { 'email:marketing': 'withdrawn' });
    return consent;
  };
  const user = open();
  await user.click(
    await screen.findByRole('button', { name: 'Withdraw consent for Marketing email' }),
  );
  expect(screen.queryByRole('checkbox')).toBeNull();
  await user.type(
    screen.getByRole('textbox', { name: 'How do you know?' }),
    'Emailed asking to stop.',
  );
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(records()).toEqual([
      {
        params: { id: contactId },
        body: {
          channel: 'email',
          purpose: 'marketing',
          status: 'withdrawn',
          note: 'Emailed asking to stop.',
          replacesWithdrawal: false,
        },
      },
    ]);
  });
  expect(await screen.findByText('Withdrawal recorded for Marketing email.')).toBeDefined();
});

it('gives consent over a withdrawal only after the person confirms the contact asked again', async () => {
  let consent = consentOf({}, { 'email:marketing': 'withdrawn' });
  server.answer = (operation) => {
    if (operation === 'recordContactConsent')
      consent = consentOf({}, { 'email:marketing': 'granted' });
    return consent;
  };
  const user = open();
  await user.click(
    await screen.findByRole('button', { name: 'Record consent for Marketing email' }),
  );
  await user.type(
    screen.getByRole('textbox', { name: 'How do you know?' }),
    'Asked in person to rejoin.',
  );
  const confirm = screen.getByRole('checkbox', {
    name: /This contact withdrew consent on .+\. I confirm/,
  });
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(
    await screen.findByText('Confirm that the contact asked to get these messages again.'),
  ).toBeDefined();
  expect(records()).toEqual([]);
  await user.click(confirm);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(records()).toMatchObject([
      { body: { status: 'granted', replacesWithdrawal: true, note: 'Asked in person to rejoin.' } },
    ]);
  });
});

it('keeps the note and says why when the change is refused or the connection fails', async () => {
  const refusals: unknown[] = [
    new ApiError({
      type: 'about:blank',
      title: 'Unprocessable',
      status: 422,
      errors: [{ path: '/note', code: 'too_small', message: 'Say more about how you know.' }],
    }),
    new ApiError({
      type: 'about:blank',
      title: 'Unprocessable',
      status: 422,
      errors: [
        {
          path: '/replacesWithdrawal',
          code: 'consent_withdrawn',
          message:
            'This contact withdrew consent. Confirm that they asked to get these messages again.',
        },
      ],
    }),
    new ApiError({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: "Your role doesn't allow this.",
    }),
    new TypeError('Failed to fetch'),
  ];
  server.answer = (operation) => {
    if (operation !== 'recordContactConsent') return consentOf();
    throw refusals.shift();
  };
  const user = open();
  await user.click(
    await screen.findByRole('button', { name: 'Record consent for Marketing email' }),
  );
  const note = screen.getByRole('textbox', { name: 'How do you know?' });
  await user.type(note, 'Asked by phone today');
  let written = 'Asked by phone today';
  for (const message of [
    'Say more about how you know.',
    'This contact withdrew consent. Confirm that they asked to get these messages again.',
    "Your role doesn't allow this.",
    "The change wasn't saved. Check your connection and try again.",
  ]) {
    // A refusal under the note stays until the note changes, so the person edits it.
    await user.type(note, '.');
    written += '.';
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(message)).toBeDefined();
    expect(note).toHaveProperty('value', written);
  }
  expect(records()).toHaveLength(4);
  // Cancel closes the form, changes nothing, and gives the keyboard back to the row.
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  const button = await screen.findByRole('button', { name: 'Record consent for Marketing email' });
  await waitFor(() => {
    expect(document.activeElement).toBe(button);
  });
  expect(records()).toHaveLength(4);
});

it('lists every change with who recorded it, where it came from and its proof', async () => {
  server.answer = () =>
    consentOf(
      {
        historyTruncated: true,
        history: [
          changeOf({
            status: 'withdrawn',
            source: 'unsubscribe_link',
            recordedBy: { kind: 'contact', name: null, you: false },
            proof: { ...noProof, linked: 'message' },
          }),
          changeOf({
            source: 'form',
            recordedBy: { kind: 'contact', name: null, you: false },
            proof: {
              ...noProof,
              wording: 'Send me offers by email.',
              pageUrl: 'https://example.com/signup',
              ipAddress: '203.0.113.9',
              linked: 'form',
            },
          }),
          changeOf({
            channel: 'sms',
            status: 'withdrawn',
            source: 'keyword',
            recordedBy: { kind: 'contact', name: null, you: false },
            proof: { ...noProof, keyword: 'STOP', linked: 'message' },
          }),
          changeOf({
            recordedBy: { kind: 'user', name: 'Dana Brooks', you: true },
            proof: { ...noProof, note: 'Asked at the front desk.' },
          }),
        ],
      },
      { 'email:marketing': 'withdrawn' },
    );
  const user = open();
  await user.click(await screen.findByText('History and proof (4)'));
  const history = screen.getByText('History and proof (4)').closest('details');
  if (history === null) throw new Error('No history.');
  const items = within(history).getAllByRole('listitem');
  expect(items.map((item) => item.querySelector('p')?.textContent)).toEqual([
    'Consent withdrawn for Marketing email',
    'Consent given for Marketing email',
    'Consent withdrawn for Marketing texts',
    'Consent given for Marketing email',
  ]);
  const [unsubscribed, form, keyword, staff] = items;
  if (
    unsubscribed === undefined ||
    form === undefined ||
    keyword === undefined ||
    staff === undefined
  )
    throw new Error('Four entries were expected.');
  expect(unsubscribed.textContent).toContain('Recorded by Contact');
  expect(unsubscribed.textContent).toContain('The unsubscribe link');
  expect(unsubscribed.textContent).toContain('Kept with the message it came from.');
  expect(form.textContent).toContain('What they agreed to: Send me offers by email.');
  expect(form.textContent).toContain('Page: https://example.com/signup');
  expect(form.textContent).toContain('IP address: 203.0.113.9');
  expect(keyword.textContent).toContain('Keyword: STOP');
  expect(staff.textContent).toContain('Recorded by You');
  expect(staff.textContent).toContain('Note: Asked at the front desk.');
  expect(within(history).getByText('Only the newest changes are shown.')).toBeDefined();
});

it('says so when nothing was ever recorded, and offers a retry when loading fails', async () => {
  let fail = true;
  server.answer = () => {
    if (fail) throw new ApiError({ type: 'about:blank', title: 'Not found', status: 404 });
    return consentOf();
  };
  const user = open();
  expect((await screen.findByRole('alert')).textContent).toContain(
    "The consent couldn't be loaded.",
  );
  fail = false;
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(
    await screen.findByText('No consent changes have been recorded for this contact.'),
  ).toBeDefined();
  expect(screen.queryByRole('alert')).toBeNull();
});
