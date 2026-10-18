// Settings → AI models: a model for each job, whose keys, the spending limit, privacy,
// prices and the month's spend, against real Postgres under row-level security, through the
// routes the app registers. The gateway then reads what was saved, so that a setting is
// proven by the call it changes. No test calls a real provider.
import { randomUUID } from 'node:crypto';

import {
  connectAiProvider,
  getAiSettings,
  getAiUsage,
  listAiModelPrices,
  removeAiModelPrice,
  setAiModelPrice,
  updateAiSettings,
  type AiSettings,
  type UpdateAiSettingsInput,
} from '@repo/contracts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  FAKE_ANTHROPIC_KEY,
  startSettingsWorld,
  type Person,
  type SettingsWorld,
} from '../test/settings-world.js';
import type { GatewayRequest } from './gateway.js';

let world: SettingsWorld;
beforeAll(async () => {
  world = await startSettingsWorld(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});
beforeEach(async () => {
  world.clock.now = new Date('2026-10-10T09:00:00.000Z');
  await world.discardQueuedTests();
  world.events.length = 0;
  for (const fake of [world.claude, world.openai, world.ollama]) fake.requests.length = 0;
});

const read = (person: Person): Promise<AiSettings> => world.call(getAiSettings, person);
const NO_JOBS = { automation_builder: null, replies: null, briefings: null, sorting: null };

/** What a person sends to save: everything as it is, with what they changed. */
function changed(
  settings: AiSettings,
  change: Partial<Omit<UpdateAiSettingsInput, 'revision'>> = {},
): UpdateAiSettingsInput {
  const choice = (job: AiSettings['jobs'][number]) =>
    job.isDefault ? null : { provider: job.provider as 'anthropic', model: job.model };
  const jobs = Object.fromEntries(settings.jobs.map((job) => [job.job, choice(job)]));
  return {
    enabled: settings.enabled,
    keySource: settings.keySource,
    monthlyLimit: settings.monthlyLimit,
    atLimit: settings.atLimit,
    maskContactDetails: settings.maskContactDetails,
    requestLogDays: settings.requestLogDays,
    backup:
      settings.backup === null
        ? null
        : { provider: settings.backup.provider as 'anthropic', model: settings.backup.model },
    jobs: { ...NO_JOBS, ...jobs },
    ...change,
    revision: settings.revision,
  };
}
const save = async (
  person: Person,
  change: Partial<Omit<UpdateAiSettingsInput, 'revision'>>,
): Promise<AiSettings> =>
  world.call(updateAiSettings, person, { body: changed(await read(person), change) });

const ask = (text: string, job: GatewayRequest['job'] = 'replies'): GatewayRequest => ({
  job,
  promptVersion: `${job}/1`,
  system: 'You write short replies.',
  messages: [{ role: 'user', text }],
  maxOutputTokens: 200,
});
/** The context a job of the business runs in. */
const worker = (person: Person) => ({
  agencyId: person.context.agencyId,
  ...(person.context.businessId === undefined ? {} : { businessId: person.context.businessId }),
  actorKind: 'ai_agent' as const,
  correlationId: randomUUID(),
});
const price = (person: Person, provider: string, model: string, amount = '0') =>
  world.call(setAiModelPrice, person, {
    body: {
      provider,
      model,
      inputPerMtok: amount,
      outputPerMtok: amount,
      source: 'Our own server',
    },
  });
/** A finished call of some earlier time, for the month's spend. */
const spent = (
  person: Person,
  job: string,
  dollars: string | null,
  at: string,
  status = 'ok',
): Promise<unknown> =>
  world.database.withTenant(person.context, (sql) =>
    sql.query(
      `insert into ai.requests (business_id, job, provider, model, key_source, status, error_code,
                                cost_estimate, latency_ms, input_tokens, output_tokens, actor_kind,
                                log, log_expires_at, started_at, finished_at)
       values (app.business_id(), $1, 'anthropic', 'claude-sonnet-5-5', 'own', $2, $3, $4, 640, 1200,
               300, 'ai_agent', '{"request": {"system": "A SECRET PROMPT"}}', $5::timestamptz + interval '30 days',
               $5, $5)`,
      [job, status, status === 'error' ? 'unavailable' : null, dollars, at],
    ),
  );

describe('a business’s AI settings', () => {
  it('are the defaults until someone saves: the agency’s keys, no limit, a log of 30 days', async () => {
    const dana = await world.admin();
    const settings = await read(dana);
    expect(settings).toMatchObject({
      enabled: true,
      keySource: 'agency',
      monthlyLimit: null,
      atLimit: 'pause',
      maskContactDetails: false,
      requestLogDays: 30,
      backup: null,
      models: [],
      limitReachedAt: null,
    });
    // Each job has its default model, which cannot run until a key is connected.
    expect(settings.jobs).toEqual([
      {
        job: 'automation_builder',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        isDefault: true,
        tested: false,
        readiness: 'no_key',
      },
      {
        job: 'replies',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        isDefault: true,
        tested: false,
        readiness: 'no_key',
      },
      {
        job: 'briefings',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        isDefault: true,
        tested: false,
        readiness: 'no_key',
      },
      {
        job: 'sorting',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        isDefault: true,
        tested: false,
        readiness: 'no_key',
      },
    ]);
    // Reading wrote nothing.
    expect(
      await world.database.withTenant(dana.context, (sql) =>
        sql.query('select 1 from ai.settings'),
      ),
    ).toEqual([]);
  });

  it('are saved whole, and the next call goes by them', async () => {
    const dana = await world.admin();
    await world.call(connectAiProvider, dana, {
      body: { provider: 'anthropic', apiKey: FAKE_ANTHROPIC_KEY },
    });
    await world.discardQueuedTests();
    const saved = await save(dana, {
      keySource: 'own',
      monthlyLimit: '50',
      atLimit: 'continue',
      maskContactDetails: true,
      requestLogDays: 0,
      backup: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      jobs: { ...NO_JOBS, replies: { provider: 'anthropic', model: 'claude-fable-5-1' } },
    });
    expect(saved).toMatchObject({
      keySource: 'own',
      monthlyLimit: '50.0000',
      atLimit: 'continue',
      maskContactDetails: true,
      requestLogDays: 0,
      backup: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', readiness: 'ready' },
    });
    expect(saved.jobs.find((job) => job.job === 'replies')).toEqual({
      job: 'replies',
      provider: 'anthropic',
      model: 'claude-fable-5-1',
      isDefault: false,
      tested: false,
      readiness: 'ready',
    });
    expect(await read(dana)).toEqual(saved);

    // The gateway reads the same rows: the model chosen, masked, and no log kept.
    const result = await world.gateway.generate(
      worker(dana),
      ask('Call Jordan on +1 415 555 0100 or write to jordan@example.com.'),
    );
    expect(result).toMatchObject({ outcome: 'ok', model: 'claude-fable-5-1' });
    const [sent] = world.claude.requests;
    expect(sent?.json).toMatchObject({ model: 'claude-fable-5-1' });
    expect(sent?.body).toContain('[phone]');
    expect(sent?.body).toContain('[email]');
    expect(sent?.body).not.toContain('jordan@example.com');
    const [call] = await world.database.withTenant(dana.context, (sql) =>
      sql.query<{ model: string; log: unknown; key_source: string }>(
        'select model, log, key_source from ai.requests',
      ),
    );
    expect(call).toEqual({ model: 'claude-fable-5-1', log: null, key_source: 'own' });
  });

  it('go back to a job’s default when its choice is cleared', async () => {
    const dana = await world.admin();
    await save(dana, {
      jobs: { ...NO_JOBS, sorting: { provider: 'openai_compatible', model: 'llama3.2' } },
    });
    expect((await read(dana)).jobs.find((job) => job.job === 'sorting')).toMatchObject({
      provider: 'openai_compatible',
      model: 'llama3.2',
      isDefault: false,
    });
    const cleared = await save(dana, { jobs: NO_JOBS });
    expect(cleared.jobs.find((job) => job.job === 'sorting')).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      isDefault: true,
    });
    expect(
      await world.database.withTenant(dana.context, (sql) =>
        sql.query('select 1 from ai.job_models'),
      ),
    ).toEqual([]);
  });

  it('are refused when they changed since the person read them, and nothing is half saved', async () => {
    const dana = await world.admin();
    const opened = await read(dana);
    await save(dana, { monthlyLimit: '20' });
    await expect(
      world.call(updateAiSettings, dana, {
        body: changed(opened, {
          maskContactDetails: true,
          jobs: { ...NO_JOBS, replies: { provider: 'anthropic', model: 'claude-opus-5-5' } },
        }),
      }),
    ).rejects.toThrow(ConflictError);
    await expect(
      world.call(updateAiSettings, dana, { body: changed(opened, { maskContactDetails: true }) }),
    ).rejects.toThrow(
      'These settings changed after you opened them. Reload the page and try again.',
    );
    const now = await read(dana);
    expect(now).toMatchObject({ monthlyLimit: '20.0000', maskContactDetails: false });
    expect(now.jobs.find((job) => job.job === 'replies')?.isDefault).toBe(true);
  });

  it('have the same revision for the same money, however the amount was written', async () => {
    const dana = await world.admin();
    const first = await save(dana, { monthlyLimit: '50' });
    const second = await save(dana, { monthlyLimit: '50.00' });
    expect(second.revision).toBe(first.revision);
    expect((await save(dana, { monthlyLimit: '50.01' })).revision).not.toBe(first.revision);
    expect((await save(dana, { monthlyLimit: null })).revision).not.toBe(first.revision);
  });

  it('take one of two saves made at once: the second waits, then finds the settings changed', async () => {
    const dana = await world.admin();
    const opened = await save(dana, { monthlyLimit: '10' });
    // Someone else's save, holding the settings row inside its transaction.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const first = world.database.withTenant(dana.context, async (sql) => {
      await sql.query('select 1 from ai.settings where business_id = app.business_id() for update');
      locked();
      await held;
      await sql.query(
        `update ai.settings set monthly_limit = 99 where business_id = app.business_id()`,
      );
    });
    await holding;
    const second = world.call(updateAiSettings, dana, {
      body: changed(opened, { monthlyLimit: '5' }),
    });
    // Another role's wait events are hidden from crm_app, so the superuser watches.
    await expect
      .poll(
        () =>
          world.database.as('postgres', async (sql) => {
            const [row] = await sql.query<{ waiting: number }>(
              `select count(*)::int as waiting from pg_stat_activity
               where datname = current_database() and wait_event_type = 'Lock'`,
            );
            return row?.waiting ?? 0;
          }),
        { timeout: 10_000, interval: 50 },
      )
      .toBe(1);
    release();
    await first;
    await expect(second).rejects.toThrow(ConflictError);
    expect((await read(dana)).monthlyLimit).toBe('99.0000');
  });

  it('forget that the limit was reached once the limit is changed, so reaching the new one is told again', async () => {
    const dana = await world.admin();
    await save(dana, { monthlyLimit: '1', atLimit: 'pause' });
    await world.database.withTenant(dana.context, (sql) =>
      sql.query(`update ai.settings set limit_reached_at = '2026-10-09T12:00:00Z'`),
    );
    expect((await read(dana)).limitReachedAt).toBe('2026-10-09T12:00:00.000Z');
    // A change that is not about the limit leaves it.
    expect((await save(dana, { maskContactDetails: true })).limitReachedAt).toBe(
      '2026-10-09T12:00:00.000Z',
    );
    expect((await save(dana, { monthlyLimit: '1.00' })).limitReachedAt).toBe(
      '2026-10-09T12:00:00.000Z',
    );
    expect((await save(dana, { monthlyLimit: '5' })).limitReachedAt).toBeNull();
    await world.database.withTenant(dana.context, (sql) =>
      sql.query(`update ai.settings set limit_reached_at = '2026-10-09T12:00:00Z'`),
    );
    expect((await save(dana, { atLimit: 'continue' })).limitReachedAt).toBeNull();
  });

  it('turn AI off for the business, and on again', async () => {
    const dana = await world.admin();
    await world.call(connectAiProvider, dana, {
      body: { provider: 'anthropic', apiKey: FAKE_ANTHROPIC_KEY },
    });
    await save(dana, { keySource: 'own', enabled: false });
    expect(await world.gateway.generate(worker(dana), ask('Hello'))).toEqual({ outcome: 'off' });
    expect(world.claude.requests).toEqual([]);
    await save(dana, { enabled: true });
    expect(await world.gateway.generate(worker(dana), ask('Hello'))).toMatchObject({
      outcome: 'ok',
    });
  });

  it('say which models can be chosen with the keys in use, and what stands in a choice’s way', async () => {
    const dana = await world.admin();
    const agency = await world.agencyAdmin(dana.context.agencyId);
    // The agency has Claude; the business has a model server of its own.
    await world.call(connectAiProvider, agency, {
      body: { provider: 'anthropic', apiKey: FAKE_ANTHROPIC_KEY },
    });
    await world.call(connectAiProvider, dana, {
      body: {
        provider: 'openai_compatible',
        baseUrl: `${world.ollama.origin}/v1`,
        model: 'fixture-model',
      },
    });

    const onAgencyKeys = await read(dana);
    expect(onAgencyKeys.keySource).toBe('agency');
    expect(onAgencyKeys.models).toEqual([
      { provider: 'anthropic', model: 'claude-fable-5-1', priced: true },
      { provider: 'anthropic', model: 'claude-opus-5-5', priced: true },
      { provider: 'anthropic', model: 'claude-sonnet-5-5', priced: true },
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', priced: true },
    ]);
    expect(onAgencyKeys.jobs.map((job) => job.readiness)).toEqual([
      'ready',
      'ready',
      'ready',
      'ready',
    ]);

    // On its own keys the business has no Claude: the defaults cannot run, and it says so.
    const onOwnKeys = await save(dana, {
      keySource: 'own',
      backup: { provider: 'openai_compatible', model: 'fixture-model' },
    });
    expect(onOwnKeys.models).toEqual([
      { provider: 'openai_compatible', model: 'fixture-model', priced: false },
    ]);
    expect(onOwnKeys.jobs.map((job) => job.readiness)).toEqual([
      'no_key',
      'no_key',
      'no_key',
      'no_key',
    ]);
    expect(onOwnKeys.backup).toMatchObject({ readiness: 'ready' });

    // Under a limit that pauses, a model nobody has priced cannot be held to the limit.
    const limited = await save(dana, { monthlyLimit: '50', atLimit: 'pause' });
    expect(limited.backup).toMatchObject({ readiness: 'price_needed' });
    expect((await save(dana, { atLimit: 'continue' })).backup).toMatchObject({
      readiness: 'ready',
    });
    await save(dana, { atLimit: 'pause' });
    // The agency says what the business's server costs: nothing. A second model it priced
    // is offered too.
    await price(agency, 'openai_compatible', 'fixture-model');
    await price(agency, 'openai_compatible', 'another/model:7b', '0.10');
    await price(agency, 'openai', 'gpt-not-connected', '1');
    const priced = await read(dana);
    expect(priced.backup).toMatchObject({ readiness: 'ready' });
    expect(priced.models).toEqual([
      { provider: 'openai_compatible', model: 'fixture-model', priced: true },
      { provider: 'openai_compatible', model: 'another/model:7b', priced: true },
    ]);
  });

  it('take any model for a job, and say when its provider has no key', async () => {
    const dana = await world.admin();
    const saved = await save(dana, {
      keySource: 'own',
      jobs: { ...NO_JOBS, briefings: { provider: 'openai', model: 'gpt-not-connected' } },
    });
    expect(saved.jobs.find((job) => job.job === 'briefings')).toEqual({
      job: 'briefings',
      provider: 'openai',
      model: 'gpt-not-connected',
      isDefault: false,
      tested: false,
      readiness: 'no_key',
    });
    expect(await world.gateway.generate(worker(dana), ask('Hello', 'briefings'))).toEqual({
      outcome: 'not_configured',
      reason: 'no_key',
    });
  });

  it('record who changed what, and none of it is secret', async () => {
    const dana = await world.admin();
    await save(dana, { monthlyLimit: '50', maskContactDetails: true });
    const [event] = await world.database.as('crm_owner', (sql) =>
      sql.query<{ type: string; subject_kind: string; subject_id: string; payload: unknown }>(
        `select type, subject_kind, subject_id, payload from events.events
         where business_id = $1 order by recorded_at`,
        [dana.context.businessId],
      ),
    );
    expect(event).toEqual({
      type: 'ai_settings.updated',
      subject_kind: 'business',
      subject_id: dana.context.businessId,
      payload: {
        changed: ['monthlyLimit', 'maskContactDetails'],
        enabled: true,
        keySource: 'agency',
        monthlyLimit: '50',
        atLimit: 'pause',
        maskContactDetails: true,
        requestLogDays: 30,
      },
    });
    const [audit] = await world.database.as('crm_owner', (sql) =>
      sql.query<{ command: string; outcome: string; actor_id: string; input: unknown }>(
        `select command, outcome, actor_id, input from audit.commands where business_id = $1`,
        [dana.context.businessId],
      ),
    );
    expect(audit).toMatchObject({
      command: 'ai.update_settings',
      outcome: 'ok',
      actor_id: dana.userId,
      input: { monthlyLimit: '50', maskContactDetails: true },
    });
    expect(JSON.stringify(audit?.input)).not.toContain('revision');
  });

  it('belong to one business: a sibling’s and another agency’s are their own', async () => {
    const dana = await world.admin();
    const sibling = await world.admin(dana.context.agencyId);
    const stranger = await world.admin();
    await save(dana, { monthlyLimit: '50', maskContactDetails: true, requestLogDays: 7 });
    for (const other of [sibling, stranger])
      expect(await read(other)).toMatchObject({
        monthlyLimit: null,
        maskContactDetails: false,
        requestLogDays: 30,
      });
    // A revision read in one business saves nothing in another.
    await expect(
      world.call(updateAiSettings, sibling, {
        body: changed(await read(dana), { maskContactDetails: false }),
      }),
    ).rejects.toThrow(ConflictError);
    expect((await read(dana)).maskContactDetails).toBe(true);
  });

  it('are a business’s: at the agency there are none to read or save', async () => {
    const dana = await world.admin();
    const agency = await world.agencyAdmin(dana.context.agencyId);
    await expect(read(agency)).rejects.toMatchObject({
      name: 'ValidationError',
      issues: [{ code: 'business_required' }],
    });
    await expect(
      world.call(updateAiSettings, agency, { body: changed(await read(dana)) }),
    ).rejects.toThrow(ValidationError);
    await expect(world.call(getAiUsage, agency)).rejects.toThrow(ValidationError);
  });
});

describe('this month’s spend', () => {
  it('adds up the month by job, counts apart the calls whose cost nobody knows, and lists the latest calls', async () => {
    const dana = await world.admin();
    await save(dana, { monthlyLimit: '50' });
    // Last month's calls are last month's.
    await spent(dana, 'replies', '9.990000', '2026-09-30T23:59:59Z');
    await spent(dana, 'replies', '7.800000', '2026-10-01T00:00:00Z');
    await spent(dana, 'replies', '0.000001', '2026-10-02T10:00:00Z');
    await spent(dana, 'sorting', '2.900000', '2026-10-03T10:00:00Z');
    await spent(dana, 'sorting', null, '2026-10-04T10:00:00Z');
    await spent(dana, 'connection_test', null, '2026-10-05T10:00:00Z', 'error');
    await spent(dana, 'connection_test', '0', '2026-10-06T10:00:00Z');

    const usage = await world.call(getAiUsage, dana);
    expect(usage).toMatchObject({
      month: '2026-10',
      spent: '10.700001',
      calls: 6,
      unknownCostCalls: 2,
      limit: '50.0000',
      byJob: [
        { job: 'connection_test', spent: '0.000000', calls: 2, unknownCostCalls: 1 },
        { job: 'replies', spent: '7.800001', calls: 2, unknownCostCalls: 0 },
        { job: 'sorting', spent: '2.900000', calls: 2, unknownCostCalls: 1 },
      ],
    });
    // Newest first, each with what it cost or null, and why it failed as a category.
    expect(
      usage.recent.map((call) => [call.startedAt, call.job, call.status, call.costEstimate]),
    ).toEqual([
      ['2026-10-06T10:00:00.000Z', 'connection_test', 'ok', '0.000000'],
      ['2026-10-05T10:00:00.000Z', 'connection_test', 'error', null],
      ['2026-10-04T10:00:00.000Z', 'sorting', 'ok', null],
      ['2026-10-03T10:00:00.000Z', 'sorting', 'ok', '2.900000'],
      ['2026-10-02T10:00:00.000Z', 'replies', 'ok', '0.000001'],
      ['2026-10-01T00:00:00.000Z', 'replies', 'ok', '7.800000'],
      ['2026-09-30T23:59:59.000Z', 'replies', 'ok', '9.990000'],
    ]);
    expect(usage.recent[1]).toMatchObject({
      errorCode: 'unavailable',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      keySource: 'own',
      latencyMs: 640,
      inputTokens: 1200,
      outputTokens: 300,
    });
    // Nothing of what was said in any call is in the answer.
    expect(JSON.stringify(usage)).not.toContain('A SECRET PROMPT');
  });

  it('is nothing in a month with no calls, and starts over with the month', async () => {
    const dana = await world.admin();
    expect(await world.call(getAiUsage, dana)).toEqual({
      month: '2026-10',
      spent: '0.000000',
      calls: 0,
      unknownCostCalls: 0,
      limit: null,
      byJob: [],
      recent: [],
    });
    await spent(dana, 'replies', '3.000000', '2026-10-31T23:59:59Z');
    world.clock.now = new Date('2026-11-01T00:00:00.000Z');
    expect(await world.call(getAiUsage, dana)).toMatchObject({
      month: '2026-11',
      spent: '0.000000',
      calls: 0,
      byJob: [],
    });
  });

  it('lists the twenty latest calls and no more', async () => {
    const dana = await world.admin();
    for (let minute = 0; minute < 23; minute += 1)
      await spent(
        dana,
        'replies',
        '0.010000',
        `2026-10-09T10:${String(minute).padStart(2, '0')}:00Z`,
      );
    const usage = await world.call(getAiUsage, dana);
    expect(usage.calls).toBe(23);
    expect(usage.spent).toBe('0.230000');
    expect(usage.recent).toHaveLength(20);
    expect(usage.recent[0]?.startedAt).toBe('2026-10-09T10:22:00.000Z');
    expect(usage.recent[19]?.startedAt).toBe('2026-10-09T10:03:00.000Z');
  });

  it('is one business’s: a sibling and another agency see none of it', async () => {
    const dana = await world.admin();
    await spent(dana, 'replies', '7.800000', '2026-10-01T00:00:00Z');
    for (const other of [await world.admin(dana.context.agencyId), await world.admin()])
      expect(await world.call(getAiUsage, other)).toMatchObject({
        spent: '0.000000',
        calls: 0,
        recent: [],
      });
  });
});

describe('model prices', () => {
  it('are the shipped ones until the agency sets its own, which then stand in their place', async () => {
    const dana = await world.admin();
    const agency = await world.agencyAdmin(dana.context.agencyId);
    const shipped = await world.call(listAiModelPrices, agency);
    expect(shipped.canManage).toBe(true);
    expect(shipped.data).toContainEqual({
      shipped: true,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      inputPerMtok: '2.000000',
      outputPerMtok: '10.000000',
      cacheReadPerMtok: '0.100000',
      cacheWritePerMtok: '2.500000',
      cacheWrite1hPerMtok: '4.000000',
      source: 'https://platform.claude.com/docs/en/about-claude/pricing',
      checkedOn: '2026-10-14',
    });
    expect(shipped.data.every((each) => each.shipped)).toBe(true);

    world.clock.now = new Date('2026-10-12T23:30:00.000Z');
    const set = await world.call(setAiModelPrice, agency, {
      body: {
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        inputPerMtok: '1.5',
        outputPerMtok: '7.5',
        cacheReadPerMtok: '0.15',
        cacheWritePerMtok: '1.875',
        cacheWrite1hPerMtok: '3',
        source: 'Our negotiated rate',
      },
    });
    expect(set).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      inputPerMtok: '1.500000',
      outputPerMtok: '7.500000',
      cacheReadPerMtok: '0.150000',
      cacheWritePerMtok: '1.875000',
      cacheWrite1hPerMtok: '3.000000',
      source: 'Our negotiated rate',
      checkedOn: '2026-10-12',
    });
    const after = await world.call(listAiModelPrices, agency);
    expect(after.data.filter((each) => each.model === 'claude-sonnet-5-5')).toEqual([set]);
    expect(after.data).toHaveLength(shipped.data.length);

    // A business of the agency reads them, and cannot change them.
    const seen = await world.call(listAiModelPrices, dana);
    expect(seen.canManage).toBe(false);
    expect(seen.data).toEqual(after.data);
    await expect(
      world.call(setAiModelPrice, dana, {
        body: {
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          inputPerMtok: '0',
          outputPerMtok: '0',
          source: 'A business lowering what it is billed',
        },
      }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      world.call(removeAiModelPrice, dana, { query: { provider: set.provider, model: set.model } }),
    ).rejects.toThrow('Change this for the whole agency, outside any business.');
    expect((await world.call(listAiModelPrices, agency)).data).toEqual(after.data);

    // Removed, the shipped price applies again.
    await world.call(removeAiModelPrice, agency, {
      query: { provider: set.provider, model: set.model },
    });
    expect((await world.call(listAiModelPrices, agency)).data).toEqual(shipped.data);
    await expect(
      world.call(removeAiModelPrice, agency, {
        query: { provider: set.provider, model: set.model },
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('may be zero for a model of one’s own, and cached input then costs what input does', async () => {
    const agency = await world.agencyAdmin((await world.database.fixtures.agency()).id);
    const set = await price(agency, 'openai_compatible', 'llama3.2');
    expect(set).toMatchObject({
      inputPerMtok: '0.000000',
      outputPerMtok: '0.000000',
      cacheReadPerMtok: '0.000000',
      cacheWritePerMtok: '0.000000',
      // No price for an hour's cache is taken from another: without one it is not used.
      cacheWrite1hPerMtok: null,
      source: 'Our own server',
    });
    const again = await price(agency, 'openai_compatible', 'llama3.2', '0.25');
    expect(again).toMatchObject({
      inputPerMtok: '0.250000',
      cacheReadPerMtok: '0.250000',
      cacheWritePerMtok: '0.250000',
      cacheWrite1hPerMtok: null,
    });
    expect(
      (await world.call(listAiModelPrices, agency)).data.filter((each) => !each.shipped),
    ).toEqual([again]);
  });

  it('are the price a call is costed at from then on', async () => {
    const dana = await world.admin();
    const agency = await world.agencyAdmin(dana.context.agencyId);
    await world.call(connectAiProvider, dana, {
      body: { provider: 'anthropic', apiKey: FAKE_ANTHROPIC_KEY },
    });
    await save(dana, { keySource: 'own' });
    // A dollar a token: a cost nobody could mistake for the shipped price.
    await price(agency, 'anthropic', 'claude-sonnet-5-5', '1000000');
    const result = await world.gateway.generate(worker(dana), ask('Hello'));
    if (result.outcome !== 'ok' || result.usage === null)
      throw new Error('The call did not answer.');
    const tokens =
      result.usage.inputTokens +
      result.usage.outputTokens +
      result.usage.cacheReadTokens +
      result.usage.cacheWriteTokens;
    expect(result.costMicros).toBe(BigInt(tokens) * 1_000_000n);
    expect((await world.call(getAiUsage, dana)).spent).toBe(`${String(tokens)}.000000`);
  });

  it('are one agency’s: another agency neither sees nor removes them', async () => {
    const agency = await world.agencyAdmin((await world.database.fixtures.agency()).id);
    const other = await world.agencyAdmin((await world.database.fixtures.agency()).id);
    const set = await price(agency, 'openai_compatible', 'llama3.2');
    expect(
      (await world.call(listAiModelPrices, other)).data.filter((each) => !each.shipped),
    ).toEqual([]);
    await expect(
      world.call(removeAiModelPrice, other, {
        query: { provider: set.provider, model: set.model },
      }),
    ).rejects.toThrow(NotFoundError);
    expect(
      (await world.call(listAiModelPrices, agency)).data.filter((each) => !each.shipped),
    ).toEqual([set]);
  });
});

describe('who may open Settings → AI models', () => {
  it('is whoever’s role allows it: without it nothing is read and nothing is changed', async () => {
    const dana = await world.admin();
    const settings = await read(dana);
    const member = world.limited(dana, [
      'contacts.manage',
      'conversations.reply',
      'mailboxes.manage',
      'apps.manage',
    ]);
    const id = 'aic_01h455vb4pex5vsknk084sn02q';
    const inputs = new Map<string, { params?: unknown; query?: unknown; body?: unknown }>([
      ['connectAiProvider', { body: { provider: 'anthropic', apiKey: FAKE_ANTHROPIC_KEY } }],
      ['updateAiConnection', { params: { id }, body: { apiKey: FAKE_ANTHROPIC_KEY } }],
      ['removeAiConnection', { params: { id } }],
      ['startAiConnectionTest', { body: { connectionId: id } }],
      ['getAiConnectionTest', { params: { id: 'aict_01h455vb4pex5vsknk084sn02q' } }],
      ['updateAiSettings', { body: changed(settings) }],
      [
        'setAiModelPrice',
        {
          body: {
            provider: 'openai',
            model: 'm',
            inputPerMtok: '0',
            outputPerMtok: '0',
            source: 'x',
          },
        },
      ],
      ['removeAiModelPrice', { query: { provider: 'openai', model: 'm' } }],
    ]);
    expect(world.routes).toHaveLength(12);
    for (const route of world.routes) {
      const { operationId } = route.endpoint;
      await expect(
        world.call(route.endpoint, member, inputs.get(operationId)),
        operationId,
      ).rejects.toMatchObject({ name: 'ForbiddenError', permission: 'ai.manage' });
    }
    // Every refusal is on record, and none of them kept the key that was sent.
    const refusals = await world.database.as('crm_owner', (sql) =>
      sql.query<{ command: string; outcome: string; input: unknown }>(
        `select command, outcome, input from audit.commands
         where business_id = $1 and outcome = 'denied' order by command`,
        [dana.context.businessId],
      ),
    );
    expect(refusals.map((each) => each.command)).toEqual([
      'ai.connect_provider',
      'ai.list_connections',
      'ai.list_model_prices',
      'ai.read_connection_test',
      'ai.read_settings',
      'ai.read_usage',
      'ai.remove_connection',
      'ai.remove_model_price',
      'ai.set_model_price',
      'ai.test_connection',
      'ai.update_connection',
      'ai.update_settings',
    ]);
    expect(JSON.stringify(refusals)).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(
      await world.database.withTenant(dana.context, (sql) =>
        sql.query(
          `select 1 from ai.provider_keys union all select 1 from vault.secrets
           union all select 1 from ai.settings`,
        ),
      ),
    ).toEqual([]);
  });
});
