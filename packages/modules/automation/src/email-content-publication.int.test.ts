import { automationDocument } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { publishAutomationVersion } from './enrolment.js';

let database: TestDatabase;
let db: Database;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

it('publishes distinct email copy bindings and preserves earlier version content', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const automation = await database.withTenant(business.context, (sql) =>
    sql.one<{ id: string }>(
      `insert into automation.automations (business_id,name,draft,created_by_kind)
       values ($1,'Welcome','{}','system') returning id`,
      [business.id],
    ),
  );
  const document = (subject: string) =>
    automationDocument.parse({
      name: 'Welcome',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'email',
      steps: {
        email: { type: 'email.send', config: { mode: 'copy', subject, body: 'Independent body' } },
        legacy: { type: 'email.send', config: { subject: 'Legacy subject', body: 'Legacy body' } },
      },
    });
  const first = await withTenant(db, business.context, (trx) =>
    publishAutomationVersion(
      trx,
      business.context,
      automation.id,
      document('First guide'),
      'First',
    ),
  );
  const second = await withTenant(db, business.context, (trx) =>
    publishAutomationVersion(
      trx,
      business.context,
      automation.id,
      document('Revised guide'),
      'Second',
    ),
  );
  const rows = await database.withTenant(business.context, (sql) =>
    sql.query(
      `select b.id,b.version_id,b.step,b.current_revision,r.mode,r.subject,r.body
     from automation.email_bindings b
     join automation.email_content_revisions r
       on r.business_id=b.business_id and r.binding_id=b.id and r.revision=b.current_revision
     where b.automation_id=$1 order by r.subject`,
      [automation.id],
    ),
  );
  expect(rows).toMatchObject([
    {
      version_id: first.versionId,
      step: 'email',
      current_revision: 1,
      mode: 'copy',
      subject: 'First guide',
      body: 'Independent body',
    },
    {
      version_id: second.versionId,
      step: 'email',
      current_revision: 1,
      mode: 'copy',
      subject: 'Revised guide',
      body: 'Independent body',
    },
  ]);
  expect(rows[0]?.['id']).not.toBe(rows[1]?.['id']);
});
