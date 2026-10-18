// A business's integrations as the API holds them, for the component tests and the browser
// spec of Settings → Integrations: every write is parsed by the contract's own schema and
// every answer is typed by the contract's own types. A card's state is worked out from its
// accounts as the server works it out: attention first, then working, then still checking.
// Nothing here imports the dashboard's code, so a test never checks the page against itself.
import {
  connectIntegrationInput,
  INTEGRATION_LIMITS,
  OPERATOR_SETTINGS_GUIDE,
  updateIntegrationConnectionInput,
  type IntegrationActivity,
  type IntegrationConnection,
  type IntegrationConnectStarted,
  type IntegrationDetail,
  type IntegrationEntry,
  type IntegrationList,
} from '@repo/contracts';

export const at = '2026-10-17T09:00:00.000Z';
export const integrationConnectionId = (number: number): string =>
  `int_01k8e2wzr0e00800000000${String(number).padStart(4, '0')}`;

/** Where a provider's sign-in starts, as the server would hand it over. */
export const authorizeUrlOf = (key: string): string =>
  `https://auth.example.test/${key}/authorize?state=attempt1`;

/** The key the stand-in refuses, as a provider refuses a wrong one. */
export const refusedKey = 'wrong-key';

export interface IntegrationsWorld {
  entries: IntegrationEntry[];
  canManage: boolean;
  /** Every account's activity, newest first. */
  activity: IntegrationActivity[];
  next: number;
}

const connectionOf = (
  number: number,
  connection: Partial<IntegrationConnection> = {},
): IntegrationConnection => ({
  id: integrationConnectionId(number),
  accountLabel: null,
  status: 'connected',
  errorCode: null,
  errorDetail: null,
  primary: true,
  connectedBy: 'Dana Brooks',
  connectedAt: at,
  lastOkAt: at,
  lastErrorAt: null,
  settings: {},
  webhookUrl: null,
  revision: 1,
  ...connection,
});

type Elsewhere = Pick<
  IntegrationEntry,
  'key' | 'name' | 'description' | 'category' | 'page' | 'mayManage'
> &
  Partial<IntegrationEntry>;

const elsewhereOf = (entry: Elsewhere): IntegrationEntry => ({
  auth: 'elsewhere',
  available: true,
  operatorGuide: OPERATOR_SETTINGS_GUIDE,
  multipleAccounts: true,
  state: 'not_connected',
  connected: 0,
  attention: 0,
  label: null,
  connections: [],
  ...entry,
});

type Provider = Pick<IntegrationEntry, 'key' | 'name' | 'description' | 'category' | 'auth'> &
  Partial<IntegrationEntry>;

const providerOf = (entry: Provider): IntegrationEntry => ({
  available: true,
  operatorGuide: null,
  multipleAccounts: false,
  page: null,
  mayManage: true,
  state: 'not_connected',
  connected: 0,
  attention: 0,
  label: null,
  connections: [],
  ...entry,
});

const hoursBefore = (hours: number): string =>
  new Date(Date.parse('2026-10-18T09:00:00.000Z') - hours * 3_600_000).toISOString();

/**
 * Six cards that live on pages of their own, then the providers connected here: QuickBooks
 * needing a new sign-in, Xero working, Shopify still checking, Slack with two accounts,
 * Notion the install has not set up, Typeform connected with a key, and Zoom not connected
 * yet. Lead intake has no card. Slack's first account has thirty things in its activity, so the list pages.
 */
export function integrationsWorldOf(overrides: Partial<IntegrationsWorld> = {}): IntegrationsWorld {
  const slack = integrationConnectionId(4);
  const slackOther = integrationConnectionId(5);
  const unsorted: IntegrationActivity[] = [
    ...Array.from({ length: 30 }, (_, index): IntegrationActivity => ({
      connectionId: slack,
      at: hoursBefore(index * 2),
      kind: index % 3 === 0 ? 'webhook_received' : 'check_ok',
      errorCode: null,
      detail: index % 3 === 0 ? `Message ${String(index)} arrived.` : null,
    })),
    {
      connectionId: slackOther,
      at: hoursBefore(1),
      kind: 'connected',
      errorCode: null,
      detail: null,
    },
  ];
  const activity = unsorted.sort((one, other) => other.at.localeCompare(one.at));
  return {
    entries: [
      elsewhereOf({
        key: 'google_calendar',
        name: 'Google Calendar',
        description:
          'Two-way sync for each team member: bookings go into their calendar, and busy time keeps slots free.',
        category: 'calendar_email',
        page: 'calendar_connections',
        mayManage: true,
        state: 'connected',
        connected: 1,
        label: 'dana@harborlights.example',
      }),
      elsewhereOf({
        key: 'mailboxes',
        name: 'Email Services',
        description: 'Connect any mailbox to send from it and read its replies into Conversations.',
        category: 'calendar_email',
        page: 'email_services',
        mayManage: true,
        state: 'needs_attention',
        connected: 1,
        attention: 2,
      }),
      elsewhereOf({
        key: 'emailable',
        name: 'Email Verification',
        description: 'Check email addresses with Emailable before anything is sent to them.',
        category: 'calendar_email',
        page: 'email_verification',
        mayManage: true,
      }),
      elsewhereOf({
        key: 'twilio',
        name: 'Phone System',
        description: 'Text messages and calls through your own Twilio account.',
        category: 'phone_messaging',
        page: 'phone_system',
        mayManage: false,
        state: 'connected',
        connected: 1,
        label: 'Harbor Lights Twilio',
      }),
      elsewhereOf({
        key: 'ai_models',
        name: 'AI Models',
        description: 'Your own keys for Anthropic, OpenAI or a model server of your own.',
        category: 'ai',
        page: 'ai_models',
        mayManage: true,
      }),
      elsewhereOf({
        key: 'apps_and_api_keys',
        name: 'Apps and API keys',
        description:
          'Keys for your own code, Zapier, Make or n8n, and the marketplace apps you installed.',
        category: 'developers',
        page: 'apps_and_api_keys',
        mayManage: true,
        operatorGuide: null,
      }),
      providerOf({
        key: 'quickbooks',
        name: 'QuickBooks Online',
        description: 'Send paid invoices to your books.',
        category: 'payments_accounting',
        auth: 'oauth2',
        operatorGuide: OPERATOR_SETTINGS_GUIDE,
        connections: [
          connectionOf(1, {
            accountLabel: 'Harbor Lights LLC',
            status: 'needs_attention',
            errorCode: 'reauthorize',
            errorDetail: 'QuickBooks asks to be signed in again.',
            lastErrorAt: hoursBefore(3),
          }),
        ],
      }),
      providerOf({
        key: 'xero',
        name: 'Xero',
        description: 'Keep invoices and payments in step with Xero.',
        category: 'payments_accounting',
        auth: 'oauth2',
        connections: [connectionOf(2, { accountLabel: 'Harbor Lights Books' })],
      }),
      providerOf({
        key: 'shopify',
        name: 'Shopify',
        description: 'Bring in customers and orders from your shop.',
        category: 'ecommerce',
        auth: 'oauth2',
        connections: [connectionOf(3, { status: 'connecting', lastOkAt: null })],
      }),
      providerOf({
        key: 'slack',
        name: 'Slack',
        description: 'Post to a channel when something happens.',
        category: 'productivity',
        auth: 'oauth2',
        multipleAccounts: true,
        connections: [
          connectionOf(4, {
            accountLabel: 'Harbor Lights',
            webhookUrl: 'https://crm.example.test/api/v1/integrations/slack/updates/hl1',
          }),
          connectionOf(5, { accountLabel: 'Northwind crew', primary: false, connectedBy: null }),
        ],
      }),
      providerOf({
        key: 'notion',
        name: 'Notion',
        description: 'Keep notes about contacts in Notion.',
        category: 'productivity',
        auth: 'oauth2',
        available: false,
        mayManage: false,
        operatorGuide: OPERATOR_SETTINGS_GUIDE,
      }),
      providerOf({
        key: 'typeform',
        name: 'Typeform',
        description: 'Turn Typeform answers into contacts.',
        category: 'forms',
        auth: 'api_key',
      }),
      providerOf({
        key: 'zoom',
        name: 'Zoom',
        description: 'Create a Zoom meeting for each booking.',
        category: 'calendar_email',
        auth: 'oauth2',
      }),
    ],
    canManage: true,
    activity,
    next: 6,
    ...overrides,
  };
}

/** A card as the server reads it: a provider's state from its accounts, primary first. */
function entryOf(world: IntegrationsWorld, entry: IntegrationEntry): IntegrationEntry {
  if (entry.auth === 'elsewhere') return entry;
  const connections = [...entry.connections].sort(
    (one, other) => Number(other.primary) - Number(one.primary),
  );
  const connected = connections.filter((each) => each.status === 'connected').length;
  const attention = connections.filter((each) => each.status === 'needs_attention').length;
  const [only, ...others] = connections;
  return {
    ...entry,
    mayManage: world.canManage && entry.available,
    connections,
    connected,
    attention,
    label: only !== undefined && others.length === 0 ? only.accountLabel : null,
    state:
      attention > 0
        ? 'needs_attention'
        : connected > 0
          ? 'connected'
          : connections.some((each) => each.status === 'connecting')
            ? 'connecting'
            : 'not_connected',
  };
}

export const listOf = (world: IntegrationsWorld): IntegrationList => ({
  entries: world.entries.map((entry) => entryOf(world, entry)),
  canManage: world.canManage,
});

/** A refusal as the server words it, for the stand-ins to throw or answer with. */
export interface Refusal {
  readonly status: number;
  readonly detail: string;
}
export const isRefusal = (value: unknown): value is Refusal =>
  typeof value === 'object' && value !== null && 'status' in value && 'detail' in value;

const notFound: Refusal = { status: 404, detail: 'Integration not found.' };

function find(world: IntegrationsWorld, key: string): IntegrationEntry | undefined {
  return world.entries.find((entry) => entry.key === key);
}

function change(
  world: IntegrationsWorld,
  key: string,
  connections: (current: IntegrationConnection[]) => IntegrationConnection[],
): void {
  world.entries = world.entries.map((entry) =>
    entry.key === key ? { ...entry, connections: connections(entry.connections) } : entry,
  );
}

export function detailOf(world: IntegrationsWorld, key: string): IntegrationDetail | Refusal {
  const entry = find(world, key);
  if (entry === undefined) return notFound;
  const ids = new Set(entry.connections.map((each) => each.id));
  return {
    entry: entryOf(world, entry),
    activity: world.activity
      .filter((each) => ids.has(each.connectionId))
      .slice(0, INTEGRATION_LIMITS.recentActivity),
  };
}

export function connectIn(
  world: IntegrationsWorld,
  key: string,
  body: unknown,
): IntegrationConnectStarted | Refusal {
  const entry = find(world, key);
  if (entry === undefined || entry.auth === 'elsewhere') return notFound;
  const input = connectIntegrationInput.safeParse(body ?? {});
  if (!input.success) return { status: 422, detail: 'Paste the key.' };
  if (entry.auth === 'oauth2') return { authorizeUrl: authorizeUrlOf(key), connection: null };
  if (input.data.apiKey === undefined) return { status: 422, detail: 'Paste the key.' };
  if (input.data.apiKey === refusedKey)
    return { status: 422, detail: `${entry.name} refused that key. Check it and paste it again.` };
  const made: IntegrationConnection = {
    id: integrationConnectionId(world.next),
    accountLabel: null,
    status: 'connecting',
    errorCode: null,
    errorDetail: null,
    primary: entry.connections.length === 0,
    connectedBy: 'Dana Brooks',
    connectedAt: at,
    lastOkAt: null,
    lastErrorAt: null,
    settings: {},
    webhookUrl: null,
    revision: 1,
  };
  world.next += 1;
  change(world, key, (current) => [...current, made]);
  return { authorizeUrl: null, connection: made };
}

export function updateIn(
  world: IntegrationsWorld,
  key: string,
  id: string,
  body: unknown,
): IntegrationConnection | Refusal {
  const input = updateIntegrationConnectionInput.parse(body);
  const current = find(world, key)?.connections.find((each) => each.id === id);
  if (current === undefined) return notFound;
  if (current.revision !== input.revision)
    return { status: 409, detail: 'This connection changed. Read it again before changing it.' };
  const saved: IntegrationConnection = {
    ...current,
    primary: input.primary ?? current.primary,
    settings: input.settings ?? current.settings,
    revision: current.revision + 1,
  };
  change(world, key, (connections) =>
    connections.map((each) =>
      each.id === id
        ? saved
        : input.primary === true && each.primary
          ? { ...each, primary: false, revision: each.revision + 1 }
          : each,
    ),
  );
  return saved;
}

export function testIn(
  world: IntegrationsWorld,
  key: string,
  id: string,
): IntegrationConnection | Refusal {
  const current = find(world, key)?.connections.find((each) => each.id === id);
  if (current === undefined) return notFound;
  world.activity = [
    {
      connectionId: id,
      at: '2026-10-18T10:00:00.000Z',
      kind: 'check_ok',
      errorCode: null,
      detail: null,
    },
    ...world.activity,
  ];
  return current;
}

export function disconnectIn(world: IntegrationsWorld, key: string, id: string): Refusal | null {
  const current = find(world, key)?.connections.find((each) => each.id === id);
  if (current === undefined) return notFound;
  change(world, key, (connections) => connections.filter((each) => each.id !== id));
  return null;
}

export function activityPageIn(
  world: IntegrationsWorld,
  id: string,
  before: string | undefined,
): { items: IntegrationActivity[]; next: string | null } {
  const items = world.activity
    .filter((each) => each.connectionId === id && (before === undefined || each.at < before))
    .slice(0, INTEGRATION_LIMITS.activityPage);
  const last = items.at(-1);
  return {
    items,
    next: items.length === INTEGRATION_LIMITS.activityPage && last !== undefined ? last.at : null,
  };
}
