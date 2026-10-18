// A field's value as something an assistant may propose, against real Postgres under
// row-level security: the fields' own command, run from a proposal by a person, by an API
// key and by the assistant, with the field's own rules holding for each. The proposal store
// is the AI module's; here its part is played by plain hooks.
import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  ApprovalRequiredError,
  type Invocation,
  type Proposable,
  type ProposalHooks,
  type Services,
  type UndoPlan,
} from '@repo/commands';
import {
  fieldDefinition,
  recordFields,
  type FieldDefinition,
  type RecordField,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ConflictError, NotFoundError, toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFieldProposables, crmRoutes } from '../index.js';

let database: TestDatabase;
let db: Database;
let services: Services;
let proposable: Proposable;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  const [only, ...more] = createFieldProposables();
  if (only === undefined || more.length > 0) throw new Error('Expected one proposable.');
  proposable = only;
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function call(operationId: string, invocation: Invocation, body?: unknown, params = {}) {
  const route = crmRoutes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, body, params, query: {} }, services);
}

async function setUp(
  options: Partial<Pick<FieldDefinition, 'aiFillSources' | 'aiOverwrite'>> = {},
) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const person: Invocation = {
    context: {
      ...business.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
  const contact = await database.fixtures.contact(person.context);
  const id = toPublicId('contact', contact.id);
  const field = fieldDefinition.parse(
    await call('createField', person, {
      key: 'venue',
      label: 'Venue',
      objectKey: 'contact',
      valueType: 'text',
      description: 'Where the event is held.',
      currency: null,
      options: [],
      aiFillSources: options.aiFillSources ?? ['conversations'],
      aiOverwrite: options.aiOverwrite ?? 'ask',
      archived: false,
    }),
  );
  const saved = async (): Promise<RecordField> => {
    const { items } = recordFields.parse(await call('getRecordFields', person, undefined, { id }));
    const [item] = items;
    if (item === undefined) throw new Error('The contact has no field.');
    return item;
  };
  /** The input an extraction proposal holds: the assistant's reading, made on the value now. */
  const proposed = async (value: unknown = 'Willow Park barn') => ({
    id,
    fieldId: field.id,
    value,
    revision: (await saved()).revision,
    aiSource: 'conversations',
    confidence: 0.9,
  });
  const assistant: Invocation = {
    context: { ...business.context, actorKind: 'ai_agent', correlationId: randomUUID() },
    permissions: new Set(['fields.values']),
    agent: 'extraction',
  };
  const setRule = (level: 'suggest' | 'ask' | 'act', action = 'update_field') =>
    database.withTenant(business.context, (sql) =>
      sql.query(
        `insert into ai.autonomy_rules (business_id, agent, action, level)
         values (app.business_id(), 'extraction', $1, $2)
         on conflict on constraint autonomy_rules_unique do update set level = excluded.level`,
        [action, level],
      ),
    );
  const types = async (value: string): Promise<void> => {
    await call(
      'setRecordField',
      person,
      { value, revision: (await saved()).revision },
      { id, fieldId: field.id },
    );
  };
  return {
    person,
    assistant,
    contactId: contact.id,
    id,
    field,
    saved,
    proposed,
    setRule,
    types,
    user,
  };
}

/** Runs the proposable as the store would, and keeps what the store would be handed. */
async function run(input: unknown, invocation: Invocation) {
  const done: { undo?: UndoPlan; result?: unknown; eventIds?: readonly string[] } = {};
  const hooks: ProposalHooks = {
    proposal: { id: randomUUID(), agent: 'extraction' },
    begin: () => Promise.resolve('run'),
    finish: (_trx, finished) => {
      Object.assign(done, finished);
      return Promise.resolve();
    },
  };
  const ran = await proposable.run(services, input, invocation, hooks);
  return { ran, ...done, proposalId: hooks.proposal.id };
}

/** The input of the command that reverses an applied proposal. */
function wayBack(undo: UndoPlan | undefined): Readonly<Record<string, unknown>> {
  if (undo === undefined || 'impossible' in undo) throw new Error('Nothing reverses this.');
  return undo.input;
}

describe('the proposable', () => {
  it('is the fields’ own command, for the extraction assistant, under the action update_field', () => {
    expect(proposable).toMatchObject({
      kind: 'field_value',
      commandName: 'field.value.set',
      permission: 'fields.values',
      action: 'update_field',
      agents: ['extraction'],
      changeable: true,
    });
  });

  it('is about the record, is made on the saved value, and shows the change as a card does', async () => {
    const { person, contactId, id, field, proposed, types, saved } = await setUp();
    const input = await proposed();
    const read = <T>(work: (trx: Parameters<Proposable['subject']>[0]) => Promise<T>) =>
      withTenant(db, person.context, work);
    expect(await read((trx) => proposable.subject(trx, input))).toEqual({
      recordId: contactId,
      contactId,
    });
    expect(await read((trx) => proposable.revision(trx, input))).toBe(input.revision);
    expect(await read((trx) => proposable.present(trx, input, person))).toEqual({
      kind: 'field_value',
      fieldId: field.id,
      label: 'Venue',
      from: null,
      fromSource: null,
      to: 'Willow Park barn',
    });
    // A person fills the field meanwhile: the proposal's fingerprint no longer matches.
    await types('The old mill');
    expect(await read((trx) => proposable.revision(trx, input))).toBe((await saved()).revision);
    expect(await read((trx) => proposable.revision(trx, input))).not.toBe(input.revision);
    expect(await read((trx) => proposable.present(trx, input, person))).toMatchObject({
      from: 'The old mill',
      fromSource: 'user',
    });
    // An input that is not the command's is refused before anything is read.
    expect(() => {
      proposable.check({ ...input, tags: ['vip'] });
    }).toThrow(ValidationError);
    expect(() => {
      proposable.check({ ...input, aiSource: 'the_message_said_so' });
    }).toThrow(ValidationError);
    await expect(
      read((trx) => proposable.subject(trx, { ...input, id: 'con_01h455vb4pex5vsknk084sn02q' })),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(id).toMatch(/^con_/);
  });

  it('lets a person change the value first: it is then theirs, with nothing of the assistant’s on it', async () => {
    const { person, proposed, saved } = await setUp();
    const input = await proposed();
    const changed = proposable.change(input, { value: 'The small barn', aiSource: 'forms' });
    expect(changed).toEqual({
      id: input.id,
      fieldId: input.fieldId,
      revision: input.revision,
      value: 'The small barn',
    });
    expect((await run(changed, person)).ran).toBe(true);
    expect(await saved()).toMatchObject({
      value: 'The small barn',
      source: { kind: 'user', you: true },
      confidence: null,
      confirmedAt: null,
    });
  });
});

describe('a person applying the assistant’s value', () => {
  it('saves it as the assistant’s, confirmed by them, and Undo puts back what was there', async () => {
    const { person, proposed, saved, types, field, id } = await setUp();
    await types('The old mill');
    const before = await saved();
    const { ran, undo, proposalId } = await run(await proposed(), person);
    expect(ran).toBe(true);
    const after = await saved();
    expect(after).toMatchObject({
      value: 'Willow Park barn',
      source: { kind: 'ai_agent', you: false },
      confirmedBy: { you: true },
    });
    expect(after.confidence).toBeCloseTo(0.9);
    expect(after.confirmedAt).not.toBeNull();
    const [event] = await database.as('crm_owner', (sql) =>
      sql.query<{ actor_kind: string; proposal_id: string }>(
        `select actor_kind, proposal_id from events.events
         where type = 'field.value_set' and proposal_id = $1`,
        [proposalId],
      ),
    );
    expect(event).toEqual({ actor_kind: 'user', proposal_id: proposalId });
    expect(undo).toEqual({
      kind: 'field_value',
      input: { id, fieldId: field.id, value: 'The old mill', revision: after.revision },
    });
    // The way back is the same command, as whoever undoes: the old value, as their own.
    expect((await run(wayBack(undo), person)).ran).toBe(true);
    expect(await saved()).toMatchObject({
      value: before.value,
      source: { kind: 'user', you: true },
      confirmedAt: null,
    });
  });

  it('puts an empty field back to empty on Undo, and is refused once the value changed again', async () => {
    const { person, proposed, saved, types } = await setUp();
    const { undo } = await run(await proposed(), person);
    const back = wayBack(undo);
    expect(back['value']).toBeNull();
    await types('Changed by hand since');
    await expect(run(back, person)).rejects.toBeInstanceOf(ConflictError);
    expect((await saved()).value).toBe('Changed by hand since');
  });

  it('is held to the field’s AI sources: a field that does not take conversations takes no such value', async () => {
    for (const aiFillSources of [[], ['forms']] as const) {
      const { person, proposed, saved } = await setUp({ aiFillSources: [...aiFillSources] });
      await expect(run(await proposed(), person)).rejects.toMatchObject({
        name: 'ValidationError',
        issues: [{ path: '/aiSource', code: 'ai_source_disabled' }],
      });
      expect((await saved()).value).toBeNull();
    }
  });

  it('is held to "never": no approval replaces a value a person entered or confirmed', async () => {
    const { person, proposed, saved, types } = await setUp({ aiOverwrite: 'never' });
    // An empty field is filled.
    await run(await proposed('First reading'), person);
    expect(await saved()).toMatchObject({ value: 'First reading', source: { kind: 'ai_agent' } });
    // What the person confirmed by approving is now a person's.
    await expect(run(await proposed('Second reading'), person)).rejects.toBeInstanceOf(
      ConflictError,
    );
    await types('Typed by hand');
    await expect(run(await proposed('Third reading'), person)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await saved()).value).toBe('Typed by hand');
  });

  it('is stale once the value has changed, as any save from an old page is', async () => {
    const { person, proposed, saved, types } = await setUp();
    const input = await proposed();
    await types('Typed meanwhile');
    await expect(run(input, person)).rejects.toBeInstanceOf(ConflictError);
    expect((await saved()).value).toBe('Typed meanwhile');
  });

  it('cannot claim an AI source outside a proposal, as before', async () => {
    const { person, proposed, id, field, saved } = await setUp();
    const { id: _id, fieldId: _fieldId, ...body } = await proposed();
    await expect(
      call('setRecordField', person, body, { id, fieldId: field.id }),
    ).rejects.toMatchObject({ issues: [{ code: 'trusted_ai_only' }] });
    expect((await saved()).value).toBeNull();
  });

  it('saves the value as an API key’s own when a key applies it', async () => {
    const { person, proposed, saved } = await setUp();
    const key: Invocation = {
      context: {
        agencyId: person.context.agencyId,
        ...(person.context.businessId === undefined
          ? {}
          : { businessId: person.context.businessId }),
        actorKind: 'api_key',
        actorId: randomUUID(),
        correlationId: randomUUID(),
      },
      permissions: new Set(['fields.values']),
    };
    expect((await run(await proposed(), key)).ran).toBe(true);
    expect(await saved()).toMatchObject({
      value: 'Willow Park barn',
      source: { kind: 'api_key' },
      confidence: null,
      confirmedAt: null,
      confirmedBy: null,
    });
  });

  it('needs the permission the command needs', async () => {
    const { person, proposed, saved } = await setUp();
    await expect(
      run(await proposed(), { ...person, permissions: new Set(['contacts.manage']) }),
    ).rejects.toMatchObject({ permission: 'fields.values' });
    expect((await saved()).value).toBeNull();
  });
});

describe('the assistant applying its own proposal', () => {
  it('is refused with no rule, at suggest and at ask, and by a rule for another action', async () => {
    const { assistant, proposed, saved, setRule } = await setUp();
    const input = await proposed();
    await expect(run(input, assistant)).rejects.toBeInstanceOf(ApprovalRequiredError);
    for (const level of ['suggest', 'ask'] as const) {
      await setRule(level);
      await expect(run(input, assistant)).rejects.toMatchObject({ reason: 'approval_required' });
    }
    await setRule('act', 'remember_fact');
    await expect(run(input, assistant)).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect((await saved()).value).toBeNull();
  });

  it('fills an empty field at act, as the assistant, unconfirmed', async () => {
    const { assistant, proposed, saved, setRule } = await setUp();
    await setRule('act');
    expect((await run(await proposed(), assistant)).ran).toBe(true);
    const after = await saved();
    expect(after).toMatchObject({
      value: 'Willow Park barn',
      source: { kind: 'ai_agent', you: false },
      confirmedAt: null,
      confirmedBy: null,
    });
    expect(after.confidence).toBeCloseTo(0.9);
  });

  it('never replaces a value a person typed under "ask", even at act', async () => {
    const { assistant, proposed, saved, setRule, types } = await setUp();
    await setRule('act');
    await types('The old mill');
    await expect(run(await proposed(), assistant)).rejects.toBeInstanceOf(ConflictError);
    expect(await saved()).toMatchObject({ value: 'The old mill', source: { kind: 'user' } });
  });

  it('cannot fill a field whose AI source is off, even at act', async () => {
    const { assistant, proposed, saved, setRule } = await setUp({ aiFillSources: ['forms'] });
    await setRule('act');
    await expect(run(await proposed(), assistant)).rejects.toBeInstanceOf(ValidationError);
    expect((await saved()).value).toBeNull();
  });
});
