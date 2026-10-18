// A run a stop condition ends says so (a gap the Automation day test found):
// automation.run.stopped, once, on the record's timeline, caused by the event that stopped
// it, beside automation.run.completed and automation.run.failed. And the wait it was in is
// closed, not left waiting for ever. Real Postgres; the event is matched by the worker's
// own task.
import { randomUUID } from 'node:crypto';

import { defineCommand, runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { ForbiddenError } from '@repo/kernel';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import { startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { matchEventCommand, matchEventTask } from './match-task.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

// An appointment booked for a record, as the calendar's own command tells of it.
const emitBooked = defineCommand({
  name: 'test.appointment_booked',
  permission: 'contacts.manage',
  input: z.strictObject({ recordId: z.uuid() }),
  async handle(_trx, input, command) {
    return command.emit({
      type: 'appointment.booked',
      subject: { kind: 'appointment', id: randomUUID() },
      records: [input.recordId],
      payload: {},
    });
  },
});

const untilBooked: AutomationDocumentInput = {
  name: 'Until they book',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  stopWhen: [{ event: 'appointment.booked' }],
  start: 'pause',
  steps: {
    pause: { type: 'wait', config: { duration: 'P7D' }, next: 'nudge' },
    nudge: { type: 'wait', config: { duration: 'P1D' } },
  },
};

const booked = (tenant: Tenant, recordId: string) =>
  runCommand(
    h.services,
    emitBooked,
    { recordId },
    { context: { ...tenant, correlationId: randomUUID() }, permissions: 'all' },
  );
/** The match job for an event, run as the worker runs it: as the system, caused by the event. */
const matchJob = (tenant: Tenant, eventId: string) =>
  matchEventTask.run(
    { eventId },
    {
      invocation: {
        context: { ...tenant, correlationId: randomUUID() },
        permissions: 'all',
        causationId: eventId,
      },
      services: h.services,
    },
  );

it('says a run was stopped, once, for its record, caused by the event that stopped it', async () => {
  const tenant = await h.business();
  const { id } = await h.publish(tenant, untilBooked);
  const ada = await h.enrol(tenant, 'Ada');
  const grace = await h.enrol(tenant, 'Grace');
  const [adaRun = ''] = ada.enrolments;
  const [graceRun = ''] = grace.enrolments;
  await h.step(tenant, adaRun);
  await h.step(tenant, graceRun);
  expect(await h.steps(tenant)).toEqual([
    { step_key: 'pause', status: 'waiting', resumes: false, finished: false },
    { step_key: 'pause', status: 'waiting', resumes: false, finished: false },
  ]);

  const eventId = await booked(tenant, ada.contactId);
  await matchJob(tenant, eventId);
  expect(await h.run(tenant, adaRun)).toMatchObject({
    status: 'exited',
    exit_reason: 'stop:appointment.booked',
    current_step: null,
    wake_at: null,
  });
  const stopped = await h.database.withTenant(tenant, (sql) =>
    sql.query(
      `select type, subject_kind, subject_id, payload, causation_id, actor_kind
       from events.events where type like 'automation.run.%' order by recorded_at, id`,
    ),
  );
  expect(stopped).toEqual([
    {
      type: 'automation.run.stopped',
      subject_kind: 'automation_run',
      subject_id: adaRun,
      payload: { automationId: id, reason: 'stop:appointment.booked' },
      causation_id: eventId,
      actor_kind: 'system',
    },
  ]);
  // It is on Ada's timeline, and nobody else's.
  expect(
    await h.database.withTenant(tenant, (sql) =>
      sql.query(
        `select t.record_id from crm.timeline_entries t
         where t.event_type = 'automation.run.stopped'`,
      ),
    ),
  ).toEqual([{ record_id: ada.contactId }]);
  // The wait she was in is closed as skipped; Grace's goes on, untouched.
  expect(await h.steps(tenant)).toEqual([
    { step_key: 'pause', status: 'skipped', resumes: false, finished: true },
    { step_key: 'pause', status: 'waiting', resumes: false, finished: false },
  ]);
  expect(await h.run(tenant, graceRun)).toMatchObject({ status: 'waiting', exit_reason: null });

  // The job run again, as a retry runs it, ends nothing more and says nothing more.
  await matchJob(tenant, eventId);
  expect(await h.events(tenant, 'automation.run.%')).toHaveLength(1);
  // The match is audited as the engine's command, with the event it emitted.
  const audited = await h.database.as('crm_owner', (sql) =>
    sql.query<{ outcome: string; events: number }>(
      `select outcome, cardinality(event_ids) as events from audit.commands
       where business_id = $1 and command = 'automation.match_event' order by recorded_at, id`,
      [tenant.businessId],
    ),
  );
  expect(audited.slice(-2)).toEqual([
    { outcome: 'ok', events: 1 },
    { outcome: 'ok', events: 0 },
  ]);
  expect(await h.differences()).toEqual([]);
});

it('lets only the engine match events, even an actor holding every permission', async () => {
  const tenant = await h.business();
  await h.publish(tenant, untilBooked);
  const { eventId } = await h.contact(tenant);
  const user = await h.database.fixtures.user();
  await expect(
    runCommand(
      h.services,
      matchEventCommand,
      { eventId },
      { context: { ...tenant, actorKind: 'user', actorId: user.id }, permissions: 'all' },
    ),
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(
    await h.database.withTenant(tenant, (sql) => sql.query('select id from automation.enrolments')),
  ).toEqual([]);
});
