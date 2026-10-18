// Migration 0052 (proposals, approvals, undo and autonomy; reply drafts) at the database's
// own level: what ai.proposals now keeps and refuses, the proposal behind an audit row and
// an event, ai.draft_requests with its grants and policy, the job an arriving message
// queues, the hourly sweep, and what the migration does to rows an install already had.
// What Apply, Dismiss and Undo do with these tables is the command layer's and the AI
// module's to prove (packages/commands, packages/modules/ai).
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TenantContext } from '@repo/kernel';
import { startPostgres, testDatabase, type Postgres, type TestDatabase } from '@repo/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { bootstrapFile, migrate } from './index.js';

const PROPOSALS = '0052_ai_proposals.sql';
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

async function business(agencyId?: string) {
  const agency = agencyId ?? (await database.fixtures.agency()).id;
  const created = await database.fixtures.business(agency);
  const context: TenantContext = { ...created.context, correlationId: randomUUID() };
  return { context, agencyId: agency };
}

/** A contact with a conversation, as the first message to or from them makes one. */
async function conversation(context: TenantContext) {
  const contact = await database.fixtures.contact(context);
  const { id } = await database.withTenant(context, (sql) =>
    sql.one<{ id: string }>(
      `insert into messaging.conversations (business_id, contact_id)
       values (app.business_id(), $1) returning id`,
      [contact.id],
    ),
  );
  return { id, contactId: contact.id };
}

const REPLY = { name: 'conversation.reply', input: { text: 'Hello' } };

/** A proposal as an agent stores one; every column a test does not name is as the app writes it. */
const proposal = (context: TenantContext, columns: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    agent: 'inbox',
    kind: 'reply',
    summary: 'Reply about the date',
    command: JSON.stringify(REPLY),
    autonomy: 'ask',
    revision: 'thread:1',
    ...columns,
  };
  const names = Object.keys(row);
  return database.withTenant(context, (sql) =>
    sql.one<{ id: string } & Record<string, unknown>>(
      `insert into ai.proposals (business_id, ${names.join(', ')})
       values (app.business_id(), ${names.map((_, index) => `$${String(index + 1)}`).join(', ')})
       returning *`,
      names.map((name) => row[name]),
    ),
  );
};

const change = (context: TenantContext, id: string, set: string, values: readonly unknown[] = []) =>
  database.withTenant(context, (sql) =>
    sql.query(`update ai.proposals set ${set} where id = $1 returning id`, [id, ...values]),
  );

const refused = async (work: Promise<unknown>, constraint: string): Promise<void> => {
  await expect(work).rejects.toMatchObject({ constraint });
};

const APPLIED = `status = 'applied', decided_at = now(), decided_by_kind = 'user',
  result = '{"kind": "message"}', undo = '{"impossible": "message_sent"}'`;

describe('ai.proposals', () => {
  it('keeps the command to run, by name with its input, and refuses anything else', async () => {
    const { context } = await business();
    const made = await proposal(context);
    expect(made).toMatchObject({
      status: 'pending',
      command: REPLY,
      revision: 'thread:1',
      edited: false,
      result: null,
      undo: null,
      basis: null,
      undone_at: null,
    });
    await refused(proposal(context, { basis: '[]' }), 'proposals_basis_object');
    expect(await proposal(context, { basis: '{"messages": 4}' })).toMatchObject({
      basis: { messages: 4 },
    });
    for (const command of [
      {},
      { name: 'conversation.reply' },
      { input: {} },
      { name: 7, input: {} },
      { name: 'reply', input: {} },
      { name: 'Conversation.Reply', input: {} },
      { name: 'conversation.reply', input: [] },
      { name: 'conversation.reply', input: 'text' },
    ])
      await refused(
        proposal(context, { command: JSON.stringify(command) }),
        'proposals_command_shape',
      );
  });

  it('says what it was made on, and has no default for it', async () => {
    const { context } = await business();
    await expect(
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into ai.proposals (business_id, agent, kind, summary, command, autonomy)
           values (app.business_id(), 'inbox', 'reply', 'No revision', $1, 'ask')`,
          [JSON.stringify(REPLY)],
        ),
      ),
    ).rejects.toMatchObject({ code: '23502', column: 'revision' });
    await refused(proposal(context, { revision: 'r'.repeat(201) }), 'proposals_revision_length');
    await proposal(context, { revision: 'r'.repeat(200) });
  });

  it('holds one waiting proposal of a kind for a conversation, and any number once decided', async () => {
    const { context } = await business();
    const { id: conversationId } = await conversation(context);
    const first = await proposal(context, { conversation_id: conversationId });
    await refused(
      proposal(context, { conversation_id: conversationId }),
      'proposals_one_pending_per_conversation_idx',
    );
    // Another kind waits beside it, and so does the same kind for another conversation.
    await proposal(context, { conversation_id: conversationId, kind: 'conversation_status' });
    const other = await conversation(context);
    await proposal(context, { conversation_id: other.id });
    await change(
      context,
      first.id,
      "status = 'dismissed', decided_at = now(), decided_by_kind = 'user'",
    );
    await proposal(context, { conversation_id: conversationId });
  });

  it('is decided by a known kind of actor, and has a decider exactly when it is decided', async () => {
    const { context } = await business();
    const { id } = await proposal(context);
    await refused(
      change(context, id, "status = 'dismissed', decided_at = now()"),
      'proposals_decider_complete',
    );
    await refused(
      change(context, id, "status = 'dismissed', decided_at = now(), decided_by_kind = 'robot'"),
      'proposals_decided_by_kind_valid',
    );
    await refused(change(context, id, "decided_by_kind = 'user'"), 'proposals_decider_complete');
    await change(context, id, "status = 'dismissed', decided_at = now(), decided_by_kind = 'user'");
  });

  it('has an outcome and a way back only once applied, and always then', async () => {
    const { context } = await business();
    const { id } = await proposal(context);
    await refused(
      change(context, id, `result = '{"kind": "message"}'`),
      'proposals_result_only_applied',
    );
    await refused(
      change(context, id, `undo = '{"impossible": "x"}'`),
      'proposals_result_only_applied',
    );
    await refused(
      change(context, id, "status = 'applied', decided_at = now(), decided_by_kind = 'user'"),
      'proposals_applied_has_undo',
    );
    await refused(
      change(
        context,
        id,
        `status = 'applied', decided_at = now(), decided_by_kind = 'user', undo = '[]'`,
      ),
      'proposals_undo_object',
    );
    await refused(
      change(
        context,
        id,
        `status = 'applied', decided_at = now(), decided_by_kind = 'user', undo = '{}', result = '7'`,
      ),
      'proposals_result_object',
    );
    await change(context, id, APPLIED);
  });

  it('moves only forward: waiting to applied, dismissed or expired; applied to undone', async () => {
    const { context } = await business();
    const decided = "decided_at = now(), decided_by_kind = 'user'";
    const undone = "status = 'undone', undone_at = now(), undone_by_kind = 'user'";
    const waiting = "status = 'pending', decided_at = null, decided_by_kind = null";

    const dismissed = await proposal(context);
    await refused(change(context, dismissed.id, undone), 'proposals_status_forward');
    await change(context, dismissed.id, `status = 'dismissed', ${decided}`);
    for (const next of [
      waiting,
      APPLIED,
      "status = 'expired'",
      `${undone}, undo = '{"impossible": "x"}'`,
    ])
      await refused(change(context, dismissed.id, next), 'proposals_status_forward');

    const expired = await proposal(context);
    await change(
      context,
      expired.id,
      "status = 'expired', decided_at = now(), decided_by_kind = 'system'",
    );
    for (const next of [waiting, APPLIED, "status = 'dismissed'"])
      await refused(change(context, expired.id, next), 'proposals_status_forward');

    const applied = await proposal(context);
    await change(context, applied.id, APPLIED);
    for (const next of [
      `${waiting}, result = null, undo = null`,
      "status = 'dismissed'",
      "status = 'expired'",
    ])
      await refused(change(context, applied.id, next), 'proposals_status_forward');
    await change(context, applied.id, undone);
    for (const next of [
      "status = 'applied', undone_at = null, undone_by_kind = null",
      "status = 'dismissed', undone_at = null, undone_by_kind = null",
      `${waiting}, undone_at = null, undone_by_kind = null, result = null, undo = null`,
    ])
      await refused(change(context, applied.id, next), 'proposals_status_forward');
  });

  it('never changes what it is about, or anything at all once decided', async () => {
    const { context } = await business();
    const { id: conversationId } = await conversation(context);
    const other = await conversation(context);
    const waiting = await proposal(context, { conversation_id: conversationId });
    for (const set of [
      "agent = 'copilot'",
      "kind = 'conversation_status'",
      'conversation_id = $2',
      "autonomy = 'act'",
      "created_at = now() - interval '1 day'",
    ])
      await refused(
        change(context, waiting.id, set, set.includes('$2') ? [other.id] : []),
        'proposals_subject_fixed',
      );
    await refused(
      change(context, waiting.id, 'conversation_id = null, record_id = $2', [other.contactId]),
      'proposals_subject_fixed',
    );

    await change(context, waiting.id, APPLIED);
    for (const set of [
      `command = '{"name": "contact.trash", "input": {}}'`,
      "summary = 'Something else'",
      'edited = true',
      `result = '{"kind": "other"}'`,
      "revision = 'thread:9'",
      "decided_by_id = '01890a5d-ac96-774b-bcce-b302099a8057'",
    ])
      await refused(change(context, waiting.id, set), 'proposals_decided_fixed');
    // Undoing says who and when, and rewrites nothing about how it was applied.
    const undone = "status = 'undone', undone_at = now(), undone_by_kind = 'user'";
    for (const more of [
      `undo = '{"impossible": "rewritten"}'`,
      `result = '{"kind": "other"}'`,
      `command = '{"name": "contact.trash", "input": {}}'`,
      "decided_by_kind = 'system'",
      'decided_at = now()',
      "applied_event_id = '01890a5d-ac96-774b-bcce-b302099a8057'",
    ])
      await refused(change(context, waiting.id, `${undone}, ${more}`), 'proposals_applied_fixed');
    await refused(
      change(context, waiting.id, "status = 'undone', undone_at = now()"),
      'proposals_undone_complete',
    );
    await refused(
      change(context, waiting.id, "status = 'undone', undone_at = now(), undone_by_kind = 'robot'"),
      'proposals_undone_by_kind_valid',
    );
    await change(context, waiting.id, undone);
    await refused(change(context, waiting.id, 'undone_at = now()'), 'proposals_decided_fixed');
  });

  it('cannot be deleted by the app: the record of what was proposed stays', async () => {
    const { context } = await business();
    const { id } = await proposal(context);
    await expect(
      database.withTenant(context, (sql) =>
        sql.query('delete from ai.proposals where id = $1', [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('has an index for the one waiting proposal and for the sweep', async () => {
    const indexes = await database.as('crm_owner', (sql) =>
      sql.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
         where schemaname = 'ai'
           and indexname in ('proposals_one_pending_per_conversation_idx', 'proposals_expiry_idx')
         order by indexname`,
      ),
    );
    expect(indexes.map((index) => index.indexdef)).toEqual([
      "CREATE INDEX proposals_expiry_idx ON ai.proposals USING btree (expires_at) WHERE (status = 'pending'::text)",
      "CREATE UNIQUE INDEX proposals_one_pending_per_conversation_idx ON ai.proposals USING btree (business_id, conversation_id, kind) WHERE ((status = 'pending'::text) AND (conversation_id IS NOT NULL))",
    ]);
  });
});

describe('the proposal behind a command and its events', () => {
  it('is kept on the audit row and on the event, and is empty for everything else', async () => {
    const { context } = await business();
    const { id } = await proposal(context);
    const rows = await database.withTenant(context, async (sql) => {
      await sql.query(
        `insert into audit.commands (agency_id, business_id, command, actor_kind, outcome, correlation_id, proposal_id)
         values (app.agency_id(), app.business_id(), 'conversation.reply', 'user', 'ok', $1, $2),
                (app.agency_id(), app.business_id(), 'conversation.reply', 'user', 'ok', $1, null)`,
        [context.correlationId, id],
      );
      await sql.query(
        `insert into events.events (agency_id, business_id, type, actor_kind, correlation_id, subject_kind, subject_id, proposal_id)
         values (app.agency_id(), app.business_id(), 'message.submitted', 'user', $1, 'message', $3, $2),
                (app.agency_id(), app.business_id(), 'message.submitted', 'user', $1, 'message', $3, null)`,
        [context.correlationId, id, randomUUID()],
      );
      return {
        audit: await sql.query(
          'select proposal_id from audit.commands where correlation_id = $1 order by proposal_id',
          [context.correlationId],
        ),
        events: await sql.query(
          'select proposal_id from events.events where correlation_id = $1 order by proposal_id',
          [context.correlationId],
        ),
      };
    });
    expect(rows.audit).toEqual([{ proposal_id: id }, { proposal_id: null }]);
    expect(rows.events).toEqual([{ proposal_id: id }, { proposal_id: null }]);
  });

  it('has an index on each log for the rows of one proposal', async () => {
    const indexes = await database.as('crm_owner', (sql) =>
      sql.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
         where indexname in ('commands_proposal_idx', 'events_proposal_idx') order by indexname`,
      ),
    );
    expect(indexes.map((index) => index.indexdef)).toEqual([
      'CREATE INDEX commands_proposal_idx ON ONLY audit.commands USING btree (proposal_id) WHERE (proposal_id IS NOT NULL)',
      'CREATE INDEX events_proposal_idx ON ONLY events.events USING btree (proposal_id) WHERE (proposal_id IS NOT NULL)',
    ]);
  });
});

/** A draft request; every column a test does not name is as the app writes it. */
const draft = (
  context: TenantContext,
  conversationId: string,
  columns: Record<string, unknown> = {},
) => {
  const row: Record<string, unknown> = {
    conversation_id: conversationId,
    origin: 'person',
    ...columns,
  };
  const names = Object.keys(row);
  return database.withTenant(context, (sql) =>
    sql.one<{ id: string } & Record<string, unknown>>(
      `insert into ai.draft_requests (business_id, ${names.join(', ')})
       values (app.business_id(), ${names.map((_, index) => `$${String(index + 1)}`).join(', ')})
       returning *, expires_at - created_at = interval '3 minutes' as three_minutes`,
      names.map((name) => row[name]),
    ),
  );
};
const finished = { status: 'finished', finished_at: '2026-10-10T09:00:01Z' };

describe('ai.draft_requests', () => {
  it('has forced row-level security with the tenant policy', async () => {
    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ enabled: boolean; forced: boolean; policies: string[] }>(
        `select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
                array(select format('%s %s %s', p.policyname, p.permissive, p.cmd)
                      from pg_policies p
                      where p.schemaname = 'ai' and p.tablename = 'draft_requests' order by 1) as policies
         from pg_class c where c.oid = 'ai.draft_requests'::regclass`,
      ),
    );
    expect(rows).toEqual([
      { enabled: true, forced: true, policies: ['tenant_isolation PERMISSIVE ALL'] },
    ]);
  });

  it('grants crm_app what it uses and nothing to the other runtime roles', async () => {
    const grants = await database.as('crm_owner', (sql) =>
      sql.query<{ grantee: string; privileges: string[] }>(
        `select grantee::text, array_agg(privilege_type::text order by privilege_type) as privileges
         from information_schema.role_table_grants
         where table_schema = 'ai' and table_name = 'draft_requests'
           and grantee in ('crm_app', 'crm_auth', 'crm_worker', 'PUBLIC')
         group by 1 order by 1`,
      ),
    );
    expect(grants).toEqual([
      { grantee: 'crm_app', privileges: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] },
    ]);
  });

  it('has an index for each thing it points at', async () => {
    const indexes = await database.as('crm_owner', (sql) =>
      sql.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
         where schemaname = 'ai' and tablename = 'draft_requests' order by indexname`,
      ),
    );
    expect(indexes.map((index) => index.indexdef)).toEqual([
      'CREATE INDEX draft_requests_conversation_idx ON ai.draft_requests USING btree (business_id, conversation_id, created_at DESC)',
      "CREATE UNIQUE INDEX draft_requests_one_pending_idx ON ai.draft_requests USING btree (business_id, conversation_id) WHERE (status = 'pending'::text)",
      'CREATE UNIQUE INDEX draft_requests_pkey ON ai.draft_requests USING btree (business_id, id)',
      'CREATE INDEX draft_requests_proposal_idx ON ai.draft_requests USING btree (business_id, proposal_id)',
      'CREATE INDEX draft_requests_request_idx ON ai.draft_requests USING btree (business_id, request_id)',
    ]);
  });

  it('starts pending, with three minutes for a worker to write it, one at a time for a conversation', async () => {
    const { context } = await business();
    const { id: conversationId } = await conversation(context);
    const made = await draft(context, conversationId);
    expect(made).toMatchObject({
      status: 'pending',
      outcome: null,
      reason: null,
      proposal_id: null,
      request_id: null,
      claim: null,
      finished_at: null,
      three_minutes: true,
    });
    await refused(draft(context, conversationId), 'draft_requests_one_pending_idx');
    await database.withTenant(context, (sql) =>
      sql.query(
        `update ai.draft_requests set status = 'finished', outcome = 'failed', reason = 'timeout',
           finished_at = now() where id = $1`,
        [made.id],
      ),
    );
    await draft(context, conversationId, { origin: 'message' });
  });

  it('is finished exactly when it has an end and an outcome, of the kinds there are', async () => {
    const { context } = await business();
    const { id: conversationId } = await conversation(context);
    await refused(
      draft(context, conversationId, { status: 'finished' }),
      'draft_requests_finished_together',
    );
    await refused(
      draft(context, conversationId, { ...finished }),
      'draft_requests_finished_together',
    );
    await refused(
      draft(context, conversationId, { outcome: 'failed' }),
      'draft_requests_finished_together',
    );
    await refused(
      draft(context, conversationId, { ...finished, outcome: 'sent' }),
      'draft_requests_outcome_valid',
    );
    await refused(
      draft(context, conversationId, { origin: 'model' }),
      'draft_requests_origin_valid',
    );
    await refused(
      draft(context, conversationId, { ...finished, outcome: 'failed', reason: 'Not A Code' }),
      'draft_requests_reason_format',
    );
    for (const outcome of [
      'refused',
      'failed',
      'paused',
      'ai_off',
      'not_configured',
      'nothing_to_answer',
      'cannot_reply',
      'superseded',
      'expired',
    ])
      await draft(context, conversationId, { ...finished, outcome, reason: 'some_reason' });
  });

  it('names its proposal only when one was drafted, and outlives the proposal’s call', async () => {
    const { context } = await business();
    const { id: conversationId } = await conversation(context);
    const made = await proposal(context, { conversation_id: conversationId });
    await refused(
      draft(context, conversationId, { ...finished, outcome: 'failed', proposal_id: made.id }),
      'draft_requests_drafted_has_proposal',
    );
    const call = await database.withTenant(context, (sql) =>
      sql.one<{ id: string }>(
        `insert into ai.requests (business_id, job, provider, model, key_source, status, actor_kind, finished_at)
         values (app.business_id(), 'replies', 'anthropic', 'claude-sonnet-5-5', 'agency', 'ok', 'ai_agent', now())
         returning id`,
      ),
    );
    const drafted = await draft(context, conversationId, {
      ...finished,
      outcome: 'drafted',
      proposal_id: made.id,
      request_id: call.id,
    });
    // crm_owner, as the retention of the request log would: the app cannot delete a call.
    await database.as('crm_owner', (sql) =>
      sql.query('delete from ai.requests where id = $1', [call.id]),
    );
    expect(
      await database.withTenant(context, (sql) =>
        sql.one('select proposal_id, request_id from ai.draft_requests where id = $1', [
          drafted.id,
        ]),
      ),
    ).toEqual({ proposal_id: made.id, request_id: null });
  });

  it('is seen and written only by its own business', async () => {
    const one = await business();
    const sibling = await business(one.agencyId);
    const stranger = await business();
    const { id: conversationId } = await conversation(one.context);
    const made = await draft(one.context, conversationId);
    for (const context of [sibling.context, stranger.context]) {
      expect(
        await database.withTenant(context, (sql) => sql.query('select id from ai.draft_requests')),
      ).toEqual([]);
      expect(
        await database.withTenant(context, (sql) =>
          sql.query('delete from ai.draft_requests returning id'),
        ),
      ).toEqual([]);
      await expect(
        database.withTenant(context, (sql) =>
          sql.query(
            `insert into ai.draft_requests (business_id, conversation_id, origin) values ($1, $2, 'person')`,
            [one.context.businessId, conversationId],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
    expect(
      await database.as('crm_app', (sql) => sql.query('select 1 from ai.draft_requests')),
    ).toEqual([]);
    expect(
      await database.withTenant(one.context, (sql) =>
        sql.query('select id from ai.draft_requests'),
      ),
    ).toEqual([{ id: made.id }]);
  });
});

describe('an open dashboard', () => {
  it('is told to refetch when a proposal or a draft is stored or changes, with no row data', async () => {
    const { context } = await business();
    const { id: conversationId } = await conversation(context);
    const listener = new pg.Client({ connectionString: database.url('crm_app') });
    const heard: string[] = [];
    listener.on('notification', (notification) => {
      if (notification.channel === 'crm_business_changed') heard.push(notification.payload ?? '');
    });
    await listener.connect();
    try {
      await listener.query('listen crm_business_changed');
      // Notifications arrive in commit order, so once a marker sent afterwards is heard,
      // everything the work caused has been heard too.
      const heardAfter = async (work: () => Promise<unknown>): Promise<string[]> => {
        await work();
        const sent = randomUUID();
        await database.as('postgres', (sql) =>
          sql.query("select pg_notify('crm_business_changed', $1)", [sent]),
        );
        await expect.poll(() => heard, { timeout: 10_000 }).toContain(sent);
        return [...new Set(heard.splice(0))].filter((payload) => payload !== sent);
      };
      const told = [context.businessId];

      // "Writing…" appears, and goes when the worker finishes.
      let draftId = '';
      expect(
        await heardAfter(async () => {
          draftId = (await draft(context, conversationId)).id;
        }),
      ).toEqual(told);
      expect(
        await heardAfter(() =>
          database.withTenant(context, (sql) =>
            sql.query(
              `update ai.draft_requests set status = 'finished', finished_at = now(),
                 outcome = 'refused' where id = $1`,
              [draftId],
            ),
          ),
        ),
      ).toEqual(told);

      // The draft arrives, and is decided.
      let proposalId = '';
      expect(
        await heardAfter(async () => {
          proposalId = (await proposal(context, { conversation_id: conversationId })).id;
        }),
      ).toEqual(told);
      expect(await heardAfter(() => change(context, proposalId, APPLIED))).toEqual(told);
      expect(
        await heardAfter(() =>
          change(
            context,
            proposalId,
            `status = 'undone', undone_at = now(), undone_by_kind = 'user'`,
          ),
        ),
      ).toEqual(told);

      // The hourly sweep closes a proposal in every business it touches.
      const waiting = await proposal(context, {
        conversation_id: conversationId,
        expires_at: '2020-01-01T00:00:00Z',
      });
      expect(waiting['status']).toBe('pending');
      expect(
        await heardAfter(() =>
          database.as('crm_app', (sql) => sql.query('select private.expire_ai_proposals()')),
        ),
      ).toContain(context.businessId);

      // Work that rolled back tells nobody.
      expect(
        await heardAfter(async () => {
          await expect(
            database.withTenant(context, async (sql) => {
              await sql.query(
                `insert into ai.draft_requests (business_id, conversation_id, origin)
                 values (app.business_id(), $1, 'message')`,
                [conversationId],
              );
              throw new Error('rolled back');
            }),
          ).rejects.toThrow('rolled back');
        }),
      ).toEqual([]);
    } finally {
      await listener.end();
    }
  });
});

/** A message from the contact, stored with its event as the inbound commands store them. */
async function receive(
  context: TenantContext,
  on: { readonly id: string; readonly contactId: string },
  options: {
    readonly direction?: string;
    readonly type?: string;
    readonly payload?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await database.withTenant(context, async (sql) => {
    const account = await sql.one<{ id: string }>(
      `insert into messaging.channel_accounts (business_id, channel, name, status)
       values (app.business_id(), 'webchat', $1, 'active') returning id`,
      [`Chat ${randomUUID().slice(0, 8)}`],
    );
    const direction = options.direction ?? 'inbound';
    const message = await sql.one<{ id: string }>(
      `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id,
         direction, status, body_text, author_kind, author_id, idempotency_key)
       values (app.business_id(), $1, 'webchat', $2, $3, $4, 'Is the 14th free?', $5, $6, $7)
       returning id`,
      [
        on.id,
        account.id,
        direction,
        direction === 'inbound' ? 'received' : 'sent',
        direction === 'inbound' ? 'contact' : 'system',
        direction === 'inbound' ? on.contactId : null,
        direction === 'inbound' ? null : randomUUID(),
      ],
    );
    await sql.query(
      `insert into events.events (agency_id, business_id, type, actor_kind, correlation_id,
                                  subject_kind, subject_id, payload)
       values (app.agency_id(), app.business_id(), $1, 'contact', $2, 'message', $3, $4)`,
      [
        options.type ?? 'message.received',
        context.correlationId,
        message.id,
        options.payload ?? { conversationId: on.id, channel: 'webchat' },
      ],
    );
  });
}

const draftJobs = (conversationId: string) =>
  database.as('crm_owner', (sql) =>
    sql.query<{
      payload: unknown;
      max_attempts: number;
      soon: boolean;
      later: boolean;
    }>(
      `select p.payload, j.max_attempts, j.run_at > now() as later,
              j.run_at <= now() + interval '4 seconds' as soon
       from graphile_worker.jobs j join graphile_worker._private_jobs p on p.id = j.id
       where j.task_identifier = 'ai.draft_reply' and j.key = 'ai-draft-reply:' || $1::text`,
      [conversationId],
    ),
  );

/** A key the agency's businesses may use: a model server that asks for none. */
const agencyKey = (agencyId: string) =>
  database.as('crm_owner', (sql) =>
    sql.query(
      `insert into ai.provider_keys (agency_id, provider, label, base_url)
       values ($1, 'openai_compatible', $2, 'http://ollama:11434/v1')`,
      [agencyId, `Key ${randomUUID().slice(0, 8)}`],
    ),
  );

describe('an arriving message', () => {
  it('queues one draft job for its conversation, in the business, caused by its event', async () => {
    const { context, agencyId } = await business();
    await agencyKey(agencyId);
    const on = await conversation(context);
    await receive(context, on);
    const [job, ...more] = await draftJobs(on.id);
    expect(more).toEqual([]);
    expect(job).toMatchObject({ max_attempts: 3, later: true, soon: true });
    const event = await database.withTenant(context, (sql) =>
      sql.one<{ id: string }>(
        `select id from events.events where correlation_id = $1 and type = 'message.received'`,
        [context.correlationId],
      ),
    );
    expect(job?.payload).toEqual({
      agencyId: context.agencyId,
      businessId: context.businessId,
      correlationId: context.correlationId,
      causationId: event.id,
      data: { conversationId: on.id },
    });
  });

  it('gathers a burst into the one waiting job', async () => {
    const { context, agencyId } = await business();
    await agencyKey(agencyId);
    const on = await conversation(context);
    await receive(context, on);
    await receive(context, on);
    await receive(context, on);
    expect(await draftJobs(on.id)).toHaveLength(1);
    const other = await conversation(context);
    await receive(context, other);
    expect(await draftJobs(other.id)).toHaveLength(1);
  });

  it('queues nothing where no provider’s key could be used', async () => {
    const { context } = await business();
    const on = await conversation(context);
    await receive(context, on);
    expect(await draftJobs(on.id)).toEqual([]);
    // Another agency's key, and a sibling business's own key, are not this business's.
    const stranger = await business();
    await agencyKey(stranger.agencyId);
    const sibling = await business(context.agencyId);
    await database.withTenant(sibling.context, (sql) =>
      sql.query(
        `insert into ai.provider_keys (agency_id, business_id, provider, label, base_url)
         values (app.agency_id(), app.business_id(), 'openai_compatible', 'Own', 'http://ollama:11434/v1')`,
      ),
    );
    await receive(context, on);
    expect(await draftJobs(on.id)).toEqual([]);
    // Its own key is, once the business takes its keys from itself: until then the
    // gateway would look for the agency's key and find none.
    await database.withTenant(context, (sql) =>
      sql.query(
        `insert into ai.provider_keys (agency_id, business_id, provider, label, base_url)
         values (app.agency_id(), app.business_id(), 'openai_compatible', 'Own', 'http://ollama:11434/v1')`,
      ),
    );
    await receive(context, on);
    expect(await draftJobs(on.id)).toEqual([]);
    await database.withTenant(context, (sql) =>
      sql.query(
        `insert into ai.settings (business_id, key_source) values (app.business_id(), 'own')`,
      ),
    );
    await receive(context, on);
    expect(await draftJobs(on.id)).toHaveLength(1);
  });

  it('queues nothing for a business that uses its own keys and has none, whatever its agency has', async () => {
    const { context, agencyId } = await business();
    await agencyKey(agencyId);
    await database.withTenant(context, (sql) =>
      sql.query(
        `insert into ai.settings (business_id, key_source) values (app.business_id(), 'own')`,
      ),
    );
    const on = await conversation(context);
    await receive(context, on);
    expect(await draftJobs(on.id)).toEqual([]);
  });

  it('queues nothing while AI is turned off for the business', async () => {
    const { context, agencyId } = await business();
    await agencyKey(agencyId);
    await database.withTenant(context, (sql) =>
      sql.query(`insert into ai.settings (business_id, enabled) values (app.business_id(), false)`),
    );
    const on = await conversation(context);
    await receive(context, on);
    expect(await draftJobs(on.id)).toEqual([]);
    await database.withTenant(context, (sql) => sql.query(`update ai.settings set enabled = true`));
    await receive(context, on);
    expect(await draftJobs(on.id)).toHaveLength(1);
  });

  it('queues nothing for any other event, or for one that names no conversation', async () => {
    const { context, agencyId } = await business();
    await agencyKey(agencyId);
    const on = await conversation(context);
    // A reply the business sent is another event: message.submitted.
    await receive(context, on, { direction: 'outbound', type: 'message.submitted' });
    await receive(context, on, { type: 'message.delivered' });
    for (const payload of [{}, { conversationId: 'not-an-id' }, { conversationId: 7 }])
      await receive(context, on, { payload });
    expect(await draftJobs(on.id)).toEqual([]);
    expect(
      await database.as('crm_owner', (sql) =>
        sql.query(
          `select 1 from graphile_worker.jobs j
           where j.task_identifier = 'ai.draft_reply' and j.key like 'ai-draft-reply:not%'`,
        ),
      ),
    ).toEqual([]);
  });
});

describe('private.expire_ai_proposals', () => {
  it('closes waiting proposals whose time is up, as the system, and no others', async () => {
    const { context } = await business();
    const due = await proposal(context, { expires_at: '2026-01-01T00:00:00Z' });
    const later = await proposal(context, { expires_at: '2999-01-01T00:00:00Z' });
    const open = await proposal(context);
    const done = await proposal(context, { expires_at: '2026-01-01T00:00:00Z' });
    await change(
      context,
      done.id,
      "status = 'dismissed', decided_at = now(), decided_by_kind = 'user'",
    );
    const { expired } = await database.as('crm_app', (sql) =>
      sql.one<{ expired: number }>('select private.expire_ai_proposals() as expired'),
    );
    expect(expired).toBeGreaterThanOrEqual(1);
    const rows = await database.withTenant(context, (sql) =>
      sql.query(
        `select id, status, decided_by_kind, decided_by_id, decided_at is not null as decided
         from ai.proposals where id = any($1::uuid[])`,
        [[due.id, later.id, open.id, done.id]],
      ),
    );
    expect(new Map(rows.map((row) => [row['id'], row]))).toEqual(
      new Map([
        [
          due.id,
          {
            id: due.id,
            status: 'expired',
            decided_by_kind: 'system',
            decided_by_id: null,
            decided: true,
          },
        ],
        [
          later.id,
          {
            id: later.id,
            status: 'pending',
            decided_by_kind: null,
            decided_by_id: null,
            decided: false,
          },
        ],
        [
          open.id,
          {
            id: open.id,
            status: 'pending',
            decided_by_kind: null,
            decided_by_id: null,
            decided: false,
          },
        ],
        [
          done.id,
          {
            id: done.id,
            status: 'dismissed',
            decided_by_kind: 'user',
            decided_by_id: null,
            decided: true,
          },
        ],
      ]),
    );
  });

  it('takes at most as many as it is asked to, and forgets draft requests a week old', async () => {
    const { context } = await business();
    const { id: conversationId } = await conversation(context);
    for (let index = 0; index < 3; index += 1)
      await proposal(context, { expires_at: '2026-01-01T00:00:00Z' });
    expect(
      await database.as('crm_app', (sql) =>
        sql.one('select private.expire_ai_proposals(2) as expired'),
      ),
    ).toEqual({ expired: 2 });
    const old = await draft(context, conversationId, {
      ...finished,
      outcome: 'failed',
      created_at: '2026-01-01T00:00:00Z',
      expires_at: '2026-01-01T00:03:00Z',
    });
    const recent = await draft(context, conversationId, { ...finished, outcome: 'failed' });
    await database.as('crm_app', (sql) => sql.query('select private.expire_ai_proposals(0)'));
    expect(
      await database.withTenant(context, (sql) =>
        sql.query('select id from ai.draft_requests where id = any($1::uuid[])', [
          [old.id, recent.id],
        ]),
      ),
    ).toEqual([{ id: recent.id }]);
  });

  it('is the app’s to call and nobody else’s', async () => {
    for (const role of ['crm_auth', 'crm_worker'] as const)
      await expect(
        database.as(role, (sql) => sql.query('select private.expire_ai_proposals()')),
      ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('an install that already had proposals', () => {
  let postgres: Postgres;
  let earlier: string;
  beforeAll(async () => {
    postgres = await startPostgres({ bootstrapFile });
    earlier = await mkdtemp(join(tmpdir(), 'crm-before-ai-proposals-'));
    for (const name of await readdir(migrationsDirectory))
      if (name < PROPOSALS) await cp(join(migrationsDirectory, name), join(earlier, name));
  });
  afterAll(async () => {
    await postgres.stop();
    await rm(earlier, { recursive: true, force: true });
  });

  it('keeps every row, closes the ones still waiting, and wraps a command it cannot run', async () => {
    const connectionString = postgres.url(await postgres.createDatabase());
    const before = await migrate({ connectionString, directory: earlier });
    expect(before.applied).not.toContain(PROPOSALS);
    // crm_owner, as an import or a repair would write: it is not held to a tenant.
    const owner = new pg.Client({ connectionString });
    await owner.connect();
    try {
      const one = async (text: string, values: readonly unknown[] = []): Promise<string> => {
        const { rows } = await owner.query<{ id: string }>(text, [...values]);
        const [row] = rows;
        if (row === undefined) throw new Error(`No row: ${text}`);
        return row.id;
      };
      const agency = await one(
        "insert into tenancy.agencies (name, slug) values ('Agency', 'agency') returning id",
      );
      const businessId = await one(
        "insert into tenancy.businesses (agency_id, name, slug) values ($1, 'Business', 'business') returning id",
        [agency],
      );
      const waiting = await one(
        `insert into ai.proposals (business_id, agent, kind, summary, command, autonomy)
         values ($1, 'inbox', 'send_message', 'Written by hand', '{"type": "message.send"}', 'ask')
         returning id`,
        [businessId],
      );
      const decided = await one(
        `insert into ai.proposals (business_id, agent, kind, summary, command, autonomy, status,
                                   decided_at, decided_by_kind)
         values ($1, 'inbox', 'send_message', 'Dismissed by hand',
                 '{"name": "conversation.reply", "input": {"text": "Hi"}}', 'ask', 'dismissed',
                 '2026-10-01T10:00:00Z', 'user')
         returning id`,
        [businessId],
      );

      const upgrade = await migrate({ connectionString });
      expect(upgrade.applied).toContain(PROPOSALS);

      const rows = await owner.query(
        `select id, status, command, revision, edited, decided_by_kind, decided_at is not null as decided,
                decided_at = '2026-10-01T10:00:00Z' as kept_time
         from ai.proposals order by summary desc`,
      );
      expect(rows.rows).toEqual([
        {
          id: waiting,
          status: 'expired',
          command: { name: 'unknown.command', input: { type: 'message.send' } },
          revision: '',
          edited: false,
          decided_by_kind: 'system',
          decided: true,
          kept_time: false,
        },
        {
          id: decided,
          status: 'dismissed',
          command: { name: 'conversation.reply', input: { text: 'Hi' } },
          revision: '',
          edited: false,
          decided_by_kind: 'user',
          decided: true,
          kept_time: true,
        },
      ]);
    } finally {
      await owner.end();
    }
  });
});
