// Migration 0084 (the in-app assistant) at the database's own level: what its three tables
// keep and refuse, who reads and writes a conversation, the hourly sweep, and what
// ai.proposals now holds about a form. What a turn does with these tables is the AI
// module's to prove (packages/modules/ai), and the isolation of every actor is in
// tests/02_tenant_isolation.sql.
import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

/** A business, and someone signed in there acting themselves. */
async function person(agencyId?: string, businessId?: { context: TenantContext }) {
  const agency = agencyId ?? (await database.fixtures.agency()).id;
  const created = businessId ?? (await database.fixtures.business(agency));
  const user = await database.fixtures.user();
  const context: TenantContext = {
    ...created.context,
    actorKind: 'user',
    userId: user.id,
    actorId: user.id,
    correlationId: randomUUID(),
  };
  return { agencyId: agency, business: created, context, userId: user.id };
}
/** The worker in that business: the system, on nobody's behalf. */
const worker = (context: TenantContext): TenantContext => ({
  agencyId: context.agencyId,
  ...(context.businessId === undefined ? {} : { businessId: context.businessId }),
  actorKind: 'system',
  correlationId: context.correlationId,
});

const insert = (
  context: TenantContext,
  table: string,
  row: Record<string, unknown>,
): Promise<{ id: string } & Record<string, unknown>> => {
  const names = Object.keys(row);
  return database.withTenant(context, (sql) =>
    sql.one<{ id: string } & Record<string, unknown>>(
      `insert into ai.${table} (business_id, ${names.join(', ')})
       values (app.business_id(), ${names.map((_, index) => `$${String(index + 1)}`).join(', ')})
       returning *`,
      names.map((name) => row[name]),
    ),
  );
};
const thread = (context: TenantContext, columns: Record<string, unknown> = {}) =>
  insert(context, 'assistant_threads', {
    user_id: context.userId,
    title: 'Build a form',
    ...columns,
  });
const turn = (context: TenantContext, threadId: string, columns: Record<string, unknown> = {}) =>
  insert(context, 'assistant_turns', {
    thread_id: threadId,
    user_id: context.userId,
    page: '{"route": "/forms"}',
    correlation_id: randomUUID(),
    ...columns,
  });
const message = (
  context: TenantContext,
  threadId: string,
  turnId: string,
  columns: Record<string, unknown> = {},
) =>
  insert(context, 'assistant_messages', {
    thread_id: threadId,
    turn_id: turnId,
    user_id: context.userId,
    seq: 1,
    kind: 'user',
    text: 'Build a form',
    ...columns,
  });
const refused = async (work: Promise<unknown>, constraint: string): Promise<void> => {
  await expect(work).rejects.toMatchObject({ constraint });
};
const FINISHED = { status: 'finished', outcome: 'answered', finished_at: new Date() };

describe('a conversation with the assistant', () => {
  it('keeps a bounded continuity checkpoint and a private, uniquely identified tool execution journal', async () => {
    const owner = await person();
    const colleague = await person(owner.agencyId, owner.business);
    const made = await thread(owner.context);
    const started = await turn(owner.context, made.id);
    const record = {
      thread_id: made.id,
      turn_id: started.id,
      user_id: owner.userId,
      call_id: 'provider-call-1',
      operation_id: 'createForm',
      effect: 'draft',
    };
    const call = await insert(worker(owner.context), 'assistant_tool_calls', record);
    expect(call).toMatchObject({ state: 'started', finished_at: null });
    await expect(
      insert(worker(owner.context), 'assistant_tool_calls', record),
    ).rejects.toMatchObject({ code: '23505' });
    expect(
      await database.withTenant(colleague.context, (sql) =>
        sql.query('select id from ai.assistant_tool_calls'),
      ),
    ).toEqual([]);
    expect(
      await database.withTenant(owner.context, (sql) =>
        sql.query('select id from ai.assistant_tool_calls'),
      ),
    ).toEqual([{ id: call.id }]);
    expect(
      await database.withTenant(owner.context, (sql) =>
        sql.query(
          'update ai.assistant_tool_calls set state = $1, finished_at = now() where id = $2 returning id',
          ['completed', call.id],
        ),
      ),
    ).toEqual([]);
    await expect(
      database.withTenant(worker(owner.context), (sql) =>
        sql.query('update ai.assistant_threads set checkpoint = $1 where id = $2', ['[]', made.id]),
      ),
    ).rejects.toMatchObject({ constraint: 'assistant_checkpoint_object' });
    await expect(
      database.withTenant(owner.context, (sql) =>
        sql.query('update ai.assistant_threads set checkpoint = $1 where id = $2', [
          '{"version":1}',
          made.id,
        ]),
      ),
    ).rejects.toMatchObject({ constraint: 'assistant_checkpoint_worker_only' });
    await expect(thread(owner.context, { checkpoint: '{"version":1}' })).rejects.toMatchObject({
      constraint: 'assistant_checkpoint_worker_only',
    });
    await database.withTenant(worker(owner.context), (sql) =>
      sql.query('update ai.assistant_threads set checkpoint = $1 where id = $2', [
        '{"version":1}',
        made.id,
      ]),
    );
    expect(
      await database.withTenant(owner.context, (sql) =>
        sql.one('select checkpoint from ai.assistant_threads where id = $1', [made.id]),
      ),
    ).toEqual({ checkpoint: { version: 1 } });
    await database.withTenant(worker(owner.context), (sql) =>
      sql.query(
        'update ai.assistant_tool_calls set state = $1, finished_at = now() where id = $2',
        ['uncertain', call.id],
      ),
    );
    expect(
      await database.withTenant(owner.context, (sql) =>
        sql.one('select state from ai.assistant_tool_calls where id = $1', [call.id]),
      ),
    ).toEqual({ state: 'uncertain' });
    await database.withTenant(worker(owner.context), (sql) =>
      sql.query('update ai.assistant_tool_calls set state = $1 where id = $2', [
        'completed',
        call.id,
      ]),
    );
    await expect(
      database.withTenant(worker(owner.context), (sql) =>
        sql.query('update ai.assistant_tool_calls set operation_id = $1 where id = $2', [
          'publishForm',
          call.id,
        ]),
      ),
    ).rejects.toMatchObject({ constraint: 'assistant_tool_call_identity_fixed' });
    await expect(
      database.withTenant(worker(owner.context), (sql) =>
        sql.query('update ai.assistant_tool_calls set state = $1 where id = $2', [
          'failed',
          call.id,
        ]),
      ),
    ).rejects.toMatchObject({ constraint: 'assistant_tool_call_terminal_fixed' });
  });
  it('is a titled thread that expires a month after it was made, unless it is used', async () => {
    const { context } = await person();
    const made = await thread(context);
    expect(made).toMatchObject({ title: 'Build a form', message_seq: 0, user_id: context.userId });
    const { days, whole } = await database.withTenant(context, (sql) =>
      sql.one<{ days: number; whole: boolean }>(
        `select extract(day from expires_at - created_at)::int as days,
                last_activity_at = date_trunc('milliseconds', last_activity_at) as whole
         from ai.assistant_threads where id = $1`,
        [made.id],
      ),
    );
    expect({ days, whole }).toEqual({ days: 30, whole: true });
    for (const title of ['', 'x'.repeat(121)])
      await refused(thread(context, { title }), 'assistant_threads_title_length');
    await refused(thread(context, { message_seq: -1 }), 'assistant_threads_seq_nonnegative');
  });

  it('runs one turn of a thread at a time, each finished with how it ended', async () => {
    const { context } = await person();
    const { id: threadId } = await thread(context);
    const first = await turn(context, threadId);
    expect(first).toMatchObject({ status: 'queued', outcome: null, steps: 0, cost_estimate: null });
    await refused(turn(context, threadId), 'assistant_turns_one_open_idx');
    for (const [columns, constraint] of [
      [{ status: 'finished' }, 'assistant_turns_finished_together'],
      [{ status: 'finished', finished_at: new Date() }, 'assistant_turns_finished_together'],
      [{ outcome: 'answered' }, 'assistant_turns_finished_together'],
      [{ status: 'running' }, 'assistant_turns_started_before_finished'],
      [{ status: 'waiting' }, 'assistant_turns_status_valid'],
      [{ ...FINISHED, outcome: 'published' }, 'assistant_turns_outcome_valid'],
      [
        { ...FINISHED, outcome: 'failed', reason: 'Not A Category' },
        'assistant_turns_reason_format',
      ],
      [{ ...FINISHED, steps: -1 }, 'assistant_turns_steps_nonnegative'],
      [{ ...FINISHED, cost_estimate: -1 }, 'assistant_turns_cost_nonnegative'],
      [{ ...FINISHED, page: '[]' }, 'assistant_turns_page_object'],
    ] as const)
      await refused(turn(context, (await thread(context)).id, columns), constraint);
    // Once it has finished, the thread takes the next.
    await database.withTenant(worker(context), (sql) =>
      sql.query(
        `update ai.assistant_turns set status = 'finished', outcome = 'paused',
           reason = 'limit_reached', finished_at = now(), steps = 3, cost_estimate = 0.0042
         where id = $1`,
        [first.id],
      ),
    );
    expect(
      await turn(context, threadId, { status: 'running', started_at: new Date() }),
    ).toMatchObject({ status: 'running' });
  });

  it('numbers its messages within the thread, and keeps each to what its kind holds', async () => {
    const { context } = await person();
    const { id: threadId } = await thread(context);
    const { id: turnId } = await turn(context, threadId);
    await message(context, threadId, turnId);
    await refused(message(context, threadId, turnId), 'assistant_messages_seq_unique');
    const activity = '{"operationId": "createForm", "effect": "draft", "ok": true, "target": null}';
    expect(
      await message(context, threadId, turnId, {
        seq: 2,
        kind: 'activity',
        text: 'Did it',
        activity,
      }),
    ).toMatchObject({ kind: 'activity', activity: { operationId: 'createForm' } });
    for (const [columns, constraint] of [
      [{ seq: 0 }, 'assistant_messages_seq_positive'],
      [{ seq: 3, kind: 'tool' }, 'assistant_messages_kind_valid'],
      [{ seq: 3, text: 'x'.repeat(20_001) }, 'assistant_messages_text_length'],
      [{ seq: 3, activity }, 'assistant_messages_activity_only'],
      [{ seq: 3, kind: 'activity', activity: '[]' }, 'assistant_messages_activity_object'],
      [{ seq: 3, code: 'step_limit' }, 'assistant_messages_code_only'],
      [{ seq: 3, kind: 'error', code: 'Not A Code' }, 'assistant_messages_code_format'],
      [{ seq: 3, proposal_id: randomUUID() }, 'assistant_messages_proposal_only'],
    ] as const)
      await refused(message(context, threadId, turnId, columns), constraint);
    // A message belongs to its turn's thread: not to another thread of the same person.
    const other = await thread(context);
    await refused(message(context, other.id, turnId), 'assistant_messages_owner');
  });

  it('is its person’s alone, the worker’s to run, and nobody else’s to read or write', async () => {
    const dana = await person();
    const sam = await person(dana.agencyId, dana.business);
    const { id: threadId } = await thread(dana.context);
    const { id: turnId } = await turn(dana.context, threadId);
    await message(dana.context, threadId, turnId);
    const counts = (context: TenantContext) =>
      database.withTenant(context, (sql) =>
        sql.one<{ threads: number; turns: number; messages: number }>(
          `select (select count(*) from ai.assistant_threads)::int as threads,
                  (select count(*) from ai.assistant_turns)::int as turns,
                  (select count(*) from ai.assistant_messages)::int as messages`,
        ),
      );
    const all = { threads: 1, turns: 1, messages: 1 };
    const none = { threads: 0, turns: 0, messages: 0 };
    expect(await counts(dana.context)).toEqual(all);
    expect(await counts(worker(dana.context))).toEqual(all);
    expect(await counts(sam.context)).toEqual(none);
    // Carrying her id is not being her: an assistant running a tool for her, and an API key.
    const { actorId: _dana, ...carrying } = dana.context;
    expect(await counts({ ...carrying, actorKind: 'ai_agent' })).toEqual(none);
    expect(await counts({ ...carrying, actorKind: 'api_key', actorId: randomUUID() })).toEqual(
      none,
    );
    // Nobody plants a thread, a turn or a message on her.
    await expect(thread(sam.context, { user_id: dana.userId })).rejects.toMatchObject({
      code: '42501',
    });
    await refused(turn(sam.context, threadId), 'assistant_turns_owner');
    await expect(
      message(sam.context, threadId, turnId, { seq: 2, user_id: dana.userId }),
    ).rejects.toThrow();
    // The worker writes the turn's messages, for her and for nobody else.
    await message(worker(dana.context), threadId, turnId, {
      seq: 2,
      kind: 'assistant',
      text: 'What is it for?',
      user_id: dana.userId,
    });
    await refused(
      message(worker(dana.context), threadId, turnId, { seq: 3, user_id: sam.userId }),
      'assistant_messages_owner',
    );
    // crm_app never rewrites or deletes a message, and never deletes a turn by itself.
    for (const statement of [
      `update ai.assistant_messages set text = 'rewritten'`,
      `delete from ai.assistant_messages`,
      `delete from ai.assistant_turns`,
    ])
      await expect(
        database.withTenant(dana.context, (sql) => sql.query(statement)),
      ).rejects.toMatchObject({ code: '42501' });
    // She deletes her thread, and its turns and messages go with it.
    await database.withTenant(dana.context, (sql) =>
      sql.query(`delete from ai.assistant_threads where id = $1`, [threadId]),
    );
    expect(await counts(worker(dana.context))).toEqual(none);
  });

  it('is removed with its turns and messages when its time is up, a bounded number at a time', async () => {
    const { context } = await person();
    const stale: string[] = [];
    for (const title of ['Old', 'Older']) {
      const { id } = await thread(context, { title });
      const { id: turnId } = await turn(context, id, FINISHED);
      await message(context, id, turnId);
      stale.push(id);
    }
    const kept = await thread(context, { title: 'Kept' });
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update ai.assistant_threads set expires_at = now() - interval '1 hour' where id = any($1)`,
        [stale],
      ),
    );
    const sweep = (limit: number) =>
      database.as('crm_app', (sql) =>
        sql.one<{ removed: number }>(`select private.expire_assistant_threads($1) as removed`, [
          limit,
        ]),
      );
    expect(await sweep(-5)).toEqual({ removed: 0 });
    expect(await sweep(1)).toEqual({ removed: 1 });
    expect(await sweep(1000)).toEqual({ removed: 1 });
    expect(await sweep(1000)).toEqual({ removed: 0 });
    const left = await database.withTenant(worker(context), (sql) =>
      sql.query<{ id: string }>(`select id from ai.assistant_threads`),
    );
    expect(left).toEqual([{ id: kept.id }]);
    expect(
      await database.withTenant(worker(context), (sql) =>
        sql.query(`select 1 from ai.assistant_messages`),
      ),
    ).toEqual([]);
  });

  it('tells open dashboards when a message is written and when a turn moves', async () => {
    const { context } = await person();
    const { id: threadId } = await thread(context);
    const triggers = await database.as('crm_owner', (sql) =>
      sql.query<{ table: string; trigger: string }>(
        `select c.relname as table, t.tgname as trigger
         from pg_trigger t join pg_class c on c.oid = t.tgrelid
         where c.relnamespace = 'ai'::regnamespace and c.relname like 'assistant\\_%'
           and not t.tgisinternal
         order by 1, 2`,
      ),
    );
    expect(triggers).toEqual([
      { table: 'assistant_messages', trigger: 'assistant_messages_changed' },
      { table: 'assistant_messages', trigger: 'assistant_messages_owner' },
      { table: 'assistant_threads', trigger: 'assistant_checkpoint_guard' },
      { table: 'assistant_tool_calls', trigger: 'assistant_tool_call_immutable' },
      { table: 'assistant_tool_calls', trigger: 'assistant_tool_calls_owner' },
      { table: 'assistant_turns', trigger: 'assistant_turns_changed' },
      { table: 'assistant_turns', trigger: 'assistant_turns_owner' },
    ]);
    // The notification is sent in the writer's transaction: writing succeeds with it.
    const { id: turnId } = await turn(context, threadId);
    await message(context, threadId, turnId);
  });
});

describe('a proposal about a form', () => {
  const form = async (context: TenantContext, name = 'Wedding enquiry') =>
    database.withTenant(context, (sql) =>
      sql.one<{ id: string }>(
        `insert into forms.forms (business_id, name, definition, public_key)
         values (app.business_id(), $1, '{}', $2) returning id`,
        [name, randomUUID().replaceAll('-', '')],
      ),
    );
  const proposal = (context: TenantContext, columns: Record<string, unknown> = {}) =>
    insert(context, 'proposals', {
      agent: 'copilot',
      kind: 'form_publish',
      summary: 'Publish the form',
      command: '{"name": "forms.publish", "input": {}}',
      autonomy: 'ask',
      revision: 'form:1',
      ...columns,
    });

  it('is about that form and nothing else, one waiting at a time, and goes with the form', async () => {
    const { context } = await person();
    const { id: formId } = await form(context);
    const contact = await database.fixtures.contact(context);
    const made = await proposal(context, { form_id: formId });
    expect(made).toMatchObject({ form_id: formId, status: 'pending' });
    await refused(
      proposal(context, { form_id: formId, record_id: contact.id }),
      'proposals_one_subject',
    );
    await refused(proposal(context, { form_id: formId }), 'proposals_one_pending_per_form_idx');
    // Another kind, another form, and one that is no longer waiting, are no clash.
    await proposal(context, { form_id: formId, kind: 'form_unpublish' });
    const { id: other } = await form(context, 'Another');
    await proposal(context, { form_id: other });
    // What it is about never changes.
    await refused(
      database.withTenant(context, (sql) =>
        sql.query(`update ai.proposals set form_id = $2 where id = $1`, [made.id, other]),
      ),
      'proposals_subject_fixed',
    );
    await database.withTenant(context, (sql) =>
      sql.query(
        `update ai.proposals set status = 'dismissed', decided_at = now(), decided_by_kind = 'user'
         where id = $1`,
        [made.id],
      ),
    );
    await proposal(context, { form_id: formId });
    // A form of another business is not one a proposal here can be about.
    const elsewhere = await person();
    await expect(proposal(elsewhere.context, { form_id: formId })).rejects.toMatchObject({
      code: '23503',
    });
    // Deleting the form removes what was proposed about it.
    await database.as('crm_owner', (sql) =>
      sql.query(`delete from forms.forms where id = $1`, [formId]),
    );
    expect(
      await database.withTenant(context, (sql) =>
        sql.query<{ form_id: string }>(
          `select form_id from ai.proposals where form_id is not null`,
        ),
      ),
    ).toEqual([{ form_id: other }]);
  });
});
