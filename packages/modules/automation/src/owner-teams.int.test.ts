// owner.assign for teams, through real runs on real Postgres: the turn between several
// members, kept per automation and step, the member who left, a contact that keeps its
// owner, and several contacts enrolled at the same moment.
import { randomUUID } from 'node:crypto';

import { runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { toPublicId, ValidationError } from '@repo/kernel';
import type { TaskOptions } from '@repo/module-crm';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { nextTurn, turnOrder } from './actions-owner.js';
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
      // An empty user id stands for a membership tenancy names nobody for.
      return Promise.resolve(member?.[0] === '' ? null : (member?.[0] ?? null));
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

/** A team member: the user, and the membership id a step names them by. */
async function member(): Promise<{ userId: string; membership: string }> {
  const user = await h.database.fixtures.user();
  const membership = toPublicId('membership', user.id);
  team.set(user.id, membership);
  return { userId: user.id, membership };
}

type Sharing = Extract<
  AutomationDocumentInput['steps'][string],
  { type: 'owner.assign' }
>['config'];

const shares = (config: Sharing): AutomationDocumentInput => ({
  name: 'Share the leads',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'assign',
  steps: { assign: { type: 'owner.assign', config } },
});

/** Runs the enrolment's one step, as the worker's job does. */
const step = (tenant: Tenant, enrolmentId: string) =>
  runCommand(h.services, runStep, { enrolmentId, sequence: 0 }, as(tenant));

async function outcome(tenant: Tenant, contactId: string, enrolmentId: string) {
  const [contact] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ owner_user_id: string | null }>(
      'select owner_user_id from crm.contacts where id = $1',
      [contactId],
    ),
  );
  const [row] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{
      status: string;
      output: Record<string, unknown>;
      explanation: string;
      error: { code: string } | null;
    }>(
      `select status, output, explanation, error from automation.step_runs
       where enrolment_id = $1 order by started_at desc, id desc limit 1`,
      [enrolmentId],
    ),
  );
  return { owner: contact?.owner_user_id ?? null, row };
}

/** A new contact, enrolled by its own event, with the owner it starts with. */
async function enrolled(tenant: Tenant, owner?: string) {
  const made = await h.contact(tenant, 'Lead');
  if (owner !== undefined)
    await h.database.as('postgres', (sql) =>
      sql.query('update crm.contacts set owner_user_id = $2 where id = $1', [
        made.contactId,
        owner,
      ]),
    );
  await h.match(tenant, made.eventId);
  const [run] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>('select id from automation.enrolments where record_id = $1', [
      made.contactId,
    ]),
  );
  if (run === undefined) throw new Error('Nothing enrolled.');
  return { contactId: made.contactId, enrolmentId: run.id };
}

/** A new contact enrolled and run to its end: who owns it, and what the step said. */
async function lead(tenant: Tenant, owner?: string) {
  const run = await enrolled(tenant, owner);
  await step(tenant, run.enrolmentId);
  return outcome(tenant, run.contactId, run.enrolmentId);
}

const cursors = (tenant: Tenant) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{ step_key: string; next_position: number }>(
      'select step_key, next_position from automation.assignment_cursors order by step_key',
    ),
  );

it('reads a turn as a place in the list, whatever length the list has now', () => {
  expect(turnOrder(['a', 'b', 'c'], 0)).toEqual(['a', 'b', 'c']);
  expect(turnOrder(['a', 'b', 'c'], 2)).toEqual(['c', 'a', 'b']);
  // A place kept for a longer list is still a place in a shorter one.
  expect(turnOrder(['a', 'b'], 5)).toEqual(['b', 'a']);
  expect(turnOrder([], 3)).toEqual([]);
  expect(nextTurn(0, 0, 3)).toBe(1);
  expect(nextTurn(2, 0, 3)).toBe(0);
  // One member passed over: the turn goes on after the member chosen.
  expect(nextTurn(0, 1, 3)).toBe(2);
  expect(nextTurn(5, 0, 2)).toBe(0);
  expect(nextTurn(4, 0, 0)).toBe(0);
});

it('shares contacts between the members in turn, and keeps the turn when published again', async () => {
  const tenant = await h.business();
  const [a, b, c] = [await member(), await member(), await member()];
  const users = [a.membership, b.membership, c.membership];
  const published = await h.publish(tenant, shares({ users }));
  const owners: (string | null)[] = [];
  for (let index = 0; index < 4; index++) owners.push((await lead(tenant)).owner);
  expect(owners).toEqual([a.userId, b.userId, c.userId, a.userId]);
  expect(await cursors(tenant)).toEqual([{ step_key: 'assign', next_position: 1 }]);

  // A new version of the same automation goes on where the turn stood.
  await h.publish(tenant, shares({ users }), published.automationId);
  const fifth = await lead(tenant);
  expect(fifth.owner).toBe(b.userId);
  expect(fifth.row).toMatchObject({
    status: 'succeeded',
    output: { membershipId: b.membership },
    explanation: "The contact's owner was assigned: number 2 of 3 in turn.",
  });
  // Nine contacts in all: each member has three.
  for (let index = 0; index < 4; index++) await lead(tenant);
  const counts = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ owner_user_id: string; contacts: number }>(
      `select owner_user_id, count(*)::int as contacts from crm.contacts
       where owner_user_id is not null group by owner_user_id`,
    ),
  );
  expect(counts.map((row) => row.contacts)).toEqual([3, 3, 3]);
  expect(await h.events(tenant, 'contact.owner_assigned')).toHaveLength(9);
});

it('passes over a member who has left the team, and fails when none is left', async () => {
  const tenant = await h.business();
  const [a, b, c] = [await member(), await member(), await member()];
  await h.publish(tenant, shares({ users: [a.membership, b.membership, c.membership] }));
  expect((await lead(tenant)).owner).toBe(a.userId);
  team.delete(b.userId);
  const second = await lead(tenant);
  expect(second.owner).toBe(c.userId);
  expect(second.row?.explanation).toBe(
    "The contact's owner was assigned: number 3 of 3 in turn, after passing over 1 who has left the team.",
  );
  expect(await cursors(tenant)).toEqual([{ step_key: 'assign', next_position: 0 }]);

  team.delete(a.userId);
  team.delete(c.userId);
  const nobody = await lead(tenant);
  expect(nobody.owner).toBeNull();
  expect(nobody.row).toMatchObject({ status: 'failed', error: { code: 'unavailable_member' } });
  // A step that failed used no turn.
  expect(await cursors(tenant)).toEqual([{ step_key: 'assign', next_position: 0 }]);
});

it('leaves a contact that has an owner alone when told to, and uses no turn for it', async () => {
  const tenant = await h.business();
  const [a, b, kept] = [await member(), await member(), await member()];
  await h.publish(tenant, shares({ users: [a.membership, b.membership], onlyIfUnassigned: true }));
  const owned = await lead(tenant, kept.userId);
  expect(owned.owner).toBe(kept.userId);
  expect(owned.row).toMatchObject({
    status: 'succeeded',
    output: {},
    explanation: 'The contact already has an owner, and this step leaves an owner in place.',
  });
  expect(await cursors(tenant)).toEqual([]);
  expect((await lead(tenant)).owner).toBe(a.userId);
  expect((await lead(tenant, kept.userId)).owner).toBe(kept.userId);
  expect((await lead(tenant)).owner).toBe(b.userId);
});

it('keeps the single user shape, with and without onlyIfUnassigned', async () => {
  const tenant = await h.business();
  const [a, other] = [await member(), await member()];
  await h.publish(tenant, shares({ user: a.membership }));
  const replaced = await lead(tenant, other.userId);
  expect(replaced.owner).toBe(a.userId);
  expect(replaced.row).toMatchObject({
    output: { membershipId: a.membership },
    explanation: "The contact's owner was assigned.",
  });
  expect(await cursors(tenant)).toEqual([]);

  const careful = await h.business();
  await h.publish(careful, shares({ user: a.membership, onlyIfUnassigned: true }));
  expect((await lead(careful, other.userId)).owner).toBe(other.userId);
  expect((await lead(careful)).owner).toBe(a.userId);
});

it('gives contacts enrolled at the same moment different members', async () => {
  const tenant = await h.business();
  const [a, b] = [await member(), await member()];
  await h.publish(tenant, shares({ users: [a.membership, b.membership] }));
  const runs: { contactId: string; enrolmentId: string }[] = [];
  for (let index = 0; index < 6; index++) runs.push(await enrolled(tenant));
  // Every step at once, each in its own transaction, as several workers would run them.
  await Promise.all(runs.map((run) => step(tenant, run.enrolmentId)));
  const owners = await Promise.all(
    runs.map(async (run) => (await outcome(tenant, run.contactId, run.enrolmentId)).owner),
  );
  expect(owners.filter((owner) => owner === a.userId)).toHaveLength(3);
  expect(owners.filter((owner) => owner === b.userId)).toHaveLength(3);
});

it('passes over several members who left, whether tenancy refuses them or names nobody', async () => {
  const tenant = await h.business();
  const [a, b, c] = [await member(), await member(), await member()];
  // One who left, and one tenancy answers with nobody for.
  team.delete(a.userId);
  team.set('', b.membership);
  team.delete(b.userId);
  await h.publish(tenant, shares({ users: [a.membership, b.membership, c.membership] }));
  const assigned = await lead(tenant);
  team.delete('');
  expect(assigned.owner).toBe(c.userId);
  expect(assigned.row?.explanation).toBe(
    "The contact's owner was assigned: number 3 of 3 in turn, after passing over 2 who have left the team.",
  );
});
