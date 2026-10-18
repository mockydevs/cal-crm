// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ContactPreferences } from './contact-preferences';
// Loaded here, before any test starts: the page fetches these lazily, and a test that had to
// wait for their code to be read for the first time lost that race on a busy machine. With
// them loaded, a test waits on React alone.
import './contact-preferences-forms';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
  /** The server's own list of zones, which the picker shows. */
  zones: () => unknown;
}
const server = vi.hoisted((): Server => ({
  calls: [],
  answer: () => undefined,
  zones: () => undefined,
}));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      if (endpoint.operationId === 'listTimeZones') return Promise.resolve().then(server.zones);
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
// A server that lists every zone this runtime knows, as most do.
const everyZone = { items: [...Intl.supportedValuesOf('timeZone'), 'UTC'].sort() };
beforeEach(() => {
  server.calls.length = 0;
  server.zones = () => everyZone;
});
afterEach(cleanup);

const contactId = 'con_01m4bd188ff82s0add91b7pz63';
const contactKey = ['b', 'biz_test', 'contacts', contactId];
const first = 'a'.repeat(64);
const second = 'b'.repeat(64);
const reason = 'Asked by phone on 9 October to stop.';

interface Shown {
  timeZone: string | null;
  doNotContact: boolean;
  preferencesRevision: string;
  canManage: boolean;
}
const contactOf = (patch: Partial<Shown> = {}): Record<string, unknown> => ({
  id: contactId,
  firstName: 'Maya',
  lastName: 'Thompson',
  name: 'Maya Thompson',
  emails: ['maya@example.com'],
  phones: [],
  timeZone: null,
  doNotContact: false,
  preferencesRevision: first,
  trashedAt: null,
  createdAt: '2026-10-08T12:00:00.000Z',
  updatedAt: '2026-10-08T12:00:00.000Z',
  canManage: true,
  ...patch,
});

function open(props: { readOnly?: boolean } = {}): {
  user: ReturnType<typeof userEvent.setup>;
  client: QueryClient;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <ContactPreferences contactId={contactId} {...props} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  // Keys follow one another with no timer between them (user-event's `delay`). Every key
  // is still its own events and its own render; what goes is a wait per character, which
  // on a busy machine took a long test past its five seconds.
  return { user: userEvent.setup({ delay: null }), client };
}

/** The server keeps one contact; a save answers with what `change` makes of it. */
function serve(
  start: Record<string, unknown>,
  change: (body: Record<string, unknown>) => Record<string, unknown> = () => ({}),
): { current: () => Record<string, unknown>; set: (patch: Partial<Shown>) => void } {
  let contact = start;
  server.answer = (operation, input) => {
    if (operation === 'updateContact') {
      const { body } = input as { body: Record<string, unknown> };
      contact = { ...contact, ...change(body) };
    }
    return contact;
  };
  return {
    current: () => contact,
    set: (patch) => {
      contact = { ...contact, ...patch };
    },
  };
}

const saves = (): unknown[] =>
  server.calls.filter((call) => call.operation === 'updateContact').map((call) => call.input);
const refusal = (status: number, errors?: { path: string; code: string; message: string }[]) =>
  new ApiError({
    type: 'about:blank',
    title: 'Refused',
    status,
    ...(errors === undefined ? {} : { errors }),
  });
const section = async (name: string): Promise<HTMLElement> => {
  const block = (await screen.findByRole('heading', { name, level: 3 })).parentElement;
  if (block === null) throw new Error(`No section for ${name}.`);
  return block;
};
const zoneBox = (): HTMLElement => screen.getByRole('combobox', { name: 'Time zone' });

it('shows the time zone with its offset, and that do not contact is off', async () => {
  serve(contactOf({ timeZone: 'Africa/Nairobi' }));
  open();
  const zone = await section('Time zone');
  expect(within(zone).getByText('Africa/Nairobi')).toBeDefined();
  expect(within(zone).getByText('GMT+3 · East Africa Time')).toBeDefined();
  expect(within(zone).getByText('Quiet hours follow the clock there.')).toBeDefined();
  expect(within(zone).getByRole('button', { name: 'Change time zone' })).toBeDefined();
  const block = await section('Do not contact');
  expect(within(block).getByText('Off')).toBeDefined();
  expect(
    within(block).getByText('Messages are sent to this contact where their consent allows it.'),
  ).toBeDefined();
  expect(within(block).getByRole('button', { name: 'Turn on do not contact' })).toBeDefined();
  expect(
    screen.getByRole('heading', { name: 'Time zone and do not contact', level: 2 }),
  ).toBeDefined();
  expect(server.calls).toEqual([{ operation: 'getContact', input: { params: { id: contactId } } }]);
});

it('says what a missing time zone and do not contact mean for sending', async () => {
  serve(contactOf({ doNotContact: true }));
  open();
  expect(
    within(await section('Time zone')).getByText(
      "This contact has no time zone. Quiet hours follow the business's time zone.",
    ),
  ).toBeDefined();
  expect(screen.getByRole('button', { name: 'Set time zone' })).toBeDefined();
  const block = await section('Do not contact');
  expect(within(block).getByText('On')).toBeDefined();
  expect(
    within(block).getByText(
      'No messages are sent to this contact, on any channel, whatever consent is recorded.',
    ),
  ).toBeDefined();
  expect(within(block).getByRole('button', { name: 'Turn off do not contact' })).toBeDefined();
});

it.each([
  ['without the permission', contactOf({ timeZone: 'Africa/Nairobi', canManage: false }), {}],
  ['for a contact in the trash', contactOf({ timeZone: 'Africa/Nairobi' }), { readOnly: true }],
])('is read-only %s', async (_label, contact, props) => {
  serve(contact);
  open(props);
  expect(within(await section('Time zone')).getByText('Africa/Nairobi')).toBeDefined();
  expect(within(await section('Do not contact')).getByText('Off')).toBeDefined();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
});

// Searching the whole list and saving a choice were one test once. Drawing about four
// hundred options and narrowing them key by key is most of a second by itself, so each is
// its own test now.

/** Opens the time zone form from the keyboard, and waits for the keyboard to be in its box. */
async function openZonesByKeyboard(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const button = await screen.findByRole('button', { name: 'Set time zone' });
  button.focus();
  await user.keyboard('{Enter}');
  // The form's code and the server's zones arrive, and the keyboard is in the box.
  const box = await screen.findByRole('combobox', { name: 'Time zone' });
  await waitFor(() => {
    expect(document.activeElement).toBe(box);
  });
  expect(screen.getByRole('group', { name: 'Set time zone' })).toBeDefined();
  return box;
}
// The list and its options are found by their role attribute in these two tests, not by a
// search of the page by role: working out the role of each of four hundred options, at
// every look, is several times slower, and slower again on a busy machine.
const zoneList = (): Element | null => document.querySelector('[role="listbox"]');
const zoneOptions = (): Element[] => [...document.querySelectorAll('[role="option"]')];

it('searches about four hundred zones from the keyboard', async () => {
  serve(contactOf(), (body) => ({ timeZone: body['timeZone'], preferencesRevision: second }));
  const { user } = open();
  await openZonesByKeyboard(user);
  // The whole list is there before anything is typed, and typing narrows it.
  await user.keyboard('{ArrowDown}');
  await waitFor(() => {
    expect(zoneList()).not.toBeNull();
  });
  expect(zoneOptions().length).toBeGreaterThan(300);
  await user.keyboard('east africa nairobi');
  await waitFor(() => {
    expect(zoneOptions().map((option) => option.getAttribute('data-value'))).toEqual([
      'Africa/Nairobi',
    ]);
  });
  expect(saves()).toEqual([]);
});

it('sets a time zone from the keyboard: Enter chooses, and Enter again saves', async () => {
  serve(contactOf(), (body) => ({ timeZone: body['timeZone'], preferencesRevision: second }));
  const { user } = open();
  const box = await openZonesByKeyboard(user);
  await user.keyboard('nairobi');
  await waitFor(() => {
    expect(zoneOptions().map((option) => option.getAttribute('data-value'))).toEqual([
      'Africa/Nairobi',
    ]);
  });
  // Enter chooses the highlighted zone; Enter again, with the list closed, saves.
  await user.keyboard('{Enter}');
  expect(box).toHaveProperty('value', 'Africa/Nairobi');
  await waitFor(() => {
    expect(zoneList()).toBeNull();
  });
  expect(saves()).toEqual([]);
  await user.keyboard('{Enter}');
  await waitFor(() => {
    expect(saves()).toEqual([
      {
        params: { id: contactId },
        body: { timeZone: 'Africa/Nairobi', preferencesRevision: first },
      },
    ]);
  });
  expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Time zone saved.');
  const next = await screen.findByRole('button', { name: 'Change time zone' });
  await waitFor(() => {
    expect(document.activeElement).toBe(next);
  });
  expect(within(await section('Time zone')).getByText('GMT+3 · East Africa Time')).toBeDefined();
  expect(screen.queryByRole('combobox')).toBeNull();
});

it('removes the time zone when the box is cleared, and sends nothing when nothing changed', async () => {
  serve(contactOf({ timeZone: 'Africa/Nairobi' }), (body) => ({
    timeZone: body['timeZone'],
    preferencesRevision: second,
  }));
  const { user } = open();
  await user.click(await screen.findByRole('button', { name: 'Change time zone' }));
  expect(await screen.findByRole('combobox', { name: 'Time zone' })).toHaveProperty(
    'value',
    'Africa/Nairobi',
  );
  expect(screen.getByText(/Clear the box to remove the time zone\./)).toBeDefined();
  // Saving what is already there closes the form without a request.
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('button', { name: 'Change time zone' })).toBeDefined();
  expect(saves()).toEqual([]);

  await user.click(screen.getByRole('button', { name: 'Change time zone' }));
  await user.click(await screen.findByRole('button', { name: 'Clear time zone' }));
  expect(zoneBox()).toHaveProperty('value', '');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(saves()).toEqual([
      { params: { id: contactId }, body: { timeZone: null, preferencesRevision: first } },
    ]);
  });
  expect(await screen.findByText('Time zone removed.')).toBeDefined();
  expect(await screen.findByRole('button', { name: 'Set time zone' })).toBeDefined();
});

it('offers the zones the server lists, under the names it has for them', async () => {
  // A server without the older names: India is Asia/Kolkata there, whatever the browser says.
  server.zones = () => ({ items: ['Africa/Nairobi', 'Asia/Kolkata', 'Etc/GMT+3', 'UTC'] });
  serve(contactOf(), (body) => ({ timeZone: body['timeZone'], preferencesRevision: second }));
  const { user } = open();
  await user.click(await screen.findByRole('button', { name: 'Set time zone' }));
  await user.click(await screen.findByRole('combobox', { name: 'Time zone' }));
  await screen.findByRole('listbox');
  expect(screen.getAllByRole('option').map((option) => option.getAttribute('data-value'))).toEqual([
    'UTC',
    'Africa/Nairobi',
    'Asia/Kolkata',
  ]);
  await user.keyboard('new york');
  expect(await screen.findByText('No time zones match.')).toBeDefined();
  await user.clear(zoneBox());
  await user.type(zoneBox(), 'india{Enter}');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(saves()).toEqual([
      { params: { id: contactId }, body: { timeZone: 'Asia/Kolkata', preferencesRevision: first } },
    ]);
  });
});

it("waits for the server's zones, and offers a retry when they don't arrive", async () => {
  serve(contactOf());
  let finish = (): void => undefined;
  let attempts = 0;
  server.zones = () => {
    attempts += 1;
    if (attempts === 1) throw refusal(503);
    return new Promise((resolve) => {
      finish = () => {
        resolve(everyZone);
      };
    });
  };
  const { user } = open();
  await user.click(await screen.findByRole('button', { name: 'Set time zone' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    "The time zones couldn't be loaded.",
  );
  // Nothing can be saved without the list, and the form can still be left.
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined();
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Loading time zones…')).toBeDefined();
  finish();
  expect(await screen.findByRole('combobox', { name: 'Time zone' })).toBeDefined();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(saves()).toEqual([]);
});

it('shows any other refusal of the time zone under the box, and keeps the form open', async () => {
  const refusals: unknown[] = [
    refusal(422, [{ path: '/timeZone', code: 'custom', message: "This isn't a time zone." }]),
    new ApiError({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: "Your role doesn't allow this.",
    }),
    new TypeError('Failed to fetch'),
  ];
  server.answer = (operation) => {
    if (operation !== 'updateContact') return contactOf();
    throw refusals.shift();
  };
  // The zones this test chooses, and no more: about four hundred options are drawn and
  // searched by the test above, and here they would only be weight.
  server.zones = () => ({ items: ['Africa/Cairo', 'Africa/Lagos', 'Africa/Nairobi', 'UTC'] });
  const { user } = open();
  await user.click(await screen.findByRole('button', { name: 'Set time zone' }));
  await screen.findByRole('combobox', { name: 'Time zone' });
  for (const [typed, message] of [
    ['nairobi', "This isn't a time zone."],
    ['lagos', "Your role doesn't allow this."],
    ['cairo', "The change wasn't saved. Check your connection and try again."],
  ] as const) {
    await user.clear(zoneBox());
    await user.type(zoneBox(), `${typed}{Enter}`);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(message)).toBeDefined();
    expect(zoneBox()).toBeDefined();
  }
  expect(saves()).toHaveLength(3);
  // Cancel closes the form, changes nothing more, and gives the keyboard back.
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  const button = await screen.findByRole('button', { name: 'Set time zone' });
  await waitFor(() => {
    expect(document.activeElement).toBe(button);
  });
  expect(saves()).toHaveLength(3);
});

it('turns do not contact on only with a reason and a confirmation, from the keyboard', async () => {
  serve(contactOf({ timeZone: 'Africa/Nairobi' }), (body) => ({
    doNotContact: body['doNotContact'],
    preferencesRevision: second,
  }));
  const { user } = open();
  const button = await screen.findByRole('button', { name: 'Turn on do not contact' });
  button.focus();
  await user.keyboard('{Enter}');
  const why = await screen.findByRole('textbox', { name: 'Why?' });
  expect(document.activeElement).toBe(why);
  expect(screen.getByRole('group', { name: 'Turn on do not contact' })).toBeDefined();
  const confirm = screen.getByRole('checkbox', {
    name: 'I confirm that no messages should be sent to this contact, on any channel, until this is turned off.',
  });
  const save = screen.getByRole('button', { name: 'Save' });

  // No reason, then one too short: nothing is sent, and the field says what to write.
  await user.click(save);
  expect(await screen.findByText('Say why, in at least 10 characters.')).toBeDefined();
  await user.type(why, 'too short');
  await user.click(save);
  expect(await screen.findByText('Say why, in at least 10 characters.')).toBeDefined();
  // A reason without the confirmation: still nothing is sent.
  await user.clear(why);
  await user.type(why, `  ${reason} `);
  await user.click(save);
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Confirm that no messages should be sent to this contact.',
  );
  expect(saves()).toEqual([]);

  // Tab from the reason reaches the confirmation, Space ticks it, and Tab, Enter saves.
  why.focus();
  await user.keyboard('{Tab}');
  expect(document.activeElement).toBe(confirm);
  await user.keyboard(' {Tab}{Enter}');
  await waitFor(() => {
    expect(saves()).toEqual([
      {
        params: { id: contactId },
        body: { doNotContact: true, doNotContactReason: reason, preferencesRevision: first },
      },
    ]);
  });
  expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Do not contact is on.');
  const next = await screen.findByRole('button', { name: 'Turn off do not contact' });
  await waitFor(() => {
    expect(document.activeElement).toBe(next);
  });
  expect(within(await section('Do not contact')).getByText('On')).toBeDefined();
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('turns do not contact off with a reason and a confirmation too', async () => {
  serve(contactOf({ doNotContact: true }), (body) => ({
    doNotContact: body['doNotContact'],
    preferencesRevision: second,
  }));
  const { user } = open();
  await user.click(await screen.findByRole('button', { name: 'Turn off do not contact' }));
  expect(await screen.findByRole('group', { name: 'Turn off do not contact' })).toBeDefined();
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Say why, in at least 10 characters.')).toBeDefined();
  await user.type(
    screen.getByRole('textbox', { name: 'Why?' }),
    'Asked in person to hear from us.',
  );
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Confirm that this contact may be sent messages again.',
  );
  expect(saves()).toEqual([]);
  await user.click(
    screen.getByRole('checkbox', {
      name: 'I confirm that this contact may be sent messages again, where their consent allows it.',
    }),
  );
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(saves()).toEqual([
      {
        params: { id: contactId },
        body: {
          doNotContact: false,
          doNotContactReason: 'Asked in person to hear from us.',
          preferencesRevision: first,
        },
      },
    ]);
  });
  expect(await screen.findByText('Do not contact is off.')).toBeDefined();
  expect(within(await section('Do not contact')).getByText('Off')).toBeDefined();
});

it('keeps the reason and says why when the server refuses it', async () => {
  const refusals: unknown[] = [
    refusal(422, [
      { path: '/doNotContactReason', code: 'too_small', message: 'Say more about why.' },
    ]),
    new TypeError('Failed to fetch'),
  ];
  server.answer = (operation) => {
    if (operation !== 'updateContact') return contactOf();
    throw refusals.shift();
  };
  const { user } = open();
  await user.click(await screen.findByRole('button', { name: 'Turn on do not contact' }));
  const why = await screen.findByRole('textbox', { name: 'Why?' });
  await user.type(why, reason);
  await user.click(screen.getByRole('checkbox'));
  let written = reason;
  for (const message of [
    'Say more about why.',
    "The change wasn't saved. Check your connection and try again.",
  ]) {
    // A refusal under the reason stays until the reason changes, so the person edits it.
    await user.type(why, '!');
    written += '!';
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(message)).toBeDefined();
    expect(why).toHaveProperty('value', written);
  }
  expect(saves()).toHaveLength(2);
});

it("doesn't write over someone else's change: it shows the latest and asks again", async () => {
  const stored = serve(contactOf());
  const answer = server.answer;
  let refuse = true;
  server.answer = (operation, input) => {
    if (operation === 'updateContact' && refuse) {
      // Someone else turned do not contact on while this form was open.
      stored.set({ doNotContact: true, preferencesRevision: second });
      throw refusal(409);
    }
    return answer(operation, input);
  };
  const { user } = open();
  await user.click(await screen.findByRole('button', { name: 'Set time zone' }));
  await user.type(await screen.findByRole('combobox', { name: 'Time zone' }), 'nairobi{Enter}');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect((await screen.findByRole('alert')).textContent).toContain(
    "Someone else changed this contact while you had it open, so your change wasn't saved.",
  );
  expect(
    await screen.findByText(/The latest is shown here: make your change again\./),
  ).toBeDefined();
  // The form is closed, the other person's change is shown, and nothing was sent twice.
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(within(await section('Do not contact')).getByText('On')).toBeDefined();
  expect(
    within(await section('Time zone')).getByText(/This contact has no time zone\./),
  ).toBeDefined();
  expect(saves()).toHaveLength(1);
  expect(server.calls.map((call) => call.operation)).toEqual([
    'getContact',
    'updateContact',
    'getContact',
  ]);

  // Starting again clears the message, and the new change is based on the latest.
  refuse = false;
  stored.set({});
  await user.click(screen.getByRole('button', { name: 'Set time zone' }));
  expect(screen.queryByRole('alert')).toBeNull();
  await user.type(await screen.findByRole('combobox', { name: 'Time zone' }), 'nairobi{Enter}');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(saves()).toHaveLength(2);
  });
  expect(saves()[1]).toEqual({
    params: { id: contactId },
    body: { timeZone: 'Africa/Nairobi', preferencesRevision: second },
  });
});

it('lets nothing be changed from out-of-date settings until the latest has loaded', async () => {
  const stored = serve(contactOf());
  const answer = server.answer;
  let reload: 'fails' | 'waits' | 'works' = 'fails';
  let finish = (): void => undefined;
  let updates = 0;
  server.answer = (operation, input) => {
    if (operation === 'updateContact') {
      updates += 1;
      stored.set({ timeZone: 'Europe/London', preferencesRevision: second });
      throw refusal(409);
    }
    // The first read is the page opening; later ones are reloads.
    if (updates === 0 || reload === 'works') return answer(operation, input);
    // Not found is not retried, so the failure shows at once.
    if (reload === 'fails') throw refusal(404);
    return new Promise((resolve) => {
      finish = () => {
        resolve(answer(operation, input));
      };
    });
  };
  const { user } = open();
  await user.click(await screen.findByRole('button', { name: 'Turn on do not contact' }));
  await user.type(await screen.findByRole('textbox', { name: 'Why?' }), reason);
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Save' }));

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Reload to see the latest before you change it.');
  expect(
    await within(alert).findByText(
      "The latest couldn't be loaded. Check your connection and reload.",
    ),
  ).toBeDefined();
  // What is shown is known to be old, so no change can start from it.
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('button', { name: 'Turn on do not contact' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(screen.getByRole('button', { name: 'Set time zone' })).toHaveProperty('disabled', true);
  expect(saves()).toHaveLength(1);

  reload = 'waits';
  await user.click(within(alert).getByRole('button', { name: 'Reload' }));
  const waiting = await screen.findByRole('button', { name: 'Reloading…' });
  expect(waiting).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Set time zone' })).toHaveProperty('disabled', true);
  reload = 'works';
  finish();

  expect(
    await screen.findByText(/The latest is shown here: make your change again\./),
  ).toBeDefined();
  expect(within(await section('Time zone')).getByText('Europe/London')).toBeDefined();
  expect(screen.getByRole('button', { name: 'Change time zone' })).toHaveProperty(
    'disabled',
    false,
  );
  expect(screen.getByRole('button', { name: 'Turn on do not contact' })).toHaveProperty(
    'disabled',
    false,
  );
  expect(screen.queryByRole('button', { name: /Reload/ })).toBeNull();
  expect(saves()).toHaveLength(1);
});

it('bases a change on the settings the form opened with, even after the page refreshed them', async () => {
  serve(contactOf(), () => ({}));
  const { user, client } = open();
  await user.click(await screen.findByRole('button', { name: 'Turn on do not contact' }));
  await user.type(await screen.findByRole('textbox', { name: 'Why?' }), reason);
  await user.click(screen.getByRole('checkbox'));
  // A live update arrives while the form is open: someone else changed both settings.
  client.setQueryData(
    contactKey,
    contactOf({ timeZone: 'Europe/London', doNotContact: true, preferencesRevision: second }),
  );
  expect(within(await section('Time zone')).getByText('Europe/London')).toBeDefined();
  expect(within(await section('Do not contact')).getByText('On')).toBeDefined();
  // The form is still the one that was opened: what it asks, and what was written in it.
  expect(screen.getByRole('group', { name: 'Turn on do not contact' })).toBeDefined();
  expect(screen.getByRole('textbox', { name: 'Why?' })).toHaveProperty('value', reason);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(saves()).toHaveLength(1);
  });
  // The server gets the old revision, so it can refuse: the newest one is never borrowed.
  expect(saves()[0]).toMatchObject({ body: { doNotContact: true, preferencesRevision: first } });
});

it('offers a retry when the contact fails to load, and says so when the server sends no settings', async () => {
  let attempt = 0;
  server.answer = () => {
    attempt += 1;
    if (attempt === 1) throw refusal(404);
    const {
      timeZone: _zone,
      doNotContact: _flag,
      preferencesRevision: _revision,
      ...old
    } = contactOf();
    return old;
  };
  const { user } = open();
  expect((await screen.findByRole('alert')).textContent).toContain(
    "The settings couldn't be loaded.",
  );
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(
    await screen.findByText(
      "This server didn't send the contact's time zone or do not contact setting.",
    ),
  ).toBeDefined();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
});
