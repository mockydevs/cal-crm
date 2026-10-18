// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type {
  PhoneNumber,
  SmsConnection,
  SmsConnectionAttempt,
  SmsProviderNumber,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { SmsConnections } from './sms-settings';

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

const connectionOf = (patch: Partial<SmsConnection> = {}): SmsConnection => ({
  id: 'smsc_01k8e2wzr0e008000000000001',
  provider: 'twilio',
  label: 'Front desk',
  accountSid: 'AC00000000000000000000000000000001',
  status: 'connected',
  accountType: 'full',
  accountStatus: 'active',
  warnings: [],
  lastCheckedAt: '2026-10-09T00:00:00.000Z',
  createdAt: '2026-10-08T00:00:00.000Z',
  ...patch,
});

const numberOf = (patch: Partial<SmsProviderNumber> = {}): SmsProviderNumber => ({
  providerNumberRef: 'PN00000000000000000000000000000001',
  e164: '+15551234567',
  friendlyName: 'Main line',
  capabilities: ['sms', 'mms'],
  registeredAs: null,
  seenAt: '2026-10-09T00:00:00.000Z',
  ...patch,
});

/**
 * Puts text in a field as one paste, the way a person enters an Account SID or a token.
 * Typing its thirty-four characters is an event and a render of the page for each.
 */
async function put(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  text: string,
): Promise<void> {
  await user.click(field);
  await user.paste(text);
}

/** The connections as someone who manages only SMS sees them: with the registered list. */
function open(registeredNumbers = true): ReturnType<typeof userEvent.setup> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <SmsConnections registeredNumbers={registeredNumbers} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  // Keys follow one another with no timer between them (user-event's `delay`). Every key
  // is still its own events and its own render; what goes is a wait per character, which
  // on a busy machine took a long test past its five seconds.
  return userEvent.setup({ delay: null });
}
const callsTo = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);

it('shows the permission refusal without exposing connection controls', async () => {
  server.answer = () => {
    throw new ApiError({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'SMS management is not granted.',
    });
  };
  open();
  expect(await screen.findByText('You need permission to manage SMS.')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Connect Twilio' })).toBeNull();
});

it('offers a retry when connections cannot be loaded for another reason', async () => {
  let fail = true;
  server.answer = (operation) => {
    if (operation !== 'listSmsConnections') return { data: [] };
    if (fail) throw new ApiError({ type: 'about:blank', title: 'Unavailable', status: 503 });
    return { data: [], unavailable: null };
  };
  const user = open();
  expect(await screen.findByText("We couldn't load your SMS connections.")).toBeDefined();
  fail = false;
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(
    await screen.findByText('No SMS connections yet. Connect Twilio to get started.'),
  ).toBeDefined();
});

it('connects Twilio, discloses the webhook URL once and clears the token', async () => {
  const attemptId = 'smst_01k8e2wzr0e008000000000001';
  const connectionId = 'smsc_01k8e2wzr0e008000000000001';
  let connections: SmsConnection[] = [];
  let connected = false;
  server.answer = (operation, input) => {
    if (operation === 'listPhoneNumbers') return { data: [] };
    if (operation === 'listSmsConnections') return { data: connections, unavailable: null };
    if (operation === 'listSmsProviderNumbers') return { data: [] };
    if (operation === 'connectSms') {
      const { body } = input as { body: { accountSid: string; authToken: string } };
      expect(body.authToken).toBe('fixture-auth-token');
      return {
        attempt: {
          id: attemptId,
          createdAt: '2026-10-09T00:00:00.000Z',
          status: 'pending',
          connectionId: null,
          result: null,
        },
        inboundWebhookUrl: 'https://crm.example/webhooks/twilio/tok_once',
      };
    }
    if (operation === 'getSmsConnectionAttempt') {
      if (!connected)
        return {
          id: attemptId,
          createdAt: '2026-10-09T00:00:00.000Z',
          status: 'pending',
          connectionId: null,
          result: null,
        };
      connections = [connectionOf({ id: connectionId })];
      return {
        id: attemptId,
        createdAt: '2026-10-09T00:00:00.000Z',
        status: 'connected',
        connectionId,
        result: {
          accountType: 'full',
          accountStatus: 'active',
          subaccount: false,
          numbersFound: 2,
        },
      } satisfies SmsConnectionAttempt;
    }
    return undefined;
  };
  const user = open();
  await screen.findByText('No SMS connections yet. Connect Twilio to get started.');
  await user.click(screen.getByRole('button', { name: 'Connect Twilio' }));
  await user.type(screen.getByLabelText('Label'), 'Front desk');
  await put(user, screen.getByLabelText('Account SID'), 'AC00000000000000000000000000000001');
  await put(user, screen.getByLabelText('Auth Token'), 'fixture-auth-token');
  connected = false;
  await user.click(screen.getByRole('button', { name: 'Test and connect' }));
  expect(await screen.findByLabelText('Auth Token')).toHaveProperty('value', '');
  connected = true;
  await waitFor(() => {
    expect(screen.getByText('Twilio connected.')).toBeDefined();
  });
  expect(screen.getByText('https://crm.example/webhooks/twilio/tok_once')).toBeDefined();
  expect(callsTo('connectSms')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Close' }));
  await user.click(screen.getByRole('button', { name: 'Connect Twilio' }));
  expect(screen.queryByText('https://crm.example/webhooks/twilio/tok_once')).toBeNull();
});

it('explains a failed connection attempt without leaking why beyond the given reason', async () => {
  server.answer = (operation) => {
    if (operation === 'listPhoneNumbers') return { data: [] };
    if (operation === 'listSmsConnections') return { data: [], unavailable: null };
    if (operation === 'connectSms')
      return {
        attempt: {
          id: 'smst_02',
          createdAt: '2026-10-09T00:00:00.000Z',
          status: 'pending',
          connectionId: null,
          result: null,
        },
        inboundWebhookUrl: null,
      };
    if (operation === 'getSmsConnectionAttempt')
      return {
        id: 'smst_02',
        createdAt: '2026-10-09T00:00:00.000Z',
        status: 'failed',
        connectionId: null,
        failure: 'authentication',
        result: null,
      } satisfies SmsConnectionAttempt;
    return undefined;
  };
  const user = open();
  await screen.findByText('No SMS connections yet. Connect Twilio to get started.');
  await user.click(screen.getByRole('button', { name: 'Connect Twilio' }));
  await user.type(screen.getByLabelText('Label'), 'Front desk');
  await put(user, screen.getByLabelText('Account SID'), 'AC00000000000000000000000000000001');
  await put(user, screen.getByLabelText('Auth Token'), 'wrong-token');
  await user.click(screen.getByRole('button', { name: 'Test and connect' }));
  expect(await screen.findByText('Twilio rejected the Account SID or token.')).toBeDefined();
});

it('shows a connection, its trial warning, its numbers, and registers an SMS-capable one', async () => {
  const connection = connectionOf({ warnings: ['trial_account'] });
  let registered: PhoneNumber[] = [];
  server.answer = (operation, input) => {
    if (operation === 'listSmsConnections') return { data: [connection], unavailable: null };
    if (operation === 'listPhoneNumbers') return { data: registered };
    if (operation === 'listSmsProviderNumbers')
      return {
        data: [
          numberOf({
            providerNumberRef: 'PN00000000000000000000000000000011',
            e164: '+15550000001',
            capabilities: ['voice'],
          }),
          numberOf({
            providerNumberRef: 'PN00000000000000000000000000000012',
            e164: '+15550000002',
          }),
        ],
      };
    if (operation === 'registerPhoneNumber') {
      const { body } = input as { body: { providerNumberRef: string; name: string } };
      expect(body.providerNumberRef).toBe('PN00000000000000000000000000000012');
      registered = [
        {
          id: 'phn_01k8e2wzr0e008000000000001',
          name: body.name,
          e164: '+15550000002',
          connectionId: connection.id,
          capabilities: ['sms', 'mms'],
          status: 'active',
          createdAt: '2026-10-08T00:00:00.000Z',
        },
      ];
      return {
        id: 'phn_01k8e2wzr0e008000000000001',
        name: body.name,
        e164: '+15550000002',
        connectionId: connection.id,
        capabilities: ['sms', 'mms'],
        status: 'active',
        createdAt: '2026-10-08T00:00:00.000Z',
      };
    }
    return undefined;
  };
  const user = open();
  expect(await screen.findByText('Front desk')).toBeDefined();
  expect(
    screen.getByText('This is a Twilio trial account. Sending may be limited to verified numbers.'),
  ).toBeDefined();
  await user.click(screen.getByText('Numbers from Twilio'));
  const voiceOnlyRow = screen.getByText('+15550000001').closest('li');
  expect(voiceOnlyRow).not.toBeNull();
  expect(
    within(voiceOnlyRow as HTMLElement)
      .getByRole('button', { name: 'Register' })
      .matches(':disabled'),
  ).toBe(true);
  const smsRow = screen.getByText('+15550000002').closest('li') as HTMLElement;
  await user.click(within(smsRow).getByRole('button', { name: 'Register' }));
  await user.clear(within(smsRow).getByLabelText('Name'));
  await user.type(within(smsRow).getByLabelText('Name'), 'Front line');
  await user.click(within(smsRow).getByRole('button', { name: 'Register' }));
  await waitFor(() => {
    expect(callsTo('registerPhoneNumber')).toEqual([
      {
        body: {
          connectionId: connection.id,
          providerNumberRef: 'PN00000000000000000000000000000012',
          name: 'Front line',
        },
      },
    ]);
  });
  // The form closes, Twilio's numbers are read again, and the number is listed as registered.
  await waitFor(() => {
    expect(within(smsRow).queryByLabelText('Name')).toBeNull();
  });
  await waitFor(() => {
    expect(callsTo('listSmsProviderNumbers')).toHaveLength(2);
  });
  const list = await screen.findByRole('region', { name: 'Registered phone numbers' });
  expect(await within(list).findByText('Front line')).toBeDefined();
});

it('lists registered numbers with status, capabilities and their connection', async () => {
  const connection = connectionOf({ label: 'Front desk' });
  server.answer = (operation) => {
    if (operation === 'listSmsConnections') return { data: [connection], unavailable: null };
    if (operation === 'listSmsProviderNumbers') return { data: [] };
    if (operation === 'listPhoneNumbers')
      return {
        data: [
          {
            id: 'phn_01k8e2wzr0e008000000000001',
            name: 'Support line',
            e164: '+15551234567',
            connectionId: connection.id,
            capabilities: ['sms', 'mms'],
            status: 'failing',
            createdAt: '2026-10-08T00:00:00.000Z',
          },
        ],
      };
    return undefined;
  };
  open();
  const row = (await screen.findByText('Support line')).closest('li') as HTMLElement;
  expect(within(row).getByText('Failing')).toBeDefined();
  expect(within(row).getByText(/Front desk/)).toBeDefined();
  expect(within(row).getByText('MMS')).toBeDefined();
});

it('leaves the registered list to the phone numbers for someone who manages calls too', async () => {
  server.answer = (operation) =>
    operation === 'listSmsConnections'
      ? { data: [connectionOf()], unavailable: null }
      : { data: [] };
  open(false);
  expect(await screen.findByRole('heading', { name: 'Front desk' })).toBeDefined();
  expect(screen.queryByRole('heading', { name: 'Registered phone numbers' })).toBeNull();
  expect(callsTo('listPhoneNumbers')).toEqual([]);
});

it('starts a refresh and shows it is under way', async () => {
  const connection = connectionOf();
  server.answer = (operation) => {
    if (operation === 'listPhoneNumbers') return { data: [] };
    if (operation === 'listSmsConnections') return { data: [connection], unavailable: null };
    if (operation === 'listSmsProviderNumbers') return { data: [numberOf()] };
    if (operation === 'refreshSmsProviderNumbers') return null;
    return undefined;
  };
  const user = open();
  await screen.findByText('Front desk');
  await user.click(screen.getByText('Numbers from Twilio'));
  await user.click(screen.getByRole('button', { name: 'Refresh numbers' }));
  await waitFor(() => {
    expect(callsTo('refreshSmsProviderNumbers')).toEqual([{ params: { id: connection.id } }]);
  });
  expect(await screen.findByText('Refreshing from Twilio…')).toBeDefined();
});

it('says plainly why text messages are unavailable on an install without a secure public address', async () => {
  server.answer = (operation) => {
    if (operation === 'listSmsConnections')
      return {
        data: [connectionOf()],
        unavailable: {
          code: 'public_address_unsuitable',
          message: "The server's own sentence, which the page does not show.",
        },
      };
    return { data: [] };
  };
  open();
  const notice = await screen.findByRole('alert');
  expect(notice.textContent).toBe(
    "Text messages can't be sent or received on this install yet. Twilio reports deliveries and incoming messages to the install's public address, and it only reports to a secure one: an https address with no underscore in its name. Ask whoever runs this install to set its public address (PUBLIC_URL) to one. You can still connect an account and register numbers now; they will start working once the address is set.",
  );
  expect(screen.queryByText("The server's own sentence, which the page does not show.")).toBeNull();
  // What is connected is still shown and can still be managed.
  expect(screen.getByRole('heading', { name: 'Front desk' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Connect Twilio' })).toBeDefined();
});

it('says nothing of the kind on an install that can send and receive', async () => {
  server.answer = (operation) =>
    operation === 'listSmsConnections'
      ? { data: [connectionOf()], unavailable: null }
      : { data: [] };
  open();
  expect(await screen.findByRole('heading', { name: 'Front desk' })).toBeDefined();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/can't be sent or received/)).toBeNull();
});
