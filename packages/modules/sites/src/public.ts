// The public side of sites: a published page as a visitor is sent it, on the install's own
// address, and a draft as its editor previews it. The transport (apps/server) owns HTTP:
// the shared rate limit, the headers, caching. This file owns what is read and what is
// rendered.
//
// The rules it keeps:
// - a page answers only while it is published and its business is active. A site's key
//   that names nothing, a path no step has, a step that is not published and a site that
//   was deleted are one answer: nothing;
// - what is rendered is the published version, never a newer saved one; a step with a
//   split test shows its control page to everyone (variations are not served yet);
// - a page is what the published document and the site as it is now make it (its steps'
//   paths and order, its saved sections, the forms it shows), so a renamed step or a
//   changed saved section never leaves a stale link behind. It is rendered when that
//   changes and not otherwise: each visit asks the database, in one statement, for
//   everything the page is made from (private.site_page_state, 0089), and a page rendered
//   from exactly that is sent again as it is (page-cache.ts);
// - a site that takes a lead on any published page (a form or a calendar) and has not
//   switched it off names the arrival's script on every page of it, so how a visitor
//   arrived is kept from page to page in their own browser tab. A site that takes no lead
//   names no such script, and neither does a draft shown to its editor;
// - nothing a tenant wrote as code is sent: the renderer leaves custom code and head and
//   body code out, and the policy sent with the page allows no script but the CRM's own;
// - a merge field is filled in with the business's custom value of that key, and shows
//   nothing when there is none; a calendar is a link to its own booking page, written only
//   while that page would take a booking.
import { randomUUID } from 'node:crypto';

import { requireBusiness, type Invocation } from '@repo/commands';
import {
  customValuePaths,
  pageDocumentReferences,
  pageSection,
  SITE_PAGE_PATH,
  SITE_PREVIEW_PAGE_PATH,
  sitePublicKey,
  type PageDocument,
  type PageSection,
  type SiteKeepArrival,
  type SitePagePreview,
  type SitePageProblem,
  type SitePublicStatus,
} from '@repo/contracts';
import { withTenant, type Database, type DatabaseTransaction } from '@repo/db';
import { ConflictError, parsePublicId, toPublicId, type TenantContext } from '@repo/kernel';
import { pageChangesAt, renderPage, type PageScripts, type RenderContext } from '@repo/site-render';
import { pageEtag, pagePolicy } from '@repo/site-render/server';
import { sql } from 'kysely';

import { pageProblems, type PageFacts } from './checks.js';
import { DEFAULT_PAGE_CACHE, PageCache, type PageCacheLimits } from './page-cache.js';
import { issuePreviewToken, PREVIEW_MINUTES, readPreviewToken } from './preview-token.js';
import { homeStepOf, keepArrivalOf, kindOf, requirePage, roleOf, storedDocument } from './rows.js';

/**
 * Where a calendar's own booking page is, on the install's address, before the three names
 * that say which calendar: the dashboard's public route /book/<agency>/<business>/<calendar>.
 */
const BOOKING_PAGE_PATH = '/book';

/** Where the CRM's own form embed is loaded from (apps/server: forms-embed/transport.ts). */
const FORM_SCRIPT_PATH = '/forms/embed.js';

/**
 * What the forms module knows about some forms, by their ids: the key a page shows a form
 * by, and whether it is published. The server passes the forms module's own reader.
 */
export type ReadSiteForms = (
  trx: DatabaseTransaction,
  ids: readonly string[],
) => Promise<ReadonlyMap<string, { readonly publicKey: string; readonly published: boolean }>>;

/**
 * What a page's checks and its renderer are told about the install and by the other
 * modules. Everything is optional: left out, the page is checked and rendered as on an
 * install that has none of it.
 */
export interface PageReaders {
  /** The forms module's reader, for a form shown on a page. Without it one is refused. */
  readonly forms?: ReadSiteForms | undefined;
  /**
   * The install's own address when it serves booking pages there (/book/…), which a
   * calendar on a page links to. Without it a calendar on a page is refused.
   */
  readonly bookingUrl?: string | undefined;
  /**
   * Where the install's small page scripts are loaded from, each only when the server has
   * it to send. Without one, a countdown shows its remaining time as rendered and a popup
   * opens from a link only, and the page's problems say so.
   */
  readonly scripts?: PageScripts | undefined;
}

interface StepFact {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly position: number;
  /** Whether its control page is published, so a visitor can reach it. */
  readonly published: boolean;
  /** Its control page, and the version of it that is live. */
  readonly controlPageId: string;
  readonly publishedVersion: number | null;
}

/** A site as its pages are checked and rendered: its settings and every step. */
export interface SiteMap {
  readonly id: string;
  readonly kind: 'funnel' | 'website';
  readonly publicKey: string;
  readonly faviconUrl: string | null;
  /** Whether the site's pages keep how a visitor arrived between them. */
  readonly keepArrival: SiteKeepArrival;
  readonly steps: readonly StepFact[];
}

export async function readSiteMap(
  trx: DatabaseTransaction,
  siteId: string,
): Promise<SiteMap | undefined> {
  const site = await trx
    .selectFrom('sites.sites')
    .select(['id', 'kind', 'public_key', 'favicon_url', 'keep_arrival'])
    .where('id', '=', siteId)
    .executeTakeFirst();
  if (site === undefined) return undefined;
  const steps = await trx
    .selectFrom('sites.steps as s')
    .innerJoin('sites.pages as p', (join) =>
      join.onRef('p.step_id', '=', 's.id').on('p.role', '=', 'control'),
    )
    .select(['s.id', 's.name', 's.path', 's.position', 'p.id as page_id', 'p.published_version'])
    .where('s.site_id', '=', siteId)
    .orderBy('s.position')
    .execute();
  return {
    id: site.id,
    kind: kindOf(site.kind),
    publicKey: site.public_key,
    faviconUrl: site.favicon_url,
    keepArrival: keepArrivalOf(site.keep_arrival),
    steps: steps.map((step) => ({
      id: step.id,
      name: step.name,
      path: step.path,
      position: step.position,
      published: step.published_version !== null,
      controlPageId: step.page_id,
      publishedVersion: step.published_version,
    })),
  };
}

/**
 * Every saved section, form and calendar a page was found to refer to, by their own ids,
 * whether each was there to be read or not: what has to be asked about again to know
 * whether the page would still be rendered the same.
 */
export interface PageReferences {
  sectionIds: string[];
  formIds: string[];
  calendarIds: string[];
}

/** The forms and calendars some documents name, wherever in them, and the saved sections they show. */
interface NamedLeads {
  readonly forms: (string | null)[];
  readonly calendars: (string | null)[];
  readonly sections: (string | null)[];
}

const FORMS_NAMED = '$.** ? (@.type == "form").props.formId';
const CALENDARS_NAMED = '$.** ? (@.type == "calendar").props.calendarId';
const SECTIONS_SHOWN = '$.sections[*] ? (@.type == "saved_section").sectionId';

/**
 * Whether the site takes a lead on any page a visitor can reach: a published form shown,
 * or a calendar that can be booked, on a published page of it or in a saved section such
 * a page shows. Exactly what the renderer would write for them, so a site whose only form
 * was unpublished loads nothing for it. Asked only when a page is rendered: two statements
 * for what the site's pages name, then the readers every page's own forms and calendars
 * are read with. What was looked at is added to `references`, so the page is rendered
 * again when any of it changes (private.site_page_state).
 */
async function readTakesLeads(
  trx: DatabaseTransaction,
  siteId: string,
  readers: PageReaders,
  references: PageReferences | undefined,
): Promise<boolean> {
  const {
    rows: [pages],
  } = await sql<NamedLeads>`
    with docs as (
      select v.document
      from sites.pages p
      join sites.page_versions v on v.page_id = p.id and v.number = p.published_version
      where p.site_id = ${siteId}::uuid and p.role = 'control'
    )
    select
      array(select distinct jsonb_path_query(document, ${FORMS_NAMED}::jsonpath) #>> '{}' from docs) as forms,
      array(select distinct jsonb_path_query(document, ${CALENDARS_NAMED}::jsonpath) #>> '{}' from docs) as calendars,
      array(select distinct jsonb_path_query(document, ${SECTIONS_SHOWN}::jsonpath) #>> '{}' from docs) as sections
  `.execute(trx);
  const ids = (kind: 'form' | 'calendar' | 'site_section', named: readonly (string | null)[]) =>
    named.flatMap((id) => (id === null ? [] : (parsePublicId(kind, id) ?? [])));
  const sectionIds = ids('site_section', pages?.sections ?? []);
  let inSections: NamedLeads | undefined;
  if (sectionIds.length > 0)
    ({
      rows: [inSections],
    } = await sql<NamedLeads>`
      with docs as (
        select c.document
        from sites.saved_sections c
        where c.id = any (${sectionIds}::uuid[])
          and (c.site_id is null or c.site_id = ${siteId}::uuid)
      )
      select
        array(select distinct jsonb_path_query(document, ${FORMS_NAMED}::jsonpath) #>> '{}' from docs) as forms,
        array(select distinct jsonb_path_query(document, ${CALENDARS_NAMED}::jsonpath) #>> '{}' from docs) as calendars,
        '{}'::text[] as sections
    `.execute(trx));
  const formIds = [
    ...new Set(ids('form', [...(pages?.forms ?? []), ...(inSections?.forms ?? [])])),
  ];
  const calendarIds = [
    ...new Set(ids('calendar', [...(pages?.calendars ?? []), ...(inSections?.calendars ?? [])])),
  ];
  if (references !== undefined) {
    const add = (held: readonly string[], more: readonly string[]) => [
      ...new Set([...held, ...more]),
    ];
    references.sectionIds = add(references.sectionIds, sectionIds);
    references.formIds = add(references.formIds, formIds);
    references.calendarIds = add(references.calendarIds, calendarIds);
  }
  if (readers.forms !== undefined && formIds.length > 0)
    for (const form of (await readers.forms(trx, formIds)).values())
      if (form.published) return true;
  if (readers.bookingUrl !== undefined)
    for (const calendar of (await readCalendarLinks(trx, calendarIds)).values())
      if (calendar.bookable) return true;
  return false;
}

/** The business's custom values that say something, under every name a page may write. */
async function readMergeValues(trx: DatabaseTransaction): Promise<Map<string, string>> {
  const rows = await trx.selectFrom('crm.custom_values').select(['key', 'value']).execute();
  const values = new Map<string, string>();
  for (const row of rows)
    if (row.value.trim() !== '')
      for (const path of customValuePaths(row.key)) values.set(path, row.value);
  return values;
}

/**
 * The calendars of this business among those named: where each one's booking page is, as
 * a path on the install, and whether that page would take a booking right now.
 */
async function readCalendarLinks(
  trx: DatabaseTransaction,
  ids: readonly string[],
): Promise<Map<string, { path: string; bookable: boolean }>> {
  const found = new Map<string, { path: string; bookable: boolean }>();
  if (ids.length === 0) return found;
  const { rows } = await sql<{
    calendar_id: string;
    agency_slug: string;
    business_slug: string;
    calendar_slug: string;
    bookable: boolean;
  }>`
    select calendar_id, agency_slug, business_slug, calendar_slug, bookable
    from private.site_calendar_links(${[...ids]}::uuid[])
  `.execute(trx);
  for (const row of rows)
    found.set(toPublicId('calendar', row.calendar_id), {
      path: `${BOOKING_PAGE_PATH}/${row.agency_slug}/${row.business_slug}/${row.calendar_slug}`,
      bookable: row.bookable,
    });
  return found;
}

/**
 * The facts a page's checks and its renderer share, for one document of one step. With
 * `references`, what was looked for is written there.
 */
export async function readPageFacts(
  trx: DatabaseTransaction,
  site: SiteMap,
  page: { readonly stepId: string; readonly role: 'control' | 'variation' },
  document: PageDocument,
  readers: PageReaders,
  references?: PageReferences,
): Promise<PageFacts> {
  const { forms } = readers;
  const { sectionIds } = pageDocumentReferences(document);
  const sections = new Map<string, PageSection>();
  const wanted = sectionIds.flatMap((id) => parsePublicId('site_section', id) ?? []);
  if (wanted.length > 0) {
    const rows = await trx
      .selectFrom('sites.saved_sections')
      .select(['id', 'document'])
      .where('id', 'in', wanted)
      .where((eb) => eb.or([eb('site_id', 'is', null), eb('site_id', '=', site.id)]))
      .execute();
    for (const row of rows) {
      // Written through the schema on every save; one this release cannot read is left out.
      const parsed = pageSection.safeParse(row.document);
      if (parsed.success) sections.set(toPublicId('site_section', row.id), parsed.data);
    }
  }
  const formIds = new Set<string>();
  const calendarIds = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === 'object' && value !== null) {
      const node = value as {
        type?: unknown;
        props?: { formId?: unknown; calendarId?: unknown };
      };
      if (node.type === 'form' && typeof node.props?.formId === 'string')
        formIds.add(node.props.formId);
      if (node.type === 'calendar' && typeof node.props?.calendarId === 'string')
        calendarIds.add(node.props.calendarId);
      Object.values(value).forEach(collect);
    }
  };
  collect(document);
  for (const section of sections.values()) collect(section);
  let known: Map<string, { key: string; published: boolean }> | undefined;
  if (references !== undefined) references.sectionIds = wanted;
  if (forms !== undefined) {
    known = new Map();
    const ids = [...formIds].flatMap((id) => parsePublicId('form', id) ?? []);
    if (references !== undefined) references.formIds = ids;
    const found: Awaited<ReturnType<ReadSiteForms>> =
      ids.length === 0 ? new Map() : await forms(trx, ids);
    for (const [id, form] of found)
      known.set(toPublicId('form', id), { key: form.publicKey, published: form.published });
  }
  const wantedCalendars = [...calendarIds].flatMap((id) => parsePublicId('calendar', id) ?? []);
  if (references !== undefined) references.calendarIds = wantedCalendars;
  const calendars =
    readers.bookingUrl === undefined ? undefined : await readCalendarLinks(trx, wantedCalendars);
  const own = site.steps.find((step) => step.id === page.stepId);
  const next =
    site.kind === 'funnel' && own !== undefined
      ? site.steps.find((step) => step.position > own.position)
      : undefined;
  return {
    kind: site.kind,
    role: page.role,
    steps: new Map(
      site.steps.map((step) => [
        toPublicId('site_step', step.id),
        { name: step.name, path: step.path, published: step.published },
      ]),
    ),
    nextStepId: next === undefined ? undefined : toPublicId('site_step', next.id),
    sections,
    forms: known,
    calendars,
    mergeValues: await readMergeValues(trx),
    scripts: {
      countdown: readers.scripts?.countdown !== undefined,
      popup: readers.scripts?.popup !== undefined,
    },
  };
}

/** The site's own address on the install, as a path: `/s/<key>`. */
export const sitePath = (publicKey: string): string => `${SITE_PAGE_PATH}/${publicKey}`;

function renderContext(
  site: SiteMap,
  facts: PageFacts,
  step: { readonly name: string; readonly path: string },
  options: {
    readonly publicUrl: string;
    readonly now: number;
    readonly preview: boolean;
    readonly readers: PageReaders;
    /** Whether the pages of this site keep how a visitor arrived (served, below). */
    readonly arrival: RenderContext['arrival'];
  },
): RenderContext {
  const { bookingUrl } = options.readers;
  const base = sitePath(site.publicKey);
  const next = facts.nextStepId === undefined ? undefined : facts.steps.get(facts.nextStepId);
  return {
    siteBase: base,
    title: step.name,
    canonicalUrl: new URL(`${base}/${step.path}`, options.publicUrl).toString(),
    faviconUrl: site.faviconUrl,
    // The install's own address is shared by every tenant: nothing on it is listed.
    index: false,
    preview: options.preview,
    // Only steps a visitor can reach are linked to; the rest stay plain text.
    steps: new Map(
      [...facts.steps].flatMap(([id, each]) => (each.published ? [[id, each.path]] : [])),
    ),
    nextStepPath: next?.published === true ? next.path : undefined,
    sections: facts.sections,
    forms: new Map(
      [...(facts.forms ?? [])].flatMap(([id, form]) => (form.published ? [[id, form.key]] : [])),
    ),
    formScriptUrl: FORM_SCRIPT_PATH,
    // A calendar is linked to only while its booking page would take a booking. The
    // address is whole, since the booking page is the install's, not the site's.
    calendars: new Map(
      bookingUrl === undefined
        ? []
        : [...(facts.calendars ?? [])].flatMap(([id, calendar]) =>
            calendar.bookable ? [[id, new URL(calendar.path, bookingUrl).toString()]] : [],
          ),
    ),
    mergeValues: facts.mergeValues,
    scripts: options.readers.scripts,
    arrival: options.arrival,
    now: options.now,
    // What a visitor is sent holds only the rules of what is on the page.
    baseRules: 'used',
  };
}

/**
 * The response headers of a site's Security tab that are safe on an address tenants share
 * with each other and with the dashboard: ones that can only narrow what this one page
 * does. Everything else (a policy of the tenant's own, cross-origin sharing, anything that
 * speaks for the whole address) waits for the site's own connected domain.
 */
const SHARED_ADDRESS_HEADERS = new Set([
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'x-permitted-cross-domain-policies',
]);

/** A page as the transport sends it. */
export interface ServedSitePage {
  readonly html: string;
  /** The same page as the bytes that are sent (UTF-8), made once. */
  readonly body: Buffer;
  /** A strong validator of exactly these bytes. */
  readonly etag: string;
  /** The Content-Security-Policy this page is sent with. */
  readonly policy: string;
  /** The site's own response headers that apply on this address, names in lowercase. */
  readonly headers: readonly { readonly name: string; readonly value: string }[];
  /**
   * Which published page this is, for whoever counts views and for the limit of its
   * business. Left out for a preview: a draft shown to its editor is nobody's view.
   */
  readonly view?: ServedView | undefined;
}

/** What was served, for whoever counts it. Ids only: nothing about the visitor. */
export interface ServedView {
  readonly businessId: string;
  readonly siteId: string;
  readonly stepId: string;
  readonly pageId: string;
}

export interface PublicSiteRequest {
  readonly requestId: string;
}

export interface PublicSiteHandlers {
  /**
   * The published page at a site's key and path (empty for the site's own address), or
   * undefined for anything that is not there to be seen.
   */
  readonly page: (
    siteKey: string,
    path: string,
    request: PublicSiteRequest,
  ) => Promise<ServedSitePage | undefined>;
  /** The newest saved version of the page a preview link names, or undefined. */
  readonly preview: (
    previewToken: string,
    request: PublicSiteRequest,
  ) => Promise<ServedSitePage | undefined>;
}

export interface PublicSiteOptions {
  readonly db: Database;
  /** Keys preview links: the server's public intake secret (PUBLIC_INTAKE_SECRET). */
  readonly secret: string;
  /** The install's own public address, where the pages answer. */
  readonly publicUrl: string;
  /** The forms module's reader, for a form shown on a page. */
  readonly forms?: ReadSiteForms | undefined;
  /** Whether the install serves booking pages at its public address (PageReaders.bookingUrl). */
  readonly booking?: boolean | undefined;
  /** Where the install's small page scripts are loaded from (PageReaders.scripts). */
  readonly scripts?: PageScripts | undefined;
  /** The clock, in milliseconds. Tests pass their own. */
  readonly now?: (() => number) | undefined;
  /**
   * How many rendered pages this process keeps, and how many bytes of them (a page counts
   * as twice its bytes on the wire: its text and what is sent). Left out: 500 pages and
   * 64 MiB. Zero for either keeps none, and every visit renders.
   */
  readonly cache?: Partial<PageCacheLimits> | undefined;
  /**
   * Told each time a published page is rendered, which is when it was not kept or what it
   * is made from has changed. For a measurement or a test; a throw here is the caller's.
   */
  readonly onRendered?: ((view: ServedView) => void) | undefined;
}

/** A rendered page as it is kept: with what it was rendered from, and until when it holds. */
interface KeptPage {
  readonly page: ServedSitePage;
  /** private.site_page_state, read at the moment the page's own rows were. */
  readonly state: string;
  readonly sectionIds: readonly string[];
  readonly formIds: readonly string[];
  readonly calendarIds: readonly string[];
  /** When the same rows would render differently (a countdown moves on), in milliseconds. */
  readonly changesAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const visitor = (
  scope: { readonly agencyId: string; readonly businessId: string },
  requestId: string,
): TenantContext => ({
  agencyId: scope.agencyId,
  businessId: scope.businessId,
  // A visitor is nobody the CRM knows: the read is the system's own, in that business.
  actorKind: 'system',
  correlationId: UUID.test(requestId) ? requestId : randomUUID(),
});

const readersOf = (options: PublicSiteOptions): PageReaders => ({
  forms: options.forms,
  bookingUrl: options.booking === true ? options.publicUrl : undefined,
  scripts: options.scripts,
});

async function served(
  trx: DatabaseTransaction,
  site: SiteMap,
  page: { readonly stepId: string; readonly role: 'control' | 'variation' },
  document: PageDocument,
  options: PublicSiteOptions,
  preview: boolean,
  /** Filled with what the page refers to and when it would change by itself. */
  kept?: PageReferences & { changesAt: number },
): Promise<ServedSitePage | undefined> {
  const step = site.steps.find((each) => each.id === page.stepId);
  if (step === undefined) return undefined;
  const readers = readersOf(options);
  const facts = await readPageFacts(trx, site, page, document, readers, kept);
  const now = (options.now ?? Date.now)();
  // How a visitor arrived is kept between the pages of a site that takes a lead somewhere,
  // unless the site says never; a draft shown to its editor is nobody's visit. Asked only
  // when the server has the script to send. What the answer was read from joins what this
  // page is kept by: a form published on another step renders this page again.
  let arrival: RenderContext['arrival'];
  if (!preview && site.keepArrival !== 'never' && readers.scripts?.arrival !== undefined) {
    if (await readTakesLeads(trx, site.id, readers, kept))
      arrival = { site: site.publicKey, always: site.keepArrival === 'always' };
  }
  const rendered = renderPage(
    document,
    renderContext(site, facts, step, {
      publicUrl: options.publicUrl,
      now,
      preview,
      readers,
      arrival,
    }),
  );
  if (rendered === undefined) return undefined;
  if (kept !== undefined)
    kept.changesAt = pageChangesAt(document, facts.sections, now) ?? Number.POSITIVE_INFINITY;
  const headers = await trx
    .selectFrom('sites.security_headers')
    .select(['name_normalized', 'value'])
    .where('site_id', '=', site.id)
    .orderBy('name_normalized')
    .execute();
  return {
    html: rendered.html,
    body: Buffer.from(rendered.html, 'utf8'),
    etag: pageEtag(rendered.html),
    // A draft may be shown beside its editor, on the CRM's own address; a live page in no frame.
    policy: pagePolicy(rendered, { frameAncestors: preview ? 'self' : 'none' }),
    headers: headers.flatMap((header) =>
      header.name_normalized !== null && SHARED_ADDRESS_HEADERS.has(header.name_normalized)
        ? [{ name: header.name_normalized, value: header.value }]
        : [],
    ),
  };
}

/** A document this release can read, or undefined: a page that cannot be shown is not there. */
async function readableVersion(
  trx: DatabaseTransaction,
  pageId: string,
  number: number,
): Promise<PageDocument | undefined> {
  const row = await trx
    .selectFrom('sites.page_versions')
    .select('document')
    .where('page_id', '=', pageId)
    .where('number', '=', number)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  try {
    return storedDocument(row.document);
  } catch {
    return undefined;
  }
}

export function createPublicSiteHandlers(options: PublicSiteOptions): PublicSiteHandlers {
  const { db } = options;
  /** The business a key's site belongs to, while that business is active. */
  const resolve = async (siteKey: string) => {
    const {
      rows: [found],
    } = await sql<{ agency_id: string; business_id: string; site_id: string }>`
      select agency_id, business_id, site_id from private.resolve_site(${siteKey})
    `.execute(db);
    return found;
  };

  /**
   * Everything a page of the site is rendered from, in one statement: undefined when the
   * key names no site of an active business.
   */
  const readState = async (
    executor: Database | DatabaseTransaction,
    siteKey: string,
    sectionIds: readonly string[],
    formIds: readonly string[],
    calendarIds: readonly string[],
  ): Promise<string | undefined> => {
    const {
      rows: [found],
    } = await sql<{ state: string }>`
      select state
      from private.site_page_state(
        ${siteKey}, ${[...sectionIds]}::uuid[], ${[...formIds]}::uuid[], ${[...calendarIds]}::uuid[])
    `.execute(executor);
    return found?.state;
  };

  const cache = new PageCache<KeptPage>({ ...DEFAULT_PAGE_CACHE, ...options.cache });
  /** The renders under way, by page: a page is rendered by one request at a time. */
  const rendering = new Map<string, Promise<ServedSitePage | undefined>>();

  /** Reads the page's rows and renders it, and keeps what was rendered. */
  const render = async (
    siteKey: string,
    path: string,
    address: string,
    request: PublicSiteRequest,
  ): Promise<ServedSitePage | undefined> => {
    // The one way across businesses: a key names its site, its business and its agency.
    const found = await resolve(siteKey);
    const scope =
      found === undefined
        ? undefined
        : { agencyId: found.agency_id, businessId: found.business_id };
    const kept =
      found === undefined || scope === undefined
        ? undefined
        : await withTenant(
            db,
            visitor(scope, request.requestId),
            async (trx): Promise<KeptPage | undefined> => {
              const site = await readSiteMap(trx, found.site_id);
              if (site === undefined) return undefined;
              const step =
                path === ''
                  ? homeStepOf(site.kind, site.steps)
                  : site.steps.find((s) => s.path === path);
              // The control page, whatever the step's split test says: variations are not served.
              if (step === undefined) return undefined;
              const { publishedVersion } = step;
              if (publishedVersion === null) return undefined;
              const document = await readableVersion(trx, step.controlPageId, publishedVersion);
              if (document === undefined) return undefined;
              const references = { sectionIds: [], formIds: [], calendarIds: [], changesAt: 0 };
              const page = await served(
                trx,
                site,
                { stepId: step.id, role: 'control' },
                document,
                options,
                false,
                references,
              );
              if (page === undefined) return undefined;
              // Read in the same snapshot as the rows above: the state of exactly this page.
              const state = await readState(
                trx,
                siteKey,
                references.sectionIds,
                references.formIds,
                references.calendarIds,
              );
              if (state === undefined) return undefined;
              return {
                page: {
                  ...page,
                  view: {
                    businessId: scope.businessId,
                    siteId: site.id,
                    stepId: step.id,
                    pageId: step.controlPageId,
                  },
                },
                state,
                sectionIds: references.sectionIds,
                formIds: references.formIds,
                calendarIds: references.calendarIds,
                changesAt: references.changesAt,
              };
            },
            // One moment of the database for every read, so the state kept with the page
            // is the state the page was rendered from, whatever is saved meanwhile.
            { snapshot: true },
          );
    if (kept === undefined) {
      // Nothing to be seen is never kept: the next request asks again.
      cache.delete(address);
      return undefined;
    }
    // Its text and its bytes are both held.
    cache.set(address, kept, kept.page.body.byteLength * 2);
    if (kept.page.view !== undefined) options.onRendered?.(kept.page.view);
    return kept.page;
  };

  return {
    async page(siteKey, path, request) {
      if (!sitePublicKey.safeParse(siteKey).success) return undefined;
      const address = `${siteKey}/${path}`;
      // A request renders the page itself, or joins the render another request began and
      // then asks again whether what that one kept is still the page: a page saved while
      // a render was under way is never sent to a request that came after the save.
      for (let joined = 0; joined < 3; joined += 1) {
        const kept = cache.get(address);
        if (kept !== undefined && (options.now ?? Date.now)() < kept.changesAt) {
          const state = await readState(
            db,
            siteKey,
            kept.sectionIds,
            kept.formIds,
            kept.calendarIds,
          );
          if (state === kept.state) return kept.page;
          if (state === undefined) {
            // The site is gone, or its business is off.
            cache.delete(address);
            return undefined;
          }
        }
        const running = rendering.get(address);
        if (running === undefined) {
          const mine = render(siteKey, path, address, request);
          rendering.set(address, mine);
          try {
            return await mine;
          } finally {
            rendering.delete(address);
          }
        }
        // Its failure is its own request's; this one goes round again.
        await running.catch(() => undefined);
      }
      // Three renders in a row began before this request could use one: render alone.
      return render(siteKey, path, address, request);
    },

    async preview(previewToken, request) {
      const named = readPreviewToken(options.secret, previewToken, (options.now ?? Date.now)());
      if (named === undefined) return undefined;
      // The link names its page's business: the draft is read there, under row-level
      // security, and only while that business is active.
      return withTenant(db, visitor(named, request.requestId), async (trx) => {
        const page = await trx
          .selectFrom('sites.pages')
          .select(['id', 'step_id', 'site_id', 'role', 'current_version'])
          .where('id', '=', named.pageId)
          .executeTakeFirst();
        if (page === undefined) return undefined;
        const site = await readSiteMap(trx, page.site_id);
        if (site === undefined) return undefined;
        const active = await resolve(site.publicKey);
        if (active?.business_id !== named.businessId) return undefined;
        const document = await readableVersion(trx, page.id, page.current_version);
        if (document === undefined) return undefined;
        return served(
          trx,
          site,
          { stepId: page.step_id, role: roleOf(page.role) },
          document,
          options,
          true,
        );
      });
    },
  };
}

export interface SitePreviewOptions {
  /** The install's public address, when it serves public pages. */
  readonly publicUrl: string | undefined;
  /** Keys the links: the server's public intake secret. */
  readonly secret: string | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * A link that shows the page's newest saved version for a while, for anyone in the
 * business who may read the page. It changes nothing and is not kept: each call makes
 * another, and each runs out by itself.
 */
export async function readSitePagePreview(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
  options: SitePreviewOptions,
): Promise<SitePagePreview> {
  const businessId = requireBusiness(invocation.context);
  const page = await requirePage(trx, publicId);
  if (options.secret === undefined || options.publicUrl === undefined)
    throw new ConflictError(
      'Public pages are switched off on this install, so there is nothing to preview on.',
    );
  // To the whole second: that is as fine as the link says when it runs out.
  const expiresAt =
    Math.floor(((options.now ?? Date.now)() + PREVIEW_MINUTES * 60_000) / 1000) * 1000;
  const token = issuePreviewToken(
    options.secret,
    { agencyId: invocation.context.agencyId, businessId, pageId: page.id },
    expiresAt,
  );
  return {
    url: new URL(`${SITE_PREVIEW_PAGE_PATH}/${token}`, options.publicUrl).toString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/** A page's problems, for the version given, as the page's own read and publishing show them. */
export async function readPageProblems(
  trx: DatabaseTransaction,
  page: { readonly step_id: string; readonly site_id: string; readonly role: string },
  document: PageDocument,
  readers: PageReaders,
): Promise<SitePageProblem[]> {
  const site = await readSiteMap(trx, page.site_id);
  // The page was read a moment ago, so its site was there: it was deleted in between.
  if (site === undefined) throw new ConflictError('This site was deleted.');
  const facts = await readPageFacts(
    trx,
    site,
    { stepId: page.step_id, role: roleOf(page.role) },
    document,
    readers,
  );
  return pageProblems(document, facts);
}

/**
 * Whether this install serves public pages, as a person is told before they publish: a
 * page is published either way, but with no public address nobody can open it.
 */
export function sitePublicStatus(options: {
  readonly publicUrl: string | undefined;
  readonly scripts?: PageScripts | undefined;
}): SitePublicStatus {
  const scripts = {
    countdown: options.scripts?.countdown !== undefined,
    popup: options.scripts?.popup !== undefined,
  };
  if (options.publicUrl === undefined)
    return {
      enabled: false,
      code: 'no_public_secret',
      reason:
        'Public pages are switched off on this install, so a published page cannot be opened by anyone yet. Whoever runs the install switches them on by setting PUBLIC_INTAKE_SECRET and restarting.',
      baseUrl: null,
      scripts: { countdown: false, popup: false },
    };
  return {
    enabled: true,
    code: 'enabled',
    reason: null,
    baseUrl: new URL(SITE_PAGE_PATH, options.publicUrl).toString(),
    scripts,
  };
}
