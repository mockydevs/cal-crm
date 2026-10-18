// team.notify, and who it tells: the
// contact's owner; everyone; or the owner, and everyone when the contact has none. A step
// written before the third choice existed keeps telling nobody when there is no owner.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import type { NotifyAutomationTeam } from './actions-notification.js';
import { matchEvent, publishAutomationVersion } from './enrolment.js';
import { createRunStepCommand } from './runner.js';
import { contactValues } from './values.js';

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

type To = 'contact_owner' | 'everyone' | 'owner_or_everyone' | undefined;

/** A contact, with an owner or without, run through one team.notify step. */
async function notified(to: To, owned: boolean) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context: TenantContext = { ...business.context, correlationId: randomUUID() };
  const owner = await database.fixtures.user();
  const everyone = [owner.id, (await database.fixtures.user()).id];
  // The server's notification service, stood in for: it is told who, and tells them.
  const told: Parameters<NotifyAutomationTeam>[2][] = [];
  const notifyTeam: NotifyAutomationTeam = (_trx, _context, notice) => {
    told.push(notice);
    return Promise.resolve(notice.to === 'everyone' ? everyone : notice.to);
  };
  const runStep = createRunStepCommand({
    notifyTeam,
    tasks: {
      actorNames: {},
      assignees: {
        resolve: () => Promise.resolve(null),
        read: () => Promise.resolve({ items: [], nextCursor: null }),
        memberships: () => Promise.resolve(new Map<string, string>()),
      },
    },
  });
  const document: AutomationDocumentInput = {
    name: 'New lead',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'tell',
    steps: {
      tell: {
        type: 'team.notify',
        config: { message: '{{contact.firstName}} asked for a quote', ...(to ? { to } : {}) },
      },
    },
  };
  await runCommand(
    services,
    createContactCommand,
    { firstName: 'Ada', emails: [`${randomUUID()}@example.test`] },
    { context, permissions: 'all' },
  );
  const enrolled = await withTenant(db, context, async (trx) => {
    const { id } = await trx
      .insertInto('automation.automations')
      .values({
        business_id: business.id,
        name: document.name,
        draft: JSON.stringify(document),
        created_by_kind: 'system',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await publishAutomationVersion(trx, context, id, automationDocument.parse(document), 'v1');
    const event = await trx
      .selectFrom('events.events')
      .select(['id', 'subject_id'])
      .where('type', '=', 'contact.created')
      .executeTakeFirstOrThrow();
    const [first] = (await matchEvent(trx, context, event.id, contactValues)).enrolled;
    if (first === undefined) throw new Error('Nothing enrolled.');
    return { enrolmentId: first.enrolmentId, contactId: event.subject_id };
  });
  if (owned)
    await database.as('postgres', (client) =>
      client.query('update crm.contacts set owner_user_id = $1 where id = $2', [
        owner.id,
        enrolled.contactId,
      ]),
    );
  expect(
    await runCommand(
      services,
      runStep,
      { enrolmentId: enrolled.enrolmentId, sequence: 0 },
      { context: { ...context, correlationId: randomUUID() }, permissions: 'all' },
    ),
  ).toBe('ran');
  const [step] = await database.withTenant(context, (sql) =>
    sql.query<{ status: string; explanation: string }>(
      'select status, explanation from automation.step_runs',
    ),
  );
  return { told, owner: owner.id, step, contactId: enrolled.contactId };
}

it.each<[To, boolean, 'owner' | 'everyone' | 'nobody', number]>([
  ['owner_or_everyone', true, 'owner', 1],
  ['owner_or_everyone', false, 'everyone', 2],
  ['contact_owner', true, 'owner', 1],
  // As it always was: no owner, nobody told.
  ['contact_owner', false, 'nobody', 0],
  [undefined, false, 'nobody', 0],
  ['everyone', true, 'everyone', 2],
  ['everyone', false, 'everyone', 2],
])('to %s, for a contact with an owner (%s), tells %s', async (to, owned, who, count) => {
  const s = await notified(to, owned);
  expect(s.told).toHaveLength(1);
  expect(s.told[0]).toMatchObject({
    to: who === 'everyone' ? 'everyone' : who === 'owner' ? [s.owner] : [],
    message: 'Ada asked for a quote',
    recordId: s.contactId,
    automation: { name: 'New lead' },
  });
  expect(s.step).toEqual({
    status: 'succeeded',
    explanation: `Notified ${String(count)} team members.`,
  });
});
