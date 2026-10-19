// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { PhoneNumberSettings, PhoneSystemSettings } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhoneSystemPage } from './phone-system';
import type { PhoneSystemMemberList } from './phone-system-parts';

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
  initialsOf: (name: string) => name.slice(0, 1),
}));
vi.mock('./shell/page', () => ({
  Page: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const first = 'a'.repeat(64);
const second = 'b'.repeat(64);
const dana = 'mem_01k8e2wzr0e008000000000001';
const lee = 'mem_01k8e2wzr0e008000000000002';
const frontId = 'phn_01k8e2wzr0e008000000000001';
const textsId = 'phn_01k8e2wzr0e008000000000002';

/** The members who may own a number or take its calls, as GET /phone-system/members pages them. */
const members: PhoneSystemMemberList['data'] = [
  { id: dana, name: 'Dana Brooks', email: 'dana@harborlights.example' },
  { id: lee, name: 'Lee Park', email: 'lee@harborlights.example' },
];

/** One page of members after a cursor: one member a page, so every list is paged. */
function memberPage(input: unknown): PhoneSystemMemberList {
  const after = (input as { query?: { after?: string } }).query?.after;
  const start = after === undefined ? 0 : members.findIndex((each) => each.id === after) + 1;
  const page = members.slice(start, start + 1);
  const last = page.at(-1);
  return {
    data: page,
    nextCursor: last === undefined || start + 1 >= members.length ? null : last.id,
  };
}

const voiceOf = (): NonNullable<PhoneNumberSettings['voice']> => ({
  recording: { enabled: false, announcement: { enabled: false, message: null } },
  routing: {
    primaryMemberId: dana,
    forwardTo: null,
    useBusinessFallback: false,
    ringAlso: [],
    ringTimeoutSeconds: 20,
    voicemailBackup: true,
  },
  advanced: {
    callConnectConfirmation: false,
    whisper: { enabled: false, message: null },
    forwardedCallerId: 'caller',
    preferContactOwner: false,
  },
});

const front = (patch: Partial<PhoneNumberSettings> = {}): PhoneNumberSettings => ({
  id: frontId,
  e164: '+14155550123',
  capabilities: ['sms', 'voice'],
  status: 'active',
  isDefault: true,
  name: 'Front desk',
  ownerId: dana,
  voice: voiceOf(),
  revision: first,
  warnings: [],
  ...patch,
});

const texts = (patch: Partial<PhoneNumberSettings> = {}): PhoneNumberSettings => ({
  id: textsId,
  e164: '+12125550188',
  capabilities: ['sms', 'mms'],
  status: 'failing',
  isDefault: false,
  name: 'Text line',
  ownerId: null,
  voice: null,
  revision: first,
  warnings: [],
  ...patch,
});

const settingsOf = (patch: Partial<PhoneSystemSettings> = {}): PhoneSystemSettings => ({
  defaultNumberId: frontId,
  inbound: { preferAssignedUser: true, allowAnonymousCallers: true, fallbackNumber: null },
  outbound: {
    callerId: 'account_default',
    connectAgent: 'after_announcement',
    quietHoursWarning: true,
  },
  recording: { retentionDays: null, transcriptionEnabled: false },
  missedCallText: { enabled: false, message: null },
  revision: first,
  calling: {
    available: false,
    unavailable: { code: 'calling_not_set_up', message: 'The server says so.' },
  },
  ...patch,
});

const refusal = (status: number, errors?: { path: string; code: string; message: string }[]) =>
  new ApiError({
    type: 'about:blank',
    title: status === 409 ? 'Conflict' : status === 403 ? 'Forbidden' : 'Unprocessable Content',
    status,
    detail: 'Refused.',
    ...(errors === undefined ? {} : { errors }),
  });

/** What the person may change here: an owner has both, a custom role may have one. */
let granted: string[] = ['sms.manage', 'phone.manage'];
beforeEach(() => {
  granted = ['sms.manage', 'phone.manage'];
});

/** Answers as the server does, with what a test changes on top. */
function serve(
  overrides: Partial<Record<string, (input: unknown) => unknown>> = {},
  numbers: PhoneNumberSettings[] = [front(), texts()],
): void {
  server.answer = (operation, input) => {
    const override = overrides[operation];
    if (override !== undefined) return override(input);
    if (operation === 'getMyPermissions')
      return { business: 'biz_01k8e2wzr0e008000000000001', permissions: granted };
    if (operation === 'listPhoneNumbers')
      return {
        data: numbers.map((number) => ({
          id: number.id,
          name: number.name,
          e164: number.e164,
          connectionId: 'smsc_01k8e2wzr0e008000000000001',
          capabilities: number.capabilities,
          status: number.status,
          createdAt: '2026-10-08T00:00:00.000Z',
        })),
      };
    if (operation === 'getPhoneSystemSettings') return settingsOf();
    if (operation === 'listPhoneSystemNumbers') return { data: numbers };
    if (operation === 'getPhoneNumberSettings') {
      const { params } = input as { params: { id: string } };
      return numbers.find((number) => number.id === params.id);
    }
    if (operation === 'listPhoneSystemMembers') return memberPage(input);
    if (operation === 'listSmsConnections') return { data: [], unavailable: null };
    return undefined;
  };
}

function open(): ReturnType<typeof userEvent.setup> {
  const client = new QueryClient({
    // The page retries a failed read twice (retryFaults); here, with no wait between.
    defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <PhoneSystemPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup({ delay: null });
}

const callsTo = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);

const rowOf = async (name: string): Promise<HTMLElement> =>
  (await screen.findByRole('heading', { name, level: 3 })).closest('li') as HTMLElement;

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  control: HTMLElement,
  option: string,
): Promise<void> {
  await user.click(control);
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('who may see what', () => {
  const phoneReads = [
    'getPhoneSystemSettings',
    'listPhoneSystemNumbers',
    'listPhoneSystemMembers',
    'listTeam',
  ];
  const smsReads = ['listSmsConnections', 'listPhoneNumbers'];
  const asked = (operations: readonly string[]): string[] =>
    server.calls
      .map((call) => call.operation)
      .filter((operation) => operations.includes(operation));

  it('gives someone who manages only SMS the Twilio connection and the registered numbers', async () => {
    granted = ['sms.manage'];
    serve({ listSmsConnections: () => ({ data: [], unavailable: null }) });
    open();
    expect(await screen.findByRole('button', { name: 'Connect Twilio' })).toBeDefined();
    expect(await screen.findByRole('heading', { name: 'Registered phone numbers' })).toBeDefined();
    expect(await screen.findByText('Front desk')).toBeDefined();
    expect(screen.queryByRole('tab', { name: 'Voice settings' })).toBeNull();
    expect(screen.queryByRole('heading', { name: "Calls aren't available yet" })).toBeNull();
    expect(screen.queryByText(/permission to manage the phone system/)).toBeNull();
    expect(asked(phoneReads)).toEqual([]);
  });

  it('gives someone who manages only calls the numbers and voice settings, and no Twilio credentials', async () => {
    granted = ['phone.manage'];
    serve();
    const user = open();
    expect(await rowOf('Front desk')).toBeDefined();
    expect(
      await screen.findByText(/Connecting a Twilio account and registering numbers/),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Connect Twilio' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Registered phone numbers' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Voice settings' }));
    expect(await screen.findByRole('form', { name: 'Voice settings' })).toBeDefined();
    expect(asked(smsReads)).toEqual([]);
  });

  it('shows someone with both one list of numbers, beside the Twilio connection', async () => {
    serve();
    open();
    expect(await rowOf('Front desk')).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Connect Twilio' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Registered phone numbers' })).toBeNull();
    expect(asked(['listPhoneNumbers'])).toEqual([]);
  });

  it('asks for nothing else from someone who may manage neither', async () => {
    granted = ['contacts.manage'];
    serve();
    open();
    expect(
      await screen.findByText(
        'You need permission to manage the phone system or SMS to use this page.',
      ),
    ).toBeDefined();
    expect(asked([...phoneReads, ...smsReads])).toEqual([]);
  });

  it('offers to try again when what the person may do cannot be read', async () => {
    let failing = true;
    serve({
      getMyPermissions: () => {
        if (failing) throw new Error('offline');
        return { business: null, permissions: ['phone.manage'] };
      },
    });
    const user = open();
    const alert = await screen.findByText("We couldn't check what you may change here.");
    expect(asked([...phoneReads, ...smsReads])).toEqual([]);
    failing = false;
    await user.click(
      within(alert.closest('p') as HTMLElement).getByRole('button', { name: 'Try again' }),
    );
    expect(await rowOf('Front desk')).toBeDefined();
  });
});

describe('the number inventory', () => {
  it('says calls are not available yet, in its own words, and lists each number', async () => {
    serve({}, [front({ warnings: ['short_ring_timeout'] }), texts()]);
    open();
    expect(
      await screen.findByRole('heading', { name: "Calls aren't available yet" }),
    ).toBeDefined();
    expect(
      screen.getByText(/Calling isn't set up on the Twilio account your numbers come from/),
    ).toBeDefined();
    expect(screen.queryByText('The server says so.')).toBeNull();

    const row = await rowOf('Front desk');
    expect(within(row).getByText('Default')).toBeDefined();
    expect(within(row).getByText('Active')).toBeDefined();
    expect(within(row).getByText('+14155550123')).toBeDefined();
    await waitFor(() => {
      expect(within(row).getAllByText('Dana Brooks')).toHaveLength(2);
    });
    expect(within(row).getByText('20 seconds')).toBeDefined();
    expect(
      within(row).getByText('It rings for under 20 seconds, which can be too short to answer.'),
    ).toBeDefined();
    expect(within(row).queryByRole('button', { name: /Make .* the default/ })).toBeNull();

    const other = await rowOf('Text line');
    expect(within(other).getByText('Failing')).toBeDefined();
    expect(within(other).getByText("Can't take calls")).toBeDefined();
    expect(within(other).getByText('Not applicable')).toBeDefined();
    expect(within(other).getByText('Nobody')).toBeDefined();
    expect(within(other).queryByRole('button', { name: /Make .* the default/ })).toBeNull();
  });

  it('says plainly that calls work once they do', async () => {
    serve({
      getPhoneSystemSettings: () => settingsOf({ calling: { available: true, unavailable: null } }),
    });
    open();
    expect(
      await screen.findByText(
        "Calls can be made from this business's numbers and are answered here.",
      ),
    ).toBeDefined();
  });

  it('says why calls need a number that takes them', async () => {
    serve({
      getPhoneSystemSettings: () =>
        settingsOf({
          calling: { available: false, unavailable: { code: 'no_voice_number', message: 'x' } },
        }),
    });
    open();
    expect(
      await screen.findByText(/None of this business's registered numbers can take calls/),
    ).toBeDefined();
  });

  it('finds numbers by digits however they are written, and by who has them', async () => {
    serve();
    const user = open();
    await rowOf('Front desk');
    const search = screen.getByRole('searchbox', { name: 'Search numbers' });
    await user.type(search, '(212) 555');
    expect(screen.queryByRole('heading', { name: 'Front desk' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Text line' })).toBeDefined();
    await user.clear(search);
    await waitFor(() => {
      expect(screen.getAllByText('Dana Brooks').length).toBeGreaterThan(0);
    });
    await user.type(search, 'dana');
    expect(screen.getByRole('heading', { name: 'Front desk' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Text line' })).toBeNull();
    await user.clear(search);
    await user.type(search, 'warehouse');
    expect(screen.getByText('No numbers match “warehouse”.')).toBeDefined();
  });

  it('says what to do when nothing is registered yet', async () => {
    serve({}, []);
    open();
    expect(await screen.findByText(/No numbers registered yet/)).toBeDefined();
    // The Twilio account they come from is on the same tab.
    expect(await screen.findByRole('button', { name: 'Connect Twilio' })).toBeDefined();
  });

  it('makes a number that takes calls the default, under the settings revision', async () => {
    const sales = front({
      id: 'phn_01k8e2wzr0e008000000000003',
      name: 'Sales',
      e164: '+14155550199',
      isDefault: false,
    });
    serve(
      {
        updatePhoneSystemSettings: (input) => ({
          ...settingsOf(),
          ...(input as { body: object }).body,
          revision: second,
        }),
      },
      [front(), sales],
    );
    const user = open();
    const row = await rowOf('Sales');
    await waitFor(() => {
      expect(
        within(row)
          .getByRole('button', { name: 'Make Sales the default number' })
          .matches(':disabled'),
      ).toBe(false);
    });
    await user.click(within(row).getByRole('button', { name: 'Make Sales the default number' }));
    await waitFor(() => {
      expect(callsTo('updatePhoneSystemSettings')).toEqual([
        {
          body: {
            ...settingsOf({ defaultNumberId: sales.id }),
            calling: undefined,
            revision: first,
          },
        },
      ]);
    });
    expect(await screen.findByText('Sales is now the default number.')).toBeDefined();
    // The numbers are read again, so the Default badge moves.
    await waitFor(() => {
      expect(callsTo('listPhoneSystemNumbers')).toHaveLength(2);
    });
  });

  it('says a default number change lost to a newer save, and reads the settings again', async () => {
    serve(
      {
        updatePhoneSystemSettings: () => {
          throw refusal(409);
        },
      },
      [front({ isDefault: false }), front({ id: 'phn_01k8e2wzr0e008000000000003', name: 'Sales' })],
    );
    const user = open();
    const row = await rowOf('Front desk');
    const button = within(row).getByRole('button', { name: 'Make Front desk the default number' });
    await waitFor(() => {
      expect(button.matches(':disabled')).toBe(false);
    });
    await user.click(button);
    expect(
      await screen.findByText(/The voice settings changed since they were loaded/),
    ).toBeDefined();
    await waitFor(() => {
      expect(callsTo('getPhoneSystemSettings')).toHaveLength(2);
    });
  });

  it('refuses plainly without the permission, and keeps the Twilio connections', async () => {
    serve({
      getPhoneSystemSettings: () => {
        throw refusal(403);
      },
      listPhoneSystemNumbers: () => {
        throw refusal(403);
      },
    });
    open();
    expect(
      await screen.findAllByText('You need permission to manage the phone system.'),
    ).toHaveLength(2);
    expect(await screen.findByRole('button', { name: 'Connect Twilio' })).toBeDefined();
  });

  it('names nobody as gone while the members cannot be read, and offers to read them again', async () => {
    let failing = true;
    serve({
      listPhoneSystemMembers: (input) => {
        if (failing) throw refusal(403);
        return memberPage(input);
      },
    });
    const user = open();
    const row = await rowOf('Front desk');
    expect(within(row).getAllByText('A team member')).toHaveLength(2);
    expect(within(row).queryByText('Unavailable member')).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'Edit configuration of Front desk' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit configuration' });
    const alert = within(dialog)
      .getByText(/The team couldn't be loaded/)
      .closest('[role="alert"]');
    expect(alert).not.toBeNull();
    failing = false;
    await user.click(within(alert as HTMLElement).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(within(dialog).queryByText(/The team couldn't be loaded/)).toBeNull();
    });
    expect(within(row).getAllByText('Dana Brooks')).toHaveLength(2);
    expect(callsTo('listTeam')).toEqual([]);
  });

  it('reads every page of members, and offers only them', async () => {
    serve();
    const user = open();
    const row = await rowOf('Front desk');
    await waitFor(() => {
      expect(within(row).getAllByText('Dana Brooks')).toHaveLength(2);
    });
    expect(callsTo('listPhoneSystemMembers')).toEqual([
      { query: { limit: 100 } },
      { query: { limit: 100, after: dana } },
    ]);
    await user.click(within(row).getByRole('button', { name: 'Edit configuration of Front desk' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit configuration' });
    await user.click(within(dialog).getByLabelText('Assigned to'));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Nobody',
      'Dana Brooks',
      'Lee Park',
    ]);
    expect(callsTo('listTeam')).toEqual([]);
  });

  it('says the members are still loading rather than naming nobody', async () => {
    serve({ listPhoneSystemMembers: () => new Promise(() => undefined) });
    const user = open();
    const row = await rowOf('Front desk');
    expect(within(row).getAllByText('A team member')).toHaveLength(2);
    await user.click(within(row).getByRole('button', { name: 'Edit configuration of Front desk' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit configuration' });
    expect(within(dialog).getByText('Loading team members…')).toBeDefined();
  });

  it('offers to try again when the numbers cannot be read', async () => {
    let failing = true;
    serve({
      listPhoneSystemNumbers: () => {
        if (failing) throw new Error('offline');
        return { data: [front()] };
      },
    });
    const user = open();
    const alert = await screen.findByText("We couldn't load the phone numbers.");
    failing = false;
    await user.click(
      within(alert.closest('p') as HTMLElement).getByRole('button', { name: 'Try again' }),
    );
    expect(await rowOf('Front desk')).toBeDefined();
  });
});

describe('a number configuration', () => {
  async function edit(
    user: ReturnType<typeof userEvent.setup>,
    name: string,
  ): Promise<HTMLElement> {
    const row = await rowOf(name);
    await user.click(within(row).getByRole('button', { name: `Edit configuration of ${name}` }));
    return screen.findByRole('dialog', { name: 'Edit configuration' });
  }

  it('saves the name, the forwarding and the advanced settings under the revision read', async () => {
    serve({
      updatePhoneNumberSettings: (input) => {
        const { body } = input as { body: Record<string, unknown> };
        return { ...front(), ...body, revision: second };
      },
    });
    const user = open();
    const dialog = await edit(user, 'Front desk');
    expect(
      within(dialog).getByRole('tab', { name: 'Basic details' }).getAttribute('aria-selected'),
    ).toBe('true');
    const name = within(dialog).getByLabelText('Friendly name');
    await user.clear(name);
    await user.type(name, 'Main line');
    await user.click(within(dialog).getByRole('switch', { name: 'Record calls' }));
    await user.click(within(dialog).getByRole('switch', { name: 'Play a recording announcement' }));
    await user.type(within(dialog).getByLabelText('Announcement'), 'This call is recorded.');

    await user.click(within(dialog).getByRole('tab', { name: 'Call forwarding' }));
    await user.type(within(dialog).getByLabelText('Second, an outside number'), '+14155550177');
    const ring = within(dialog).getByLabelText('Ring for (seconds)');
    await user.clear(ring);
    await user.type(ring, '30');

    await user.click(within(dialog).getByRole('tab', { name: 'Advanced settings' }));
    await user.click(within(dialog).getByRole('switch', { name: 'Call connect' }));
    await choose(user, within(dialog).getByLabelText('A forwarded call shows'), 'This number');

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(callsTo('updatePhoneNumberSettings')).toHaveLength(1);
    });
    const base = voiceOf();
    expect(callsTo('updatePhoneNumberSettings')[0]).toEqual({
      params: { id: frontId },
      body: {
        name: 'Main line',
        ownerId: dana,
        voice: {
          recording: {
            enabled: true,
            announcement: { enabled: true, message: 'This call is recorded.' },
          },
          routing: { ...base.routing, forwardTo: '+14155550177', ringTimeoutSeconds: 30 },
          advanced: {
            ...base.advanced,
            callConnectConfirmation: true,
            forwardedCallerId: 'business_number',
          },
        },
        revision: first,
      },
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(await screen.findByText('Main line saved.')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Main line', level: 3 })).toBeDefined();
  });

  it('checks the fields before sending, and opens the section with the first problem', async () => {
    serve();
    const user = open();
    const dialog = await edit(user, 'Front desk');
    await user.click(within(dialog).getByRole('tab', { name: 'Call forwarding' }));
    const ring = within(dialog).getByLabelText('Ring for (seconds)');
    await user.clear(ring);
    await user.type(ring, '3');
    await user.type(within(dialog).getByLabelText('Second, an outside number'), '0712 345');
    await user.click(within(dialog).getByRole('tab', { name: 'Basic details' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      within(dialog).getByRole('tab', { name: 'Call forwarding' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(within(dialog).getByText('Use 5 to 120 seconds.')).toBeDefined();
    expect(
      within(dialog).getByText('Use the full number with its country code, such as +14155550123.'),
    ).toBeDefined();
    expect(callsTo('updatePhoneNumberSettings')).toEqual([]);
  });

  it('shows what only the server can refuse beside its field', async () => {
    serve({
      updatePhoneNumberSettings: () => {
        throw refusal(422, [
          {
            path: '/voice/routing/forwardTo',
            code: 'forwards_to_own_number',
            message: 'That is one of this business’s numbers.',
          },
        ]);
      },
    });
    const user = open();
    const dialog = await edit(user, 'Front desk');
    await user.click(within(dialog).getByRole('tab', { name: 'Call forwarding' }));
    await user.type(within(dialog).getByLabelText('Second, an outside number'), '+12125550188');
    await user.click(within(dialog).getByRole('tab', { name: 'Advanced settings' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(
        "Use a number outside this business: a call can't be sent on to one of its own numbers.",
      ),
    ).toBeDefined();
    expect(
      within(dialog).getByRole('tab', { name: 'Call forwarding' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('recovers from a newer save by reading the number again', async () => {
    let current = front();
    serve({
      getPhoneNumberSettings: () => current,
      updatePhoneNumberSettings: () => {
        throw refusal(409);
      },
    });
    const user = open();
    const dialog = await edit(user, 'Front desk');
    await waitFor(() => {
      expect(callsTo('getPhoneNumberSettings')).toHaveLength(1);
    });
    // Meanwhile someone else renames it.
    current = front({ name: 'Reception', revision: second });
    const name = within(dialog).getByLabelText('Friendly name');
    await user.clear(name);
    await user.type(name, 'Mine');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(/This number's settings changed since you opened them/),
    ).toBeDefined();
    expect(
      (callsTo('updatePhoneNumberSettings')[0] as { body: { revision: string } }).body.revision,
    ).toBe(first);
    await user.click(within(dialog).getByRole('button', { name: 'Reload number' }));
    await waitFor(() => {
      expect(within(dialog).getByLabelText<HTMLInputElement>('Friendly name').value).toBe(
        'Reception',
      );
    });
    expect(within(dialog).queryByText(/changed since you opened them/)).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Save' }).matches(':disabled')).toBe(true);
  });

  it('keeps a number that cannot take calls to its name and owner', async () => {
    serve({
      updatePhoneNumberSettings: (input) => ({
        ...texts(),
        ...(input as { body: object }).body,
        revision: second,
      }),
    });
    const user = open();
    const dialog = await edit(user, 'Text line');
    expect(
      within(dialog)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Basic details']);
    expect(within(dialog).getByText(/This number can't take calls/)).toBeDefined();
    await waitFor(() => {
      expect(screen.queryAllByText('Dana Brooks').length).toBeGreaterThan(0);
    });
    await choose(user, within(dialog).getByLabelText('Assigned to'), 'Lee Park');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(callsTo('updatePhoneNumberSettings')).toEqual([
        {
          params: { id: textsId },
          body: { name: 'Text line', ownerId: lee, voice: null, revision: first },
        },
      ]);
    });
  });

  it('takes the first person off the people who ring beside them', async () => {
    const shared = front({
      voice: {
        ...voiceOf(),
        routing: { ...voiceOf().routing, primaryMemberId: null, ringAlso: [lee] },
      },
    });
    serve(
      {
        updatePhoneNumberSettings: (input) => ({
          ...shared,
          ...(input as { body: object }).body,
          revision: second,
        }),
      },
      [shared],
    );
    const user = open();
    const dialog = await edit(user, 'Front desk');
    await user.click(within(dialog).getByRole('tab', { name: 'Call forwarding' }));
    await waitFor(() => {
      expect(
        within(within(dialog).getByRole('list', { name: 'Chosen team members' })).getByText(
          'Lee Park',
        ),
      ).toBeDefined();
    });
    await choose(user, within(dialog).getByLabelText('First, a team member'), 'Lee Park');
    expect(within(dialog).queryByRole('list', { name: 'Chosen team members' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(callsTo('updatePhoneNumberSettings')).toHaveLength(1);
    });
    const { body } = callsTo('updatePhoneNumberSettings')[0] as {
      body: { voice: { routing: { primaryMemberId: string; ringAlso: string[] } } };
    };
    expect(body.voice.routing).toMatchObject({ primaryMemberId: lee, ringAlso: [] });
  });

  it('says calls are not available yet inside the configuration too', async () => {
    serve();
    const user = open();
    await screen.findByRole('heading', { name: "Calls aren't available yet" });
    const dialog = await edit(user, 'Front desk');
    expect(within(dialog).getByText(/Calls can't be made or taken yet/)).toBeDefined();
  });

  it('says which call settings are not used yet once calls can be made', async () => {
    serve({
      getPhoneSystemSettings: () => settingsOf({ calling: { available: true, unavailable: null } }),
    });
    const user = open();
    const dialog = await edit(user, 'Front desk');
    expect(within(dialog).queryByText(/Calls can't be made or taken yet/)).toBeNull();
    expect(within(dialog).getByText(/Calls aren't recorded yet\./)).toBeDefined();
    expect(within(dialog).getByText(/None of these are used on calls yet\./)).toBeDefined();
  });

  it('shows that voicemail backup is not taken yet once calls can be made', async () => {
    serve({
      getPhoneSystemSettings: () => settingsOf({ calling: { available: true, unavailable: null } }),
    });
    const user = open();
    const dialog = await edit(user, 'Front desk');
    await user.click(within(dialog).getByRole('tab', { name: 'Call forwarding' }));
    expect(
      within(dialog).getByText('No voicemail is taken yet: a caller nobody answers is hung up on.'),
    ).toBeDefined();
  });
});

describe('the voice settings', () => {
  async function voiceTab(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    await user.click(await screen.findByRole('tab', { name: 'Voice settings' }));
    return screen.findByRole('form', { name: 'Voice settings' });
  }

  it('saves the business defaults under the revision they were read with', async () => {
    serve({
      updatePhoneSystemSettings: (input) => ({
        ...settingsOf(),
        ...(input as { body: object }).body,
        revision: second,
      }),
    });
    const user = open();
    const form = await voiceTab(user);
    await user.click(
      within(form).getByRole('switch', { name: 'Allow callers who hide their number' }),
    );
    await user.type(within(form).getByLabelText('Business fallback number'), '+14155550100');
    await choose(
      user,
      within(form).getByLabelText('Caller ID'),
      "A number with the contact's area code",
    );
    await user.click(within(form).getByRole('switch', { name: 'Delete old recordings' }));
    const days = within(form).getByLabelText('Delete recordings older than (days)');
    expect((days as HTMLInputElement).value).toBe('90');
    await user.clear(days);
    await user.type(days, '30');
    await user.click(
      within(form).getByRole('switch', { name: 'Text a caller back after a missed call' }),
    );
    await user.type(within(form).getByLabelText('Text'), 'Sorry we missed you.');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(callsTo('updatePhoneSystemSettings')).toEqual([
        {
          body: {
            defaultNumberId: frontId,
            inbound: {
              preferAssignedUser: true,
              allowAnonymousCallers: false,
              fallbackNumber: '+14155550100',
            },
            outbound: {
              callerId: 'local_presence',
              connectAgent: 'after_announcement',
              quietHoursWarning: true,
            },
            recording: { retentionDays: 30, transcriptionEnabled: false },
            missedCallText: { enabled: true, message: 'Sorry we missed you.' },
            revision: first,
          },
        },
      ]);
    });
    expect(await within(form).findByText('Settings saved.')).toBeDefined();
    expect(within(form).getByRole('button', { name: 'Save changes' }).matches(':disabled')).toBe(
      true,
    );
  });

  it('offers only numbers that take calls as the default', async () => {
    serve();
    const user = open();
    const form = await voiceTab(user);
    await user.click(within(form).getByLabelText('Calls go out from'));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'No default number',
      'Front desk (+14155550123)',
    ]);
  });

  it('says which defaults are not used on calls yet, and promises nothing for them', async () => {
    serve({
      getPhoneSystemSettings: () => settingsOf({ calling: { available: true, unavailable: null } }),
    });
    const user = open();
    const form = await voiceTab(user);
    const group = (name: string): HTMLElement => within(form).getByRole('region', { name });
    expect(within(group('Default number')).queryByText(/yet\./)).toBeNull();
    expect(within(group('Incoming calls')).queryByText(/yet\./)).toBeNull();
    expect(
      within(group('Outgoing calls')).getByText(/None of these are used on calls yet\./),
    ).toBeDefined();
    expect(
      within(group('Recording and transcription')).getByText(
        /Calls aren't recorded or transcribed yet\./,
      ),
    ).toBeDefined();
    expect(
      within(group('Missed-call text')).getByText(/Missed-call texts aren't sent yet\./),
    ).toBeDefined();
  });

  it('asks for the missed-call text before sending', async () => {
    serve();
    const user = open();
    const form = await voiceTab(user);
    await user.click(
      within(form).getByRole('switch', { name: 'Text a caller back after a missed call' }),
    );
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(
      within(form).getByText('Write the text a caller gets after a missed call.'),
    ).toBeDefined();
    expect(callsTo('updatePhoneSystemSettings')).toEqual([]);
  });

  it('recovers from a newer save by reading the settings again', async () => {
    let current = settingsOf();
    serve({
      getPhoneSystemSettings: () => current,
      updatePhoneSystemSettings: () => {
        throw refusal(409);
      },
    });
    const user = open();
    const form = await voiceTab(user);
    current = settingsOf({
      inbound: {
        preferAssignedUser: true,
        allowAnonymousCallers: true,
        fallbackNumber: '+14155550111',
      },
      revision: second,
    });
    await user.type(within(form).getByLabelText('Business fallback number'), '+14155550100');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(
      await within(form).findByText(/These settings changed since you opened them/),
    ).toBeDefined();
    await user.click(within(form).getByRole('button', { name: 'Reload settings' }));
    await waitFor(() => {
      expect(within(form).getByLabelText<HTMLInputElement>('Business fallback number').value).toBe(
        '+14155550111',
      );
    });
    expect(within(form).getByRole('button', { name: 'Save changes' }).matches(':disabled')).toBe(
      true,
    );
  });

  it('puts back what was read when changes are discarded', async () => {
    serve();
    const user = open();
    const form = await voiceTab(user);
    await user.type(within(form).getByLabelText('Business fallback number'), '+1415');
    await user.click(within(form).getByRole('button', { name: 'Discard changes' }));
    expect(within(form).getByLabelText<HTMLInputElement>('Business fallback number').value).toBe(
      '',
    );
  });

  it('moves between its tabs with the arrow keys', async () => {
    serve();
    const user = open();
    const numbersTab = await screen.findByRole('tab', { name: 'Phone numbers' });
    numbersTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Voice settings' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Voice settings' }));
    await user.keyboard('{Home}');
    expect(numbersTab.getAttribute('aria-selected')).toBe('true');
  });
});
