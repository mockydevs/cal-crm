// What the workflow backend's integration tests share: a migrated database, a business, a
// published automation, contacts enrolled from their own events, and the engine's commands
// run as the worker runs them. Nothing here stands in for the engine: events are matched
// and steps are run by its own commands.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { inject } from 'vitest';

import { createRunStepCommand, matchEventCommand, publishAutomationVersion } from '../src/index.js';

// These automations create no tasks, so nothing here resolves an assignee.
export const runStepCommand = createRunStepCommand({
  tasks: {
    actorNames: {},
    assignees: {
      resolve: () => Promise.resolve(null),
      read: () => Promise.resolve({ items: [], nextCursor: null }),
      memberships: () => Promise.resolve(new Map<string, string>()),
    },
  },
  smsAvailable: true,
  // The calendar module makes the real link (its appointment-links.int test); here an
  // address that names the appointment shows what a message is given.
  appointmentLinks: {
    manageUrl: (_trx, appointmentId) =>
      Promise.resolve(`https://crm.example.test/appointments/manage/test-${appointmentId}`),
  },
});

export type Tenant = TenantContext & { readonly businessId: string };

export interface Published {
  readonly tenant: Tenant;
  /** The automation's stored id, and the id the API shows for it. */
  readonly automationId: string;
  readonly id: string;
  readonly versionId: string;
}

export interface Enrolled {
  /** The contact's stored id, and the id the API shows for it. */
  readonly contactId: string;
  readonly contact: string;
  readonly eventId: string;
  /** The runs the contact's own event started, in the order made. */
  readonly enrolments: readonly string[];
}

/** The simplest automation that waits: every new contact, one day, then done. */
export const waitsADay: AutomationDocumentInput = {
  name: 'Follow-up',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'pause',
  steps: {
    pause: { type: 'wait', config: { duration: 'P1D' }, next: 'settle' },
    settle: { type: 'wait', config: { duration: 'PT1M' } },
  },
};

export interface Harness {
  readonly database: TestDatabase;
  readonly db: Database;
  readonly services: Services;
  /** A new business in a new agency, acting as the system does. */
  business(): Promise<Tenant>;
  /** Publishes a document as a new automation of the business, or as a new version. */
  publish(
    tenant: Tenant,
    document?: AutomationDocumentInput,
    automationId?: string,
  ): Promise<Published>;
  /** A new contact, through the CRM's own command, and the event that says so. */
  contact(tenant: Tenant, firstName?: string): Promise<Omit<Enrolled, 'enrolments'>>;
  /** Matches one stored event, as the worker's match job does. */
  match(
    tenant: Tenant,
    eventId: string,
  ): Promise<{ enrolled: number; exited: number; woken: number; moved: number }>;
  /** A new contact, enrolled by its own event in every active automation it starts. */
  enrol(tenant: Tenant, firstName?: string): Promise<Enrolled>;
  /** Runs the enrolment's current step at a moment, as the worker's step job does. */
  step(tenant: Tenant, enrolmentId: string, now?: Date): Promise<'ran' | 'skipped'>;
  /** The enrolment as stored. */
  run(
    tenant: Tenant,
    enrolmentId: string,
  ): Promise<{
    status: string;
    current_step: string | null;
    wake_at: Date | null;
    exit_reason: string | null;
    sequence: number;
  }>;
  /** Every step row of the business, oldest first. */
  steps(
    tenant: Tenant,
  ): Promise<{ step_key: string; status: string; resumes: boolean; finished: boolean }[]>;
  /** The events of a kind the business has recorded, oldest first. */
  events(
    tenant: Tenant,
    like: string,
  ): Promise<{ type: string; subject_id: string; payload: Record<string, unknown> }[]>;
  /** Every counter that differs from the rows it counts, in the whole database. */
  differences(): Promise<unknown[]>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const database = await testDatabase(inject('databaseServer'));
  const db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  const services: Services = { db, authorize: allowEveryone };
  const as = (tenant: Tenant) => ({
    context: { ...tenant, correlationId: randomUUID() },
    permissions: 'all' as const,
  });

  const run: Harness['run'] = async (tenant, enrolmentId) => {
    const row = await withTenant(db, tenant, (trx) =>
      trx
        .selectFrom('automation.enrolments')
        .select(['status', 'current_step', 'wake_at', 'exit_reason', 'state'])
        .where('id', '=', enrolmentId)
        .executeTakeFirstOrThrow(),
    );
    const { state, ...rest } = row;
    return { ...rest, sequence: (state as { sequence?: number }).sequence ?? 0 };
  };

  const contact: Harness['contact'] = async (tenant, firstName = 'Ada') => {
    const created = await runCommand(
      services,
      createContactCommand,
      { firstName, emails: [`${randomUUID()}@example.test`] },
      as(tenant),
    );
    const event = await withTenant(db, tenant, (trx) =>
      trx
        .selectFrom('events.events')
        .select(['id', 'subject_id'])
        .where('type', '=', 'contact.created')
        .orderBy('recorded_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow(),
    );
    return { contactId: event.subject_id, contact: created.id, eventId: event.id };
  };

  const match: Harness['match'] = (tenant, eventId) =>
    runCommand(services, matchEventCommand, { eventId }, as(tenant));

  return {
    database,
    db,
    services,
    run,
    contact,
    match,
    async business() {
      const agency = await database.fixtures.agency();
      const business = await database.fixtures.business(agency.id);
      return { ...business.context, businessId: business.id, correlationId: randomUUID() };
    },
    publish(tenant, document = waitsADay, automationId) {
      return withTenant(db, tenant, async (trx) => {
        const id =
          automationId ??
          (
            await trx
              .insertInto('automation.automations')
              .values({
                business_id: tenant.businessId,
                name: document.name,
                draft: JSON.stringify(document),
                created_by_kind: 'system',
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id;
        const { versionId } = await publishAutomationVersion(
          trx,
          tenant,
          id,
          automationDocument.parse(document),
          'Published',
        );
        return { tenant, automationId: id, id: toPublicId('automation', id), versionId };
      });
    },
    async enrol(tenant, firstName) {
      const made = await contact(tenant, firstName);
      await match(tenant, made.eventId);
      const enrolments = await withTenant(db, tenant, (trx) =>
        trx
          .selectFrom('automation.enrolments')
          .select('id')
          .where('record_id', '=', made.contactId)
          .orderBy('id')
          .execute(),
      );
      return { ...made, enrolments: enrolments.map((row) => row.id) };
    },
    async step(tenant, enrolmentId, now) {
      const { sequence } = await run(tenant, enrolmentId);
      return runCommand(
        services,
        runStepCommand,
        { enrolmentId, sequence, ...(now === undefined ? {} : { now: now.toISOString() }) },
        as(tenant),
      );
    },
    steps: (tenant) =>
      database.withTenant(tenant, (sql) =>
        sql.query(
          `select step_key, status, resumes, finished_at is not null as finished
           from automation.step_runs order by started_at, id`,
        ),
      ),
    events: (tenant, like) =>
      database.withTenant(tenant, (sql) =>
        sql.query(
          `select type, subject_id, payload from events.events
           where type like $1 order by recorded_at, id`,
          [like],
        ),
      ),
    differences: () =>
      database.as('crm_owner', (sql) =>
        sql.query(
          `select scope, key, metric, counted::int as counted, actual::int as actual
           from private.automation_stat_differences() order by scope, key, metric`,
        ),
      ),
    async close() {
      await db.destroy();
      await database.close();
    },
  };
}
