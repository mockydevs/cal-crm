// The server's actual automation worker composition, with real tenant-scoped notices.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Services } from '@repo/commands';
import { automationDocument } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { workerTasks } from './worker-tasks.js';

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

async function scene(
  to: 'everyone' | 'contact_owner',
  message = 'New lead: {{contact.firstName}}',
) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, correlationId: randomUUID() };
  const contact = await database.fixtures.contact(context, { firstName: 'Ada' });
  const member = await database.fixtures.user();
  const optedOut = await database.fixtures.user();
  const outsider = await database.fixtures.user();
  await database.as('crm_owner', async (sql) => {
    const role = await sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id,scope,key,name,is_builtin,permissions)
       values ($1,'business','member','Member',true,'{}') returning id`,
      [agency.id],
    );
    for (const user of [member, optedOut])
      await sql.query(
        `insert into tenancy.memberships(user_id,agency_id,business_id,role_id)
         values ($1,$2,$3,$4)`,
        [user.id, agency.id, business.id, role.id],
      );
    await sql.query('update crm.contacts set owner_user_id=$2 where id=$1', [
      contact.id,
      member.id,
    ]);
    await sql.query(
      `insert into notifications.preferences(business_id,user_id,kind,in_app)
       values ($1,$2,'automation.notice',false)`,
      [business.id, optedOut.id],
    );
  });
  const document = automationDocument.parse({
    name: 'Welcome new leads',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'tell',
    steps: { tell: { type: 'team.notify', config: { to, message } } },
  });
  const run = await database.withTenant(context, (sql) =>
    sql.one<{ id: string; automation_id: string }>(
      `with a as (
         insert into automation.automations(business_id,name,draft,created_by_kind)
         values ($1,'Welcome new leads',$3,'system') returning id
       ), v as (
         insert into automation.versions(business_id,automation_id,version,document,published_by_kind)
         select $1,id,1,$3,'system' from a returning id,automation_id
       )
       insert into automation.enrolments
         (business_id,automation_id,version_id,record_id,reentry_key,current_step,status,state,correlation_id)
       select $1,automation_id,id,$2,$2,'tell','running','{"sequence":0}',$4 from v
       returning id,automation_id`,
      [business.id, contact.id, JSON.stringify(document), context.correlationId],
    ),
  );
  const task = workerTasks().find((candidate) => candidate.name === 'automations.run_step');
  if (task === undefined) throw new Error('Missing automation step task.');
  const execute = () =>
    task.run(task.data.parse({ enrolmentId: run.id, sequence: 0 }), {
      services,
      invocation: { context, permissions: 'all' },
    });
  const notices = () =>
    database.withTenant(context, (sql) =>
      sql.query<{
        user_id: string;
        title: string;
        body: string;
        actor_kind: string;
        actor_id: string;
        record_id: string;
      }>(
        `select user_id,title,body,actor_kind,actor_id,record_id
         from notifications.notifications where kind='automation.notice'`,
      ),
    );
  return { context, member, optedOut, outsider, contact, run, execute, notices };
}

it.each(['everyone', 'contact_owner'] as const)(
  'the composed worker notifies %s with merge text, preferences and once-per-visit semantics',
  async (to) => {
    const at = await scene(to);
    await at.execute();
    await at.execute();
    expect(await at.notices()).toEqual([
      {
        user_id: at.member.id,
        title: 'Welcome new leads',
        body: 'New lead: Ada',
        actor_kind: 'automation',
        actor_id: at.run.automation_id,
        record_id: at.contact.id,
      },
    ]);
  },
);

it('refuses missing merge data without writing a notice', async () => {
  const at = await scene('everyone', 'Phone: {{contact.phone}}');
  await at.execute();
  expect(await at.notices()).toEqual([]);
  const run = await database.withTenant(at.context, (sql) =>
    sql.one<{ status: string; exit_reason: string }>(
      'select status,exit_reason from automation.enrolments where id=$1',
      [at.run.id],
    ),
  );
  expect(run).toEqual({ status: 'failed', exit_reason: 'missing_values' });
});

it.each(['missing', 'outside_business'] as const)(
  'continues without notifying a contact owner who is %s',
  async (owner) => {
    const at = await scene('contact_owner');
    await database.as('crm_owner', (sql) =>
      sql.query('update crm.contacts set owner_user_id=$2 where id=$1', [
        at.contact.id,
        owner === 'missing' ? null : at.outsider.id,
      ]),
    );
    await at.execute();
    expect(await at.notices()).toEqual([]);
    const run = await database.withTenant(at.context, (sql) =>
      sql.one<{ status: string; exit_reason: string | null }>(
        'select status,exit_reason from automation.enrolments where id=$1',
        [at.run.id],
      ),
    );
    expect(run).toEqual({ status: 'completed', exit_reason: null });
  },
);
