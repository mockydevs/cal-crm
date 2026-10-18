// @vitest-environment jsdom
// Settings → Integrations: each card's state in plain words, the chips and the search,
// connecting with the provider's sign-in or a key, the outcome the sign-in comes back with,
// disconnecting, and the Manage panel's accounts and activity. The API is a small world
// shaped by the contract's own types (e2e/integrations-fixtures.ts).
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  activityPageIn,
  authorizeUrlOf,
  connectIn,
  detailOf,
  disconnectIn,
  integrationConnectionId,
  integrationsWorldOf,
  isRefusal,
  listOf,
  refusedKey,
  testIn,
  updateIn,
  type IntegrationsWorld,
} from '../../e2e/integrations-fixtures';
import IntegrationsPage from './settings-page';

interface Input {
  readonly body?: unknown;
  readonly params?: { readonly provider?: string; readonly id?: string };
  readonly query?: { readonly before?: string };
}
const server = vi.hoisted(
  (): {
    world: IntegrationsWorld | undefined;
    writes: { operation: string; body: unknown }[];
    asked: string[];
    agencyStaff: boolean;
    left: string[];
  } => ({ world: undefined, writes: [], asked: [], agencyStaff: false, left: [] }),
);

vi.mock('../api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: Input) =>
      Promise.resolve().then(() => {
        const world = server.world;
        if (world === undefined) throw new Error('no server');
        server.asked.push(endpoint.operationId);
        if (
          endpoint.operationId !== 'listIntegrations' &&
          endpoint.operationId !== 'getIntegration'
        )
          server.writes.push({ operation: endpoint.operationId, body: input.body });
        const key = input.params?.provider ?? '';
        const id = input.params?.id ?? '';
        const answers: Record<string, () => unknown> = {
          listIntegrations: () => listOf(world),
          getIntegration: () => detailOf(world, key),
          connectIntegration: () => connectIn(world, key, input.body),
          updateIntegrationConnection: () => updateIn(world, key, id, input.body),
          testIntegrationConnection: () => testIn(world, key, id),
          disconnectIntegration: () => disconnectIn(world, key, id),
          listIntegrationActivity: () => activityPageIn(world, id, input.query?.before),
        };
        const answer = answers[endpoint.operationId]?.();
        if (answer === undefined) throw new Error(`unexpected ${endpoint.operationId}`);
        if (isRefusal(answer))
          throw new ApiError({ type: 'about:blank', title: 'Refused', ...answer });
        return answer;
      }),
  }),
}));
vi.mock('../workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
  meQuery: {
    queryKey: ['me'],
    queryFn: () => Promise.resolve({ agencyStaff: server.agencyStaff }),
  },
}));
vi.mock('./leave', () => ({
  leaveFor: (url: string) => {
    server.left.push(url);
  },
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params: { slug: string };
    children: ReactNode;
    className?: string;
    'aria-label'?: string;
  }) => (
    <a href={to.replace('$slug', params.slug)} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => () => Promise.resolve(),
}));
vi.mock('../shell/page', () => ({
  Page: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 60000 });

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.world = undefined;
  server.writes = [];
  server.asked = [];
  server.agencyStaff = false;
  server.left = [];
});
afterEach(cleanup);

function show(
  world: IntegrationsWorld = integrationsWorldOf(),
  address: { integration?: string; outcome?: string } = {},
  onArrived: () => void = () => undefined,
): { world: IntegrationsWorld; user: ReturnType<typeof userEvent.setup> } {
  server.world = world;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>
        <IntegrationsPage {...address} onArrived={onArrived} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { world, user: userEvent.setup() };
}

const card = (name: string): HTMLElement => screen.getByRole('article', { name });
const cardNames = (): string[] =>
  screen.getAllByRole('article').map((each) => within(each).getByRole('heading').textContent);

it('says where each integration stands, in plain words', async () => {
  show();
  await screen.findByRole('article', { name: 'Google Calendar' });
  expect(screen.getByRole('heading', { level: 1, name: 'Integrations' })).toBeTruthy();
  expect(screen.getByText('Connect the tools your business already uses.')).toBeTruthy();
  expect(cardNames()).toEqual([
    'Google Calendar',
    'Email Services',
    'Email Verification',
    'Phone System',
    'AI Models',
    'Apps and API keys',
    'QuickBooks Online',
    'Xero',
    'Shopify',
    'Slack',
    'Notion',
    'Typeform',
    'Zoom',
  ]);
  expect(within(card('Google Calendar')).getByText('dana@harborlights.example')).toBeTruthy();
  expect(within(card('Xero')).getByText('Harbor Lights Books')).toBeTruthy();
  expect(within(card('Xero')).getByText('Connected by Dana Brooks · Oct 17, 2026')).toBeTruthy();
  expect(within(card('Slack')).getByText('2 accounts connected')).toBeTruthy();
  expect(
    within(card('QuickBooks Online')).getByText('QuickBooks asks to be signed in again.'),
  ).toBeTruthy();
  expect(
    within(card('QuickBooks Online')).getByRole('button', { name: 'Reconnect QuickBooks Online' }),
  ).toBeTruthy();
  expect(within(card('Email Services')).getByText('2 connections need attention')).toBeTruthy();
  expect(within(card('Shopify')).getByText('Checking the account…')).toBeTruthy();
  const notion = card('Notion');
  expect(within(notion).getByText("Your administrator hasn't set this up.")).toBeTruthy();
  expect(within(notion).queryByRole('button', { name: /Connect/ })).toBeNull();
  expect(within(notion).queryByRole('link', { name: /Operator setup guide/ })).toBeNull();
  expect(
    screen.getByRole('link', { name: 'Find more in App Marketplace' }).getAttribute('href'),
  ).toBe('/b/harbor/app-marketplace');
});

it('links the operator setup guide for the agency’s staff only, in a new tab', async () => {
  server.agencyStaff = true;
  show();
  const notionCard = await screen.findByRole('article', { name: 'Notion' });
  const link = await within(notionCard).findByRole('link', {
    name: 'Operator setup guide (opens in a new tab)',
  });
  expect(link.getAttribute('href')).toBe(
    'https://github.com/mockydevs/cal-crm/blob/main/docs/HOSTING.md#51-what-you-set',
  );
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
});

it('filters by chip and by search, keeping the order served', async () => {
  const { user } = show();
  await screen.findByRole('article', { name: 'Google Calendar' });
  const chips = within(screen.getByRole('group', { name: 'Categories' }));
  expect(chips.getAllByRole('button').map((each) => each.textContent)).toEqual([
    'All',
    'Connected',
    'Calendar & email',
    'Phone & messaging',
    'AI',
    'Payments & accounting',
    'E-commerce',
    'Productivity',
    'Forms',
    'Developers',
  ]);
  await user.click(chips.getByRole('button', { name: 'Payments & accounting' }));
  expect(
    chips.getByRole('button', { name: 'Payments & accounting' }).getAttribute('aria-pressed'),
  ).toBe('true');
  expect(cardNames()).toEqual(['QuickBooks Online', 'Xero']);
  await user.click(chips.getByRole('button', { name: 'Connected' }));
  expect(cardNames()).toEqual([
    'Google Calendar',
    'Email Services',
    'Phone System',
    'QuickBooks Online',
    'Xero',
    'Slack',
  ]);
  await user.click(chips.getByRole('button', { name: 'All' }));
  await user.type(screen.getByRole('searchbox', { name: 'Search integrations' }), 'twilio');
  expect(cardNames()).toEqual(['Phone System']);
  await user.clear(screen.getByRole('searchbox', { name: 'Search integrations' }));
  await user.type(
    screen.getByRole('searchbox', { name: 'Search integrations' }),
    'nothing like it',
  );
  expect(screen.getByText('No integrations match.')).toBeTruthy();
});

it('sends an integration that lives elsewhere to its own page, for someone who may manage it', async () => {
  show();
  const calendar = await screen.findByRole('article', { name: 'Google Calendar' });
  expect(
    within(calendar).getByRole('link', { name: 'Manage Google Calendar' }).getAttribute('href'),
  ).toBe('/b/harbor/settings/calendars/connections');
  expect(
    within(card('Email Verification'))
      .getByRole('link', { name: 'Connect Email Verification' })
      .getAttribute('href'),
  ).toBe('/b/harbor/settings/email');
  expect(within(card('Phone System')).queryByRole('link')).toBeNull();
  expect(
    within(card('Phone System')).getByRole('button', { name: 'Actions for Phone System' }),
  ).toBeTruthy();
});

it('connects with the provider’s sign-in by going to the address it serves', async () => {
  const { user } = show();
  await user.click(
    within(await screen.findByRole('article', { name: 'Zoom' })).getByRole('button', {
      name: 'Connect Zoom',
    }),
  );
  await waitFor(() => {
    expect(server.left).toEqual([authorizeUrlOf('zoom')]);
  });
  expect(server.writes).toEqual([{ operation: 'connectIntegration', body: {} }]);
});

it('connects with a key, and shows why a key was refused', async () => {
  const { world, user } = show();
  await user.click(
    within(await screen.findByRole('article', { name: 'Typeform' })).getByRole('button', {
      name: 'Connect Typeform',
    }),
  );
  const dialog = await screen.findByRole('dialog', { name: 'Connect Typeform' });
  const box = within(dialog).getByLabelText('Key');
  expect(box.getAttribute('type')).toBe('password');
  await user.type(box, refusedKey);
  await user.click(within(dialog).getByRole('button', { name: 'Connect' }));
  expect(await within(dialog).findByRole('alert')).toHaveProperty(
    'textContent',
    'Typeform refused that key. Check it and paste it again.',
  );
  await user.clear(box);
  await user.type(box, 'tfp_live_123');
  await user.click(within(dialog).getByRole('button', { name: 'Connect' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  expect(server.writes.at(-1)).toEqual({
    operation: 'connectIntegration',
    body: { apiKey: 'tfp_live_123' },
  });
  expect(world.entries.find((each) => each.key === 'typeform')?.connections).toHaveLength(1);
  expect(await screen.findByText('Typeform is connected. Checking the account…')).toBeTruthy();
  expect(await within(card('Typeform')).findByText('Checking the account…')).toBeTruthy();
});

it('shows integrations without changing them to someone who may not', async () => {
  show(integrationsWorldOf({ canManage: false }));
  await screen.findByRole('article', { name: 'Google Calendar' });
  expect(screen.getByText('You need permission to manage integrations.')).toBeTruthy();
  for (const name of ['QuickBooks Online', 'Xero', 'Slack', 'Typeform', 'Zoom']) {
    expect(within(card(name)).queryByRole('button')).toBeNull();
  }
  expect(
    within(card('Google Calendar')).getByRole('link', { name: 'Manage Google Calendar' }),
  ).toBeTruthy();
});

it('says how the provider’s sign-in went, then clears the address', async () => {
  const arrived = vi.fn();
  show(integrationsWorldOf(), { integration: 'slack', outcome: 'scopes_missing' }, arrived);
  expect(
    await screen.findByText(
      "Slack wasn't connected: allow everything it asks for, then try again.",
    ),
  ).toHaveProperty('role', 'status');
  expect(arrived).toHaveBeenCalled();
});

it('ignores an outcome the callback never sends', async () => {
  show(integrationsWorldOf(), { integration: 'slack', outcome: 'hacked' });
  await screen.findByRole('article', { name: 'Slack' });
  expect(screen.queryByText(/Slack/, { selector: '[role="status"]' })).toBeNull();
});

it('disconnects from the menu after saying what stops', async () => {
  const { world, user } = show();
  await user.click(
    within(await screen.findByRole('article', { name: 'Xero' })).getByRole('button', {
      name: 'Actions for Xero',
    }),
  );
  await user.click(await screen.findByRole('menuitem', { name: 'Disconnect' }));
  const asking = await screen.findByRole('dialog', { name: 'Disconnect Xero?' });
  expect(
    within(asking).getByText(
      'Its steps stop and it no longer sends anything here. What it already brought in stays.',
    ),
  ).toBeTruthy();
  await user.click(within(asking).getByRole('button', { name: 'Disconnect' }));
  await waitFor(() => {
    expect(world.entries.find((each) => each.key === 'xero')?.connections).toEqual([]);
  });
  expect(server.writes.at(-1)?.operation).toBe('disconnectIntegration');
  expect(await within(card('Xero')).findByRole('button', { name: 'Connect Xero' })).toBeTruthy();
});

it('manages accounts in the panel: primary, a check, and older activity', async () => {
  const { world, user } = show();
  await user.click(
    within(await screen.findByRole('article', { name: 'Slack' })).getByRole('button', {
      name: 'Manage Slack',
    }),
  );
  const panel = await screen.findByRole('dialog', { name: 'Manage Slack' });
  const harbor = await within(panel).findByRole('listitem', { name: 'Harbor Lights' });
  expect(within(harbor).getByText('Primary')).toBeTruthy();
  expect(within(harbor).getByRole('textbox', { name: 'Update address' })).toHaveProperty(
    'value',
    'https://crm.example.test/api/v1/integrations/slack/updates/hl1',
  );
  expect(within(harbor).getByRole('button', { name: 'Copy update address' })).toBeTruthy();
  const northwind = within(panel).getByRole('listitem', { name: 'Northwind crew' });
  expect(within(northwind).queryByRole('textbox')).toBeNull();
  expect(within(panel).getAllByRole('listitem').length).toBe(2 + 20);

  await user.click(within(northwind).getByRole('button', { name: 'Make primary' }));
  await waitFor(() => {
    expect(
      world.entries.find((each) => each.key === 'slack')?.connections.find((each) => each.primary)
        ?.id,
    ).toBe(integrationConnectionId(5));
  });
  expect(server.writes.at(-1)).toEqual({
    operation: 'updateIntegrationConnection',
    body: { primary: true, revision: 1 },
  });

  // Someone else changed Harbor Lights after the panel read it.
  const slack = world.entries.find((each) => each.key === 'slack');
  const before = server.asked.filter((each) => each === 'getIntegration').length;
  await waitFor(() => {
    expect(server.asked.filter((each) => each === 'getIntegration').length).toBeGreaterThan(0);
  });
  if (slack === undefined) throw new Error('No Slack.');
  const again = await within(panel).findByRole('listitem', { name: 'Harbor Lights' });
  slack.connections = slack.connections.map((each) =>
    each.id === integrationConnectionId(4) ? { ...each, revision: 9 } : each,
  );
  await user.click(await within(again).findByRole('button', { name: 'Make primary' }));
  expect(await within(panel).findByRole('alert')).toHaveProperty(
    'textContent',
    'This connection changed since you opened it.',
  );
  expect(server.asked.filter((each) => each === 'getIntegration').length).toBeGreaterThan(before);

  await user.click(
    within(within(panel).getByRole('listitem', { name: 'Northwind crew' })).getByRole('button', {
      name: 'Check now',
    }),
  );
  await waitFor(() => {
    expect(server.writes.at(-1)?.operation).toBe('testIntegrationConnection');
  });

  const activity = within(panel).getByRole('list', { name: 'Activity' });
  await waitFor(() => {
    expect(within(activity).getAllByRole('listitem')).toHaveLength(20);
  });
  expect(within(activity).getAllByText('Checked: working').length).toBeGreaterThan(0);
  await user.click(within(panel).getByRole('button', { name: 'Older' }));
  await waitFor(() => {
    expect(within(activity).getAllByRole('listitem')).toHaveLength(world.activity.length);
  });
  expect(within(panel).queryByRole('button', { name: 'Older' })).toBeNull();
  expect(within(activity).getByText('Message 27 arrived.')).toBeTruthy();
});

it('asks again while an account is being checked', async () => {
  show();
  await screen.findByRole('article', { name: 'Shopify' });
  await waitFor(
    () => {
      expect(server.asked.filter((each) => each === 'listIntegrations').length).toBeGreaterThan(1);
    },
    { timeout: 5000 },
  );
});
