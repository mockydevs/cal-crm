// The engine's guards against loops, end to end on a migrated database with the engine's own
// commands and graphile_worker's own queue: a workflow's own change starts it no more, two
// workflows that change each other's fields go round once, a breaker stops a loop that
// comes back from outside, a loop goes round once an hour at most, a wait until a date
// field follows the field, a contact in the trash leaves its workflows, a paused workflow
// says why it did not start, and one business's burst does not hold another's new lead
// behind it.
import { randomUUID } from 'node:crypto';

import { defineCommand, runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { createContactCommand } from '@repo/module-crm';
import { sql } from 'kysely';
import * as z from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RUN_LIMIT_STARTS, RUN_LIMIT_WINDOW_MINUTES } from './run-guards.js';
import { scheduleDueEnrolments } from './runner.js';
import { startHarness, type Harness, type Tenant } from '../test/workflows.js';
import {
  as,
  clearQueue,
  contactField,
  drain,
  evaluationsOf,
  fieldValue,
  queued,
  runsOf,
  setField,
} from '../test/worker.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await clearQueue(h);
});

const plusOne = (target: string, from = target) => ({
  [target]: { op: 'math', left: from, operator: '+', right: 1 },
});

const counting = (on: string, write: string, name = 'Count touches'): AutomationDocumentInput =>
  ({
    name,
    triggers: [{ id: 'changed', type: 'field.changed', config: { field: on } }],
    start: 'bump',
    steps: { bump: { type: 'contact.update', config: { fields: plusOne(write) } } },
    settings: { reEnrollment: 'after_finished', timezone: 'business' },
  }) as AutomationDocumentInput;

describe('a change made in the chain that started a run', () => {
  it('does not start the workflow again: one that writes the field it listens for runs once', async () => {
    const t = await h.business();
    const touches = await contactField(h, t, 'touches', 'number');
    const p = await h.publish(t, counting('contact.custom.touches', 'contact.custom.touches'));
    const c = await h.contact(t, 'Selfloop');
    await setField(h, t, c.contact, touches, '1');
    const ran = await drain(h, [t], { max: 300 });
    const runs = await runsOf(h, t, p.automationId);
    expect(runs.map((run) => run.status)).toEqual(['completed']);
    expect(await fieldValue(h, t, c.contact, touches)).toBe('2');
    expect(await evaluationsOf(h, t, p.automationId)).toEqual([
      { reason: 'refused_loop', detail: { cause: 'own_change' } },
    ]);
    expect(ran['automations.match_event']).toBe(2);
    expect(await queued(h)).toEqual([]);
    // Every event the run's step wrote carries the run's correlation.
    const own = await h.database.withTenant(t, (db) =>
      db.query<{ correlation_id: string }>(
        `select correlation_id from events.events where type like 'field.%' order by recorded_at`,
      ),
    );
    expect(own.at(-1)?.correlation_id).toBe(runs[0]?.correlation_id);
    expect(await h.differences()).toEqual([]);
  });

  it('lets two workflows that change each other go round once', async () => {
    const t = await h.business();
    const x = await contactField(h, t, 'score_a', 'number');
    const y = await contactField(h, t, 'score_b', 'number');
    const a = await h.publish(t, counting('contact.custom.score_a', 'contact.custom.score_b', 'A'));
    const b = await h.publish(t, counting('contact.custom.score_b', 'contact.custom.score_a', 'B'));
    const c = await h.contact(t, 'Pingpong');
    // A person gives each field a value; then A starts from a person's change, B from
    // A's, and A not again from B's.
    await setField(h, t, c.contact, y, '0');
    await drain(h, [t], { max: 400 });
    const before = (await runsOf(h, t, b.automationId)).length;
    await setField(h, t, c.contact, x, '1');
    await drain(h, [t], { max: 400 });
    expect((await runsOf(h, t, a.automationId)).length).toBe(1);
    expect((await runsOf(h, t, b.automationId)).length).toBe(before + 1);
    expect(await fieldValue(h, t, c.contact, x)).toBe('2');
    const refused = (await evaluationsOf(h, t, a.automationId)).filter(
      (each) => each.reason === 'refused_loop',
    );
    expect(refused).toEqual([{ reason: 'refused_loop', detail: { cause: 'own_change' } }]);
    expect(await queued(h)).toEqual([]);
  });

  it('still starts one more run for a person who changes the field during a run', async () => {
    const t = await h.business();
    const touches = await contactField(h, t, 'visits', 'number');
    const p = await h.publish(t, {
      name: 'Slow count',
      triggers: [
        { id: 'changed', type: 'field.changed', config: { field: 'contact.custom.visits' } },
      ],
      start: 'pause',
      steps: {
        pause: { type: 'wait', config: { duration: 'PT1M' }, next: 'note' },
        note: { type: 'note.create', config: { text: 'Visited' } },
      },
      settings: { reEnrollment: 'after_finished', timezone: 'business' },
    });
    const c = await h.contact(t, 'Changes');
    await setField(h, t, c.contact, touches, '1');
    await drain(h, [t]);
    await setField(h, t, c.contact, touches, '2');
    await drain(h, [t], { now: new Date(Date.now() + 120_000) });
    await drain(h, [t], { now: new Date(Date.now() + 240_000) });
    const runs = await runsOf(h, t, p.automationId);
    expect(runs.map((run) => run.status)).toEqual(['completed', 'completed']);
  });
});

describe('the circuit breaker', () => {
  it(`stops a workflow after ${String(RUN_LIMIT_STARTS)} starts for one record in ${String(RUN_LIMIT_WINDOW_MINUTES)} minutes, and says so once`, async () => {
    const t = await h.business();
    const pings = await contactField(h, t, 'pings', 'number');
    const p = await h.publish(t, {
      name: 'Echo',
      triggers: [
        { id: 'changed', type: 'field.changed', config: { field: 'contact.custom.pings' } },
      ],
      start: 'note',
      steps: { note: { type: 'note.create', config: { text: 'Ping' } } },
      settings: { reEnrollment: 'after_finished', timezone: 'business' },
    });
    const c = await h.contact(t, 'Echoed');
    // Each a change from outside, as a webhook's receiver writing back would make.
    for (let ping = 1; ping <= RUN_LIMIT_STARTS + 2; ping += 1) {
      await setField(h, t, c.contact, pings, String(ping));
      await drain(h, [t]);
    }
    expect((await runsOf(h, t, p.automationId)).length).toBe(RUN_LIMIT_STARTS);
    const refused = await evaluationsOf(h, t, p.automationId);
    expect(refused).toEqual([
      {
        reason: 'refused_loop',
        detail: { cause: 'run_limit', starts: RUN_LIMIT_STARTS, windowMinutes: 60 },
      },
      {
        reason: 'refused_loop',
        detail: { cause: 'run_limit', starts: RUN_LIMIT_STARTS, windowMinutes: 60 },
      },
    ]);
    const told = await h.events(t, 'automation.loop_stopped');
    expect(told).toEqual([
      {
        type: 'automation.loop_stopped',
        subject_id: p.automationId,
        payload: {
          automationId: p.id,
          eventType: expect.any(String) as string,
          starts: RUN_LIMIT_STARTS,
          windowMinutes: 60,
        },
      },
    ]);
  });
});

describe('a loop', () => {
  it('goes round once an hour at most, whatever its wait', async () => {
    const t = await h.business();
    const p = await h.publish(t, {
      name: 'Nudge loop',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'nudge',
      steps: {
        nudge: { type: 'note.create', config: { text: 'Nudge' }, next: 'pause' },
        pause: { type: 'wait', config: { duration: 'PT0S' }, next: 'again' },
        again: { type: 'goto', config: { target: 'nudge' } },
      },
    });
    await h.contact(t, 'Nudged');
    await drain(h, [t], { max: 50 });
    const [run] = await runsOf(h, t, p.automationId);
    expect(run?.status).toBe('waiting');
    expect(run?.current_step).toBe('nudge');
    const wait = (run?.wake_at?.getTime() ?? 0) - Date.now();
    expect(wait).toBeGreaterThan(3_500_000);
    expect(wait).toBeLessThanOrEqual(3_600_000);
    const notes = await h.database.withTenant(t, (db) =>
      db.one<{ n: number }>(`select count(*)::int as n from crm.notes`),
    );
    expect(notes.n).toBe(1);
    const held = await h.database.withTenant(t, (db) =>
      db.query<{ input: { held?: string }; status: string }>(
        `select input, status from automation.step_runs where step_key = 'nudge' order by started_at`,
      ),
    );
    expect(held.map((row) => [row.status, row.input.held ?? null])).toEqual([
      ['succeeded', null],
      ['waiting', 'loop_interval'],
    ]);
    // An hour on, the held visit runs, and the loop waits again.
    await drain(h, [t], { now: new Date(Date.now() + 3_700_000), max: 3 });
    const again = await h.database.withTenant(t, (db) =>
      db.one<{ n: number }>(`select count(*)::int as n from crm.notes`),
    );
    expect(again.n).toBe(2);
  });
});

describe('a wait until a date field', () => {
  const reminder = (ifEmpty?: string): AutomationDocumentInput =>
    ({
      name: 'Event reminder',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'until',
      steps: {
        until: {
          type: 'wait.until',
          typeVersion: 2,
          config: {
            field: 'contact.custom.event_date',
            offset: 'P1D',
            direction: 'before',
            time: '09:00',
            ...(ifEmpty === undefined ? {} : { ifEmpty }),
          },
          next: 'remind',
        },
        remind: { type: 'note.create', config: { text: 'Your event is tomorrow' } },
      },
    }) as AutomationDocumentInput;
  const notes = (t: Tenant) =>
    h.database.withTenant(t, (db) =>
      db.one<{ n: number }>(`select count(*)::int as n from crm.notes`),
    );

  it('follows the date when it moves, waits while it is empty, and wakes on the new date', async () => {
    const t = await h.business();
    const date = await contactField(h, t, 'event_date', 'date');
    const p = await h.publish(t, reminder());
    const c = await h.contact(t, 'Guest');
    await drain(h, [t]);
    // Empty: it waits for a value, and sends nothing.
    let [run] = await runsOf(h, t, p.automationId);
    expect(run).toMatchObject({ status: 'waiting', current_step: 'until' });
    expect((await notes(t)).n).toBe(0);
    await setField(h, t, c.contact, date, '2027-01-10');
    await drain(h, [t]);
    [run] = await runsOf(h, t, p.automationId);
    expect(run?.wake_at?.toISOString()).toBe('2027-01-09T09:00:00.000Z');
    // Moved a month later: the wait moves with it.
    await setField(h, t, c.contact, date, '2027-02-10');
    await drain(h, [t]);
    [run] = await runsOf(h, t, p.automationId);
    expect(run?.wake_at?.toISOString()).toBe('2027-02-09T09:00:00.000Z');
    // At the old time nothing happens.
    await drain(h, [t], { now: new Date('2027-01-09T09:00:01Z') });
    expect((await notes(t)).n).toBe(0);
    // Cleared: it holds, and sends nothing at the old time either.
    await setField(h, t, c.contact, date, null);
    await drain(h, [t]);
    await drain(h, [t], { now: new Date('2027-02-09T09:00:01Z') });
    [run] = await runsOf(h, t, p.automationId);
    expect(run).toMatchObject({ status: 'waiting', current_step: 'until' });
    expect((await notes(t)).n).toBe(0);
    // A date again, and its time comes: the reminder is written once.
    await setField(h, t, c.contact, date, '2027-03-10');
    await drain(h, [t]);
    await drain(h, [t], { now: new Date('2027-03-09T09:00:01Z') });
    [run] = await runsOf(h, t, p.automationId);
    expect(run?.status).toBe('completed');
    expect((await notes(t)).n).toBe(1);
    expect(await h.differences()).toEqual([]);
  });

  it('ends the run while the field is empty when it says so', async () => {
    const t = await h.business();
    await contactField(h, t, 'event_date', 'date');
    const p = await h.publish(t, reminder('end'));
    await h.contact(t, 'Nodate');
    await drain(h, [t]);
    const [run] = await runsOf(h, t, p.automationId);
    expect(run?.status).toBe('completed');
    expect((await notes(t)).n).toBe(0);
  });
});

// A contact moved to the trash, as the CRM's trash command does it: the row marked and the
// event written in one command.
const trashContact = defineCommand({
  name: 'test.trash_contact',
  permission: 'contacts.manage',
  input: z.strictObject({ id: z.uuid() }),
  async handle(trx, input, command) {
    await sql`update crm.contacts set deleted_at = now() where id = ${input.id}`.execute(trx);
    await command.emit({
      type: 'contact.trashed',
      subject: { kind: 'contact', id: input.id },
      records: [input.id],
    });
  },
});

describe('a contact moved to the trash', () => {
  it('leaves its workflows at once, and a step finding it there ends its run', async () => {
    const t = await h.business();
    const p = await h.publish(t);
    const first = await h.enrol(t, 'Trashed');
    await clearQueue(h);
    await runCommand(h.services, trashContact, { id: first.contactId }, as(t));
    await drain(h, [t]);
    expect(await runsOf(h, t, p.automationId)).toMatchObject([
      { status: 'exited', exit_reason: 'contact_trashed' },
    ]);
    const stopped = await h.events(t, 'automation.run.stopped');
    expect(stopped.map((each) => each.payload['reason'])).toEqual(['contact_trashed']);

    // Trashed without its event being matched yet: the step ends the run, without failing.
    const second = await h.enrol(t, 'Quietly');
    await clearQueue(h);
    await h.database.withTenant(t, (db) =>
      db.query(`update crm.contacts set deleted_at = now() where id = $1`, [second.contactId]),
    );
    const [enrolment] = second.enrolments;
    expect(await h.step(t, enrolment ?? '', new Date(Date.now() + 2 * 86_400_000))).toBe('ran');
    expect(await h.run(t, enrolment ?? '')).toMatchObject({
      status: 'exited',
      exit_reason: 'contact_trashed',
    });
    // And a contact in the trash starts no workflow.
    await h.match(t, second.eventId);
    expect(await evaluationsOf(h, t, p.automationId)).toContainEqual({
      reason: 'stopped_by_rule',
      detail: { rule: 'contact_trashed' },
    });
  });
});

describe('a paused workflow', () => {
  it('is matched, so "why didn\'t this run" says it was paused', async () => {
    const t = await h.business();
    const p = await h.publish(t);
    await h.database.as('crm_owner', (db) =>
      db.query(`update automation.automations set status = 'paused' where id = $1`, [
        p.automationId,
      ]),
    );
    const c = await h.contact(t, 'Paused');
    const jobs = await queued(h);
    expect(jobs.map((job) => job.key)).toContain(`automation-match:${c.eventId}`);
    await drain(h, [t]);
    expect(await evaluationsOf(h, t, p.automationId)).toEqual([{ reason: 'paused', detail: {} }]);
  });
});

describe('the sweeper', () => {
  it("queues a lost step under the run's own correlation", async () => {
    const t = await h.business();
    await h.publish(t);
    const made = await h.enrol(t, 'Swept');
    const [enrolment] = made.enrolments;
    await clearQueue(h);
    await h.database.as('crm_owner', (db) =>
      db.query(
        `update automation.enrolments set status = 'waiting', wake_at = now() - interval '1 minute' where id = $1`,
        [enrolment],
      ),
    );
    expect(await scheduleDueEnrolments(h.services)).toBeGreaterThanOrEqual(1);
    const [job] = (await queued(h)).filter(
      (each) => each.payload.data['enrolmentId'] === enrolment,
    );
    const run = await h.database.withTenant(t, (db) =>
      db.one<{ correlation_id: string }>(
        `select correlation_id from automation.enrolments where id = $1`,
        [enrolment],
      ),
    );
    expect(job?.payload.correlationId).toBe(run.correlation_id);
  });
});

describe('fairness between businesses (case 7)', () => {
  it("puts a quiet business's new lead ahead of a busy one's burst", async () => {
    const busy = await h.business();
    const quiet = await h.business();
    const welcome = {
      name: 'Welcome',
      triggers: [{ id: 'c', type: 'contact.created', config: {} }],
      start: 'pause',
      steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
    } as AutomationDocumentInput;
    await h.publish(busy, welcome);
    await h.publish(quiet, welcome);
    const burst = Number(process.env['FAIRNESS_BURST'] ?? 300);
    for (let each = 0; each < burst; each += 1)
      await runCommand(
        h.services,
        createContactCommand,
        { firstName: `Burst${String(each)}`, emails: [`${randomUUID()}@example.test`] },
        as(busy),
      );
    await h.contact(quiet, 'Lead');
    const jobs = await queued(h);
    const quietAt = (order: readonly { payload: { businessId: string } }[]) =>
      order.findIndex((job) => job.payload.businessId === quiet.businessId);
    // Before: every job at priority 0, so first in, first out.
    const fifo = [...jobs].sort(
      (a, b) => a.run_at.getTime() - b.run_at.getTime() || Number(a.id) - Number(b.id),
    );
    const before = quietAt(fifo);
    const after = quietAt(jobs);
    // Measured: 300 (and 1,000 with FAIRNESS_BURST=1000) put the lead second, from last.
    expect(before).toBe(burst);
    expect(after).toBeLessThan(4);
    // The busy business's own jobs keep their order.
    const own = jobs.filter((job) => job.payload.businessId === busy.businessId);
    expect(own.map((job) => job.id)).toEqual(
      [...own].sort((a, b) => Number(a.id) - Number(b.id)).map((job) => job.id),
    );
  });
});
