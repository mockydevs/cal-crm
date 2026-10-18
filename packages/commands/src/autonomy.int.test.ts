// The command layer's own proof that an assistant runs a command only where its
// autonomy rule says `act`, a proposal's command runs through the same layer with nothing
// left out, and a proposal is marked with its command's change or not at all. The commands
// here are made for the tests; the real ones are proven where they live.
import { randomUUID } from 'node:crypto';

import type { AiAgent, AutonomyLevel } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ConflictError, ForbiddenError, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import {
  allowEveryone,
  ApprovalRequiredError,
  defineCommand,
  defineProposable,
  proposableOf,
  readAutonomy,
  requireBusiness,
  runCommand,
  runProposedCommand,
  type Invocation,
  type ProposalHooks,
  type ProposalLink,
  type Services,
  type UndoPlan,
} from './index.js';

let database: TestDatabase;
let db: Database;
let services: Services;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

const tagInput = z.strictObject({
  name: z.string().trim().min(1),
  contactId: z.uuid().optional(),
  fail: z.boolean().optional(),
});

// A command an assistant may run or propose: it adds a tag, about a contact when one is named.
const addTag = defineCommand({
  name: 'test.add_tag',
  permission: 'tags.manage',
  input: tagInput,
  delegation: {
    action: 'update_conversation',
    contact: (_trx, input) => Promise.resolve(input.contactId),
  },
  async handle(trx, input, command) {
    const tag = await trx
      .insertInto('crm.tags')
      .values({
        business_id: requireBusiness(command.context),
        name: input.name,
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const eventId = await command.emit({
      type: 'tag.added',
      subject: { kind: 'tag', id: tag.id },
      // What the handler was told of the proposal behind it, for the tests to read back.
      payload: { proposal: command.proposal ?? null },
    });
    if (input.fail === true) throw new Error('the handler failed');
    return { id: tag.id, eventId };
  },
});

// The same change, delegated with no contact to speak of: only the business's rule applies.
const addTagForNobody = defineCommand({
  name: 'test.add_tag_for_nobody',
  permission: 'tags.manage',
  input: tagInput,
  delegation: { action: 'update_conversation' },
  handle: (trx, input, command) => addTag.handle(trx, input, command),
});

// The same change as making a draft: the one action the in-app assistant starts out doing
// without asking.
const draftTag = defineCommand({
  name: 'test.draft_tag',
  permission: 'tags.manage',
  input: tagInput,
  delegation: { action: 'build_draft' },
  handle: (trx, input, command) => addTag.handle(trx, input, command),
});
// And as making something live, which every assistant starts out asking for.
const publishTag = defineCommand({
  name: 'test.publish_tag',
  permission: 'tags.manage',
  input: tagInput,
  delegation: { action: 'publish' },
  handle: (trx, input, command) => addTag.handle(trx, input, command),
});

// The same change by a command that holds its own rule for assistants, in its handler: here,
// that an assistant's tag is never named "Forbidden".
const addTagByOwnRule = defineCommand({
  name: 'test.add_tag_by_own_rule',
  permission: 'tags.manage',
  input: tagInput,
  ownAssistantRule: 'An assistant may add any tag but one named Forbidden.',
  handle(trx, input, command) {
    if (command.context.actorKind === 'ai_agent' && input.name === 'Forbidden')
      throw new ConflictError('An assistant may not add this tag.');
    return addTag.handle(trx, input, command);
  },
});

// A command that names both: its own rule adds to the autonomy rule, and replaces nothing.
const addTagByBothRules = defineCommand({
  name: 'test.add_tag_by_both_rules',
  permission: 'tags.manage',
  input: tagInput,
  delegation: { action: 'update_conversation' },
  ownAssistantRule: 'An assistant may add any tag but one named Forbidden.',
  handle: (trx, input, command) => addTagByOwnRule.handle(trx, input, command),
});

// The same change by a command that names no delegation: no assistant may ever run it.
const addTagByPeople = defineCommand({
  name: 'test.add_tag_by_people',
  permission: 'tags.manage',
  input: tagInput,
  handle: (trx, input, command) => addTag.handle(trx, input, command),
});

const asOwner = <Row extends object>(text: string, values: unknown[] = []) =>
  database.as('crm_owner', (sql) => sql.query<Row>(text, values));

const audits = (correlationId: string) =>
  asOwner<Record<string, unknown>>(
    `select command, outcome, error_code, actor_kind, proposal_id
     from audit.commands where correlation_id = $1 order by recorded_at, id`,
    [correlationId],
  );

const eventsOf = (correlationId: string) =>
  asOwner<Record<string, unknown>>(
    `select type, actor_kind, actor_id, proposal_id, payload
     from events.events where correlation_id = $1 order by id`,
    [correlationId],
  );

const tagsNamed = (name: string) =>
  asOwner<{ id: string }>('select id from crm.tags where name = $1', [name]);

interface World {
  readonly person: Invocation;
  readonly assistant: Invocation;
  readonly system: Invocation;
  readonly maya: string;
  readonly ken: string;
  readonly userId: string;
  setRule(level: AutonomyLevel, options?: Partial<Rule>): Promise<void>;
}

interface Rule {
  readonly agent: AiAgent;
  readonly action: string;
  readonly contactId: string | null;
}

async function setUp(agencyId?: string): Promise<World> {
  const agency = agencyId ?? (await database.fixtures.agency()).id;
  const business = await database.fixtures.business(agency);
  const user = await database.fixtures.user();
  const maya = await database.fixtures.contact(business.context, { firstName: 'Maya' });
  const ken = await database.fixtures.contact(business.context, { firstName: 'Ken' });
  const correlationId = randomUUID();
  return {
    person: {
      context: {
        ...business.context,
        userId: user.id,
        actorKind: 'user',
        actorId: user.id,
        correlationId,
      },
      permissions: new Set(['tags.manage']),
    },
    assistant: {
      context: { ...business.context, actorKind: 'ai_agent', correlationId },
      permissions: new Set(['tags.manage']),
      agent: 'inbox',
    },
    system: { context: { ...business.context, correlationId }, permissions: 'all' },
    maya: maya.id,
    ken: ken.id,
    userId: user.id,
    setRule: (level, options = {}) =>
      database.withTenant(business.context, async (sql) => {
        const rule = { agent: 'inbox', action: 'update_conversation', contactId: null, ...options };
        await sql.query(
          `insert into ai.autonomy_rules (business_id, agent, action, contact_id, level)
           values (app.business_id(), $1, $2, $3, $4)
           on conflict on constraint autonomy_rules_unique do update set level = excluded.level`,
          [rule.agent, rule.action, rule.contactId, level],
        );
      }),
  };
}

/** What a refused run must leave: the error, no tag, no event, and a denial in the audit log. */
async function expectHeld(
  world: World,
  run: Promise<unknown>,
  name: string,
  reason: 'approval_required' | 'not_delegable' = 'approval_required',
): Promise<void> {
  await expect(run).rejects.toThrow(ApprovalRequiredError);
  await expect(run).rejects.toMatchObject({ reason });
  expect(await tagsNamed(name)).toEqual([]);
  expect(await eventsOf(world.person.context.correlationId)).toEqual([]);
  expect((await audits(world.person.context.correlationId)).at(-1)).toMatchObject({
    outcome: 'denied',
    error_code: reason,
    actor_kind: 'ai_agent',
  });
}

describe('an assistant running a command', () => {
  it('is refused with no rule at all: every assistant starts at asking first', async () => {
    const world = await setUp();
    const run = runCommand(services, addTag, { name: 'No rule' }, world.assistant);
    await expectHeld(world, run, 'No rule');
    await expect(run).rejects.toThrow(ForbiddenError);
    await expect(run).rejects.toThrow(
      'The assistant may only propose this: a person has to approve it.',
    );
  });

  it.each(['suggest', 'ask'] as const)(
    'is refused when the business’s rule says %s, and nothing is changed',
    async (level) => {
      const world = await setUp();
      await world.setRule(level);
      await expectHeld(
        world,
        runCommand(services, addTag, { name: `Held at ${level}` }, world.assistant),
        `Held at ${level}`,
      );
    },
  );

  it('runs when the rule says act, as the assistant, audited like any command', async () => {
    const world = await setUp();
    await world.setRule('act');
    const { id } = await runCommand(services, addTag, { name: 'On its own' }, world.assistant);
    expect(await tagsNamed('On its own')).toEqual([{ id }]);
    expect(await eventsOf(world.person.context.correlationId)).toEqual([
      {
        type: 'tag.added',
        actor_kind: 'ai_agent',
        actor_id: null,
        proposal_id: null,
        payload: { proposal: null },
      },
    ]);
    expect(await audits(world.person.context.correlationId)).toEqual([
      {
        command: 'test.add_tag',
        outcome: 'ok',
        error_code: null,
        actor_kind: 'ai_agent',
        proposal_id: null,
      },
    ]);
  });

  it('follows a contact’s own rule before the business’s, in both directions', async () => {
    const world = await setUp();
    await world.setRule('act');
    await world.setRule('ask', { contactId: world.maya });
    // The business lets it act, and Maya's own rule holds it back for Maya alone.
    await expectHeld(
      world,
      runCommand(services, addTag, { name: 'For Maya', contactId: world.maya }, world.assistant),
      'For Maya',
    );
    await runCommand(services, addTag, { name: 'For Ken', contactId: world.ken }, world.assistant);
    expect(await tagsNamed('For Ken')).toHaveLength(1);

    const other = await setUp();
    await other.setRule('ask');
    await other.setRule('act', { contactId: other.maya });
    // The business asks first, and Maya's own rule lets it act for Maya alone.
    await runCommand(
      services,
      addTag,
      { name: 'Maya acts', contactId: other.maya },
      other.assistant,
    );
    expect(await tagsNamed('Maya acts')).toHaveLength(1);
    await expect(
      runCommand(services, addTag, { name: 'Ken asks', contactId: other.ken }, other.assistant),
    ).rejects.toThrow(ApprovalRequiredError);
    await expect(
      runCommand(services, addTag, { name: 'Nobody asks' }, other.assistant),
    ).rejects.toThrow(ApprovalRequiredError);
    expect(await tagsNamed('Ken asks')).toEqual([]);
    expect(await tagsNamed('Nobody asks')).toEqual([]);
  });

  it('follows the business’s rule alone for a command that concerns no contact', async () => {
    const world = await setUp();
    await expectHeld(
      world,
      runCommand(services, addTagForNobody, { name: 'For nobody' }, world.assistant),
      'For nobody',
    );
    // A contact's own rule says nothing about it, even for an input that names that contact.
    await world.setRule('act', { contactId: world.maya });
    await expect(
      runCommand(
        services,
        addTagForNobody,
        { name: 'For nobody', contactId: world.maya },
        world.assistant,
      ),
    ).rejects.toThrow(ApprovalRequiredError);
    await world.setRule('act');
    await runCommand(services, addTagForNobody, { name: 'For nobody' }, world.assistant);
    expect(await tagsNamed('For nobody')).toHaveLength(1);
  });

  it('is not let through by a rule for another assistant, another action or another business', async () => {
    const world = await setUp();
    await world.setRule('act', { agent: 'copilot' });
    await world.setRule('act', { action: 'send_message' });
    const sibling = await setUp(world.person.context.agencyId);
    await sibling.setRule('act');
    await expectHeld(
      world,
      runCommand(services, addTag, { name: 'Not this rule' }, world.assistant),
      'Not this rule',
    );
    // Each of those rules does let its own assistant, in its own business, act.
    await runCommand(
      services,
      addTag,
      { name: 'Copilot acts' },
      { ...world.assistant, agent: 'copilot' },
    );
    await runCommand(services, addTag, { name: 'Sibling acts' }, sibling.assistant);
    expect(await tagsNamed('Copilot acts')).toHaveLength(1);
    expect(await tagsNamed('Sibling acts')).toHaveLength(1);
  });

  it('is held again the moment the rule goes back to asking', async () => {
    const world = await setUp();
    await world.setRule('act');
    await runCommand(services, addTag, { name: 'While acting' }, world.assistant);
    await world.setRule('ask');
    await expect(
      runCommand(services, addTag, { name: 'After asking' }, world.assistant),
    ).rejects.toThrow(ApprovalRequiredError);
    expect(await tagsNamed('After asking')).toEqual([]);
  });

  it('can never run a command that names no delegation, whatever the rules say', async () => {
    const world = await setUp();
    await world.setRule('act');
    await expectHeld(
      world,
      runCommand(services, addTagByPeople, { name: 'Not delegable' }, world.assistant),
      'Not delegable',
      'not_delegable',
    );
    await expect(
      runCommand(services, addTagByPeople, { name: 'Not delegable' }, world.assistant),
    ).rejects.toThrow('An assistant cannot run this command.');
  });

  it('runs a command that holds its own rule for assistants, and is held to that rule by the command', async () => {
    const world = await setUp();
    // No autonomy rule is read for it: with none at all, and with one that says suggest.
    const first = await runCommand(
      services,
      addTagByOwnRule,
      { name: 'Own rule' },
      world.assistant,
    );
    expect(await tagsNamed('Own rule')).toEqual([{ id: first.id }]);
    await world.setRule('suggest');
    await runCommand(services, addTagByOwnRule, { name: 'Own rule again' }, world.assistant);
    expect(await tagsNamed('Own rule again')).toHaveLength(1);
    // Nor does it need to say which assistant it is: the rule is the command's, not an agent's.
    const { agent: _agent, ...nameless } = world.assistant;
    await runCommand(services, addTagByOwnRule, { name: 'Own rule, nameless' }, nameless);
    expect(await tagsNamed('Own rule, nameless')).toHaveLength(1);
    expect((await audits(world.person.context.correlationId)).at(-1)).toMatchObject({
      outcome: 'ok',
      actor_kind: 'ai_agent',
    });
    // Its own rule is what holds the assistant, and only the assistant.
    await expect(
      runCommand(services, addTagByOwnRule, { name: 'Forbidden' }, world.assistant),
    ).rejects.toThrow('An assistant may not add this tag.');
    expect(await tagsNamed('Forbidden')).toEqual([]);
    await runCommand(services, addTagByOwnRule, { name: 'Forbidden' }, world.person);
    expect(await tagsNamed('Forbidden')).toHaveLength(1);
  });

  it('holds a command that names a delegation to its autonomy rule, whatever rule of its own it has', async () => {
    const world = await setUp();
    await expectHeld(
      world,
      runCommand(services, addTagByBothRules, { name: 'Both rules' }, world.assistant),
      'Both rules',
    );
    await world.setRule('act');
    await runCommand(services, addTagByBothRules, { name: 'Both rules' }, world.assistant);
    expect(await tagsNamed('Both rules')).toHaveLength(1);
    await expect(
      runCommand(services, addTagByBothRules, { name: 'Forbidden' }, world.assistant),
    ).rejects.toThrow('An assistant may not add this tag.');
  });

  it('is refused when the invocation does not say which assistant it is', async () => {
    const world = await setUp();
    await world.setRule('act');
    const { agent: _agent, ...nameless } = world.assistant;
    await expectHeld(
      world,
      runCommand(services, addTag, { name: 'Nameless' }, nameless),
      'Nameless',
      'not_delegable',
    );
  });

  it('still needs the permission the command needs, and is told so first', async () => {
    const world = await setUp();
    await world.setRule('act');
    const run = runCommand(
      services,
      addTag,
      { name: 'No permission' },
      { ...world.assistant, permissions: new Set() },
    );
    await expect(run).rejects.toMatchObject({ permission: 'tags.manage' });
    await expect(run).rejects.not.toThrow(ApprovalRequiredError);
    expect(await tagsNamed('No permission')).toEqual([]);
    expect(await audits(world.person.context.correlationId)).toMatchObject([
      { outcome: 'denied', error_code: 'forbidden' },
    ]);
  });
});

describe('the in-app assistant', () => {
  const copilot = (world: World): Invocation => ({ ...world.assistant, agent: 'copilot' });

  it('builds a draft with no rule at all, and is held to asking the moment the business says so', async () => {
    const world = await setUp();
    await runCommand(services, draftTag, { name: 'Drafted freely' }, copilot(world));
    expect(await tagsNamed('Drafted freely')).toHaveLength(1);
    expect(
      await withTenant(db, world.person.context, (trx) =>
        readAutonomy(trx, { agent: 'copilot', action: 'build_draft' }),
      ),
    ).toEqual({ level: 'act', source: 'default', businessLevel: 'act' });

    await world.setRule('ask', { agent: 'copilot', action: 'build_draft' });
    await expect(
      runCommand(services, draftTag, { name: 'Drafted after the rule' }, copilot(world)),
    ).rejects.toMatchObject({ reason: 'approval_required' });
    expect(await tagsNamed('Drafted after the rule')).toEqual([]);
  });

  it('never publishes with no rule: making something live starts at asking', async () => {
    const world = await setUp();
    await expect(
      runCommand(services, publishTag, { name: 'Published unasked' }, copilot(world)),
    ).rejects.toMatchObject({ reason: 'approval_required' });
    expect(await tagsNamed('Published unasked')).toEqual([]);
  });

  it('is the only assistant that starts there: any other is held from building a draft', async () => {
    const world = await setUp();
    await expect(
      runCommand(services, draftTag, { name: 'Drafted by the inbox' }, world.assistant),
    ).rejects.toMatchObject({ reason: 'approval_required' });
    expect(await tagsNamed('Drafted by the inbox')).toEqual([]);
  });

  it('still needs the permission the command needs', async () => {
    const world = await setUp();
    await expect(
      runCommand(
        services,
        draftTag,
        { name: 'Drafted without the role' },
        { ...copilot(world), permissions: new Set() },
      ),
    ).rejects.toThrow('it needs tags.manage');
    expect(await tagsNamed('Drafted without the role')).toEqual([]);
  });
});

describe('everyone who is not an assistant', () => {
  it('is not held by autonomy rules: a person and the system run the command at any level', async () => {
    for (const level of ['suggest', 'ask', 'act'] as const) {
      const world = await setUp();
      await world.setRule(level);
      await runCommand(services, addTag, { name: `Person at ${level}` }, world.person);
      await runCommand(services, addTag, { name: `System at ${level}` }, world.system);
      await runCommand(services, addTagByPeople, { name: `Plain at ${level}` }, world.person);
      expect(await tagsNamed(`Person at ${level}`)).toHaveLength(1);
      expect(await tagsNamed(`System at ${level}`)).toHaveLength(1);
      expect(await tagsNamed(`Plain at ${level}`)).toHaveLength(1);
    }
  });
});

describe('readAutonomy', () => {
  it('reads the level in force for an assistant, an action and a contact', async () => {
    const world = await setUp();
    const read = (contactId?: string) =>
      withTenant(db, world.person.context, (trx) =>
        readAutonomy(trx, {
          agent: 'inbox',
          action: 'update_conversation',
          ...(contactId === undefined ? {} : { contactId }),
        }),
      );
    expect(await read()).toEqual({ level: 'ask', source: 'default', businessLevel: 'ask' });
    await world.setRule('suggest');
    await world.setRule('act', { contactId: world.maya });
    expect(await read()).toEqual({
      level: 'suggest',
      source: 'business',
      businessLevel: 'suggest',
    });
    expect(await read(world.maya)).toEqual({
      level: 'act',
      source: 'contact',
      businessLevel: 'suggest',
    });
    expect(await read(world.ken)).toEqual({
      level: 'suggest',
      source: 'business',
      businessLevel: 'suggest',
    });
  });
});

const link = (): ProposalLink => ({ id: randomUUID(), agent: 'inbox' });

describe('runProposedCommand', () => {
  it('runs the command as whoever applies, between the store’s begin and finish, in one transaction', async () => {
    const world = await setUp();
    const proposal = link();
    const seen: string[] = [];
    const done = await runProposedCommand(services, addTag, { name: ' Applied ' }, world.person, {
      proposal,
      async begin(trx, input) {
        seen.push(`begin ${input.name}`);
        // Nothing of the command exists yet.
        const tags = await trx
          .selectFrom('crm.tags')
          .select('id')
          .where('name', '=', 'Applied')
          .execute();
        seen.push(`tags before: ${String(tags.length)}`);
        return 'run';
      },
      async finish(trx, input, output, eventIds) {
        // The command's change is visible here, and nowhere else yet.
        const tags = await trx
          .selectFrom('crm.tags')
          .select('id')
          .where('name', '=', 'Applied')
          .execute();
        seen.push(`finish ${input.name} ${String(tags.length)} ${String(eventIds.length)}`);
        expect(eventIds).toEqual([output.eventId]);
        expect(await tagsNamed('Applied')).toEqual([]);
      },
    });
    expect(seen).toEqual(['begin Applied', 'tags before: 0', 'finish Applied 1 1']);
    expect(done.ran).toBe(true);
    expect(await tagsNamed('Applied')).toHaveLength(1);
    // Attributed to the person, and marked with the proposal in both logs and to the handler.
    expect(await eventsOf(world.person.context.correlationId)).toEqual([
      {
        type: 'tag.added',
        actor_kind: 'user',
        actor_id: world.userId,
        proposal_id: proposal.id,
        payload: { proposal },
      },
    ]);
    expect(await audits(world.person.context.correlationId)).toEqual([
      {
        command: 'test.add_tag',
        outcome: 'ok',
        error_code: null,
        actor_kind: 'user',
        proposal_id: proposal.id,
      },
    ]);
  });

  it('runs nothing and audits nothing when the store says it was already done', async () => {
    const world = await setUp();
    let finished = false;
    const done = await runProposedCommand(services, addTag, { name: 'Again' }, world.person, {
      proposal: link(),
      begin: () => Promise.resolve('repeat'),
      finish: () => {
        finished = true;
        return Promise.resolve();
      },
    });
    expect(done).toEqual({ ran: false });
    expect(finished).toBe(false);
    expect(await tagsNamed('Again')).toEqual([]);
    expect(await eventsOf(world.person.context.correlationId)).toEqual([]);
    expect(await audits(world.person.context.correlationId)).toEqual([]);
  });

  it('changes nothing when the store refuses, and records the refusal with the proposal', async () => {
    const world = await setUp();
    const proposal = link();
    await expect(
      runProposedCommand(services, addTag, { name: 'Refused' }, world.person, {
        proposal,
        begin: () =>
          Promise.reject(new ValidationError([{ path: '', code: 'stale', message: 'Stale.' }])),
        finish: () => Promise.resolve(),
      }),
    ).rejects.toThrow('Stale.');
    expect(await tagsNamed('Refused')).toEqual([]);
    expect(await audits(world.person.context.correlationId)).toEqual([
      {
        command: 'test.add_tag',
        outcome: 'invalid',
        error_code: 'validation',
        actor_kind: 'user',
        proposal_id: proposal.id,
      },
    ]);
  });

  it('takes the command’s change back when the store cannot mark the proposal', async () => {
    const world = await setUp();
    await expect(
      runProposedCommand(services, addTag, { name: 'Unmarked' }, world.person, {
        proposal: link(),
        begin: () => Promise.resolve('run'),
        finish: () => Promise.reject(new Error('the proposal could not be marked')),
      }),
    ).rejects.toThrow('the proposal could not be marked');
    expect(await tagsNamed('Unmarked')).toEqual([]);
    expect(await eventsOf(world.person.context.correlationId)).toEqual([]);
    expect(await audits(world.person.context.correlationId)).toMatchObject([
      { outcome: 'failed', error_code: 'internal' },
    ]);
  });

  it('never marks the proposal when the command itself fails', async () => {
    const world = await setUp();
    let finished = false;
    await expect(
      runProposedCommand(services, addTag, { name: 'Failing', fail: true }, world.person, {
        proposal: link(),
        begin: () => Promise.resolve('run'),
        finish: () => {
          finished = true;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow('the handler failed');
    expect(finished).toBe(false);
    expect(await tagsNamed('Failing')).toEqual([]);
  });

  it('validates the input and checks the permission before the store is asked anything', async () => {
    const world = await setUp();
    const proposal = link();
    let began = 0;
    const hooks = {
      proposal,
      begin: () => {
        began += 1;
        return Promise.resolve('run' as const);
      },
      finish: () => Promise.resolve(),
    };
    await expect(
      runProposedCommand(services, addTag, { name: '  ' }, world.person, hooks),
    ).rejects.toThrow(ValidationError);
    const viewer: Invocation = { ...world.person, permissions: new Set() };
    await expect(
      runProposedCommand(services, addTag, { name: 'Not allowed' }, viewer, hooks),
    ).rejects.toMatchObject({ permission: 'tags.manage' });
    const nobody: Services = { db, authorize: () => false };
    await expect(
      runProposedCommand(nobody, addTag, { name: 'Not allowed' }, world.person, hooks),
    ).rejects.toThrow(ForbiddenError);
    expect(began).toBe(0);
    expect(await tagsNamed('Not allowed')).toEqual([]);
    expect(await audits(world.person.context.correlationId)).toEqual([
      {
        command: 'test.add_tag',
        outcome: 'invalid',
        error_code: 'validation',
        actor_kind: 'user',
        proposal_id: proposal.id,
      },
      {
        command: 'test.add_tag',
        outcome: 'denied',
        error_code: 'forbidden',
        actor_kind: 'user',
        proposal_id: proposal.id,
      },
      {
        command: 'test.add_tag',
        outcome: 'denied',
        error_code: 'forbidden',
        actor_kind: 'user',
        proposal_id: proposal.id,
      },
    ]);
  });

  it('holds an assistant that applies a proposal to its rule, like any run of the command', async () => {
    const world = await setUp();
    const proposal = link();
    const hooks = {
      proposal,
      begin: () => Promise.resolve('run' as const),
      finish: () => Promise.resolve(),
    };
    await expect(
      runProposedCommand(services, addTag, { name: 'By itself' }, world.assistant, hooks),
    ).rejects.toThrow(ApprovalRequiredError);
    expect(await tagsNamed('By itself')).toEqual([]);
    expect(await audits(world.person.context.correlationId)).toEqual([
      {
        command: 'test.add_tag',
        outcome: 'denied',
        error_code: 'approval_required',
        actor_kind: 'ai_agent',
        proposal_id: proposal.id,
      },
    ]);
    await world.setRule('act');
    const done = await runProposedCommand(
      services,
      addTag,
      { name: 'By itself' },
      world.assistant,
      hooks,
    );
    expect(done.ran).toBe(true);
    expect(await tagsNamed('By itself')).toHaveLength(1);
  });
});

describe('defineProposable', () => {
  const calls: string[] = [];
  const proposable = defineProposable({
    kind: 'conversation_status',
    command: addTag,
    agents: ['inbox'],
    subject: (_trx, input) =>
      Promise.resolve(input.contactId === undefined ? {} : { contactId: input.contactId }),
    revision: (_trx, input) => Promise.resolve(`name:${input.name}`),
    change: (input, changes) => ({ ...input, ...changes }),
    present: (_trx, input) => Promise.resolve({ kind: 'tag', name: input.name }),
    capture: (_trx, input) => {
      calls.push(`capture ${input.name}`);
      return Promise.resolve({ before: `none for ${input.name}` });
    },
    result: (output) => ({ tagId: output.id }),
    undo: (captured, output, input): UndoPlan => ({
      kind: 'conversation_status',
      input: { remove: output.id, was: captured.before, name: input.name },
    }),
  });

  it('refuses a command that names no delegation: no assistant could ever propose it', () => {
    expect(() =>
      defineProposable({
        kind: 'conversation_status',
        command: addTagByPeople,
        agents: ['inbox'],
        subject: () => Promise.resolve({}),
        revision: () => Promise.resolve(''),
        present: () => Promise.resolve({}),
        capture: () => Promise.resolve(null),
        result: () => ({}),
        undo: () => ({ impossible: 'never' }),
      }),
    ).toThrow('test.add_tag_by_people names no delegation, so it cannot be proposed.');
  });

  it('says what it runs, what it needs, and which action a rule about it names', () => {
    expect(proposable).toMatchObject({
      kind: 'conversation_status',
      commandName: 'test.add_tag',
      permission: 'tags.manage',
      action: 'update_conversation',
      agents: ['inbox'],
      changeable: true,
    });
    expect(proposableOf([proposable], 'conversation_status')).toBe(proposable);
    expect(proposableOf([proposable], 'reply')).toBeUndefined();
  });

  it('checks an input as the command would, and reads it as the command would', async () => {
    const world = await setUp();
    expect(() => {
      proposable.check({ name: '' });
    }).toThrow(ValidationError);
    expect(() => {
      proposable.check({ name: 'Fine', extra: true });
    }).toThrow(ValidationError);
    proposable.check({ name: 'Fine' });
    await db.transaction().execute(async (trx) => {
      // Trimmed, as the command's own schema leaves it.
      expect(await proposable.revision(trx, { name: '  Spaced ' })).toBe('name:Spaced');
      expect(await proposable.subject(trx, { name: 'x', contactId: world.maya })).toEqual({
        contactId: world.maya,
      });
      expect(await proposable.present(trx, { name: ' Shown ' }, world.person)).toEqual({
        kind: 'tag',
        name: 'Shown',
      });
      await expect(proposable.revision(trx, { name: '' })).rejects.toThrow(ValidationError);
    });
    expect(proposable.change({ name: 'Old' }, { name: 'New' })).toEqual({ name: 'New' });
  });

  it('cannot be changed where its module allows no change', () => {
    const fixed = defineProposable({
      kind: 'reply',
      command: addTag,
      agents: ['inbox'],
      subject: () => Promise.resolve({}),
      revision: () => Promise.resolve(''),
      present: () => Promise.resolve({}),
      capture: () => Promise.resolve(null),
      result: () => ({}),
      undo: () => ({ impossible: 'never' }),
    });
    expect(fixed.changeable).toBe(false);
    expect(() => fixed.change({ name: 'Old' }, { name: 'New' })).toThrow(
      'A reply proposal cannot be changed.',
    );
  });

  it('runs its command through the command layer and hands the store the outcome and the way back', async () => {
    const world = await setUp();
    calls.length = 0;
    const proposal = link();
    let finished: Parameters<ProposalHooks['finish']>[1] | undefined;
    const ran = await proposable.run(services, { name: 'Proposed' }, world.person, {
      proposal,
      begin: () => {
        calls.push('begin');
        return Promise.resolve('run');
      },
      finish: (_trx, done) => {
        calls.push('finish');
        finished = done;
        return Promise.resolve();
      },
    });
    expect(ran).toBe(true);
    // The store decides first; what reversing needs is captured before the command runs.
    expect(calls).toEqual(['begin', 'capture Proposed', 'finish']);
    const [tag] = await tagsNamed('Proposed');
    expect(finished).toEqual({
      result: { tagId: tag?.id },
      undo: {
        kind: 'conversation_status',
        input: { remove: tag?.id, was: 'none for Proposed', name: 'Proposed' },
      },
      eventIds: [expect.any(String)],
    });
    expect(await audits(world.person.context.correlationId)).toMatchObject([
      { command: 'test.add_tag', outcome: 'ok', proposal_id: proposal.id },
    ]);
  });

  it('captures nothing and runs nothing when the store says it was already done', async () => {
    const world = await setUp();
    calls.length = 0;
    const ran = await proposable.run(services, { name: 'Done before' }, world.person, {
      proposal: link(),
      begin: () => Promise.resolve('repeat'),
      finish: () => Promise.reject(new Error('finish must not be called')),
    });
    expect(ran).toBe(false);
    expect(calls).toEqual([]);
    expect(await tagsNamed('Done before')).toEqual([]);
  });

  it('is refused for a role without the command’s permission, and for an assistant held to asking', async () => {
    const world = await setUp();
    const hooks: ProposalHooks = {
      proposal: link(),
      begin: () => Promise.resolve('run'),
      finish: () => Promise.resolve(),
    };
    await expect(
      proposable.run(
        services,
        { name: 'Kept out' },
        { ...world.person, permissions: new Set() },
        hooks,
      ),
    ).rejects.toMatchObject({ permission: 'tags.manage' });
    await expect(
      proposable.run(services, { name: 'Kept out' }, world.assistant, hooks),
    ).rejects.toThrow(ApprovalRequiredError);
    expect(await tagsNamed('Kept out')).toEqual([]);
  });
});

describe('a proposable of a command that names no delegation', () => {
  const definition = {
    kind: 'field_value',
    agents: ['extraction'],
    action: 'update_field',
    subject: (_trx: unknown, input: { contactId?: string | undefined }) =>
      Promise.resolve(input.contactId === undefined ? {} : { contactId: input.contactId }),
    revision: () => Promise.resolve('as-it-was'),
    present: () => Promise.resolve({}),
    capture: () => Promise.resolve(null),
    result: () => ({}),
    undo: (): UndoPlan => ({ impossible: 'never' }),
  } as const;
  // A command that keeps its own rule for assistants, proposed under an action of its own.
  const byOwnRule = defineProposable({ ...definition, command: addTagByOwnRule });
  // A command no assistant may run: it can be proposed, and only a person applies it.
  const byPeople = defineProposable({ ...definition, command: addTagByPeople });
  const hooks = (): ProposalHooks => ({
    proposal: { id: randomUUID(), agent: 'extraction' },
    begin: () => Promise.resolve('run'),
    finish: () => Promise.resolve(),
  });
  const reader = (world: World): Invocation => ({ ...world.assistant, agent: 'extraction' });

  it('names the action its proposable gives, and a delegation’s action comes first', () => {
    expect(byOwnRule).toMatchObject({
      commandName: 'test.add_tag_by_own_rule',
      action: 'update_field',
    });
    expect(defineProposable({ ...definition, command: addTag }).action).toBe('update_conversation');
  });

  it('holds an assistant that applies it to the rule for that action, with no rule at all and at every level but act', async () => {
    const world = await setUp();
    const held = async (name: string): Promise<void> => {
      const run = byOwnRule.run(services, { name, contactId: world.maya }, reader(world), hooks());
      await expect(run).rejects.toThrow(ApprovalRequiredError);
      await expect(run).rejects.toMatchObject({ reason: 'approval_required' });
      expect(await tagsNamed(name)).toEqual([]);
    };
    await held('No rule');
    for (const level of ['suggest', 'ask'] as const) {
      await world.setRule(level, { agent: 'extraction', action: 'update_field' });
      await held(`At ${level}`);
    }
    // A rule for another assistant, another action or another contact lets nothing through.
    await world.setRule('ask', { agent: 'extraction', action: 'update_field' });
    await world.setRule('act', { agent: 'inbox', action: 'update_field' });
    await world.setRule('act', { agent: 'extraction', action: 'remember_fact' });
    await world.setRule('act', {
      agent: 'extraction',
      action: 'update_field',
      contactId: world.ken,
    });
    await held('Other rules');
    expect(await eventsOf(world.person.context.correlationId)).toEqual([]);
    expect((await audits(world.person.context.correlationId)).at(-1)).toMatchObject({
      command: 'test.add_tag_by_own_rule',
      outcome: 'denied',
      error_code: 'approval_required',
      actor_kind: 'ai_agent',
    });
  });

  it('lets the assistant apply it where the rule says act, and the command’s own rule still holds', async () => {
    const world = await setUp();
    await world.setRule('act', { agent: 'extraction', action: 'update_field' });
    expect(await byOwnRule.run(services, { name: 'Allowed' }, reader(world), hooks())).toBe(true);
    expect(await tagsNamed('Allowed')).toHaveLength(1);
    await expect(
      byOwnRule.run(services, { name: 'Forbidden' }, reader(world), hooks()),
    ).rejects.toThrow(ConflictError);
    // The contact's own rule comes first, as for any command.
    await world.setRule('ask', {
      agent: 'extraction',
      action: 'update_field',
      contactId: world.maya,
    });
    await expect(
      byOwnRule.run(services, { name: 'For Maya', contactId: world.maya }, reader(world), hooks()),
    ).rejects.toThrow(ApprovalRequiredError);
    expect(
      await byOwnRule.run(
        services,
        { name: 'For Ken', contactId: world.ken },
        reader(world),
        hooks(),
      ),
    ).toBe(true);
  });

  it('is refused for an assistant that does not say which one it is', async () => {
    const world = await setUp();
    await world.setRule('act', { agent: 'extraction', action: 'update_field' });
    const { agent: _agent, ...nameless } = reader(world);
    const run = byOwnRule.run(services, { name: 'Nameless' }, nameless, hooks());
    await expect(run).rejects.toMatchObject({ reason: 'not_delegable' });
    expect(await tagsNamed('Nameless')).toEqual([]);
  });

  it('lets a person apply it at any level, and runs nothing when the store says it was done', async () => {
    const world = await setUp();
    expect(await byOwnRule.run(services, { name: 'By a person' }, world.person, hooks())).toBe(
      true,
    );
    expect(await tagsNamed('By a person')).toHaveLength(1);
    // Already applied: nothing is checked and nothing runs, for an assistant held to asking too.
    expect(
      await byOwnRule.run(services, { name: 'Done before' }, reader(world), {
        ...hooks(),
        begin: () => Promise.resolve('repeat'),
      }),
    ).toBe(false);
    expect(await tagsNamed('Done before')).toEqual([]);
  });

  it('never lets an assistant run a command no assistant may run, whatever the rule says', async () => {
    const world = await setUp();
    await world.setRule('act', { agent: 'extraction', action: 'update_field' });
    const run = byPeople.run(services, { name: 'People only' }, reader(world), hooks());
    await expect(run).rejects.toMatchObject({ reason: 'not_delegable' });
    expect(await tagsNamed('People only')).toEqual([]);
    expect(await byPeople.run(services, { name: 'People only' }, world.person, hooks())).toBe(true);
  });
});
