// The Contact DND trigger and the follower actions, through real runs on real Postgres: a
// change of do not disturb made by the CRM's own command starts the automations whose
// direction, flag and channel it fits, and Add and Remove Contact Followers change who
// follows the contact through the CRM's own commands.
import { randomUUID } from 'node:crypto';

import { runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { toPublicId, ValidationError } from '@repo/kernel';
import { readContactDetails, setContactDndCommand, type TaskOptions } from '@repo/module-crm';
import { withTenant } from '@repo/db';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { createRunStepCommand } from './runner.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

/** The team: user id to membership id, as the server's task options would resolve them. */
const team = new Map<string, string>();
const tasks: TaskOptions = {
  actorNames: {},
  assignees: {
    resolve: (_trx, _context, selection) => {
      const member = [...team].find(([, membership]) => membership === selection);
      if (selection !== null && member === undefined)
        throw new ValidationError([
          { path: '/assignee', code: 'unavailable_assignee', message: 'Not on the team.' },
        ]);
      return Promise.resolve(member?.[0] ?? null);
    },
    read: () => Promise.resolve({ items: [], nextCursor: null }),
    memberships: (_trx, _context, userIds) =>
      Promise.resolve(
        new Map(
          userIds.flatMap((userId): [string, string][] => {
            const membership = team.get(userId);
            return membership === undefined ? [] : [[userId, membership]];
          }),
        ),
      ),
  },
};
const runStep = createRunStepCommand({ tasks });

const as = (tenant: Tenant) => ({
  context: { ...tenant, correlationId: randomUUID() },
  permissions: 'all' as const,
});

async function member(): Promise<{ userId: string; membership: string }> {
  const user = await h.database.fixtures.user();
  const membership = toPublicId('membership', user.id);
  team.set(user.id, membership);
  return { userId: user.id, membership };
}

/** Runs the enrolment's current step, as the worker's job does, with this team. */
async function stepOnce(tenant: Tenant, enrolmentId: string): Promise<void> {
  const { sequence } = await h.run(tenant, enrolmentId);
  await runCommand(h.services, runStep, { enrolmentId, sequence }, as(tenant));
}

const noteOn = (
  trigger: AutomationDocumentInput['triggers'][number],
  name: string,
): AutomationDocumentInput => ({
  name,
  triggers: [trigger],
  start: 'note',
  steps: { note: { type: 'note.create', config: { text: `Started by ${name}.` } } },
});

/** Changes the contact's do not disturb as a person on the contact page does. */
async function setDnd(
  tenant: Tenant,
  contactId: string,
  change: {
    all?: boolean;
    channels?: readonly ('call' | 'email' | 'sms' | 'webchat')[];
    inbound?: boolean;
  },
): Promise<void> {
  const id = toPublicId('contact', contactId);
  const current = await withTenant(h.db, as(tenant).context, (trx) =>
    readContactDetails(trx, as(tenant), id, tasks),
  );
  await runCommand(
    h.services,
    setContactDndCommand(tasks),
    {
      id,
      all: change.all ?? current.dnd.all,
      channels: [...(change.channels ?? current.dnd.channels)],
      ...(change.inbound === undefined ? {} : { inbound: change.inbound }),
      reason: 'Asked by phone to change it.',
      revision: current.dnd.revision,
    },
    as(tenant),
  );
}

/** Matches every do not disturb event not matched yet: how many runs each started. */
async function matchDndEvents(
  tenant: Tenant,
  seen: Set<string>,
): Promise<{ type: string; enrolled: number }[]> {
  const events = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string; type: string }>(
      "select id, type from events.events where type like 'contact.%dnd%' or type like 'contact.do_not_contact%' order by id",
    ),
  );
  const matched: { type: string; enrolled: number }[] = [];
  for (const event of events.filter((each) => !seen.has(each.id))) {
    seen.add(event.id);
    matched.push({ type: event.type, enrolled: (await h.match(tenant, event.id)).enrolled });
  }
  return matched;
}

const startedBy = (tenant: Tenant) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{ name: string }>(
      `select a.name from automation.enrolments e
       join automation.automations a on a.business_id = e.business_id and a.id = e.automation_id
       order by e.id`,
    ),
  );

it('starts Contact DND automations for the direction, flag and channel the change fits', async () => {
  const tenant = await h.business();
  await h.publish(
    tenant,
    noteOn(
      { id: 'd', type: 'contact.dnd_changed', config: { flag: 'enabled', channel: 'sms' } },
      'SMS on',
    ),
  );
  await h.publish(
    tenant,
    noteOn({ id: 'd', type: 'contact.dnd_changed', config: { channel: 'all' } }, 'Every channel'),
  );
  await h.publish(
    tenant,
    noteOn(
      { id: 'd', type: 'contact.dnd_changed', config: { direction: 'inbound', flag: 'enabled' } },
      'Inbound on',
    ),
  );
  const contact = await h.contact(tenant, 'Lena');
  const seen = new Set<string>();
  await matchDndEvents(tenant, seen);

  await setDnd(tenant, contact.contactId, { channels: ['email', 'sms'] });
  expect(await matchDndEvents(tenant, seen)).toEqual([
    { type: 'contact.dnd_changed', enrolled: 1 },
  ]);
  // Turning SMS off fits none of them.
  await setDnd(tenant, contact.contactId, { channels: ['email'] });
  expect(await matchDndEvents(tenant, seen)).toEqual([
    { type: 'contact.dnd_changed', enrolled: 0 },
  ]);
  await setDnd(tenant, contact.contactId, { all: true, inbound: true });
  expect(await matchDndEvents(tenant, seen)).toEqual([
    { type: 'contact.do_not_contact_set', enrolled: 1 },
    { type: 'contact.inbound_dnd_set', enrolled: 1 },
  ]);
  expect((await startedBy(tenant)).map((row) => row.name)).toEqual([
    'SMS on',
    'Every channel',
    'Inbound on',
  ]);
});

it('starts one run for one save that turns do not contact on and changes channels too', async () => {
  const tenant = await h.business();
  // Both let a contact in again once its run has ended.
  const again = (document: AutomationDocumentInput): AutomationDocumentInput => ({
    ...document,
    settings: { reEnrollment: 'after_finished' },
  });
  await h.publish(
    tenant,
    again(noteOn({ id: 'd', type: 'contact.dnd_changed', config: {} }, 'Any')),
  );
  await h.publish(
    tenant,
    again(noteOn({ id: 'd', type: 'contact.dnd_changed', config: { flag: 'disabled' } }, 'Off')),
  );
  const contact = await h.contact(tenant, 'Lena');
  // Email stopped already, written as it is stored, with no event to match.
  await h.database.as('postgres', (sql) =>
    sql.query("update crm.contacts set dnd_channels = '{email}' where id = $1", [
      contact.contactId,
    ]),
  );
  const seen = new Set<string>();
  await matchDndEvents(tenant, seen);

  // One save: do not contact on, and email off. Its two events are matched by two jobs, and
  // the run the first one starts may well have ended before the second is matched.
  await setDnd(tenant, contact.contactId, { all: true, channels: [] });
  const events = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string; type: string }>(
      "select id, type from events.events where type in ('contact.do_not_contact_set', 'contact.dnd_changed') order by id",
    ),
  );
  expect(events.map((event) => event.type)).toEqual([
    'contact.do_not_contact_set',
    'contact.dnd_changed',
  ]);
  const [set, changed] = events;
  if (set === undefined || changed === undefined) throw new Error('No events.');
  expect((await h.match(tenant, set.id)).enrolled).toBe(1);
  const [first] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>("select id from automation.enrolments where status = 'running'"),
  );
  if (first === undefined) throw new Error('Nothing enrolled.');
  await stepOnce(tenant, first.id);
  expect((await h.run(tenant, first.id)).status).toBe('completed');
  // "Any change" has its run for this save; "turned off" starts, for the email channel.
  expect((await h.match(tenant, changed.id)).enrolled).toBe(1);
  expect((await startedBy(tenant)).map((row) => row.name)).toEqual(['Any', 'Off']);
  // And the save's second event is not counted against "Any change" as a run refused for
  // feeding a loop: it is the same change, which has had its run.
  expect(
    await h.database.withTenant(tenant, (sql) =>
      sql.query('select reason from automation.trigger_evaluations where event_id = $1', [
        changed.id,
      ]),
    ),
  ).toEqual([]);
});

it('adds and removes contact followers through the CRM, and can remove every follower', async () => {
  const tenant = await h.business();
  const [ada, ben, cy] = [await member(), await member(), await member()];
  await h.publish(tenant, {
    name: 'Followers',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'add',
    steps: {
      add: {
        type: 'followers.add',
        config: { users: [ada.membership, ben.membership, cy.membership] },
        next: 'remove',
      },
      remove: { type: 'followers.remove', config: { users: [ben.membership] } },
    },
  });
  const run = await h.enrol(tenant, 'Lena');
  const [enrolment] = run.enrolments;
  if (enrolment === undefined) throw new Error('Nothing enrolled.');
  const followers = () =>
    h.database.withTenant(tenant, (sql) =>
      sql.query<{ user_id: string }>(
        'select user_id from crm.contact_followers where contact_id = $1 order by user_id',
        [run.contactId],
      ),
    );
  const sorted = (ids: string[]) => ids.toSorted().map((user_id) => ({ user_id }));

  await stepOnce(tenant, enrolment);
  expect(await followers()).toEqual(sorted([ada.userId, ben.userId, cy.userId]));
  await stepOnce(tenant, enrolment);
  expect(await followers()).toEqual(sorted([ada.userId, cy.userId]));
  expect((await h.run(tenant, enrolment)).status).toBe('completed');
  expect(
    (await h.events(tenant, 'contact.follower_%')).map((event) => [
      event.type,
      event.payload['followerUserId'],
    ]),
  ).toEqual([
    ['contact.follower_added', ada.userId],
    ['contact.follower_added', ben.userId],
    ['contact.follower_added', cy.userId],
    ['contact.follower_removed', ben.userId],
  ]);

  // Every follower, by a second automation that a change of do not disturb starts.
  await h.publish(tenant, {
    name: 'Nobody follows',
    triggers: [{ id: 'dnd', type: 'contact.dnd_changed', config: {} }],
    start: 'clear',
    steps: { clear: { type: 'followers.remove', config: { all: true } } },
  });
  await setDnd(tenant, run.contactId, { channels: ['sms'] });
  expect(await matchDndEvents(tenant, new Set())).toEqual([
    { type: 'contact.dnd_changed', enrolled: 1 },
  ]);
  const [clearing] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>(
      "select id from automation.enrolments where status in ('running', 'waiting') and record_id = $1",
      [run.contactId],
    ),
  );
  if (clearing === undefined) throw new Error('Nothing enrolled.');
  await stepOnce(tenant, clearing.id);
  expect(await followers()).toEqual([]);
});

it('fails a follower step that names someone not on the team, and changes nothing', async () => {
  const tenant = await h.business();
  const ada = await member();
  // A user of the install whom the team does not have.
  const stranger = toPublicId('membership', (await h.database.fixtures.user()).id);
  await h.publish(tenant, {
    name: 'Followers',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'add',
    steps: {
      add: {
        type: 'followers.add',
        config: { users: [ada.membership, stranger] },
      },
    },
  });
  const run = await h.enrol(tenant, 'Lena');
  const [enrolment] = run.enrolments;
  if (enrolment === undefined) throw new Error('Nothing enrolled.');
  await stepOnce(tenant, enrolment);
  expect(
    await h.database.withTenant(tenant, (sql) =>
      sql.query('select user_id from crm.contact_followers where contact_id = $1', [run.contactId]),
    ),
  ).toEqual([]);
  expect((await h.run(tenant, enrolment)).status).toBe('failed');
});
