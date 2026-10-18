// Settings → AI models, against a stand-in for the API that keeps a business's connections,
// settings and calls in memory and checks every write against the contract. The whole
// product, with a real server and a stand-in provider, is in e2e/tests/ai-models.spec.ts at
// the repository's root.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import {
  connectAiProviderInput,
  setAiModelPriceInput,
  setAutonomyInput,
  startAiConnectionTestInput,
  updateAiConnectionInput,
  updateAiSettingsInput,
  type AiConnection,
  type AiConnectionTest,
  type AiModelPrice,
  type AiSettings,
  type AiTestOutcome,
  type AiUsage,
  type AutonomyLevel,
  type AutonomySetting,
  type ConnectAiProviderInput,
} from '@repo/contracts';
import { agencyStaff, dana, harbor, inHarbor, signedIn } from './session';
import { choose, expectChoice } from './select';

// Made up for this file: no provider issued it.
const KEY = 'sk-ant-fixture-0000000000000000a1f3';
const at = '2026-10-09T09:00:00.000Z';
const id = (prefix: string, number: number): string =>
  `${prefix}_01k8e2wzr0e0080000000000${String(number).padStart(2, '0')}`;

const CLAUDE = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5-20251001',
] as const;
const DEFAULTS = {
  automation_builder: 'claude-opus-5-5',
  replies: 'claude-sonnet-5-5',
  briefings: 'claude-opus-5-5',
  sorting: 'claude-haiku-4-5-20251001',
} as const;

interface World {
  /** Whose API this is: one business's, or the agency's own. */
  readonly place: 'business' | 'agency';
  connections: AiConnection[];
  tests: AiConnectionTest[];
  /** What the next test of a connection finds. */
  outcome: AiTestOutcome;
  stored: Omit<AiSettings, 'jobs' | 'models' | 'backup' | 'revision' | 'limitReachedAt'>;
  backup: { provider: string; model: string } | null;
  chosen: Partial<Record<keyof typeof DEFAULTS, { provider: string; model: string }>>;
  revision: number;
  calls: AiUsage['recent'];
  prices: AiModelPrice[];
  /** Every key a request carried, to prove where the page sent it. */
  readonly keysSent: string[];
  readonly settingsSaves: unknown[];
  /** The business's own level for replies in the Inbox; null until someone sets one. */
  autonomy: AutonomyLevel | null;
  readonly autonomySaves: unknown[];
}

const newWorld = (place: World['place'] = 'business'): World => ({
  place,
  connections: [],
  tests: [],
  outcome: 'ok',
  stored: {
    enabled: true,
    keySource: 'own',
    monthlyLimit: null,
    atLimit: 'pause',
    maskContactDetails: false,
    requestLogDays: 30,
  },
  backup: null,
  chosen: {},
  revision: 1,
  calls: [],
  prices: [],
  keysSent: [],
  settingsSaves: [],
  autonomy: null,
  autonomySaves: [],
});

const revisionOf = (world: World): string => String(world.revision).padStart(64, '0');

function settingsOf(world: World): AiSettings {
  const usable = world.connections.filter(
    (each) => each.owner === (world.stored.keySource === 'own' ? 'business' : 'agency'),
  );
  const connected = new Set<string>(usable.map((each) => each.provider));
  const priced = (provider: string, model: string): boolean =>
    provider === 'anthropic' ||
    world.prices.some((each) => each.provider === provider && each.model === model);
  const readiness = (provider: string, model: string) =>
    !connected.has(provider)
      ? ('no_key' as const)
      : world.stored.monthlyLimit !== null &&
          world.stored.atLimit === 'pause' &&
          !priced(provider, model)
        ? ('price_needed' as const)
        : ('ready' as const);
  return {
    ...world.stored,
    backup:
      world.backup === null
        ? null
        : { ...world.backup, readiness: readiness(world.backup.provider, world.backup.model) },
    jobs: (Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]).map((job) => {
      const choice = world.chosen[job] ?? { provider: 'anthropic', model: DEFAULTS[job] };
      return {
        job,
        ...choice,
        isDefault: world.chosen[job] === undefined,
        tested: false,
        readiness: readiness(choice.provider, choice.model),
      };
    }),
    models: usable.flatMap((each): AiSettings['models'] =>
      each.provider === 'anthropic'
        ? CLAUDE.map((model) => ({ provider: each.provider, model, priced: true }))
        : each.model === null
          ? []
          : [
              {
                provider: each.provider,
                model: each.model,
                priced: priced(each.provider, each.model),
              },
            ],
    ),
    limitReachedAt: null,
    revision: revisionOf(world),
  };
}

function usageOf(world: World): AiUsage {
  const known = world.calls.filter((call) => call.costEstimate !== null);
  const spent = known.reduce((total, call) => total + Number(call.costEstimate), 0);
  return {
    month: '2026-10',
    spent: spent.toFixed(6),
    calls: world.calls.length,
    unknownCostCalls: world.calls.length - known.length,
    limit: world.stored.monthlyLimit,
    byJob:
      world.calls.length === 0
        ? []
        : [
            {
              job: 'connection_test',
              spent: spent.toFixed(6),
              calls: world.calls.length,
              unknownCostCalls: world.calls.length - known.length,
            },
          ],
    recent: world.calls,
  };
}

function connectionOf(world: World, input: ConnectAiProviderInput): AiConnection {
  const apiKey = 'apiKey' in input ? input.apiKey : undefined;
  return {
    id: id('aic', world.connections.length + 1),
    provider: input.provider,
    owner: world.place,
    canManage: true,
    hasKey: apiKey !== undefined,
    keyLast4: apiKey === undefined ? null : apiKey.slice(-4),
    baseUrl: input.provider === 'openai_compatible' ? input.baseUrl : null,
    model: 'model' in input ? input.model : null,
    status: 'untested',
    lastTest: null,
    addedBy: dana.name,
    createdAt: at,
  };
}

/** Queues a test, which is finished the first time it is read back. */
function startTest(world: World, connectionId: string): AiConnectionTest {
  const test: AiConnectionTest = {
    id: id('aict', world.tests.length + 1),
    connectionId,
    kind: world.place === 'business' ? 'model_call' : 'key_check',
    status: 'pending',
    outcome: null,
    latencyMs: null,
    call: null,
    createdAt: at,
    finishedAt: null,
  };
  world.tests.push(test);
  return test;
}

function finish(world: World, test: AiConnectionTest): AiConnectionTest {
  if (test.status === 'finished') return test;
  const connection = world.connections.find((each) => each.id === test.connectionId);
  const reached = !['limit_reached', 'price_unknown', 'ai_off', 'expired'].includes(world.outcome);
  let call: AiConnectionTest['call'] = null;
  if (world.place === 'business' && reached && connection !== undefined) {
    const cost = connection.provider === 'anthropic' ? '0.000100' : null;
    call = { id: id('aireq', world.calls.length + 1), costEstimate: cost };
    world.calls.unshift({
      id: call.id,
      startedAt: at,
      job: 'connection_test',
      provider: connection.provider,
      model: connection.model ?? 'claude-haiku-4-5-20251001',
      keySource: connection.owner === 'agency' ? 'agency' : 'own',
      status: world.outcome === 'ok' ? 'ok' : 'error',
      errorCode: world.outcome === 'ok' ? null : world.outcome,
      costEstimate: world.outcome === 'ok' ? cost : null,
      latencyMs: 812,
      inputTokens: 25,
      outputTokens: 15,
    });
  }
  const done: AiConnectionTest = {
    ...test,
    status: 'finished',
    outcome: world.outcome,
    latencyMs: reached ? 812 : null,
    call: world.outcome === 'ok' ? call : null,
    finishedAt: at,
  };
  world.tests = world.tests.map((each) => (each.id === test.id ? done : each));
  if (reached)
    world.connections = world.connections.map((each) =>
      each.id === test.connectionId
        ? {
            ...each,
            status: world.outcome === 'ok' ? 'working' : 'failing',
            lastTest: { outcome: world.outcome, at, latencyMs: 812 },
          }
        : each,
    );
  return done;
}

const refuse = (route: Route, status: number, detail: string, errors?: unknown[]): Promise<void> =>
  route.fulfill({
    status,
    contentType: 'application/problem+json',
    json: { type: 'about:blank', title: 'Problem', status, detail, ...(errors ? { errors } : {}) },
  });

/** Stands in for the AI settings API. Every write is parsed with the contract's own schema. */
async function aiApi(page: Page, world: World): Promise<void> {
  const here = (route: Route): void => {
    // A business's page names the business; the agency's names none.
    expect(route.request().headers()['business-id']).toBe(
      world.place === 'business' ? harbor.id : undefined,
    );
  };
  await page.route(/\/api\/v1\/ai\/connections(?:\/[^/?]+)?$/, async (route) => {
    here(route);
    const request = route.request();
    const connectionId = new URL(request.url()).pathname.split('/ai/connections/')[1];
    if (request.method() === 'GET') {
      await route.fulfill({ json: { data: world.connections } });
      return;
    }
    if (request.method() === 'DELETE') {
      world.connections = world.connections.filter((each) => each.id !== connectionId);
      await route.fulfill({ status: 204 });
      return;
    }
    if (request.method() === 'POST') {
      const input = connectAiProviderInput.parse(request.postDataJSON());
      if ('apiKey' in input && input.apiKey !== undefined) world.keysSent.push(input.apiKey);
      if (input.provider === 'openai_compatible' && input.baseUrl.startsWith('http://192.')) {
        await refuse(route, 422, 'Refused.', [
          {
            path: '/baseUrl',
            code: 'address_not_https',
            message: "The server's own sentence, which the page does not show.",
          },
        ]);
        return;
      }
      const connection = connectionOf(world, input);
      world.connections.push(connection);
      await route.fulfill({
        status: 201,
        json: { connection, test: startTest(world, connection.id) },
      });
      return;
    }
    const changes = updateAiConnectionInput.parse(request.postDataJSON());
    if (typeof changes.apiKey === 'string') world.keysSent.push(changes.apiKey);
    world.connections = world.connections.map((each) =>
      each.id === connectionId
        ? {
            ...each,
            ...(typeof changes.apiKey === 'string' ? { keyLast4: changes.apiKey.slice(-4) } : {}),
            ...(changes.model === undefined ? {} : { model: changes.model }),
            status: 'untested',
            lastTest: null,
          }
        : each,
    );
    const connection = world.connections.find((each) => each.id === connectionId);
    await route.fulfill({
      json: { connection, test: startTest(world, connectionId ?? '') },
    });
  });
  await page.route(/\/api\/v1\/ai\/connection-tests(?:\/[^/?]+)?$/, async (route) => {
    here(route);
    const request = route.request();
    if (request.method() === 'POST') {
      const { connectionId } = startAiConnectionTestInput.parse(request.postDataJSON());
      await route.fulfill({ status: 201, json: startTest(world, connectionId) });
      return;
    }
    const testId = new URL(request.url()).pathname.split('/ai/connection-tests/')[1];
    const test = world.tests.find((each) => each.id === testId);
    if (test === undefined) await refuse(route, 404, 'No such test.');
    else await route.fulfill({ json: finish(world, test) });
  });
  await page.route('**/api/v1/ai/settings', async (route) => {
    here(route);
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({ json: settingsOf(world) });
      return;
    }
    const input = updateAiSettingsInput.parse(request.postDataJSON());
    world.settingsSaves.push(input);
    if (input.revision !== revisionOf(world)) {
      await refuse(route, 409, 'These settings changed after you opened them.');
      return;
    }
    const { revision: _revision, jobs, backup, ...stored } = input;
    world.stored = {
      ...stored,
      monthlyLimit: stored.monthlyLimit === null ? null : Number(stored.monthlyLimit).toFixed(4),
    };
    world.backup = backup;
    world.chosen = Object.fromEntries(Object.entries(jobs).filter(([, choice]) => choice !== null));
    world.revision += 1;
    await route.fulfill({ json: settingsOf(world) });
  });
  await page.route(/\/api\/v1\/ai\/autonomy(?:\?.*)?$/, async (route) => {
    here(route);
    const request = route.request();
    const replies = (): AutonomySetting => ({
      agent: 'inbox',
      action: 'send_message',
      level: world.autonomy ?? 'ask',
      source: world.autonomy === null ? 'default' : 'business',
      businessLevel: world.autonomy ?? 'ask',
    });
    if (request.method() === 'GET') {
      await route.fulfill({ json: { canChange: true, items: [replies()] } });
      return;
    }
    const input = setAutonomyInput.parse(request.postDataJSON());
    world.autonomySaves.push(input);
    world.autonomy = input.level;
    await route.fulfill({ json: replies() });
  });
  await page.route('**/api/v1/ai/usage', async (route) => {
    here(route);
    await route.fulfill({ json: usageOf(world) });
  });
  await page.route(/\/api\/v1\/ai\/model-prices(?:\?.*)?$/, async (route) => {
    here(route);
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({ json: { data: world.prices, canManage: world.place === 'agency' } });
      return;
    }
    if (request.method() === 'DELETE') {
      const query = new URL(request.url()).searchParams;
      world.prices = world.prices.filter(
        (each) => !(each.provider === query.get('provider') && each.model === query.get('model')),
      );
      await route.fulfill({ status: 204 });
      return;
    }
    const input = setAiModelPriceInput.parse(request.postDataJSON());
    const price: AiModelPrice = {
      shipped: false,
      provider: input.provider,
      model: input.model,
      inputPerMtok: Number(input.inputPerMtok).toFixed(6),
      outputPerMtok: Number(input.outputPerMtok).toFixed(6),
      cacheReadPerMtok: Number(input.cacheReadPerMtok ?? input.inputPerMtok).toFixed(6),
      cacheWritePerMtok: Number(input.cacheWritePerMtok ?? input.inputPerMtok).toFixed(6),
      cacheWrite1hPerMtok:
        input.cacheWrite1hPerMtok === undefined
          ? null
          : Number(input.cacheWrite1hPerMtok).toFixed(6),
      source: input.source,
      checkedOn: '2026-10-10',
    };
    world.prices = [
      price,
      ...world.prices.filter(
        (each) => !(each.provider === price.provider && each.model === price.model),
      ),
    ];
    await route.fulfill({ json: price });
  });
}

/** No serious or critical accessibility violation, and nothing wider than the screen. */
async function fitsAndIsAccessible(page: Page, width: number): Promise<void> {
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
}

const providers = (page: Page) => page.getByRole('region', { name: 'Providers' });
const region = (page: Page, name: string) => page.getByRole('region', { name });

for (const width of [360, 1280]) {
  test(`connects Claude, tests it, sees the call with its cost, and picks a model for a job at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    const world = newWorld();
    await aiApi(page, world);
    await page.goto(inHarbor('/settings/ai-models'));
    await expect(page.getByRole('heading', { name: 'AI Models', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    // Configuration lives in Settings: its list of pages has it, the modules' list does not.
    // On a phone the sidebar is behind the menu button.
    if (width < 1024) await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(
      page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'AI Models' }),
    ).toHaveAttribute('data-status', 'active');
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'AI Models' }),
    ).toHaveCount(0);
    if (width < 1024) await page.keyboard.press('Escape');

    // Nothing is connected: every job says what is in its way.
    await expect(page.getByText(/This can't run yet: the keys this business uses/)).toHaveCount(4);
    await fitsAndIsAccessible(page, width);

    await providers(page).getByRole('button', { name: 'Add Anthropic key' }).click();
    const key = providers(page).getByLabel('Anthropic API key');
    await expect(key).toHaveAttribute('type', 'password');
    await key.fill(KEY);
    await fitsAndIsAccessible(page, width);
    await providers(page).getByRole('button', { name: 'Save and test' }).click();

    await expect(providers(page).getByText(/Working · answered in 0\.8 seconds/)).toBeVisible();
    await expect(providers(page).getByText(/This test call cost \$0\.0001\./)).toBeVisible();
    await expect(providers(page).getByText('Connected', { exact: true })).toBeVisible();
    await expect(
      providers(page).getByText('Key ending a1f3 · added by Dana Brooks on October 9'),
    ).toBeVisible();
    // The key went to the API once, and is nowhere in the page.
    expect(world.keysSent).toEqual([KEY]);
    expect(await page.content()).not.toContain(KEY);
    await expect(providers(page).getByLabel('Anthropic API key')).toHaveCount(0);

    // The call the test made is on record, with its cost, and the month's spend has it.
    const calls = region(page, 'Recent calls');
    await expect(calls.getByRole('listitem')).toHaveCount(1);
    await expect(calls.getByRole('listitem')).toContainText('Connection test');
    await expect(calls.getByRole('listitem')).toContainText('Claude Haiku 4.5');
    await expect(calls.getByRole('listitem')).toContainText('Cost $0.0001');
    await expect(calls.getByRole('listitem')).toContainText('0.8 seconds');
    await expect(region(page, 'Spending').getByText('$0.0001', { exact: true })).toBeVisible();

    // With a key, the jobs can run, and a model can be chosen for one.
    await expect(page.getByText(/This can't run yet/)).toHaveCount(0);
    const replies = page.getByRole('combobox', { name: 'Replies and messages' });
    await expectChoice(replies, 'anthropic/claude-sonnet-5-5');
    await choose(replies, 'anthropic/claude-fable-5-1');
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    await expectChoice(replies, 'anthropic/claude-fable-5-1');
    expect(world.chosen).toEqual({
      replies: { provider: 'anthropic', model: 'claude-fable-5-1' },
    });

    await fitsAndIsAccessible(page, width);
    await page.screenshot({ path: testInfo.outputPath('ai-models.png'), fullPage: true });
  });
}

test('works by keyboard alone: a model server, the limit, privacy and a removal', async ({
  page,
}) => {
  await signedIn(page);
  const world = newWorld();
  await aiApi(page, world);
  await page.goto(inHarbor('/settings/ai-models'));
  const add = providers(page).getByRole('button', { name: 'Add server' });
  await add.focus();
  await expect(add).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(add).toHaveAttribute('aria-expanded', 'true');
  // The form's fields follow the button in the order they are read.
  await page.keyboard.press('Tab');
  await expect(providers(page).getByLabel('Server address')).toBeFocused();
  await page.keyboard.type('http://ollama:11434/v1');
  await page.keyboard.press('Tab');
  await expect(providers(page).getByLabel('Model name')).toBeFocused();
  await page.keyboard.type('llama3.2');
  await page.keyboard.press('Enter');
  await expect(providers(page).getByText(/Working · answered in 0\.8 seconds/)).toBeVisible();
  // A model nobody priced: the test call's cost is unknown, and is said to be.
  await expect(
    providers(page).getByText(/This test call's cost is unknown: the model has no price\./),
  ).toBeVisible();
  expect(world.connections).toMatchObject([
    { provider: 'openai_compatible', baseUrl: 'http://ollama:11434/v1', model: 'llama3.2' },
  ]);
  expect(world.keysSent).toEqual([]);

  // The limit: open, type, Enter.
  const spending = region(page, 'Spending');
  await spending.getByRole('button', { name: 'Change limit' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(spending.getByLabel('Monthly limit in US dollars')).toBeFocused();
  await page.keyboard.type('50');
  await page.keyboard.press('Enter');
  await expect(spending.getByText('of $50.00 this month')).toBeVisible();
  expect(world.stored.monthlyLimit).toBe('50.0000');

  // What happens at the limit: the arrow keys move between the two choices.
  await spending.getByRole('radio', { name: 'Pause AI and tell me' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(spending.getByRole('radio', { name: 'Keep going and tell me' })).toBeChecked();
  await expect.poll(() => world.stored.atLimit).toBe('continue');

  // Privacy: Space ticks a box.
  const privacy = region(page, 'Privacy');
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await privacy
    .getByRole('checkbox', { name: 'Hide phone numbers and email addresses from AI' })
    .focus();
  await page.keyboard.press('Space');
  await expect.poll(() => world.stored.maskContactDetails).toBe(true);

  // Removing asks first, and Enter on the answer removes.
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await providers(page).getByRole('button', { name: 'Remove Your own model server' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    providers(page).getByText(
      'Remove Your own model server? Jobs that use its models will stop until you choose others.',
    ),
  ).toBeVisible();
  await providers(page).getByRole('button', { name: 'Yes, remove Your own model server' }).focus();
  await page.keyboard.press('Enter');
  await expect(providers(page).getByRole('button', { name: 'Add server' })).toBeVisible();
  expect(world.connections).toEqual([]);
});

for (const width of [360, 1280]) {
  test(`says why an address was refused and what the operator must list, without the server's words, at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    const world = newWorld();
    await aiApi(page, world);
    await page.goto(inHarbor('/settings/ai-models'));
    await providers(page).getByRole('button', { name: 'Add server' }).click();
    await providers(page).getByLabel('Server address').fill('http://192.168.1.20:8080/v1');
    await providers(page).getByLabel('Model name').fill('llama3.2');
    await providers(page).getByLabel('API key (if the server needs one)').fill('local-key-0000');
    await providers(page).getByRole('button', { name: 'Save and test' }).click();
    await expect(
      providers(page).getByText(
        "This install can't call that address. It calls addresses that start with https://, and model servers that whoever runs the install has listed.",
      ),
    ).toBeVisible();
    await expect(
      providers(page).getByText(
        'For a model server on your own network, ask whoever runs this install to add 192.168.1.20:8080 to the setting AI_LOCAL_SERVERS and restart. Then save this address again, with the same host and port.',
      ),
    ).toBeVisible();
    await expect(page.getByText("The server's own sentence")).toHaveCount(0);
    // What was typed is kept to correct, and nothing was saved.
    await expect(providers(page).getByLabel('Server address')).toHaveValue(
      'http://192.168.1.20:8080/v1',
    );
    expect(world.connections).toEqual([]);
    await fitsAndIsAccessible(page, width);
  });
}

test('says what each failed test means, and keeps the last result beside the connection', async ({
  page,
}) => {
  await signedIn(page);
  const world = newWorld();
  await aiApi(page, world);
  await page.goto(inHarbor('/settings/ai-models'));
  await providers(page).getByRole('button', { name: 'Add Anthropic key' }).click();
  await providers(page).getByLabel('Anthropic API key').fill(KEY);
  world.outcome = 'authentication';
  await providers(page).getByRole('button', { name: 'Save and test' }).click();
  const result = providers(page).getByRole('alert');
  await expect(result).toHaveText(
    "The provider didn't accept this key. Check that the whole key was copied and that it hasn't been revoked, then replace it.",
  );
  await expect(providers(page).getByText('Not working', { exact: true })).toBeVisible();
  // The failed call is on record too, at a cost nobody was charged.
  await expect(region(page, 'Recent calls').getByRole('listitem')).toContainText(
    "The provider didn't accept this key.",
  );

  const outcomes: readonly (readonly [AiTestOutcome, string])[] = [
    ['billing', "The provider says this account can't be charged"],
    ['not_found', 'The provider has nothing by that name.'],
    ['unavailable', "We couldn't reach the provider, or it was too busy to answer."],
    ['blocked_address', "This install isn't allowed to call that address."],
    ['limit_reached', "Not tested: this month's AI spending limit has been reached"],
    ['expired', "The test wasn't run within two minutes."],
  ];
  for (const [outcome, words] of outcomes) {
    world.outcome = outcome;
    await providers(page).getByRole('button', { name: 'Test Anthropic' }).click();
    await expect(result).toContainText(words);
  }
  // Replacing the key tests again; a working key clears the complaint.
  world.outcome = 'ok';
  await providers(page).getByRole('button', { name: 'Replace Anthropic key' }).click();
  await providers(page).getByLabel('New Anthropic API key').fill(`${KEY}-new`);
  await providers(page).getByRole('button', { name: 'Save and test' }).click();
  await expect(providers(page).getByText(/Working · answered in 0\.8 seconds/)).toBeVisible();
  await expect(providers(page).getByText('Key ending -new', { exact: false })).toBeVisible();
  await expect(result).toHaveCount(0);
  expect(world.keysSent).toEqual([KEY, `${KEY}-new`]);
  expect(await page.content()).not.toContain(KEY);
});

test('shows the latest settings, and says so, when someone else saved first', async ({ page }) => {
  await signedIn(page);
  const world = newWorld();
  await aiApi(page, world);
  await page.goto(inHarbor('/settings/ai-models'));
  const privacy = region(page, 'Privacy');
  const mask = privacy.getByRole('checkbox', {
    name: 'Hide phone numbers and email addresses from AI',
  });
  await expect(mask).not.toBeChecked();
  // Someone else saves while this page is open.
  world.stored = { ...world.stored, requestLogDays: 7 };
  world.revision += 1;
  await mask.click();
  await expect(
    page.getByText(
      'Someone else changed these settings while you had them open. The latest are shown here: make your change again.',
    ),
  ).toBeVisible();
  await expect(privacy.getByText(/kept for 7 days/)).toBeVisible();
  await expect(mask).not.toBeChecked();
  expect(world.stored.maskContactDetails).toBe(false);
  // The change again, from what is now shown, is saved.
  // The box is ticked once the save has answered, not before.
  await mask.click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await expect(mask).toBeChecked();
  expect(world.stored).toMatchObject({ maskContactDetails: true, requestLogDays: 7 });
  await expect(page.getByText(/Someone else changed these settings/)).toHaveCount(0);
});

test('says the page is loading, then that it could not load, and loads on another try', async ({
  page,
}) => {
  await signedIn(page);
  const world = newWorld();
  await aiApi(page, world);
  let fail = true;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/ai/settings', async (route) => {
    if (!fail) {
      await route.fallback();
      return;
    }
    await held;
    await refuse(route, 503, 'Unavailable.');
  });
  await page.goto(inHarbor('/settings/ai-models'));
  await expect(page.getByText('Loading AI settings…')).toBeVisible({ timeout: 15_000 });
  release();
  // The dashboard asks a few more times before it gives up.
  await expect(page.getByText("We couldn't load the AI settings.")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('region', { name: 'Providers' })).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('region', { name: 'Providers' })).toBeVisible();
});

test('shows the permission refusal without any control', async ({ page }) => {
  await signedIn(page);
  for (const path of ['connections', 'settings', 'usage', 'model-prices'])
    await page.route(`**/api/v1/ai/${path}`, (route) =>
      refuse(route, 403, "Your role doesn't allow this: it needs ai.manage."),
    );
  await page.goto(inHarbor('/settings/ai-models'));
  await expect(page.getByText('You need permission to manage AI settings.')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: /Add|Test|Change|Turn/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Spending' })).toHaveCount(0);
});

test('says AI is off at the top, says the limit was reached, and counts calls of unknown cost apart', async ({
  page,
}) => {
  await signedIn(page);
  const world = newWorld();
  world.stored = { ...world.stored, enabled: false, monthlyLimit: '0.0001', atLimit: 'pause' };
  world.connections = [
    {
      id: id('aic', 1),
      provider: 'openai_compatible',
      owner: 'agency',
      canManage: false,
      hasKey: true,
      keyLast4: null,
      baseUrl: null,
      model: 'llama3.2',
      status: 'working',
      lastTest: null,
      addedBy: null,
      createdAt: at,
    },
  ];
  world.calls = [
    {
      id: id('aireq', 1),
      startedAt: at,
      job: 'replies',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      keySource: 'agency',
      status: 'ok',
      errorCode: null,
      costEstimate: '0.004200',
      latencyMs: 1840,
      inputTokens: 1200,
      outputTokens: 300,
    },
    {
      id: id('aireq', 2),
      startedAt: at,
      job: 'sorting',
      provider: 'openai_compatible',
      model: 'llama3.2',
      keySource: 'agency',
      status: 'ok',
      errorCode: null,
      costEstimate: null,
      latencyMs: 640,
      inputTokens: 0,
      outputTokens: 0,
    },
  ];
  await aiApi(page, world);
  await page.goto(inHarbor('/settings/ai-models'));
  await expect(
    page.getByText(
      'AI is turned off for this business. Nothing is sent to any provider until you turn it back on under Privacy.',
    ),
  ).toBeVisible({ timeout: 15_000 });
  const spending = region(page, 'Spending');
  await expect(
    spending.getByText(
      "This month's limit of $0.0001 has been reached, so AI is paused. Raise the limit to carry on.",
    ),
  ).toBeVisible();
  await expect(spending.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await expect(
    spending.getByText(
      "1 call this month has no known cost and isn't in this total: its model has no price, or the server reported no usage.",
    ),
  ).toBeVisible();
  // The agency's connection is there to use and test, not to change.
  const shared = providers(page).getByRole('list', { name: 'Bluebird Digital’s keys' });
  await expect(shared.getByText('llama3.2')).toBeVisible();
  await expect(
    shared.getByRole('button', { name: 'Test Bluebird Digital’s Your own model server' }),
  ).toBeVisible();
  await expect(
    providers(page).getByRole('button', { name: /^Remove|^Replace|^Change/ }),
  ).toHaveCount(0);
  await region(page, 'Privacy').getByRole('button', { name: 'Turn AI back on' }).click();
  await expect(page.getByText(/AI is turned off for this business/)).toHaveCount(0);
  expect(world.stored.enabled).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
});

for (const width of [360, 1280]) {
  test(`at the agency: checks a shared key without calling a model, and sets a price of zero, at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page, dana, {}, agencyStaff);
    const world = newWorld('agency');
    world.prices = [
      {
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
      },
    ];
    await aiApi(page, world);
    await page.goto('/agency/settings/ai-models');
    await expect(page.getByRole('heading', { name: 'AI models', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'AI models' }),
    ).toHaveAttribute('data-status', 'active');
    await fitsAndIsAccessible(page, width);

    await providers(page).getByRole('button', { name: 'Add Anthropic key' }).click();
    await providers(page).getByLabel('Anthropic API key').fill(KEY);
    await providers(page).getByRole('button', { name: 'Save and test' }).click();
    await expect(
      providers(page).getByText(
        /Working · answered in 0\.8 seconds.*The provider accepted the key\. No model was called, so this cost nothing/,
      ),
    ).toBeVisible();
    expect(world.calls).toEqual([]);
    expect(world.keysSent).toEqual([KEY]);
    expect(await page.content()).not.toContain(KEY);

    const prices = region(page, 'Model prices');
    await expect(
      prices.getByText('Input $2.00 · output $10.00 for a million tokens'),
    ).toBeVisible();
    await prices.getByRole('button', { name: 'Add a price' }).click();
    const form = prices.getByRole('form', { name: 'Add a price' });
    await form.getByLabel('Model name').fill('llama3.2');
    await form.getByLabel('Input, in US dollars for a million tokens').fill('0');
    await form.getByLabel('Output, in US dollars for a million tokens').fill('0');
    await form.getByLabel('Where this price comes from').fill('Runs on our own server');
    await fitsAndIsAccessible(page, width);
    await form.getByRole('button', { name: 'Save price' }).click();
    await expect(prices.getByText('Input $0.00 · output $0.00 for a million tokens')).toBeVisible();
    await expect(
      prices.getByText('Set by your agency: Runs on our own server, on 2026-10-10'),
    ).toBeVisible();
    expect(world.prices[0]).toMatchObject({
      provider: 'openai_compatible',
      model: 'llama3.2',
      inputPerMtok: '0.000000',
    });
    await prices.getByRole('button', { name: 'Remove the price of llama3.2' }).click();
    await expect(prices.getByText(/Runs on our own server/)).toHaveCount(0);
    await fitsAndIsAccessible(page, width);
  });
}
