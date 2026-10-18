// What the reporting module's Postgres tests share: a business in Nairobi's time zone with
// someone on its team, rows put straight into the tables a report reads (as the owner role,
// with the dates each test needs), and the module's routes run as the server runs them.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation } from '@repo/commands';
import type { Permission } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { readUserNames } from '@repo/module-auth';
import { readTaskAssigneeMemberships, resolveTaskAssignee } from '@repo/module-tenancy';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, inject } from 'vitest';

import { createReportingRoutes, type ReportingOptions } from '../src/index.js';

export const reportingOptions: ReportingOptions = {
  members: { resolve: resolveTaskAssignee, memberships: readTaskAssigneeMemberships },
  people: { names: readUserNames },
};

export interface Seeded {
  readonly agencyId: string;
  readonly businessId: string;
  readonly userId: string;
  /** Someone on the team who may do everything. */
  readonly manager: Invocation;
  /** The same person with only these permissions. */
  readonly withPermissions: (...permissions: Permission[]) => Invocation;
}

export interface Touch {
  readonly at: string;
  readonly medium?: string;
  readonly sessionSource: string;
  readonly utmSource?: string;
  readonly utmCampaign?: string;
  readonly referrer?: string;
  /** The lead source's name, as the CRM module would have written it. */
  readonly leadSource?: string;
  readonly first?: boolean;
  readonly latest?: boolean;
}

export interface ReportingSuite {
  readonly database: TestDatabase;
  readonly db: Database;
  /** A business of a new agency (or of the one given) with one person on its team. */
  readonly business: (timeZone?: string, agencyId?: string) => Promise<Seeded>;
  readonly contact: (
    seeded: Seeded,
    values: {
      createdAt: string;
      createdSource?: string;
      source?: string;
      owner?: boolean;
      trashed?: boolean;
    },
    touches?: readonly Touch[],
  ) => Promise<string>;
  readonly tag: (seeded: Seeded, name: string, contacts: readonly string[]) => Promise<string>;
  readonly pipeline: (
    seeded: Seeded,
    name: string,
    stages: readonly string[],
  ) => Promise<{ id: string; stages: string[] }>;
  readonly deal: (
    seeded: Seeded,
    values: {
      pipeline: { id: string; stages: string[] };
      stage?: number;
      contactId?: string;
      createdAt: string;
      status?: 'open' | 'won' | 'lost';
      closedAt?: string;
      amount?: number | null;
      currency?: string;
      source?: string;
      trashed?: boolean;
    },
  ) => Promise<string>;
  readonly calendar: (seeded: Seeded, name: string) => Promise<string>;
  readonly appointment: (
    seeded: Seeded,
    values: {
      calendarId: string;
      contactId: string;
      startsAt: string;
      createdAt?: string;
      status?: string;
      cancelledAt?: string;
      source?: string;
      assigned?: boolean;
    },
  ) => Promise<string>;
  /** Runs one of the module's routes, as the given person or the manager. */
  readonly api: (
    seeded: Seeded,
    operationId: string,
    input?: { readonly params?: unknown; readonly query?: unknown; readonly body?: unknown },
    invocation?: Invocation,
    options?: ReportingOptions,
  ) => Promise<unknown>;
}

export function reportingSuite(): ReportingSuite {
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
  const owner = <T>(work: Parameters<TestDatabase['as']>[1]) =>
    database.as('crm_owner', work) as Promise<T>;
  const routes = new Map<ReportingOptions, ReturnType<typeof createReportingRoutes>>();

  return {
    get database() {
      return database;
    },
    get db() {
      return db;
    },
    async business(timeZone = 'Africa/Nairobi', agencyId) {
      const agency = agencyId === undefined ? await database.fixtures.agency() : { id: agencyId };
      const business = await database.fixtures.business(agency.id);
      const user = await database.fixtures.user();
      await owner(async (sql) => {
        await sql.query('update tenancy.businesses set timezone = $2 where id = $1', [
          business.id,
          timeZone,
        ]);
        const role = await sql
          .one<{ id: string }>(
            `insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
           values ($1, 'business', 'owner', 'Owner', true)
           on conflict do nothing returning id`,
            [agency.id],
          )
          .catch(() =>
            sql.one<{ id: string }>(
              `select id from tenancy.roles where agency_id = $1 and scope = 'business' and key = 'owner'`,
              [agency.id],
            ),
          );
        await sql.query(
          'insert into tenancy.memberships (user_id, agency_id, business_id, role_id) values ($1, $2, $3, $4)',
          [user.id, agency.id, business.id, role.id],
        );
        await sql.query(
          `insert into crm.link_types
             (business_id, key, from_object_type_id, to_object_type_id, label, reverse_label, allows_primary)
           select $1, 'deal_contact', d.id, c.id, 'Contacts', 'Deals', true
           from crm.object_types d, crm.object_types c
           where d.business_id = $1 and d.kind = 'deal' and c.business_id = $1 and c.kind = 'contact'`,
          [business.id],
        );
      });
      const context = {
        ...business.context,
        actorKind: 'user' as const,
        actorId: user.id,
        userId: user.id,
        correlationId: randomUUID(),
      };
      return {
        agencyId: agency.id,
        businessId: business.id,
        userId: user.id,
        manager: { context, permissions: 'all' },
        withPermissions: (...permissions) => ({ context, permissions: new Set(permissions) }),
      };
    },
    contact: (seeded, values, touches = []) =>
      owner(async (sql) => {
        const { id } = await sql.one<{ id: string }>(
          `with record as (
             insert into crm.records (business_id, kind, object_type_id)
             select $1, 'contact', id from crm.object_types where business_id = $1 and kind = 'contact'
             returning id
           )
           insert into crm.contacts
             (business_id, id, first_name, created_by_kind, created_source, source, owner_user_id,
              created_at, deleted_at)
           select $1, id, 'Test', 'user', $2, $3, $4, $5::timestamptz, $6::timestamptz from record
           returning id`,
          [
            seeded.businessId,
            values.createdSource ?? 'user',
            values.source ?? null,
            values.owner === true ? seeded.userId : null,
            values.createdAt,
            values.trashed === true ? values.createdAt : null,
          ],
        );
        for (const [index, touch] of touches.entries())
          await sql.query(
            `insert into crm.contact_attributions
               (business_id, contact_id, touched_at, medium, session_source, utm_source, utm_campaign,
                referrer_domain, subject_kind, subject_id, is_first, is_latest, source_label,
                source_rule)
             values ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, 'contact', $2, $9, $10, $11::text,
                     case when $11::text is null then null else 'fixture' end)`,
            [
              seeded.businessId,
              id,
              touch.at,
              touch.medium ?? 'form',
              touch.sessionSource,
              touch.utmSource ?? null,
              touch.utmCampaign ?? null,
              touch.referrer ?? null,
              touch.first ?? index === 0,
              touch.latest ?? index === touches.length - 1,
              touch.leadSource ?? null,
            ],
          );
        return id;
      }),
    tag: (seeded, name, contacts) =>
      owner(async (sql) => {
        const { id } = await sql.one<{ id: string }>(
          `insert into crm.tags (business_id, name, created_by_kind) values ($1, $2, 'user') returning id`,
          [seeded.businessId, name],
        );
        for (const contact of contacts)
          await sql.query(
            `insert into crm.record_tags (business_id, record_id, tag_id, source_kind)
             values ($1, $2, $3, 'user')`,
            [seeded.businessId, contact, id],
          );
        return id;
      }),
    pipeline: (seeded, name, stages) =>
      owner(async (sql) => {
        const { id } = await sql.one<{ id: string }>(
          'insert into crm.pipelines (business_id, name) values ($1, $2) returning id',
          [seeded.businessId, name],
        );
        const ids: string[] = [];
        for (const [position, stage] of stages.entries())
          ids.push(
            (
              await sql.one<{ id: string }>(
                `insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
                 values ($1, $2, $3, $4) returning id`,
                [seeded.businessId, id, stage, position],
              )
            ).id,
          );
        return { id, stages: ids };
      }),
    deal: (seeded, values) =>
      owner(async (sql) => {
        const status = values.status ?? 'open';
        const { id } = await sql.one<{ id: string }>(
          `with record as (
             insert into crm.records (business_id, kind, object_type_id)
             select $1, 'deal', id from crm.object_types where business_id = $1 and kind = 'deal'
             returning id
           )
           insert into crm.deals
             (business_id, id, name, pipeline_id, stage_id, status, amount, currency, source,
              created_by_kind, created_at, closed_at, status_changed_at, deleted_at)
           select $1, id, 'Deal', $2, $3, $4, $5, $6, $7, 'user', $8::timestamptz, $9::timestamptz,
                  coalesce($9::timestamptz, $8::timestamptz), $10::timestamptz
           from record returning id`,
          [
            seeded.businessId,
            values.pipeline.id,
            values.pipeline.stages[values.stage ?? 0],
            status,
            values.amount === undefined ? 100 : values.amount,
            values.currency ?? 'KES',
            values.source ?? null,
            values.createdAt,
            status === 'open' ? null : (values.closedAt ?? values.createdAt),
            values.trashed === true ? values.createdAt : null,
          ],
        );
        if (values.contactId !== undefined)
          await sql.query(
            `insert into crm.record_links
               (business_id, link_type_id, from_record_id, to_record_id, is_primary, source_kind)
             select $1, id, $2, $3, true, 'user' from crm.link_types
             where business_id = $1 and key = 'deal_contact'`,
            [seeded.businessId, id, values.contactId],
          );
        return id;
      }),
    calendar: (seeded, name) =>
      owner(async (sql) => {
        const { id } = await sql.one<{ id: string }>(
          `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug)
           values ($1, $2, 'personal', 'Africa/Nairobi', $3) returning id`,
          [seeded.businessId, name, `cal-${randomUUID().slice(0, 8)}`],
        );
        return id;
      }),
    appointment: (seeded, values) =>
      owner(async (sql) => {
        const { id } = await sql.one<{ id: string }>(
          `insert into calendar.appointments
             (business_id, calendar_id, contact_id, assigned_user_id, title, starts_at, ends_at,
              status, source, cancelled_at, created_at)
           values ($1, $2, $3, $4, 'Visit', $5::timestamptz, $5::timestamptz + interval '30 minutes',
                   $6, $7, $8::timestamptz, coalesce($9::timestamptz, $5::timestamptz))
           returning id`,
          [
            seeded.businessId,
            values.calendarId,
            values.contactId,
            values.assigned === true ? seeded.userId : null,
            values.startsAt,
            values.status ?? 'booked',
            values.source ?? 'user',
            values.cancelledAt ?? null,
            values.createdAt ?? null,
          ],
        );
        return id;
      }),
    async api(
      seeded,
      operationId,
      input = {},
      invocation = seeded.manager,
      options = reportingOptions,
    ) {
      const made = routes.get(options) ?? createReportingRoutes(options);
      routes.set(options, made);
      const route = made.find((candidate) => candidate.endpoint.operationId === operationId);
      if (route === undefined) throw new Error(`Missing ${operationId} route.`);
      return route.run(
        {
          invocation: {
            ...invocation,
            context: { ...invocation.context, correlationId: randomUUID() },
          },
          params: input.params ?? {},
          query: input.query ?? {},
          body: input.body,
        },
        { db, authorize: allowEveryone },
      );
    },
  };
}

/** A refusal as a rejection, whether the route threw before or after it returned a promise. */
export async function refusalOf<Refusal extends Error>(
  work: () => Promise<unknown>,
  kind: abstract new (...parameters: never[]) => Refusal,
): Promise<Refusal> {
  try {
    await work();
  } catch (error) {
    if (error instanceof kind) return error;
    throw error;
  }
  throw new Error('Nothing was refused.');
}
