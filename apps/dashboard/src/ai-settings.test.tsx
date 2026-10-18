// @vitest-environment jsdom
// Settings → AI models, in a business and at the agency: what the page shows
// for each answer of the API, and what it sends. The API is stood in for here; the page's
// way through a browser is in e2e/ai-settings.spec.ts.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type {
  AiConnection,
  AiConnectionTest,
  AiModelPrice,
  AiSettings,
  AiTestOutcome,
  AiUsage,
  AutonomySetting,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiSettingsPage } from './ai-settings';
import { AgencyAiSettingsPage } from './ai-settings-agency';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('./api', () => {
  const client = {
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  };
  return { api: client, apiIn: () => client };
});
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
  meQuery: {
    queryKey: ['me'],
    queryFn: () => Promise.resolve({ agency: { name: 'Bluebird Digital' } }),
    staleTime: Infinity,
  },
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

// Made up for this file: no provider issued it.
const KEY = 'sk-ant-fixture-0000000000000000a1f3';
const CONNECTION = 'aic_01k8e2wzr0e008000000000001';
const TEST = 'aict_01k8e2wzr0e008000000000001';
const CALL = 'aireq_01k8e2wzr0e008000000000001';
const at = '2026-10-02T09:00:00.000Z';

const connectionOf = (patch: Partial<AiConnection> = {}): AiConnection => ({
  id: CONNECTION,
  provider: 'anthropic',
  owner: 'business',
  canManage: true,
  hasKey: true,
  keyLast4: 'a1f3',
  baseUrl: null,
  model: null,
  status: 'untested',
  lastTest: null,
  addedBy: 'Dana Brooks',
  createdAt: at,
  ...patch,
});
const testOf = (patch: Partial<AiConnectionTest> = {}): AiConnectionTest => ({
  id: TEST,
  connectionId: CONNECTION,
  kind: 'model_call',
  status: 'pending',
  outcome: null,
  latencyMs: null,
  call: null,
  createdAt: at,
  finishedAt: null,
  ...patch,
});
const finished = (outcome: AiTestOutcome, patch: Partial<AiConnectionTest> = {}) =>
  testOf({ status: 'finished', outcome, finishedAt: at, ...patch });
const CLAUDE = [
  { provider: 'anthropic', model: 'claude-fable-5-1', priced: true },
  { provider: 'anthropic', model: 'claude-opus-5-5', priced: true },
  { provider: 'anthropic', model: 'claude-sonnet-5-5', priced: true },
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', priced: true },
] as const;
const settingsOf = (patch: Partial<AiSettings> = {}): AiSettings => ({
  enabled: true,
  keySource: 'own',
  monthlyLimit: null,
  atLimit: 'pause',
  maskContactDetails: false,
  requestLogDays: 30,
  backup: null,
  jobs: (
    [
      ['automation_builder', 'claude-opus-5-5'],
      ['replies', 'claude-sonnet-5-5'],
      ['briefings', 'claude-opus-5-5'],
      ['sorting', 'claude-haiku-4-5-20251001'],
    ] as const
  ).map(([job, model]) => ({
    job,
    provider: 'anthropic',
    model,
    isDefault: true,
    tested: false,
    readiness: 'ready' as const,
  })),
  models: [...CLAUDE],
  limitReachedAt: null,
  revision: 'a'.repeat(64),
  ...patch,
});
const usageOf = (patch: Partial<AiUsage> = {}): AiUsage => ({
  month: '2026-10',
  spent: '0.000000',
  calls: 0,
  unknownCostCalls: 0,
  limit: null,
  byJob: [],
  recent: [],
  ...patch,
});

/** What the API holds, as a test set it up; answers are read from it at each call. */
interface World {
  connections: AiConnection[];
  settings: AiSettings;
  usage: AiUsage;
  test: AiConnectionTest;
  prices: AiModelPrice[];
  /** How much the inbox assistant does on its own for the business, and who may change it. */
  autonomy: AutonomySetting;
  canChangeAutonomy: boolean;
  /** Answers one operation another way, such as with an error. */
  override?: (operation: string, input: unknown) => unknown;
}
function serve(patch: Partial<World> = {}): World {
  const world: World = {
    connections: [],
    settings: settingsOf(),
    usage: usageOf(),
    test: testOf(),
    prices: [],
    autonomy: {
      agent: 'inbox',
      action: 'send_message',
      level: 'ask',
      source: 'default',
      businessLevel: 'ask',
    },
    canChangeAutonomy: true,
    ...patch,
  };
  server.answer = (operation, input) => {
    const other: unknown = world.override?.(operation, input);
    if (other !== undefined) return other;
    switch (operation) {
      case 'listAiConnections':
        return { data: world.connections };
      case 'getAiSettings':
      case 'updateAiSettings':
        return world.settings;
      case 'getAiUsage':
        return world.usage;
      case 'connectAiProvider':
      case 'updateAiConnection':
        return { connection: world.connections[0] ?? connectionOf(), test: testOf() };
      case 'startAiConnectionTest':
        return testOf();
      case 'getAiConnectionTest':
        return world.test;
      case 'listAiModelPrices':
        return { data: world.prices, canManage: true };
      case 'getAutonomy':
        return { canChange: world.canChangeAutonomy, items: [world.autonomy] };
      case 'setAutonomy':
        return world.autonomy;
      default:
        return undefined;
    }
  };
  return world;
}

function open(page: ReactElement = <AiSettingsPage />): ReturnType<typeof userEvent.setup> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(['me'], { agency: { name: 'Bluebird Digital' } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>{page}</I18nProvider>
    </QueryClientProvider>,
  );
  // Keys follow one another with no timer between them (user-event's `delay`). Every key
  // is still its own events and its own render; what goes is a wait per character, which
  // on a busy machine took a long test past its five seconds.
  return userEvent.setup({ delay: null });
}
const callsTo = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);
const problem = (status: number, detail: string, errors?: unknown[]): ApiError =>
  new ApiError({
    type: 'about:blank',
    title: 'Problem',
    status,
    detail,
    ...(errors === undefined ? {} : { errors }),
  } as ApiError['problem']);
const section = async (name: string): Promise<HTMLElement> => {
  const heading = await screen.findByRole('heading', { name });
  const found = heading.closest('section');
  if (found === null) throw new Error(`No section for ${name}.`);
  return found;
};

describe('opening the page', () => {
  it('says who may manage AI settings, and shows no control, to someone whose role does not', async () => {
    serve({ override: () => Promise.reject(problem(403, 'It needs ai.manage.')) });
    open();
    expect(await screen.findByText('You need permission to manage AI settings.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Providers' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Spending' })).toBeNull();
    expect(callsTo('listAiConnections')).toEqual([]);
  });

  it('offers another try when the settings cannot be loaded', async () => {
    let fail = true;
    serve({
      override: (operation) =>
        operation === 'getAiSettings' && fail
          ? Promise.reject(problem(503, 'Unavailable'))
          : undefined,
    });
    const user = open();
    expect(await screen.findByText("We couldn't load the AI settings.")).toBeDefined();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Providers' })).toBeDefined();
  });

  it('shows a business with nothing connected: what to add, what cannot run yet, and no spend', async () => {
    serve({
      settings: settingsOf({
        keySource: 'agency',
        models: [],
        jobs: settingsOf().jobs.map((job) => ({ ...job, readiness: 'no_key' })),
      }),
    });
    open();
    const providers = await section('Providers');
    expect(
      await within(providers).findByRole('button', { name: 'Add Anthropic key' }),
    ).toBeDefined();
    expect(within(providers).getByRole('button', { name: 'Add OpenAI key' })).toBeDefined();
    expect(within(providers).getByRole('button', { name: 'Add server' })).toBeDefined();
    expect(within(providers).getByText('Not available in this version yet.')).toBeDefined();
    const jobs = await section('Which model does each job');
    expect(within(jobs).getAllByText('Not tested yet')).toHaveLength(4);
    expect(
      within(jobs).getAllByText(
        "This can't run yet: the keys this business uses have none for Anthropic. Add one under Providers, switch whose keys to use, or pick another model.",
      ),
    ).toHaveLength(4);
    // The model a job is on is shown even though no key offers it.
    expect(
      within(jobs).getByRole('combobox', { name: 'Building automations' }).textContent,
    ).toContain('Claude Opus 5.5 (no key)');
    const spending = await section('Spending');
    expect(await within(spending).findByText('$0.00')).toBeDefined();
    expect(within(spending).getByText('this month')).toBeDefined();
    expect(within(spending).getByText('No limit')).toBeDefined();
    expect(within(spending).queryByRole('progressbar')).toBeNull();
    const calls = await section('Recent calls');
    expect(
      within(calls).getByText('No calls yet. Test a provider to see the first one here.'),
    ).toBeDefined();
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: 'Bluebird Digital’s keys' }).checked,
    ).toBe(true);
    expect(
      screen.getByText("Your own keys stay saved but aren't used while this is selected."),
    ).toBeDefined();
  });
});

describe('connecting a provider', () => {
  it('sends the key once, keeps it nowhere on the page, and says the test passed with how long it took', async () => {
    const world = serve();
    const user = open();
    const providers = await section('Providers');
    await user.click(await within(providers).findByRole('button', { name: 'Add Anthropic key' }));
    const field = within(providers).getByLabelText('Anthropic API key');
    expect(field.getAttribute('type')).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('off');
    await user.click(field);
    await user.paste(KEY);
    world.connections = [connectionOf()];
    await user.click(within(providers).getByRole('button', { name: 'Save and test' }));

    await waitFor(() => {
      expect(callsTo('connectAiProvider')).toEqual([
        { body: { provider: 'anthropic', apiKey: KEY } },
      ]);
    });
    expect(await within(providers).findByText('Testing…')).toBeDefined();
    expect(
      await within(providers).findByText('Key ending a1f3 · added by Dana Brooks on October 2'),
    ).toBeDefined();
    // The form is gone and the key with it: nothing on the page holds it.
    expect(within(providers).queryByLabelText('Anthropic API key')).toBeNull();
    expect(document.body.innerHTML).not.toContain(KEY);

    world.connections = [connectionOf({ status: 'working' })];
    world.test = finished('ok', {
      latencyMs: 812,
      call: { id: CALL, costEstimate: '0.000100' },
    });
    expect(
      await within(providers).findByText(/Working · answered in 0\.8 seconds/, undefined, {
        timeout: 3000,
      }),
    ).toBeDefined();
    expect(within(providers).getByText(/This test call cost \$0\.0001\./)).toBeDefined();
    expect(await within(providers).findByText('Connected')).toBeDefined();
    expect(callsTo('getAiConnectionTest')).toContainEqual({ params: { id: TEST } });
  });

  it('checks a key with the API’s own rules before sending anything', async () => {
    serve();
    const user = open();
    const providers = await section('Providers');
    await user.click(await within(providers).findByRole('button', { name: 'Add Anthropic key' }));
    await user.type(within(providers).getByLabelText('Anthropic API key'), 'sk-ant with a space');
    await user.click(within(providers).getByRole('button', { name: 'Save and test' }));
    expect(
      await within(providers).findByText(
        'A key has no spaces or line breaks. Paste it again, on its own.',
      ),
    ).toBeDefined();
    expect(callsTo('connectAiProvider')).toEqual([]);
    // Cancel closes the form and forgets what was typed.
    await user.click(within(providers).getByRole('button', { name: 'Cancel' }));
    await user.click(await within(providers).findByRole('button', { name: 'Add Anthropic key' }));
    expect(within(providers).getByLabelText<HTMLInputElement>('Anthropic API key').value).toBe('');
  });

  it('asks OpenAI for a model name, and a server of one’s own for an address and a model', async () => {
    serve();
    const user = open();
    const providers = await section('Providers');
    await user.click(await within(providers).findByRole('button', { name: 'Add OpenAI key' }));
    await user.type(within(providers).getByLabelText('Model name'), 'gpt-fixture');
    await user.type(within(providers).getByLabelText('OpenAI API key'), 'sk-fixture-openai-0000');
    await user.click(within(providers).getByRole('button', { name: 'Save and test' }));
    await waitFor(() => {
      expect(callsTo('connectAiProvider')).toEqual([
        { body: { provider: 'openai', apiKey: 'sk-fixture-openai-0000', model: 'gpt-fixture' } },
      ]);
    });

    await user.click(await within(providers).findByRole('button', { name: 'Add server' }));
    await user.type(within(providers).getByLabelText('Server address'), 'http://ollama:11434/v1');
    await user.type(within(providers).getByLabelText('Model name'), 'llama3.2');
    expect(
      within(providers).getByText(/Smaller models can struggle with bigger jobs/),
    ).toBeDefined();
    await user.click(within(providers).getByRole('button', { name: 'Save and test' }));
    await waitFor(() => {
      // No key was typed, so none is sent: the server asks for none.
      expect(callsTo('connectAiProvider')[1]).toEqual({
        body: {
          provider: 'openai_compatible',
          baseUrl: 'http://ollama:11434/v1',
          model: 'llama3.2',
        },
      });
    });
  });

  it('says in its own words why an address was refused, and what whoever runs the install must list', async () => {
    serve({
      override: (operation) =>
        operation === 'connectAiProvider'
          ? Promise.reject(
              problem(422, 'Refused', [
                {
                  path: '/baseUrl',
                  code: 'address_not_https',
                  message: "The server's own sentence, which the page does not show.",
                  suggestion: "The server's own suggestion.",
                },
              ]),
            )
          : undefined,
    });
    const user = open();
    const providers = await section('Providers');
    await user.click(await within(providers).findByRole('button', { name: 'Add server' }));
    await user.type(
      within(providers).getByLabelText('Server address'),
      'http://192.168.1.20:8080/v1',
    );
    await user.type(within(providers).getByLabelText('Model name'), 'llama3.2');
    await user.click(within(providers).getByRole('button', { name: 'Save and test' }));
    expect(
      await within(providers).findByText(
        "This install can't call that address. It calls addresses that start with https://, and model servers that whoever runs the install has listed.",
      ),
    ).toBeDefined();
    // The host and port to list are the ones that were typed.
    const step = within(providers).getByText(/ask whoever runs this install to add/);
    expect(step.textContent).toContain('192.168.1.20:8080');
    expect(step.textContent).toContain('AI_LOCAL_SERVERS');
    expect(screen.queryByText(/The server's own/)).toBeNull();
    // What was typed is still there to correct.
    expect(within(providers).getByLabelText<HTMLInputElement>('Server address').value).toBe(
      'http://192.168.1.20:8080/v1',
    );
  });

  it('does not send the person to the operator for an address that is simply malformed', async () => {
    serve({
      override: (operation) =>
        operation === 'connectAiProvider'
          ? Promise.reject(
              problem(422, 'Refused', [
                { path: '/baseUrl', code: 'address_has_query', message: 'Server words.' },
              ]),
            )
          : undefined,
    });
    const user = open();
    const providers = await section('Providers');
    await user.click(await within(providers).findByRole('button', { name: 'Add server' }));
    await user.type(
      within(providers).getByLabelText('Server address'),
      'https://models.example.com/v1?key=1',
    );
    await user.type(within(providers).getByLabelText('Model name'), 'llama3.2');
    await user.click(within(providers).getByRole('button', { name: 'Save and test' }));
    expect(
      await within(providers).findByText('Leave out everything after the path: no ? and no #.'),
    ).toBeDefined();
    expect(within(providers).queryByText(/AI_LOCAL_SERVERS and restart/)).toBeNull();
  });

  it('says so when saving fails for a reason of the server’s or the network’s', async () => {
    let answer: () => Promise<never> = () =>
      Promise.reject(
        problem(409, 'This provider is already connected here. Replace its key instead.'),
      );
    serve({ override: (operation) => (operation === 'connectAiProvider' ? answer() : undefined) });
    const user = open();
    const providers = await section('Providers');
    await user.click(await within(providers).findByRole('button', { name: 'Add Anthropic key' }));
    await user.type(within(providers).getByLabelText('Anthropic API key'), KEY);
    await user.click(within(providers).getByRole('button', { name: 'Save and test' }));
    expect(
      await within(providers).findByText(
        'This provider is already connected here. Replace its key instead.',
      ),
    ).toBeDefined();
    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    await user.click(within(providers).getByRole('button', { name: 'Save and test' }));
    expect(
      await within(providers).findByText("It wasn't saved. Check your connection and try again."),
    ).toBeDefined();
  });
});

describe('testing a connection', () => {
  const outcomes: readonly (readonly [AiTestOutcome, string, string])[] = [
    [
      'authentication',
      "The provider didn't accept this key.",
      "Check that the whole key was copied and that it hasn't been revoked, then replace it.",
    ],
    [
      'billing',
      "The provider says this account can't be charged: it has no credit, or a payment problem.",
      'Add credit or fix the payment with the provider, then test again.',
    ],
    [
      'not_found',
      'The provider has nothing by that name.',
      "Check the model's name: it must be exactly as the provider lists it. For your own server, also check the address.",
    ],
    [
      'blocked_address',
      "This install isn't allowed to call that address.",
      'An address must be a public https one, or a model server that whoever runs the install has listed in AI_LOCAL_SERVERS with the same host and port.',
    ],
    [
      'unavailable',
      "We couldn't reach the provider, or it was too busy to answer.",
      'Test again in a moment. For your own server, check that it is running and that this install can reach it.',
    ],
    [
      'limit_reached',
      "Not tested: this month's AI spending limit has been reached, so no call was made.",
      'Raise the limit, then test again.',
    ],
    [
      'expired',
      "The test wasn't run within two minutes.",
      'The part of this install that does background work may not be running. Ask whoever runs the install, then test again.',
    ],
  ];

  it.each(outcomes)('says what "%s" means and what to do about it', async (outcome, what, fix) => {
    serve({ connections: [connectionOf()], test: finished(outcome) });
    const user = open();
    const providers = await section('Providers');
    await user.click(await within(providers).findByRole('button', { name: 'Test Anthropic' }));
    const alert = await within(providers).findByRole('alert');
    expect(alert.textContent).toBe(`${what} ${fix}`);
    expect(callsTo('startAiConnectionTest')).toEqual([{ body: { connectionId: CONNECTION } }]);
  });

  it('shows what the connection remembers of its last test before anyone presses Test', async () => {
    serve({
      connections: [
        connectionOf({
          status: 'failing',
          lastTest: { outcome: 'authentication', at, latencyMs: 300 },
        }),
      ],
    });
    open();
    const providers = await section('Providers');
    expect(await within(providers).findByText('Not working')).toBeDefined();
    expect(within(providers).getByRole('alert').textContent).toContain(
      "The provider didn't accept this key.",
    );
  });

  it('says a call’s cost is unknown rather than nothing when its model has no price', async () => {
    serve({
      connections: [
        connectionOf({
          provider: 'openai_compatible',
          baseUrl: 'http://ollama:11434/v1',
          model: 'llama3.2',
          hasKey: false,
          keyLast4: null,
        }),
      ],
      test: finished('ok', { latencyMs: 2400, call: { id: CALL, costEstimate: null } }),
    });
    const user = open();
    const providers = await section('Providers');
    expect(await within(providers).findByText(/No key needed/)).toBeDefined();
    expect(within(providers).getByText('llama3.2 · http://ollama:11434/v1')).toBeDefined();
    await user.click(within(providers).getByRole('button', { name: 'Test Your own model server' }));
    expect(await within(providers).findByText(/answered in 2\.4 seconds/)).toBeDefined();
    expect(
      within(providers).getByText(/This test call's cost is unknown: the model has no price\./),
    ).toBeDefined();
  });

  it('says so when the test cannot start, or its result cannot be read', async () => {
    let fail: 'start' | 'read' | undefined = 'start';
    serve({
      connections: [connectionOf()],
      override: (operation) =>
        (operation === 'startAiConnectionTest' && fail === 'start') ||
        (operation === 'getAiConnectionTest' && fail === 'read')
          ? Promise.reject(new TypeError('Failed to fetch'))
          : undefined,
    });
    const user = open();
    const providers = await section('Providers');
    const test = await within(providers).findByRole('button', { name: 'Test Anthropic' });
    await user.click(test);
    expect(
      await within(providers).findByText(
        "The test couldn't start. Check your connection and try again.",
      ),
    ).toBeDefined();
    fail = undefined;
    await user.click(test);
    expect(await within(providers).findByText('Testing…')).toBeDefined();
    fail = 'read';
    expect(
      await within(providers).findByText("We couldn't read the test's result.", undefined, {
        timeout: 3000,
      }),
    ).toBeDefined();
  });

  it('lets a business test its agency’s connection, and change nothing of it', async () => {
    serve({
      connections: [
        connectionOf({
          owner: 'agency',
          canManage: false,
          keyLast4: null,
          addedBy: null,
          status: 'working',
        }),
      ],
      test: finished('ok', { latencyMs: 640, call: { id: CALL, costEstimate: '0.000100' } }),
    });
    const user = open();
    const providers = await section('Providers');
    const shared = await within(providers).findByRole('list', { name: 'Bluebird Digital’s keys' });
    expect(within(shared).getByText('Connected')).toBeDefined();
    expect(within(providers).queryByRole('button', { name: /Replace/ })).toBeNull();
    expect(within(providers).queryByRole('button', { name: /^Remove/ })).toBeNull();
    // The business's own Anthropic row still offers a key of its own.
    expect(within(providers).getByRole('button', { name: 'Add Anthropic key' })).toBeDefined();
    await user.click(
      within(shared).getByRole('button', { name: 'Test Bluebird Digital’s Anthropic' }),
    );
    expect(await within(shared).findByText(/answered in 0\.6 seconds/)).toBeDefined();
  });
});

describe('changing and removing a connection', () => {
  it('replaces a key without sending anything that did not change', async () => {
    serve({ connections: [connectionOf({ status: 'working' })] });
    const user = open();
    const providers = await section('Providers');
    await user.click(
      await within(providers).findByRole('button', { name: 'Replace Anthropic key' }),
    );
    // Nothing typed: there is nothing to save.
    await user.click(within(providers).getByRole('button', { name: 'Save and test' }));
    expect(
      await within(providers).findByText('Change the key, the address or the model first.'),
    ).toBeDefined();
    await user.type(within(providers).getByLabelText('New Anthropic API key'), KEY);
    await user.click(within(providers).getByRole('button', { name: 'Save and test' }));
    await waitFor(() => {
      expect(callsTo('updateAiConnection')).toEqual([
        { params: { id: CONNECTION }, body: { apiKey: KEY } },
      ]);
    });
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it('changes a server’s model, leaving its saved key and address as they are', async () => {
    serve({
      connections: [
        connectionOf({
          provider: 'openai_compatible',
          baseUrl: 'http://ollama:11434/v1',
          model: 'llama3.2',
        }),
      ],
    });
    const user = open();
    const providers = await section('Providers');
    await user.click(
      await within(providers).findByRole('button', { name: 'Change Your own model server' }),
    );
    expect(
      within(providers).getByText('Leave this empty to keep the key that is saved now.'),
    ).toBeDefined();
    const model = within(providers).getByLabelText('Model name');
    await user.clear(model);
    await user.type(model, 'qwen2.5:0.5b');
    await user.click(within(providers).getByRole('button', { name: 'Save and test' }));
    await waitFor(() => {
      expect(callsTo('updateAiConnection')).toEqual([
        { params: { id: CONNECTION }, body: { model: 'qwen2.5:0.5b' } },
      ]);
    });
  });

  it('removes a connection only after saying what that destroys', async () => {
    const world = serve({ connections: [connectionOf({ status: 'working' })] });
    const user = open();
    const providers = await section('Providers');
    await user.click(await within(providers).findByRole('button', { name: 'Remove Anthropic' }));
    expect(
      within(providers).getByText(
        'Remove Anthropic and destroy its key? Jobs that use its models will stop until you choose others.',
      ),
    ).toBeDefined();
    expect(callsTo('removeAiConnection')).toEqual([]);
    await user.click(within(providers).getByRole('button', { name: 'Cancel' }));
    expect(within(providers).queryByText(/destroy its key/)).toBeNull();

    await user.click(within(providers).getByRole('button', { name: 'Remove Anthropic' }));
    world.connections = [];
    await user.click(within(providers).getByRole('button', { name: 'Yes, remove Anthropic' }));
    await waitFor(() => {
      expect(callsTo('removeAiConnection')).toEqual([{ params: { id: CONNECTION } }]);
    });
    expect(
      await within(providers).findByRole('button', { name: 'Add Anthropic key' }),
    ).toBeDefined();
  });

  it('says so when a connection cannot be removed', async () => {
    serve({
      connections: [connectionOf()],
      override: (operation) =>
        operation === 'removeAiConnection'
          ? Promise.reject(new TypeError('Failed to fetch'))
          : undefined,
    });
    const user = open();
    const providers = await section('Providers');
    await user.click(await within(providers).findByRole('button', { name: 'Remove Anthropic' }));
    await user.click(within(providers).getByRole('button', { name: 'Yes, remove Anthropic' }));
    expect(
      await within(providers).findByText("It wasn't removed. Check your connection and try again."),
    ).toBeDefined();
  });
});

describe('a model for each job', () => {
  it('saves a choice with everything else as it was, at the revision the page was showing', async () => {
    const world = serve({ connections: [connectionOf({ status: 'working' })] });
    const user = open();
    const jobs = await section('Which model does each job');
    await user.click(within(jobs).getByRole('combobox', { name: 'Replies and messages' }));
    world.settings = settingsOf({
      revision: 'b'.repeat(64),
      jobs: settingsOf().jobs.map((job) =>
        job.job === 'replies' ? { ...job, model: 'claude-fable-5-1', isDefault: false } : job,
      ),
    });
    await user.click(await screen.findByRole('option', { name: 'Claude Fable 5.1' }));
    await waitFor(() => {
      expect(callsTo('updateAiSettings')).toEqual([
        {
          body: {
            enabled: true,
            keySource: 'own',
            monthlyLimit: null,
            atLimit: 'pause',
            maskContactDetails: false,
            requestLogDays: 30,
            backup: null,
            jobs: {
              automation_builder: null,
              replies: { provider: 'anthropic', model: 'claude-fable-5-1' },
              briefings: null,
              sorting: null,
            },
            revision: 'a'.repeat(64),
          },
        },
      ]);
    });
    expect(await screen.findByText('Saved.')).toBeDefined();
    expect(
      within(jobs).getByRole('combobox', { name: 'Replies and messages' }).textContent,
    ).toContain('Claude Fable 5.1');
  });

  it('shows Tested only for a model that passed, and what a job has cost this month', async () => {
    serve({
      settings: settingsOf({
        jobs: settingsOf().jobs.map((job) =>
          job.job === 'replies' ? { ...job, tested: true } : job,
        ),
      }),
      usage: usageOf({
        spent: '7.800000',
        calls: 300,
        byJob: [{ job: 'replies', spent: '7.800000', calls: 300, unknownCostCalls: 0 }],
      }),
    });
    open();
    const jobs = await section('Which model does each job');
    expect(await within(jobs).findByText('Tested · $7.80 this month')).toBeDefined();
    expect(within(jobs).getAllByText('Not tested yet')).toHaveLength(3);
  });

  it('sets a backup, warns when it shares the jobs’ provider, and takes it away again', async () => {
    const world = serve();
    const user = open();
    const jobs = await section('Which model does each job');
    expect(within(jobs).queryByText(/Your backup uses the same provider/)).toBeNull();
    await user.click(within(jobs).getByRole('combobox', { name: 'Backup model' }));
    world.settings = settingsOf({
      revision: 'b'.repeat(64),
      backup: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', readiness: 'ready' },
    });
    await user.click(await screen.findByRole('option', { name: 'Claude Haiku 4.5' }));
    await waitFor(() => {
      expect(callsTo('updateAiSettings')[0]).toMatchObject({
        body: { backup: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' } },
      });
    });
    expect(
      await within(jobs).findByText(
        'Your backup uses the same provider. Add a second provider so an outage at Anthropic can’t stop your automations.',
      ),
    ).toBeDefined();
    await user.click(within(jobs).getByRole('combobox', { name: 'Backup model' }));
    await user.click(await screen.findByRole('option', { name: 'No backup' }));
    await waitFor(() => {
      expect(callsTo('updateAiSettings')[1]).toMatchObject({
        body: { backup: null, revision: 'b'.repeat(64) },
      });
    });
  });

  it('says a model with no price is paused under a limit that pauses, and how to clear that', async () => {
    serve({
      settings: settingsOf({
        monthlyLimit: '50.0000',
        backup: { provider: 'openai_compatible', model: 'llama3.2', readiness: 'price_needed' },
      }),
    });
    open();
    const jobs = await section('Which model does each job');
    expect(
      within(jobs).getByText(
        `This is paused: the model has no price, so its cost can't be held to your limit. Ask Bluebird Digital to set its price in the agency's AI settings (it can be zero for a server of your own), or choose "Keep going" when the limit is reached.`,
      ),
    ).toBeDefined();
  });
});

describe('saving', () => {
  it('shows the latest settings and says so when someone else changed them first', async () => {
    let refuse = true;
    const world = serve({
      override: (operation) =>
        operation === 'updateAiSettings' && refuse
          ? Promise.reject(problem(409, 'These settings changed after you opened them.'))
          : undefined,
    });
    const user = open();
    const privacy = await section('Privacy');
    const mask = within(privacy).getByRole<HTMLInputElement>('checkbox', {
      name: 'Hide phone numbers and email addresses from AI',
    });
    // What someone else saved meanwhile.
    world.settings = settingsOf({ revision: 'c'.repeat(64), requestLogDays: 7 });
    await user.click(mask);
    expect(
      await screen.findByText(
        'Someone else changed these settings while you had them open. The latest are shown here: make your change again.',
      ),
    ).toBeDefined();
    expect(await within(await section('Privacy')).findByText(/kept for 7 days/)).toBeDefined();
    // The change again, from the revision now shown, goes through.
    refuse = false;
    await user.click(
      within(await section('Privacy')).getByRole('checkbox', {
        name: 'Hide phone numbers and email addresses from AI',
      }),
    );
    await waitFor(() => {
      expect(callsTo('updateAiSettings')[1]).toMatchObject({
        body: { maskContactDetails: true, requestLogDays: 7, revision: 'c'.repeat(64) },
      });
    });
    expect(screen.queryByText(/Someone else changed these settings/)).toBeNull();
  });

  it('says so when a change is not saved', async () => {
    serve({
      override: (operation) =>
        operation === 'updateAiSettings'
          ? Promise.reject(new TypeError('Failed to fetch'))
          : undefined,
    });
    const user = open();
    await user.click(await screen.findByRole('radio', { name: 'Keep going and tell me' }));
    expect(
      await screen.findByText("Your change wasn't saved. Check your connection and try again."),
    ).toBeDefined();
  });
});

describe('whose keys, the limit and privacy', () => {
  it('switches whose keys the business uses', async () => {
    const world = serve();
    const user = open();
    expect(
      await screen.findByText('The provider bills Harbor Lights Events directly.'),
    ).toBeDefined();
    world.settings = settingsOf({ keySource: 'agency', revision: 'b'.repeat(64) });
    await user.click(screen.getByRole('radio', { name: 'Bluebird Digital’s keys' }));
    await waitFor(() => {
      expect(callsTo('updateAiSettings')[0]).toMatchObject({ body: { keySource: 'agency' } });
    });
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLInputElement>('radio', { name: 'Bluebird Digital’s keys' }).checked,
      ).toBe(true);
    });
    // Choosing what is already chosen saves nothing.
    await user.click(screen.getByRole('radio', { name: 'Bluebird Digital’s keys' }));
    expect(callsTo('updateAiSettings')).toHaveLength(1);
  });

  it('sets, changes and removes the monthly limit, refusing what is not an amount', async () => {
    const world = serve();
    const user = open();
    const spending = await section('Spending');
    await user.click(within(spending).getByRole('button', { name: 'Change limit' }));
    const amount = within(spending).getByLabelText('Monthly limit in US dollars');
    await user.type(amount, 'fifty');
    await user.click(within(spending).getByRole('button', { name: 'Save limit' }));
    expect(
      await within(spending).findByText('Enter an amount in dollars, such as 50 or 12.50.'),
    ).toBeDefined();
    expect(callsTo('updateAiSettings')).toEqual([]);

    await user.clear(amount);
    await user.type(amount, ' 75 ');
    world.settings = settingsOf({ monthlyLimit: '75.0000', revision: 'b'.repeat(64) });
    world.usage = usageOf({ spent: '18.400000', limit: '75.0000', calls: 40 });
    await user.click(within(spending).getByRole('button', { name: 'Save limit' }));
    await waitFor(() => {
      expect(callsTo('updateAiSettings')[0]).toMatchObject({ body: { monthlyLimit: '75' } });
    });
    expect(await within(spending).findByText('of $75.00 this month')).toBeDefined();
    const bar = within(spending).getByRole('progressbar', { name: 'AI spending this month' });
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect(bar.getAttribute('aria-valuetext')).toBe('$18.40 of $75.00');
    // The form closed once the limit was saved.
    expect(within(spending).queryByLabelText('Monthly limit in US dollars')).toBeNull();

    await user.click(within(spending).getByRole('button', { name: 'Change limit' }));
    expect(
      within(spending).getByLabelText<HTMLInputElement>('Monthly limit in US dollars').value,
    ).toBe('75');
    await user.click(within(spending).getByRole('button', { name: 'Remove limit' }));
    await waitFor(() => {
      expect(callsTo('updateAiSettings')[1]).toMatchObject({
        body: { monthlyLimit: null, revision: 'b'.repeat(64) },
      });
    });
  });

  it('says when the limit is reached, what that does, and which calls are not in the total', async () => {
    serve({
      settings: settingsOf({ monthlyLimit: '50.0000', atLimit: 'pause' }),
      usage: usageOf({ spent: '50.250000', limit: '50.0000', calls: 900, unknownCostCalls: 3 }),
    });
    open();
    const spending = await section('Spending');
    expect(
      await within(spending).findByText(
        "This month's limit of $50.00 has been reached, so AI is paused. Raise the limit to carry on.",
      ),
    ).toBeDefined();
    expect(within(spending).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    expect(
      within(spending).getByText(
        "3 calls this month have no known cost and aren't in this total: their models have no price, or the server reported no usage.",
      ),
    ).toBeDefined();
  });

  it('says AI keeps going past the limit when that was chosen, and counts one unknown call as one', async () => {
    serve({
      settings: settingsOf({ monthlyLimit: '50.0000', atLimit: 'continue' }),
      usage: usageOf({ spent: '61.000000', limit: '50.0000', calls: 900, unknownCostCalls: 1 }),
    });
    open();
    const spending = await section('Spending');
    expect(
      await within(spending).findByText(
        "This month's limit of $50.00 has been reached. AI keeps going, as you chose.",
      ),
    ).toBeDefined();
    expect(
      within(spending).getByText(
        "1 call this month has no known cost and isn't in this total: its model has no price, or the server reported no usage.",
      ),
    ).toBeDefined();
    expect(
      within(spending).getByRole<HTMLInputElement>('radio', { name: 'Keep going and tell me' })
        .checked,
    ).toBe(true);
  });

  it('offers another try when the month’s spending cannot be loaded', async () => {
    let fail = true;
    serve({
      override: (operation) =>
        operation === 'getAiUsage' && fail
          ? Promise.reject(problem(503, 'Unavailable'))
          : undefined,
    });
    const user = open();
    const spending = await section('Spending');
    expect(
      await within(spending).findByText("We couldn't load this month's spending."),
    ).toBeDefined();
    fail = false;
    await user.click(within(spending).getByRole('button', { name: 'Try again' }));
    expect(await within(spending).findByText('$0.00')).toBeDefined();
  });

  it('turns masking and the request log on and off, and sets how long the log is kept', async () => {
    const world = serve();
    const user = open();
    const privacy = await section('Privacy');
    await user.click(
      within(privacy).getByRole('checkbox', {
        name: 'Hide phone numbers and email addresses from AI',
      }),
    );
    await waitFor(() => {
      expect(callsTo('updateAiSettings')[0]).toMatchObject({ body: { maskContactDetails: true } });
    });

    const days = within(privacy).getByLabelText('Days to keep the log');
    for (const wrong of ['0', '400', 'a week', '1.5']) {
      await user.clear(days);
      await user.type(days, wrong);
      await user.click(within(privacy).getByRole('button', { name: 'Save days' }));
      expect(
        await within(privacy).findByText('Enter a whole number of days from 1 to 365.'),
      ).toBeDefined();
    }
    expect(callsTo('updateAiSettings')).toHaveLength(1);
    await user.clear(days);
    await user.type(days, '7');
    await user.click(within(privacy).getByRole('button', { name: 'Save days' }));
    await waitFor(() => {
      expect(callsTo('updateAiSettings')[1]).toMatchObject({ body: { requestLogDays: 7 } });
    });

    // Keeping no log is the same setting at nothing.
    world.settings = settingsOf({ requestLogDays: 0, revision: 'b'.repeat(64) });
    await user.click(
      within(await section('Privacy')).getByRole('checkbox', { name: 'Keep a log of AI requests' }),
    );
    await waitFor(() => {
      expect(callsTo('updateAiSettings')[2]).toMatchObject({ body: { requestLogDays: 0 } });
    });
    const off = await section('Privacy');
    expect(
      await within(off).findByText(
        "Nothing of what is sent or answered is kept. Each call's cost still is.",
      ),
    ).toBeDefined();
    expect(within(off).queryByLabelText('Days to keep the log')).toBeNull();
    world.settings = settingsOf({ requestLogDays: 30, revision: 'c'.repeat(64) });
    await user.click(within(off).getByRole('checkbox', { name: 'Keep a log of AI requests' }));
    await waitFor(() => {
      expect(callsTo('updateAiSettings')[3]).toMatchObject({ body: { requestLogDays: 30 } });
    });
  });

  it('says a log of one day is kept for one day', async () => {
    serve({ settings: settingsOf({ requestLogDays: 1 }) });
    open();
    expect(
      await within(await section('Privacy')).findByText(
        'What was sent and answered is kept for 1 day, always with phone numbers and email addresses hidden, then cleared.',
      ),
    ).toBeDefined();
  });

  it('turns AI off for the business, says so at the top, and turns it back on', async () => {
    const world = serve();
    const user = open();
    const privacy = await section('Privacy');
    world.settings = settingsOf({ enabled: false, revision: 'b'.repeat(64) });
    await user.click(
      within(privacy).getByRole('button', { name: 'Turn off AI for this business' }),
    );
    await waitFor(() => {
      expect(callsTo('updateAiSettings')[0]).toMatchObject({ body: { enabled: false } });
    });
    expect(
      await screen.findByText(
        'AI is turned off for this business. Nothing is sent to any provider until you turn it back on under Privacy.',
      ),
    ).toBeDefined();
    world.settings = settingsOf({ enabled: true, revision: 'c'.repeat(64) });
    await user.click(
      within(await section('Privacy')).getByRole('button', { name: 'Turn AI back on' }),
    );
    await waitFor(() => {
      expect(callsTo('updateAiSettings')[1]).toMatchObject({ body: { enabled: true } });
    });
    await waitFor(() => {
      expect(screen.queryByText(/AI is turned off for this business/)).toBeNull();
    });
  });
});

describe('how much the assistant does on its own', () => {
  const heading = 'How much your assistant does on its own';
  /** Saves as the server does: the business's own rule, or the starting level without one. */
  const saving = (world: World) => (operation: string, input: unknown) => {
    if (operation !== 'setAutonomy') return undefined;
    const { level } = (input as { body: { level: AutonomySetting['level'] | null } }).body;
    world.autonomy = {
      ...world.autonomy,
      level: level ?? 'ask',
      source: level === null ? 'default' : 'business',
      businessLevel: level ?? 'ask',
    };
    return world.autonomy;
  };
  const pressed = (within_: HTMLElement): string[] =>
    within(within_)
      .getAllByRole('button')
      .map((each) => `${each.textContent}:${each.getAttribute('aria-pressed') ?? ''}`);

  it('shows the business’s level, and saves another the moment it is chosen', async () => {
    const world = serve();
    world.override = saving(world);
    const user = open();
    const card = await section(heading);
    const group = await within(card).findByRole('group', { name: heading });
    expect(pressed(group)).toEqual(['Suggest:false', 'Ask first:true', 'Act:false']);
    expect(within(card).getByText('Writes replies and asks you before sending.')).toBeDefined();
    expect(callsTo('getAutonomy')).toEqual([{ query: {} }]);
    // The whole business has no other setting to go back to.
    expect(within(card).queryByRole('button', { name: /^Use the business/ })).toBeNull();
    await user.dblClick(within(group).getByRole('button', { name: 'Suggest' }));
    expect(
      await within(card).findByText(
        'Saved. Your assistant writes drafts for you to send yourself.',
      ),
    ).toBeDefined();
    expect(callsTo('setAutonomy')).toEqual([
      { body: { agent: 'inbox', action: 'send_message', contactId: null, level: 'suggest' } },
    ]);
    expect(pressed(group)).toEqual(['Suggest:true', 'Ask first:false', 'Act:false']);
    // It is a rule of its own: the AI settings and their revision are not saved with it.
    expect(callsTo('updateAiSettings')).toEqual([]);
  });

  it('asks before letting the assistant act for every contact', async () => {
    const world = serve();
    world.override = saving(world);
    const user = open();
    const card = await section(heading);
    await user.click(await within(card).findByRole('button', { name: 'Act' }));
    const question = within(card).getByText(
      'Your assistant will send replies to contacts without asking, unless a contact has a setting of their own.',
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(question);
    });
    expect(callsTo('setAutonomy')).toEqual([]);
    await user.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(callsTo('setAutonomy')).toEqual([]);
    expect(within(card).queryByRole('button', { name: 'Let it act' })).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(within(card).getByRole('button', { name: 'Act' }));
    });
    await user.click(within(card).getByRole('button', { name: 'Act' }));
    await user.click(within(card).getByRole('button', { name: 'Let it act' }));
    expect(
      await within(card).findByText(
        'Saved. Your assistant replies on its own and tells you what it sent.',
      ),
    ).toBeDefined();
    expect(callsTo('setAutonomy')).toEqual([
      { body: { agent: 'inbox', action: 'send_message', contactId: null, level: 'act' } },
    ]);
    expect(within(card).getByText('Replies on its own and tells you what it sent.')).toBeDefined();
  });

  it('says the level as a sentence to someone who may not change it', async () => {
    serve({ canChangeAutonomy: false });
    open();
    const card = await section(heading);
    expect(
      await within(card).findByText('Your assistant asks before sending anything.'),
    ).toBeDefined();
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('says it could not be loaded, and loads on another try', async () => {
    let fail = true;
    serve({
      override: (operation) =>
        operation === 'getAutonomy' && fail
          ? Promise.reject(problem(503, 'Unavailable'))
          : undefined,
    });
    const user = open();
    const card = await section(heading);
    expect(await within(card).findByText("We couldn't load this setting.")).toBeDefined();
    expect(within(card).queryByRole('group')).toBeNull();
    fail = false;
    await user.click(within(card).getByRole('button', { name: 'Try again' }));
    expect(await within(card).findByRole('group', { name: heading })).toBeDefined();
  });

  it('says why a level was not saved, and keeps the one that applies', async () => {
    const world = serve();
    world.override = (operation) =>
      operation === 'setAutonomy' ? Promise.reject(problem(403, 'It needs ai.manage.')) : undefined;
    const user = open();
    const card = await section(heading);
    await user.click(await within(card).findByRole('button', { name: 'Suggest' }));
    expect(
      await within(card).findByText('Changing this needs a permission your role doesn’t have.'),
    ).toBeDefined();
    world.override = (operation) =>
      operation === 'setAutonomy' ? Promise.reject(new TypeError('Failed to fetch')) : undefined;
    await user.click(within(card).getByRole('button', { name: 'Suggest' }));
    expect(
      await within(card).findByText('That wasn’t saved. Check your connection and try again.'),
    ).toBeDefined();
    expect(pressed(within(card).getByRole('group', { name: heading }))).toEqual([
      'Suggest:false',
      'Ask first:true',
      'Act:false',
    ]);
  });
});

describe('recent calls', () => {
  it('lists each call with what happened, its cost or that it is unknown, and how long it took', async () => {
    const call = {
      id: CALL,
      startedAt: '2026-10-09T10:00:00.000Z',
      job: 'replies',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      keySource: 'own',
      status: 'ok',
      errorCode: null,
      costEstimate: '0.004200',
      latencyMs: 1840,
      inputTokens: 1200,
      outputTokens: 300,
    } as const;
    serve({
      usage: usageOf({
        calls: 6,
        recent: [
          call,
          {
            ...call,
            id: 'aireq_01k8e2wzr0e008000000000002',
            job: 'connection_test',
            provider: 'openai_compatible',
            model: 'llama3.2',
            costEstimate: null,
            latencyMs: 640,
          },
          {
            ...call,
            id: 'aireq_01k8e2wzr0e008000000000003',
            status: 'error',
            errorCode: 'authentication',
            costEstimate: null,
            latencyMs: 300,
          },
          {
            ...call,
            id: 'aireq_01k8e2wzr0e008000000000004',
            status: 'fell_back',
            errorCode: 'unavailable',
            costEstimate: null,
          },
          {
            ...call,
            id: 'aireq_01k8e2wzr0e008000000000005',
            job: 'a_job_from_a_newer_server',
            status: 'refused',
            costEstimate: '0.000042',
          },
          {
            ...call,
            id: 'aireq_01k8e2wzr0e008000000000006',
            status: 'started',
            costEstimate: null,
            latencyMs: null,
          },
          {
            ...call,
            id: 'aireq_01k8e2wzr0e008000000000007',
            status: 'error',
            errorCode: 'a_reason_from_a_newer_server',
            costEstimate: null,
            latencyMs: null,
          },
        ],
      }),
    });
    open();
    const calls = await section('Recent calls');
    const rows = await within(calls).findAllByRole('listitem');
    expect(rows.map((row) => row.textContent.replace(/\s+/g, ' '))).toEqual([
      expect.stringMatching(
        /^Replies and messages.*Claude Sonnet 5\.5AnsweredCost \$0\.00421\.8 seconds$/,
      ),
      expect.stringMatching(/^Connection test.*llama3\.2AnsweredCost unknown0\.6 seconds$/),
      expect.stringMatching(
        /Claude Sonnet 5\.5The provider didn't accept this key\.Cost unknown0\.3 seconds$/,
      ),
      expect.stringMatching(
        /We couldn't reach the provider, or it was too busy to answer\. The backup model took over\.Cost unknown/,
      ),
      expect.stringMatching(/^a_job_from_a_newer_server.*The model declinedCost <\$0\.0001/),
      expect.stringMatching(/Claude Sonnet 5\.5In progress$/),
      expect.stringMatching(/It failed\.Cost unknown$/),
    ]);
  });
});

describe('at the agency', () => {
  const shipped: AiModelPrice = {
    shipped: true,
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    inputPerMtok: '2.000000',
    outputPerMtok: '10.000000',
    cacheReadPerMtok: '0.100000',
    cacheWritePerMtok: '2.500000',
    cacheWrite1hPerMtok: '4.000000',
    source: 'https://platform.claude.com/docs/en/about-claude/pricing',
    checkedOn: '2026-10-10',
  };
  const own: AiModelPrice = {
    shipped: false,
    provider: 'openai_compatible',
    model: 'llama3.2',
    inputPerMtok: '0.000000',
    outputPerMtok: '0.000000',
    cacheReadPerMtok: '0.000000',
    cacheWritePerMtok: '0.000000',
    cacheWrite1hPerMtok: null,
    source: 'Runs on our own server',
    checkedOn: '2026-10-09',
  };

  it('says who may manage AI settings to someone whose role does not', async () => {
    serve({ override: () => Promise.reject(problem(403, 'It needs ai.manage.')) });
    open(<AgencyAiSettingsPage />);
    expect(await screen.findByText('You need permission to manage AI settings.')).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Providers' })).toBeNull();
  });

  it('offers another try when the page cannot be loaded', async () => {
    let fail = true;
    serve({
      override: (operation) =>
        operation === 'listAiModelPrices' && fail
          ? Promise.reject(problem(503, 'Unavailable'))
          : undefined,
    });
    const user = open(<AgencyAiSettingsPage />);
    expect(await screen.findByText("We couldn't load the AI settings.")).toBeDefined();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Model prices' })).toBeDefined();
  });

  it('tests a key by asking the provider about it, and says no model was called', async () => {
    serve({
      connections: [connectionOf({ owner: 'agency' })],
      test: finished('ok', { kind: 'key_check', latencyMs: 410 }),
    });
    const user = open(<AgencyAiSettingsPage />);
    expect(
      await screen.findByText(
        'Keys added here serve every business that chooses to use Bluebird Digital’s keys. Each business picks its models, its spending limit and its privacy settings in its own Settings.',
      ),
    ).toBeDefined();
    const providers = await section('Providers');
    await user.click(await within(providers).findByRole('button', { name: 'Test Anthropic' }));
    const result = await within(providers).findByText(/answered in 0\.4 seconds/);
    expect(result.textContent).toContain(
      'The provider accepted the key. No model was called, so this cost nothing',
    );
    // No settings of a business are asked for at the agency.
    expect(callsTo('getAiSettings')).toEqual([]);
    expect(callsTo('getAiUsage')).toEqual([]);
  });

  it('lists the shipped prices and the agency’s own, and removes only its own', async () => {
    const world = serve({ prices: [own, shipped] });
    const user = open(<AgencyAiSettingsPage />);
    const prices = await section('Model prices');
    expect(
      within(prices).getByText('Input $0.00 · output $0.00 for a million tokens'),
    ).toBeDefined();
    expect(
      within(prices).getByText('Set by your agency: Runs on our own server, on 2026-10-09'),
    ).toBeDefined();
    expect(
      within(prices).getByText(
        'Cache reads $0.00 · cache writes $0.00 for 5 minutes, no 1-hour price',
      ),
    ).toBeDefined();
    expect(
      within(prices).getByText('Input $2.00 · output $10.00 for a million tokens'),
    ).toBeDefined();
    expect(
      within(prices).getByText(
        'Cache reads $0.10 · cache writes $2.50 for 5 minutes, $4.00 for 1 hour',
      ),
    ).toBeDefined();
    expect(
      within(prices).getByText(
        'Shipped with this version, from https://platform.claude.com/docs/en/about-claude/pricing, checked on 2026-10-10',
      ),
    ).toBeDefined();
    expect(
      within(prices).queryByRole('button', { name: 'Remove the price of Claude Sonnet 5.5' }),
    ).toBeNull();
    world.prices = [shipped];
    await user.click(within(prices).getByRole('button', { name: 'Remove the price of llama3.2' }));
    await waitFor(() => {
      expect(callsTo('removeAiModelPrice')).toEqual([
        { query: { provider: 'openai_compatible', model: 'llama3.2' } },
      ]);
    });
    await waitFor(() => {
      expect(within(prices).queryByText(/Runs on our own server/)).toBeNull();
    });
  });

  it('adds a price, which may be zero, after checking it with the API’s own rules', async () => {
    serve({ prices: [shipped] });
    const user = open(<AgencyAiSettingsPage />);
    const prices = await section('Model prices');
    await user.click(within(prices).getByRole('button', { name: 'Add a price' }));
    const form = within(prices).getByRole('form', { name: 'Add a price' });
    await user.type(within(form).getByLabelText('Model name'), 'llama3.2');
    await user.type(
      within(form).getByLabelText('Input, in US dollars for a million tokens'),
      'free',
    );
    await user.type(within(form).getByLabelText('Output, in US dollars for a million tokens'), '0');
    await user.type(
      within(form).getByLabelText('Where this price comes from'),
      'Runs on our own server',
    );
    await user.click(within(form).getByRole('button', { name: 'Save price' }));
    expect(
      await within(form).findByText(
        'Enter a price in dollars for a million tokens, such as 3 or 0.25. Zero is allowed.',
      ),
    ).toBeDefined();
    expect(callsTo('setAiModelPrice')).toEqual([]);
    const input = within(form).getByLabelText('Input, in US dollars for a million tokens');
    await user.clear(input);
    await user.type(input, '0');
    await user.click(within(form).getByRole('button', { name: 'Save price' }));
    await waitFor(() => {
      expect(callsTo('setAiModelPrice')).toEqual([
        {
          body: {
            provider: 'openai_compatible',
            model: 'llama3.2',
            inputPerMtok: '0',
            outputPerMtok: '0',
            source: 'Runs on our own server',
          },
        },
      ]);
    });
    await waitFor(() => {
      expect(within(prices).queryByRole('form', { name: 'Add a price' })).toBeNull();
    });
  });

  it('changes a shipped price for the same model, and says so when it cannot be saved', async () => {
    serve({
      prices: [shipped],
      override: (operation) =>
        operation === 'setAiModelPrice'
          ? Promise.reject(new TypeError('Failed to fetch'))
          : undefined,
    });
    const user = open(<AgencyAiSettingsPage />);
    const prices = await section('Model prices');
    await user.click(
      within(prices).getByRole('button', { name: 'Change the price of Claude Sonnet 5.5' }),
    );
    const form = within(prices).getByRole('form', { name: 'Change a price' });
    // The model is the one being changed; its shipped source is not carried over as ours.
    expect(within(form).getByLabelText<HTMLInputElement>('Model name').value).toBe(
      'claude-sonnet-5-5',
    );
    expect(within(form).getByLabelText<HTMLInputElement>('Model name').readOnly).toBe(true);
    expect(
      within(form).getByLabelText<HTMLInputElement>('Input, in US dollars for a million tokens')
        .value,
    ).toBe('2');
    // Its cache prices are kept, so changing the input price does not price cache as input.
    expect(
      within(form).getByLabelText<HTMLInputElement>(
        'Cache writes for 1 hour, in US dollars for a million tokens',
      ).value,
    ).toBe('4');
    expect(within(form).getByLabelText<HTMLInputElement>('Where this price comes from').value).toBe(
      '',
    );
    await user.type(within(form).getByLabelText('Where this price comes from'), 'Our rate');
    await user.click(within(form).getByRole('button', { name: 'Save price' }));
    expect(
      await within(form).findByText("The price wasn't saved. Check your connection and try again."),
    ).toBeDefined();
    expect(callsTo('setAiModelPrice')).toEqual([
      {
        body: {
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          inputPerMtok: '2',
          outputPerMtok: '10',
          cacheReadPerMtok: '0.10',
          cacheWritePerMtok: '2.50',
          cacheWrite1hPerMtok: '4',
          source: 'Our rate',
        },
      },
    ]);
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(within(prices).queryByRole('form')).toBeNull();
  });
});
