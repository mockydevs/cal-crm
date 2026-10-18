// What the sites module's integration tests share: a migrated database, a business with a
// person in it, and the module's own routes called as the API calls them.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  EMPTY_PAGE_DOCUMENT,
  site as siteContract,
  sitePage,
  siteStep,
  type PageDocument,
  type Permission,
  type Site,
  type SitePage,
  type SiteStep,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database, type DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import type { DatabaseServer, TestDatabase } from '@repo/testing';
import { testDatabase } from '@repo/testing';

import {
  createPublicSiteHandlers,
  createSiteRoutes,
  type PublicSiteHandlers,
  type Resolution,
  type ServedView,
  type SiteRouteOptions,
} from '../src/index.js';

export const BUNDLE_SECRET = 'a-bundle-secret-of-32-characters-or-more';
export const TARGET = { hostname: 'sites.crm.example', addresses: ['203.0.113.10'] };
export const PUBLIC_URL = 'https://crm.example';
export const PREVIEW_SECRET = 'a-public-intake-secret-of-32-characters';
/** Where the install's small page scripts are served, as a server that has them all says. */
export const SCRIPTS = {
  arrival: '/s/_js/arrival.00112233aabbccdd.js',
  countdown: '/s/_js/countdown.0123456789abcdef.js',
  popup: '/s/_js/popup.fedcba9876543210.js',
} as const;

export interface Harness {
  readonly database: TestDatabase;
  readonly db: Database;
  readonly services: Services;
  /** What the next lookups of a host name find. */
  readonly dns: Map<string, Resolution | Error>;
  /**
   * A form of a business as the forms module would hold it, by its id: made, or changed to
   * be published or not. The rows are real (forms.forms), because what a kept page is
   * checked against is read from them by the database itself (0089).
   */
  setForm(
    businessId: string,
    id: string,
    form: { publicKey: string; published: boolean },
  ): Promise<void>;
  removeForm(businessId: string, id: string): Promise<void>;
  /**
   * A calendar of the tenant's business as the calendar module would hold it, with what
   * its booking page asks for (a person to book, a mailbox for confirmations), switched on
   * or not. The rows are real, because whether it can be booked is the database's own
   * answer (private.resolve_calendar). Answers its public id and its booking page's path.
   */
  calendar(
    tenant: Pick<Tenant, 'agencyId' | 'businessId' | 'userId'>,
    values?: { active?: boolean; slug?: string },
  ): Promise<{ id: string; uuid: string; path: string }>;
  setCalendar(uuid: string, values: { active?: boolean; slug?: string }): Promise<void>;
  /** A custom value of a business, as Settings would hold it: made, changed or emptied. */
  setCustomValue(businessId: string, key: string, value: string): Promise<void>;
  /** The clock the previews and the public pages read, in milliseconds. */
  readonly clock: { now: number };
  /** The public side, as the server mounts it. */
  readonly visit: PublicSiteHandlers;
  /** Every page the public side served to a visitor, in order, as the server would count it. */
  readonly views: ServedView[];
  /** Every page the public side had to render, in order: a kept page adds nothing here. */
  readonly renders: ServedView[];
  /** The options the harness's own routes were made with. */
  readonly options: SiteRouteOptions;
  close(): Promise<void>;
  tenant(agencyId?: string): Promise<Tenant>;
}

export interface CallInput {
  readonly params?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
}

export interface Tenant {
  readonly agencyId: string;
  readonly businessId: string;
  readonly userId: string;
  /** The person, with every permission unless some are named. */
  as(granted?: readonly Permission[] | 'all'): Invocation;
  /** One of the module's routes, by its operation. */
  call(operationId: string, input?: CallInput, invocation?: Invocation): Promise<unknown>;
  /** The same, through routes made with other options. */
  callWith(
    options: SiteRouteOptions,
    operationId: string,
    input?: CallInput,
    invocation?: Invocation,
  ): Promise<unknown>;
  read<T>(work: (trx: DatabaseTransaction) => Promise<T>): Promise<T>;
  site(body?: Record<string, unknown>): Promise<Site>;
  step(siteId: string, body?: Record<string, unknown>): Promise<SiteStep>;
  page(id: string): Promise<SitePage>;
  save(page: SitePage, document: PageDocument): Promise<SitePage>;
}

export async function openHarness(server: DatabaseServer): Promise<Harness> {
  const database = await testDatabase(server);
  const db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  const services: Services = { db, authorize: allowEveryone };
  const dns = new Map<string, Resolution | Error>();
  const people = new Map<string, string>();
  const clock = { now: Date.parse('2026-10-12T12:00:00.000Z') };
  const views: ServedView[] = [];
  const renders: ServedView[] = [];
  // What the forms module's own reader does (forms.ts, readFormKeys).
  const readForms: SiteRouteOptions['forms'] = async (trx, ids) => {
    if (ids.length === 0) return new Map();
    const rows = await trx
      .selectFrom('forms.forms')
      .select(['id', 'public_key', 'status'])
      .where('id', 'in', [...new Set(ids)])
      .where('status', '<>', 'archived')
      .execute();
    return new Map(
      rows.map((row) => [
        row.id,
        { publicKey: row.public_key, published: row.status === 'published' },
      ]),
    );
  };
  const handlers = createPublicSiteHandlers({
    db,
    secret: PREVIEW_SECRET,
    publicUrl: PUBLIC_URL,
    forms: readForms,
    booking: true,
    scripts: SCRIPTS,
    now: () => clock.now,
    onRendered: (view) => renders.push(view),
  });
  const options: SiteRouteOptions = {
    publicUrl: PUBLIC_URL,
    previewSecret: PREVIEW_SECRET,
    forms: readForms,
    booking: true,
    scripts: SCRIPTS,
    now: () => clock.now,
    bundleSecret: BUNDLE_SECRET,
    target: TARGET,
    resolve: (hostname) => {
      const found = dns.get(hostname) ?? { cnames: [], addresses: [] };
      return found instanceof Error ? Promise.reject(found) : Promise.resolve(found);
    },
    people: (_trx, ids) =>
      Promise.resolve(
        new Map(ids.flatMap((id) => (people.has(id) ? [[id, people.get(id) ?? '']] : []))),
      ),
  };

  const run = (
    routes: ReturnType<typeof createSiteRoutes>,
    operationId: string,
    input: CallInput,
    invocation: Invocation,
  ): Promise<unknown> => {
    const route = routes.find((each) => each.endpoint.operationId === operationId);
    // As the server does: whatever a route throws, at once or later, is the call's failure.
    return Promise.resolve().then(() => {
      if (route === undefined) throw new Error(`No route serves ${operationId}.`);
      return route.run(
        { invocation, params: input.params ?? {}, query: input.query ?? {}, body: input.body },
        services,
      );
    });
  };
  const routes = createSiteRoutes(options);

  return {
    database,
    db,
    services,
    dns,
    setForm: async (businessId, id, form) => {
      await database.as('crm_owner', (sql) =>
        sql.query(
          `insert into forms.forms (business_id, id, name, definition, status, public_key,
                                    published_definition, published_at)
           values ($1, $2, 'Sign up', '{"fields": []}', $3, $4, $5::jsonb, $6::timestamptz)
           on conflict (business_id, id) do update
             set status = excluded.status, public_key = excluded.public_key,
                 published_definition = excluded.published_definition,
                 published_at = excluded.published_at`,
          [
            businessId,
            id,
            form.published ? 'published' : 'draft',
            form.publicKey,
            form.published ? '{"fields": []}' : null,
            form.published ? new Date().toISOString() : null,
          ],
        ),
      );
    },
    removeForm: async (businessId, id) => {
      await database.as('crm_owner', (sql) =>
        sql.query('delete from forms.forms where business_id = $1 and id = $2', [businessId, id]),
      );
    },
    calendar: async (tenant, values = {}) => {
      const slug = values.slug ?? `cal-${randomUUID().slice(0, 8)}`;
      return database.as('crm_owner', async (sql) => {
        const names = await sql.one<{ agency: string; business: string }>(
          `select g.slug as agency, b.slug as business
           from tenancy.businesses b join tenancy.agencies g on g.id = b.agency_id
           where b.id = $1`,
          [tenant.businessId],
        );
        const secret = await sql.one<{ id: string }>(
          `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
           values ($1, $2, 'mailbox.credentials', 1, decode(repeat('00', 32), 'hex'),
                   decode(repeat('00', 17), 'hex')) returning id`,
          [tenant.agencyId, tenant.businessId],
        );
        const account = await sql.one<{ id: string }>(
          `insert into messaging.channel_accounts (business_id, channel, name)
           values ($1, 'email', $2) returning id`,
          [tenant.businessId, `Bookings ${slug}`],
        );
        await sql.query(
          `insert into messaging.mailboxes (business_id, id, email_address, auth_method, smtp_host,
             smtp_port, smtp_security, smtp_username, secret_id, use_for_conversations)
           values ($1, $2, $3, 'password', 'localhost', 1025, 'none', 'fixture', $4, true)`,
          [tenant.businessId, account.id, `${slug}@example.test`, secret.id],
        );
        await sql.query(
          `with role as (
             insert into tenancy.roles (agency_id, scope, key, name)
             values ($1, 'business', $4, 'Host') returning id)
           insert into tenancy.memberships (agency_id, business_id, user_id, role_id)
           select $1, $2, $3, id from role
           on conflict do nothing`,
          [tenant.agencyId, tenant.businessId, tenant.userId, `host_${slug.replaceAll('-', '_')}`],
        );
        const made = await sql.one<{ id: string }>(
          `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug,
             confirmation_account_id, is_active)
           values ($1, 'Intro call', 'personal', 'UTC', $2, $3, $4) returning id`,
          [tenant.businessId, slug, account.id, values.active ?? true],
        );
        await sql.query(
          `insert into calendar.calendar_members (business_id, calendar_id, user_id)
           values ($1, $2, $3)`,
          [tenant.businessId, made.id, tenant.userId],
        );
        return {
          id: toPublicId('calendar', made.id),
          uuid: made.id,
          path: `/book/${names.agency}/${names.business}/${slug}`,
        };
      });
    },
    setCalendar: async (uuid, values) => {
      await database.as('crm_owner', (sql) =>
        sql.query(
          `update calendar.calendars
           set is_active = coalesce($2, is_active), booking_slug = coalesce($3, booking_slug)
           where id = $1`,
          [uuid, values.active ?? null, values.slug ?? null],
        ),
      );
    },
    setCustomValue: async (businessId, key, value) => {
      await database.as('crm_owner', (sql) =>
        sql.query(
          `insert into crm.custom_values (business_id, key, name, value, created_by_kind)
           values ($1, $2, $2, $3, 'system')
           on conflict (business_id, key) do update set value = excluded.value`,
          [businessId, key, value],
        ),
      );
    },
    clock,
    views,
    renders,
    options,
    visit: {
      // As the server does: a page that was served is counted, by its ids.
      page: async (siteKey, path, request) => {
        const page = await handlers.page(siteKey, path, request);
        if (page?.view !== undefined) views.push(page.view);
        return page;
      },
      preview: handlers.preview,
    },
    close: async () => {
      await db.destroy();
      await database.close();
    },
    tenant: async (agencyId) => {
      const agency = agencyId === undefined ? await database.fixtures.agency() : { id: agencyId };
      const business = await database.fixtures.business(agency.id);
      const user = await database.fixtures.user({ name: 'Dana Brooks' });
      people.set(user.id, 'Dana Brooks');
      const as = (granted: readonly Permission[] | 'all' = 'all'): Invocation => ({
        context: {
          ...business.context,
          actorKind: 'user',
          actorId: user.id,
          userId: user.id,
          correlationId: randomUUID(),
        },
        permissions: granted === 'all' ? 'all' : new Set(granted),
      });
      const call: Tenant['call'] = (operationId, input = {}, invocation = as()) =>
        run(routes, operationId, input, invocation);
      const page = async (id: string): Promise<SitePage> =>
        sitePage.parse(await call('getSitePage', { params: { id } }));
      return {
        agencyId: agency.id,
        businessId: business.id,
        userId: user.id,
        as,
        call,
        callWith: (other, operationId, input = {}, invocation = as()) =>
          run(createSiteRoutes(other), operationId, input, invocation),
        read: (work) => withTenant(db, as().context, work),
        site: async (body = {}) =>
          siteContract.parse(
            await call('createSite', {
              body: { kind: 'funnel', name: `Site ${randomUUID().slice(0, 8)}`, ...body },
            }),
          ),
        step: async (siteId, body = {}) =>
          siteStep.parse(
            await call('createSiteStep', {
              params: { id: siteId },
              body: { name: 'Landing Page', path: `p-${randomUUID().slice(0, 8)}`, ...body },
            }),
          ),
        page,
        save: async (current, document) =>
          sitePage.parse(
            await call('saveSitePageDraft', {
              params: { id: current.id },
              body: { baseVersion: current.currentVersion, document },
            }),
          ),
      };
    },
  };
}

/** A page with one section holding these elements. */
export const pageWith = (children: unknown[], sections: unknown[] = []): PageDocument =>
  ({
    ...EMPTY_PAGE_DOCUMENT,
    sections: [
      ...sections,
      {
        id: 'main',
        type: 'section',
        props: { width: 'full' },
        rows: [
          {
            id: 'main-row',
            type: 'row',
            columns: [{ id: 'main-col', type: 'column', props: { span: 12 }, children }],
          },
        ],
      },
    ],
  }) as PageDocument;

export const headline = (id: string, text: string): unknown => ({
  id,
  type: 'headline',
  props: { text: [{ text }], level: 1 },
});
export const button = (id: string, action: unknown): unknown => ({
  id,
  type: 'button',
  props: { label: 'Go', subLabel: '', action },
});
