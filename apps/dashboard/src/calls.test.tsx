// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { Call, CallDetail, CallLeg } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallsPage } from './calls';
import type { SoftphoneValue } from './softphone';

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
vi.mock('./shell/page', () => ({
  Page: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));
const softphoneMock = vi.hoisted(() => ({
  current: null as SoftphoneValue | null,
}));
vi.mock('./softphone', () => ({
  useSoftphone: () => softphoneMock.current,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string;
    params: Record<string, string>;
    children: ReactNode;
    className?: string;
  }) => (
    <a
      className={className}
      href={Object.entries(params).reduce(
        (path, [key, value]) => path.replace(`$${key}`, value),
        to,
      )}
    >
      {children}
    </a>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

const dana = 'mem_01k8e2wzr0e008000000000001';
const contact = 'con_01k8e2wzr0e008000000000001';
const firstId = 'call_01k8e2wzr0e008000000000001';
const secondId = 'call_01k8e2wzr0e008000000000002';
const thirdId = 'call_01k8e2wzr0e008000000000003';

const callOf = (patch: Partial<Call> = {}): Call => ({
  id: firstId,
  direction: 'outbound',
  state: 'requested',
  outcome: null,
  failure: null,
  phoneNumberId: 'phn_01k8e2wzr0e008000000000001',
  localNumber: '+14155550123',
  remoteNumber: '+14155550199',
  contactId: contact,
  contactIdentityId: 'cid_01k8e2wzr0e008000000000001',
  membershipId: dana,
  needsReconciliation: false,
  hangUpRequested: false,
  createdAt: '2026-10-15T10:00:00.000Z',
  connectedAt: null,
  endedAt: null,
  ...patch,
});

const legOf = (patch: Partial<CallLeg> = {}): CallLeg => ({
  id: 'cleg_01k8e2wzr0e008000000000001',
  parentId: null,
  party: 'remote',
  membershipId: null,
  status: 'in-progress',
  providerDirection: 'outbound-api',
  providerCallId: `CA${'0'.repeat(32)}`,
  durationSeconds: null,
  conflict: false,
  answeredAt: '2026-10-15T10:00:05.000Z',
  endedAt: null,
  ...patch,
});

let granted: string[] = [];
beforeEach(() => {
  server.calls.length = 0;
  granted = ['calls.read', 'calls.place'];
  softphoneMock.current = null;
});

/** Answers as the server does, with what a test changes on top. */
function serve(
  items: Call[],
  overrides: Partial<Record<string, (input: unknown) => unknown>> = {},
): void {
  server.answer = (operation, input) => {
    const override = overrides[operation];
    if (override !== undefined) return override(input);
    if (operation === 'getMyPermissions') return { business: null, permissions: granted };
    if (operation === 'listTeam')
      return {
        members: [
          {
            id: dana,
            name: 'Dana Brooks',
            email: 'dana@harborlights.example',
            roleId: 'role_01k8e2wzr0e008000000000001',
            roleName: 'Owner',
            isSelf: true,
            isOwner: true,
          },
        ],
        roles: [],
        invitations: [],
        canManage: true,
      };
    if (operation === 'listCalls') return { items, nextCursor: null };
    if (operation === 'getCall') {
      const { params } = input as { params: { id: string } };
      const found = items.find((each) => each.id === params.id);
      return found === undefined ? undefined : ({ ...found, legs: [] } satisfies CallDetail);
    }
    return undefined;
  };
}

const refusal = (status: number, detail = 'Refused.') =>
  new ApiError({
    type: 'about:blank',
    title: status === 403 ? 'Forbidden' : status === 409 ? 'Conflict' : 'Unprocessable Content',
    status,
    detail,
  });

function open(contactId?: string): ReturnType<typeof userEvent.setup> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <CallsPage contactId={contactId} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup({ delay: null });
}

const callsTo = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);
const rowWith = async (text: string): Promise<HTMLElement> =>
  (await screen.findByText(text)).closest('tr') as HTMLElement;

describe('who may see calls', () => {
  it('asks for no call without permission to read them', async () => {
    granted = ['contacts.manage'];
    serve([callOf()]);
    open();
    expect(await screen.findByText('You need permission to read calls.')).toBeDefined();
    expect(callsTo('listCalls')).toEqual([]);
  });

  it('says so when the server refuses the list all the same', async () => {
    serve([], {
      listCalls: () => {
        throw refusal(403);
      },
    });
    open();
    expect(await screen.findByText('You need permission to read calls.')).toBeDefined();
  });

  it('offers to try again when what the person may do cannot be read', async () => {
    let failing = true;
    serve([callOf()], {
      getMyPermissions: () => {
        if (failing) throw new Error('offline');
        return { business: null, permissions: granted };
      },
    });
    const user = open();
    const alert = await screen.findByText("We couldn't check what you may see here.");
    const region = alert.closest<HTMLElement>('[role="alert"]');
    if (region === null) throw new Error('The permission failure has no alert region.');
    failing = false;
    await user.click(
      within(region).getByRole('button', {
        name: 'Try again',
      }),
    );
    expect(await rowWith('+14155550199')).toBeDefined();
  });
});

describe('the call list', () => {
  it('shows each call as the server has it, a requested one as waiting', async () => {
    serve([
      callOf(),
      callOf({
        id: secondId,
        direction: 'inbound',
        state: 'ended',
        outcome: 'completed',
        remoteNumber: null,
        contactId: null,
        connectedAt: '2026-10-15T09:00:05.000Z',
        endedAt: '2026-10-15T09:01:10.000Z',
      }),
      callOf({
        id: thirdId,
        state: 'unknown',
        remoteNumber: '+14155550111',
        needsReconciliation: true,
      }),
    ]);
    open();
    const requested = await rowWith('+14155550199');
    expect(within(requested).getByText('Outgoing')).toBeDefined();
    expect(within(requested).getByText('Requested')).toBeDefined();
    expect(within(requested).queryByText('Connected')).toBeNull();
    expect(await within(requested).findByText('Dana Brooks')).toBeDefined();
    expect(within(requested).getByRole('link', { name: 'Open contact' }).getAttribute('href')).toBe(
      `/b/harbor/contacts/${contact}`,
    );

    const hidden = await rowWith('Hidden number');
    expect(within(hidden).getByText('Incoming')).toBeDefined();
    expect(within(hidden).getByText('Ended: completed')).toBeDefined();
    expect(within(hidden).getByText('1:05')).toBeDefined();

    const unknown = await rowWith('+14155550111');
    expect(within(unknown).getByText('Outcome unknown')).toBeDefined();
    expect(within(unknown).getByText('Needs checking with the provider')).toBeDefined();
    expect(callsTo('listCalls')).toEqual([{ query: { limit: 25 } }]);
  });

  it('says when there are no calls yet', async () => {
    serve([]);
    open();
    expect(await screen.findByText('No calls yet.')).toBeDefined();
  });

  it('turns pages by the cursor the server gives', async () => {
    serve([], {
      listCalls: (input) => {
        const after = (input as { query: { after?: string } }).query.after;
        return after === undefined
          ? { items: [callOf()], nextCursor: firstId }
          : { items: [callOf({ id: secondId, remoteNumber: '+14155550122' })], nextCursor: null };
      },
    });
    const user = open();
    await rowWith('+14155550199');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await rowWith('+14155550122')).toBeDefined();
    expect(screen.getByText('Page 2')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Next page' }).matches(':disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await rowWith('+14155550199')).toBeDefined();
    expect(callsTo('listCalls')).toEqual([
      { query: { limit: 25 } },
      { query: { limit: 25, after: firstId } },
      { query: { limit: 25 } },
    ]);
  });

  it('asks for one direction, and for one contact’s calls when opened for a contact', async () => {
    serve([callOf()]);
    const user = open(contact);
    await rowWith('+14155550199');
    await user.click(screen.getByLabelText('Direction'));
    await user.click(await screen.findByRole('option', { name: 'Incoming' }));
    await waitFor(() => {
      expect(callsTo('listCalls')).toEqual([
        { query: { limit: 25, contactId: contact } },
        { query: { limit: 25, direction: 'inbound', contactId: contact } },
      ]);
    });
    expect(screen.getByText("This contact's calls.")).toBeDefined();
  });

  it('offers to try again when the list cannot be read', async () => {
    let failing = true;
    serve([], {
      listCalls: () => {
        if (failing) throw new Error('offline');
        return { items: [callOf()], nextCursor: null };
      },
    });
    const user = open();
    const alert = await screen.findByText("The calls couldn't be loaded.");
    const region = alert.closest<HTMLElement>('[role="alert"]');
    if (region === null) throw new Error('The call-list failure has no alert region.');
    failing = false;
    await user.click(
      within(region).getByRole('button', {
        name: 'Try again',
      }),
    );
    expect(await rowWith('+14155550199')).toBeDefined();
  });
});

describe('a call’s details', () => {
  async function details(
    user: ReturnType<typeof userEvent.setup>,
    remote: string,
  ): Promise<HTMLElement> {
    const row = await rowWith(remote);
    await user.click(within(row).getByRole('button', { name: /^Details of the call/ }));
    return screen.findByRole('dialog', { name: 'Call details' });
  }

  it('shows the legs, why a call was refused, and a record that needs checking', async () => {
    const refused = callOf({ state: 'refused', failure: 'do_not_call' });
    const connected = callOf({
      id: secondId,
      state: 'connected',
      remoteNumber: '+14155550122',
      needsReconciliation: true,
      connectedAt: '2026-10-15T10:00:05.000Z',
    });
    serve([refused, connected], {
      getCall: (input) => {
        const { params } = input as { params: { id: string } };
        return params.id === secondId
          ? {
              ...connected,
              legs: [
                legOf({ conflict: true }),
                legOf({
                  id: 'cleg_01k8e2wzr0e008000000000002',
                  parentId: 'cleg_01k8e2wzr0e008000000000001',
                  party: 'member',
                  membershipId: dana,
                  status: 'completed',
                  providerDirection: 'outbound-dial',
                  durationSeconds: 42,
                }),
              ],
            }
          : { ...refused, legs: [] };
      },
    });
    const user = open();
    const first = await details(user, '+14155550199');
    expect(within(first).getByText('Refused')).toBeDefined();
    expect(
      within(first).getByText('The contact asked not to be called, so the call was not placed.'),
    ).toBeDefined();
    expect(within(first).getByText('No call legs yet.')).toBeDefined();
    await user.click(within(first).getByRole('button', { name: 'Close' }));

    const second = await details(user, '+14155550122');
    expect(
      await within(second).findByText(
        "The provider's reports disagree with this record. Check the call in your Twilio console.",
      ),
    ).toBeDefined();
    const legs = within(second).getByRole('table', { name: 'Call legs' });
    expect(within(legs).getByText('The other party')).toBeDefined();
    expect(within(legs).getByText('In progress')).toBeDefined();
    expect(within(legs).getByText('Reports disagree')).toBeDefined();
    expect(within(legs).getByText('0:42')).toBeDefined();
    expect(await within(legs).findByText('Dana Brooks')).toBeDefined();
  });

  it('cancels a call not yet placed only when the server says it is canceled', async () => {
    serve([callOf()], {
      hangUpCall: () => callOf({ state: 'canceled' }),
    });
    const user = open();
    const panel = await details(user, '+14155550199');
    await user.click(within(panel).getByRole('button', { name: 'Hang up' }));
    const confirm = await screen.findByRole('dialog', { name: 'Cancel this call?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel the call' }));
    await waitFor(() => {
      expect(callsTo('hangUpCall')).toEqual([{ params: { id: firstId } }]);
    });
    expect(await within(panel).findByText('Canceled')).toBeDefined();
    expect(within(panel).queryByRole('button', { name: 'Hang up' })).toBeNull();
  });

  it('keeps a connected call connected until the provider ends it', async () => {
    const connected = callOf({ state: 'connected', connectedAt: '2026-10-15T10:00:05.000Z' });
    serve([connected], {
      hangUpCall: () => ({ ...connected, hangUpRequested: true }),
    });
    const user = open();
    const panel = await details(user, '+14155550199');
    await user.click(within(panel).getByRole('button', { name: 'Hang up' }));
    const confirm = await screen.findByRole('dialog', { name: 'Hang up this call?' });
    await user.click(within(confirm).getByRole('button', { name: 'Hang up' }));
    expect(
      await within(panel).findByText(
        'Hang-up requested. The call ends when the provider reports it has.',
      ),
    ).toBeDefined();
    expect(within(panel).getByText('Connected')).toBeDefined();
    expect(within(panel).queryByText('Ended: completed')).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Hang up' })).toBeNull();
  });

  it('says why a hang-up was refused, and keeps the call as it was', async () => {
    const connected = callOf({ state: 'connected' });
    serve([connected], {
      hangUpCall: () => {
        throw refusal(409, 'The call already ended.');
      },
    });
    const user = open();
    const panel = await details(user, '+14155550199');
    await user.click(within(panel).getByRole('button', { name: 'Hang up' }));
    const confirm = await screen.findByRole('dialog', { name: 'Hang up this call?' });
    await user.click(within(confirm).getByRole('button', { name: 'Hang up' }));
    expect(await within(confirm).findByText('The call already ended.')).toBeDefined();
    expect(within(panel).getByText('Connected')).toBeDefined();
  });

  it('offers no hang-up without permission to place calls', async () => {
    granted = ['calls.read'];
    serve([callOf({ state: 'connected' })]);
    const user = open();
    const panel = await details(user, '+14155550199');
    expect(within(panel).getByText('Connected')).toBeDefined();
    expect(within(panel).queryByRole('button', { name: 'Hang up' })).toBeNull();
  });

  it('offers no Call back without permission to place calls', async () => {
    granted = ['calls.read'];
    serve([callOf({ contactIdentityId: 'cid_01k8e2wzr0e008000000000001' })]);
    const user = open();
    const panel = await details(user, '+14155550199');
    expect(within(panel).queryByRole('button', { name: 'Call back' })).toBeNull();
  });

  it('offers no Call back when call has no contact identity', async () => {
    granted = ['calls.read', 'calls.place'];
    serve([callOf({ contactIdentityId: null })]);
    const user = open();
    const panel = await details(user, '+14155550199');
    expect(within(panel).queryByRole('button', { name: 'Call back' })).toBeNull();
  });

  it('disables Call back while the device is not ready', async () => {
    softphoneMock.current = {
      state: { device: 'registering', call: null, problem: null },
      placeCall: vi.fn(),
    };
    serve([callOf({ contactIdentityId: 'cid_01k8e2wzr0e008000000000001' })]);
    const user = open();
    const panel = await details(user, '+14155550199');
    const button = within(panel).getByRole('button', { name: 'Call back' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('calls placeCall with contactIdentityId when ready and displays refusal detail', async () => {
    const placeCall = vi.fn<SoftphoneValue['placeCall']>(() =>
      Promise.resolve('Cannot place call: line busy.'),
    );
    softphoneMock.current = {
      state: { device: 'ready', call: null, problem: null },
      placeCall,
    };
    serve([callOf({ contactIdentityId: 'cid_01k8e2wzr0e008000000000001' })]);
    const user = open();
    const panel = await details(user, '+14155550199');
    const button = within(panel).getByRole('button', { name: 'Call back' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await user.click(button);
    expect(placeCall).toHaveBeenCalledWith('cid_01k8e2wzr0e008000000000001');
    expect(await within(panel).findByText('Cannot place call: line busy.')).toBeDefined();
  });
  it('disables Call back while its request is on its way, so one click places one call', async () => {
    let answer: (refusal: string | undefined) => void = () => undefined;
    const placeCall = vi.fn<SoftphoneValue['placeCall']>(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    softphoneMock.current = { state: { device: 'ready', call: null, problem: null }, placeCall };
    serve([callOf({ contactIdentityId: 'cid_01k8e2wzr0e008000000000001' })]);
    const user = open();
    const panel = await details(user, '+14155550199');
    const button = within(panel).getByRole<HTMLButtonElement>('button', { name: 'Call back' });
    await user.click(button);
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(placeCall).toHaveBeenCalledTimes(1);
    answer(undefined);
    await waitFor(() => {
      expect(button.disabled).toBe(false);
    });
  });

  it('disables Call back while a call is on in this browser', async () => {
    softphoneMock.current = {
      state: {
        device: 'ready',
        problem: null,
        call: { sid: `CA${'2'.repeat(32)}`, from: '+14155550188', phase: 'open', muted: false },
      },
      placeCall: vi.fn<SoftphoneValue['placeCall']>(() => Promise.resolve(undefined)),
    };
    serve([callOf({ contactIdentityId: 'cid_01k8e2wzr0e008000000000001' })]);
    const user = open();
    const panel = await details(user, '+14155550199');
    const button = within(panel).getByRole<HTMLButtonElement>('button', { name: 'Call back' });
    expect(button.disabled).toBe(true);
  });
});
