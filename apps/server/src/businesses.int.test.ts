// Working in a business over HTTP, with real sign-in, against a migrated Postgres: the
// Business-Id header, GET /api/v1/me, and the API isolation suite. Its acceptance
// criterion: a business user can't reach another business by id through any endpoint.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowEveryone } from '@repo/commands';
import {
  aiConnectionSaved,
  contactBulkAction,
  contactDetails,
  contactFacts,
  automationDraftSaved,
  automationFolder,
  automationTestRun,
  business,
  businessProfile,
  association,
  blockedSlot,
  calendarConfiguration,
  calendarGroup,
  company,
  conversation,
  deal,
  messageTemplate,
  messageTemplateFolder,
  pipelineConfiguration,
  endpoints,
  fieldDefinition,
  fieldDeletion,
  fieldFolder,
  customValue,
  leadSourceRule,
  customValueFolder,
  snippet,
  snippetFolder,
  triggerLink,
  me,
  mailboxConnectionAttempt,
  note,
  task,
  savedView,
  smsConnectionStarted,
  phoneNumberSettings,
  webchatWidget,
  form as formContract,
  storedFile,
  scoreRule,
  tag,
  tagGroup,
  tagList,
  type Endpoint,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { parsePublicId, publicIdPrefixes, toPublicId, type TenantContext } from '@repo/kernel';
import { createAiSettingsRoutes } from '@repo/module-ai';
import { createAuthentication, readUserNames, type Authentication } from '@repo/module-auth';
import { marketplaceRoutes } from '@repo/module-tenancy';
import { createGoogleCalendarRoutes } from '@repo/module-calendar';
import { createImportRoutes } from '@repo/module-crm';
import {
  createFiles,
  createMedia,
  fileRoutes,
  mediaRoutes,
  type Files,
  type Media,
} from '@repo/module-files';
import { createFormRoutes } from '@repo/module-forms';
import { createSiteRoutes } from '@repo/module-sites';
import { createMailboxRoutes, createSmsRoutes, createWebchatRoutes } from '@repo/module-messaging';
import {
  createSealingVault,
  newSecretsKey,
  parseSecretsPublicKey,
  type SealingVault,
} from '@repo/module-vault';
import { localStorage } from '@repo/storage';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import type * as z from 'zod';

import { addCommerceRecords, commerceInputs } from '../test/commerce-fixtures.js';
import { addMarketplaceRecords, marketplaceInputs } from '../test/marketplace-fixtures.js';
import { addMediaRecords, mediaInputs } from '../test/media-fixtures.js';
import { addCampaignRecords, campaignInputs } from '../test/campaign-fixtures.js';
import {
  addGoogleRecords,
  googleConnectionsOf,
  googleRouteOptions,
} from '../test/google-fixtures.js';
import { addReport, reportingInputs } from '../test/reporting-fixtures.js';
import { addSiteRecords, SITE_ROUTE_OPTIONS, siteInputs } from '../test/sites-fixtures.js';
import { apiRoutes } from './api-routes.js';
import { API_PREFIX, buildServer, type Server } from './server.js';

const PUBLIC_URL = 'https://crm.example.test';
const PASSWORD = 'correct horse battery staple';

let database: TestDatabase;
let db: Database;
let authentication: Authentication;
let root: string;
let files: Files;
let media: Media;
let sealer: SealingVault;
const servers: Server[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  sealer = await createSealingVault(parseSecretsPublicKey((await newSecretsKey(1)).publicKey));
  authentication = createAuthentication({
    connectionString: database.url('crm_auth'),
    secret: 'a-test-secret-that-is-at-least-32-characters-long',
    publicUrl: PUBLIC_URL,
    onConnectionError: () => undefined,
    log: () => undefined,
    sendMail: () => Promise.resolve(),
  });
  root = await mkdtemp(join(tmpdir(), 'crm-businesses-'));
  const storage = localStorage({ directory: join(root, 'storage') });
  files = createFiles({
    storage,
    uploadDirectory: join(root, 'uploads'),
    maxBytes: 1024 * 1024,
    linkSecret: 'a-files-link-secret-of-32-characters-or-more',
  });
  // Media Storage, over the same files and the same storage.
  media = createMedia({
    storage,
    maxBytes: 1024 * 1024,
    linkSecret: 'a-files-link-secret-of-32-characters-or-more',
    publicUrl: PUBLIC_URL,
    servesPublic: true,
  });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close(1000)));
});

afterAll(async () => {
  await authentication.close();
  await db.destroy();
  await database.close();
  await rm(root, { recursive: true, force: true });
});

let people = 0;
/** Someone who signs in with a password, in these businesses and, if given, the agency. */
async function person(memberships: {
  businesses?: readonly { id: string; agencyId: string }[];
  staffOf?: string;
}): Promise<string> {
  const email = `person-${String(++people)}@harborlights.example`;
  const { id: userId } = await authentication.createUser({
    email,
    name: 'Dana Brooks',
    password: PASSWORD,
    emailVerified: true,
  });
  await database.as('crm_owner', async (sql) => {
    const role = (agencyId: string, scope: 'agency' | 'business') =>
      sql.one<{ id: string }>(
        `insert into tenancy.roles (agency_id, scope, key, name, is_builtin) values ($1, $2, 'owner', 'Owner', true)
         on conflict (agency_id, scope, key) do update set name = excluded.name returning id`,
        [agencyId, scope],
      );
    for (const business of memberships.businesses ?? []) {
      const { id: roleId } = await role(business.agencyId, 'business');
      await sql.query(
        `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
         values ($1, $2, $3, $4)`,
        [userId, business.agencyId, business.id, roleId],
      );
    }
    if (memberships.staffOf !== undefined) {
      const { id: roleId } = await role(memberships.staffOf, 'agency');
      await sql.query(
        'insert into tenancy.memberships (user_id, agency_id, role_id) values ($1, $2, $3)',
        [userId, memberships.staffOf, roleId],
      );
    }
  });
  return email;
}

/** Every route, as start.ts serves them on an install with each service set up. */
const everyRoute = () => [
  ...apiRoutes(authentication, sealer),
  ...createMailboxRoutes(sealer),
  ...createSmsRoutes(sealer, PUBLIC_URL),
  ...createWebchatRoutes(PUBLIC_URL),
  ...createFormRoutes(PUBLIC_URL),
  ...createSiteRoutes(SITE_ROUTE_OPTIONS),
  ...createAiSettingsRoutes({ vault: sealer, localServers: [], people: readUserNames }),
  ...fileRoutes(files, { apiUrl: `${PUBLIC_URL}${API_PREFIX}` }),
  ...mediaRoutes(media),
  ...createImportRoutes({ files, apiUrl: `${PUBLIC_URL}${API_PREFIX}` }),
  // Settings → Calendars → Connections, as an install with Google set up has it.
  ...createGoogleCalendarRoutes(googleRouteOptions(sealer)),
  // The consent page's read and decision, offered with a public address.
  ...marketplaceRoutes({ people: readUserNames, issuer: PUBLIC_URL }).filter(({ endpoint }) =>
    ['readOAuthAuthorization', 'grantOAuthAuthorization'].includes(endpoint.operationId),
  ),
];

/** The API, with every route, and a way to call it as this person, naming a business or not. */
async function signedInAs(email: string) {
  const server = await buildServer({
    config: {
      nodeEnv: 'test',
      role: 'app',
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      databaseAppUrl: database.url('crm_app'),
      databaseWorkerUrl: undefined,
      databasePoolSize: 2,
      shutdownTimeoutMs: 1000,
      dashboardDir: undefined,
      devTenantContext: undefined,
      publicUrl: PUBLIC_URL,
      authentication: undefined,
      trustProxy: [],
      mail: undefined,
      files: undefined,
      vault: undefined,
    },
    logger: pino({ level: 'silent' }),
    serveApi: true,
    routes: everyRoute(),
    services: { db, authorize: allowEveryone },
    authentication,
    files,
    readinessChecks: {},
  });
  servers.push(server);
  const { app } = server;
  const signIn = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json', origin: PUBLIC_URL },
    payload: { email, password: PASSWORD },
    // A client of its own, so sign-in's rate limit counts each person apart. Two octets
    // of the benchmarking range (RFC 2544), since the suite signs in more than 255 people.
    remoteAddress: `198.18.${String(Math.floor(people / 250))}.${String((people % 250) + 1)}`,
  });
  expect(signIn.statusCode).toBe(200);
  const setCookie = signIn.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
    .map((each) => each.split(';')[0] ?? '')
    .join('; ');

  return (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: {
      business?: string;
      payload?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) =>
    app.inject({
      method,
      url: `${API_PREFIX}${path}`,
      headers: {
        cookie,
        origin: PUBLIC_URL,
        ...(options.business === undefined
          ? {}
          : { 'business-id': toPublicId('business', options.business) }),
        ...options.headers,
      },
      ...(options.payload === undefined ? {} : { payload: options.payload as object }),
    });
}

describe('the Business-Id header', () => {
  it('lets a business user work in each of their businesses, one request at a time', async () => {
    const agency = await database.fixtures.agency();
    const a = await database.fixtures.business(agency.id);
    const b = await database.fixtures.business(agency.id);
    const call = await signedInAs(await person({ businesses: [a, b] }));

    const created = await call('POST', '/tags', { business: a.id, payload: { name: 'Wedding' } });
    expect(created.statusCode).toBe(201);
    const inA = await call('GET', '/tags', { business: a.id });
    const inB = await call('GET', '/tags', { business: b.id });

    expect(tagList.parse(inA.json()).items.map((each) => each.name)).toEqual(['Wedding']);
    expect(tagList.parse(inB.json()).items).toEqual([]);
  });

  it('lets agency staff work in any business of their agency, by naming it', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const call = await signedInAs(await person({ staffOf: agency.id }));

    const created = await call('POST', '/tags', {
      business: business.id,
      payload: { name: 'Gold client' },
    });

    expect(created.statusCode).toBe(201);
    const [row] = await database.as('crm_owner', (sql) =>
      sql.query<{ business_id: string }>('select business_id from crm.tags where name = $1', [
        tag.parse(created.json()).name,
      ]),
    );
    expect(row?.business_id).toBe(business.id);
  });

  it("refuses a business the person doesn't work in, and one outside their agency", async () => {
    const agency = await database.fixtures.agency();
    const ours = await database.fixtures.business(agency.id);
    const neighbour = await database.fixtures.business(agency.id);
    const elsewhere = await database.fixtures.business((await database.fixtures.agency()).id);
    const call = await signedInAs(await person({ businesses: [ours] }));

    const sameAgency = await call('GET', '/tags', { business: neighbour.id });
    const otherAgency = await call('GET', '/tags', { business: elsewhere.id });

    expect(sameAgency.statusCode).toBe(403);
    expect(otherAgency.statusCode).toBe(404);
  });
});

describe('GET /api/v1/me', () => {
  it('says who is signed in, where they may work, and where this request works', async () => {
    const agency = await database.fixtures.agency({ name: 'Bluebird Digital' });
    const a = await database.fixtures.business(agency.id, { name: 'Harbor Lights Events' });
    const b = await database.fixtures.business(agency.id, { name: 'Atlas Plumbing' });
    const email = await person({ businesses: [a, b] });
    const call = await signedInAs(email);

    const response = await call('GET', '/me', { business: a.id });

    expect(response.statusCode).toBe(200);
    expect(me.parse(response.json())).toMatchObject({
      user: { name: 'Dana Brooks', email },
      agency: { name: 'Bluebird Digital' },
      agencyStaff: false,
      businesses: [
        { id: toPublicId('business', b.id), name: 'Atlas Plumbing', status: 'active' },
        { id: toPublicId('business', a.id), name: 'Harbor Lights Events', status: 'active' },
      ],
      business: toPublicId('business', a.id),
    });
  });

  // The line under a business's name in the switcher: the town and region of the address
  // its own profile holds, and nothing else of that address.
  it('names each business’s town and region from its profile’s address, and null where there is none', async () => {
    const agency = await database.fixtures.agency();
    const a = await database.fixtures.business(agency.id, { name: 'Harbor Lights Events' });
    const b = await database.fixtures.business(agency.id, { name: 'Atlas Plumbing' });
    const c = await database.fixtures.business(agency.id, { name: 'Cedar Fencing' });
    const outside = await database.fixtures.business(agency.id, { name: 'Not theirs' });
    const call = await signedInAs(await person({ businesses: [a, b, c] }));
    const staff = await signedInAs(await person({ staffOf: agency.id }));
    const profileOf = async (business: { id: string }, address: object | null) => {
      const read = await staff('GET', '/business-profile', { business: business.id });
      expect(read.statusCode, read.body).toBe(200);
      const { id: _id, canManage: _canManage, ...profile } = businessProfile.parse(read.json());
      const saved = await staff('PUT', '/business-profile', {
        business: business.id,
        payload: { ...profile, address },
      });
      expect(saved.statusCode, saved.body).toBe(200);
    };
    const street = { line1: '12 Harbour Road', line2: '', postalCode: '80100', country: 'KE' };
    await profileOf(a, { ...street, city: ' Mombasa ', region: 'Mombasa County' });
    // A town and no region; and an address with neither.
    await profileOf(b, { ...street, city: 'Nakuru', region: '' });
    await profileOf(c, { ...street, city: '', region: '   ' });
    await profileOf(outside, { ...street, city: 'Kisumu', region: 'Kisumu County' });

    const response = await call('GET', '/me', { business: a.id });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      me
        .parse(response.json())
        .businesses.map(({ name, city, region }) => ({ name, city, region })),
    ).toEqual([
      { name: 'Atlas Plumbing', city: 'Nakuru', region: null },
      { name: 'Cedar Fencing', city: null, region: null },
      { name: 'Harbor Lights Events', city: 'Mombasa', region: 'Mombasa County' },
    ]);
    // Nothing else of an address, and nothing of a business they may not enter.
    for (const hidden of ['12 Harbour Road', '80100', 'Kisumu', 'Not theirs'])
      expect(response.body).not.toContain(hidden);
    // A business with no address at all.
    await profileOf(a, null);
    const cleared = await call('GET', '/me', { business: a.id });
    expect(
      me.parse(cleared.json()).businesses.find((each) => each.name === 'Harbor Lights Events'),
    ).toMatchObject({ city: null, region: null });
  });

  // The calendar is drawn in the business's zone, whatever the browser's.
  it('names each business’s own time zone', async () => {
    const agency = await database.fixtures.agency();
    const a = await database.fixtures.business(agency.id, { name: 'Harbor Lights Events' });
    const b = await database.fixtures.business(agency.id, { name: 'Atlas Plumbing' });
    await database.as('crm_owner', (sql) =>
      sql.query(
        "update tenancy.businesses set timezone = case id when $1 then 'America/Chicago' else 'Africa/Nairobi' end where id in ($1, $2)",
        [a.id, b.id],
      ),
    );
    const call = await signedInAs(await person({ businesses: [a, b] }));
    const response = await call('GET', '/me', { business: a.id });
    expect(
      me.parse(response.json()).businesses.map(({ name, timezone }) => ({ name, timezone })),
    ).toEqual([
      { name: 'Atlas Plumbing', timezone: 'Africa/Nairobi' },
      { name: 'Harbor Lights Events', timezone: 'America/Chicago' },
    ]);
  });
});

describe('POST /api/v1/businesses', () => {
  it("lets agency staff create a business that starts with the CRM's defaults, and work in it", async () => {
    const agency = await database.fixtures.agency();
    const call = await signedInAs(await person({ staffOf: agency.id }));

    const created = await call('POST', '/businesses', {
      payload: { name: 'Atlas Plumbing', timezone: 'Europe/London', currency: 'GBP' },
    });

    expect(created.statusCode).toBe(201);
    const businessId = parsePublicId('business', business.parse(created.json()).id) ?? '';
    const types = await database.as('crm_owner', (sql) =>
      sql.query<{ key: string }>(
        'select key from crm.object_types where business_id = $1 order by key',
        [businessId],
      ),
    );
    expect(types.map((type) => type.key)).toEqual(['company', 'contact', 'deal']);
    const tagged = await call('POST', '/tags', { business: businessId, payload: { name: 'VIP' } });
    expect(tagged.statusCode).toBe(201);
  });

  it('is for agency staff only', async () => {
    const agency = await database.fixtures.agency();
    const theirs = await database.fixtures.business(agency.id);
    const call = await signedInAs(await person({ businesses: [theirs] }));

    const refused = await call('POST', '/businesses', {
      payload: { name: 'Atlas Plumbing', timezone: 'Europe/London', currency: 'GBP' },
    });

    expect(refused.statusCode).toBe(403);
  });
});

describe('GET /api/v1/me before choosing', () => {
  it('lists the businesses of someone in several who has chosen none, and nothing else answers', async () => {
    const agency = await database.fixtures.agency();
    const a = await database.fixtures.business(agency.id);
    const b = await database.fixtures.business(agency.id);
    const call = await signedInAs(await person({ businesses: [a, b] }));

    const answer = await call('GET', '/me');
    const tags = await call('GET', '/tags');

    expect(answer.statusCode).toBe(200);
    expect(me.parse(answer.json())).toMatchObject({ business: null });
    expect(
      me
        .parse(answer.json())
        .businesses.map((each) => each.id)
        .sort(),
    ).toEqual([toPublicId('business', a.id), toPublicId('business', b.id)].sort());
    expect(tags.statusCode).toBe(403);
  });

  it('answers someone whose only business is closed, with none to enter, and nothing else does', async () => {
    const agency = await database.fixtures.agency();
    const closed = await database.fixtures.business(agency.id);
    await database.as('crm_owner', (sql) =>
      sql.query(`update tenancy.businesses set status = 'suspended' where id = $1`, [closed.id]),
    );
    const call = await signedInAs(await person({ businesses: [closed] }));

    const answer = await call('GET', '/me');
    const naming = await call('GET', '/me', { business: closed.id });
    const tags = await call('GET', '/tags');

    expect(answer.statusCode).toBe(200);
    expect(me.parse(answer.json())).toMatchObject({ businesses: [], business: null });
    expect(naming.statusCode).toBe(403);
    expect(tags.statusCode).toBe(403);
  });
});

// Every endpoint in the contracts is called by
// someone who works in business A only. Naming business B gets nothing. Naming A, with ids
// of B's records, finds nothing. Neither answer mentions anything of B's.
describe('the API isolation suite', () => {
  const automationDocument = {
    name: 'Business B only',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'pause',
    steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
  };

  /** The kind of record a path parameter holds, from the public id its contract shows. */
  function kindOf(schema: z.ZodType): string {
    const example = (schema.meta()?.['examples'] as readonly unknown[] | undefined)?.[0];
    const prefix = typeof example === 'string' ? example.split('_')[0] : undefined;
    const kind = Object.entries(publicIdPrefixes).find(([, each]) => each === prefix)?.[0];
    if (kind === undefined)
      throw new Error(`No id kind for a parameter shown as ${String(example)}.`);
    return kind;
  }

  /** Business B's records, by kind: every kind an endpoint takes by id needs one here. */
  let phoneLines = 0;
  async function recordsOfB(
    call: Awaited<ReturnType<typeof signedInAs>>,
    b: { readonly id: string; readonly context: TenantContext },
  ): Promise<{
    ids: Record<string, string>;
    calendarRevision: string;
    conversationRevision: string;
    templateRevision: string;
  }> {
    const createdCompany = await call('POST', '/companies', {
      payload: { name: 'Private company' },
    });
    expect(createdCompany.statusCode, createdCompany.body).toBe(201);
    const created = await call('POST', '/tags', { payload: { name: 'Private' } });
    const group = await call('POST', '/tag-groups', { payload: { name: 'Private group' } });
    expect(group.statusCode, group.body).toBe(201);
    // Into B's media library, so the library's endpoints have a file to find.
    const uploaded = await call('POST', '/files?filename=secret.txt&library=true', {
      payload: 'not for A',
      headers: { 'content-type': 'text/plain' },
    });
    expect([created.statusCode, uploaded.statusCode]).toEqual([201, 201]);
    // A CSV file of B's, and an import of it that has ended with a row it did not apply:
    // the rows of that row are B's alone, so the file of them is too.
    const uploadedCsv = await call('POST', '/files?filename=private-contacts.csv', {
      payload: 'First,Email\r\nPrivate,not-an-email\r\n',
      headers: { 'content-type': 'text/csv' },
    });
    expect(uploadedCsv.statusCode, uploadedCsv.body).toBe(201);
    const importFileId = storedFile.parse(uploadedCsv.json()).id;
    const finishedImport = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        `insert into imports.jobs (business_id, source, status, objects, created_by_kind, file_id,
                                   file_name, error_file_id, row_count, processed_count,
                                   failed_count, settings, mapping, started_at, finished_at)
         values ($1, 'csv', 'completed', '{contact}', 'system', $2, 'private-contacts.csv', $2,
                 1, 1, 1,
                 '{"object": "contact", "mode": "create", "delimiter": ",", "columns": 2, "tagIds": []}',
                 '[{"column": 1, "header": "Email", "target": {"kind": "attribute", "attribute": "email"}}]',
                 now(), now())
         returning id`,
        [b.id, parsePublicId('file', importFileId)],
      ),
    );
    const tagId = tag.parse(created.json()).id;
    await database.withTenant(b.context, async (sql) => {
      const pipeline = await sql.one<{ id: string }>(
        "insert into crm.pipelines (business_id, name) values ($1, 'Private') returning id",
        [b.id],
      );
      await sql.query(
        "insert into crm.pipeline_stages (business_id, pipeline_id, name, position) values ($1, $2, 'New', 0)",
        [b.id, pipeline.id],
      );
    });
    const pipelines = await call('GET', '/pipelines');
    const pipeline = pipelineConfiguration.parse(pipelines.json()).items[0];
    const stage = pipeline?.stages[0];
    if (pipeline === undefined || stage === undefined) throw new Error('Missing seeded stage.');
    const createdDeal = await call('POST', '/deals', {
      payload: {
        name: 'Private deal',
        pipelineId: pipeline.id,
        stageId: stage.id,
        currency: 'KES',
      },
    });
    expect(createdDeal.statusCode, createdDeal.body).toBe(201);
    const field = await call('POST', '/fields', {
      payload: {
        objectKey: 'contact',
        key: 'private',
        label: 'Private',
        description: 'Business B only.',
        valueType: 'text',
        currency: null,
        options: [],
        aiFillSources: [],
        aiOverwrite: 'ask',
        archived: false,
      },
    });
    expect(field.statusCode, field.body).toBe(201);
    // A field folder of B's own making, and a custom value in a folder of its own.
    const createdFieldFolder = await call('POST', '/field-folders', {
      payload: { objectKey: 'contact', name: 'Business B only' },
    });
    expect(createdFieldFolder.statusCode, createdFieldFolder.body).toBe(201);
    const createdValueFolder = await call('POST', '/custom-value-folders', {
      payload: { name: 'Business B only' },
    });
    expect(createdValueFolder.statusCode, createdValueFolder.body).toBe(201);
    const savedValueFolder = customValueFolder.parse(createdValueFolder.json());
    const createdValue = await call('POST', '/custom-values', {
      payload: {
        name: 'Business B only',
        value: 'Said to business B’s contacts only.',
        folderId: savedValueFolder.id,
      },
    });
    expect(createdValue.statusCode, createdValue.body).toBe(201);
    const savedFieldFolder = fieldFolder.parse(createdFieldFolder.json());
    // A second field, alone in that folder, so the folder's order is one B's member could
    // send; and what deleting B's first field would lose, with the confirmation for it.
    const filedField = await call('POST', '/fields', {
      payload: {
        objectKey: 'contact',
        key: 'filed',
        label: 'Filed',
        description: 'Business B only, in its own folder.',
        valueType: 'text',
        currency: null,
        options: [],
        aiFillSources: [],
        aiOverwrite: 'ask',
        archived: false,
        folderId: savedFieldFolder.id,
      },
    });
    expect(filedField.statusCode, filedField.body).toBe(201);
    const readDeletion = await call(
      'GET',
      `/fields/${fieldDefinition.parse(field.json()).id}/deletion`,
    );
    expect(readDeletion.statusCode, readDeletion.body).toBe(200);
    const savedValue = customValue.parse(createdValue.json());
    // An engagement score rule of B's own: what A's requests name below.
    const createdScoreRule = await call('POST', '/scoring/rules', {
      payload: {
        when: { action: 'appointment_booked' },
        calculation: 'add',
        points: 10,
      },
    });
    expect(createdScoreRule.statusCode, createdScoreRule.body).toBe(201);
    // A lead source rule of B's own: what A's requests name below.
    const createdRule = await call('POST', '/lead-sources/rules', {
      payload: {
        name: 'Business B only',
        conditions: [{ fact: 'utm_campaign', op: 'contains', value: 'b-only' }],
        source: 'Business B only',
      },
    });
    expect(createdRule.statusCode, createdRule.body).toBe(201);
    const tagCreated = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        `select id from events.events where subject_id = $1 and type = 'tag.created'`,
        [parsePublicId('tag', tagId)],
      ),
    );
    // A notification of B's own member, written as the worker writes one: theirs alone,
    // so not even another member of B reads or marks it, let alone someone in A.
    const told = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        `insert into notifications.notifications
           (agency_id, business_id, user_id, kind, source_key, actor_kind, subject_kind)
         select $1, m.business_id, m.user_id, 'ai.limit_reached', 'business-b-only', 'system',
                'ai_settings'
         from tenancy.memberships m where m.business_id = $2
         returning id`,
        [b.context.agencyId, b.id],
      ),
    );
    // A conversation of B's own member with the in-app assistant, with a turn that has
    // finished: theirs alone, so nobody in A reads it, goes on in it or deletes it.
    const talked = await database.as('crm_owner', async (sql) => {
      const thread = await sql.one<{ id: string; user_id: string }>(
        `insert into ai.assistant_threads (business_id, user_id, title, message_seq)
         select m.business_id, m.user_id, 'Business B only', 1
         from tenancy.memberships m where m.business_id = $1
         returning id, user_id`,
        [b.id],
      );
      const turn = await sql.one<{ id: string }>(
        `insert into ai.assistant_turns (business_id, thread_id, user_id, status, outcome, page,
           correlation_id, finished_at)
         values ($1, $2, $3, 'finished', 'answered', '{"route": "/forms"}', uuidv7(), now())
         returning id`,
        [b.id, thread.id, thread.user_id],
      );
      await sql.query(
        `insert into ai.assistant_messages (business_id, thread_id, turn_id, user_id, seq, kind, text)
         values ($1, $2, $3, $4, 1, 'user', 'Business B only')`,
        [b.id, thread.id, turn.id, thread.user_id],
      );
      return { thread: thread.id, turn: turn.id };
    });
    const user = await database.fixtures.user();
    const teamRecords = await database.as('crm_owner', async (sql) => {
      const role = await sql.one<{ id: string; agency_id: string }>(
        `select r.id, r.agency_id from tenancy.roles r join tenancy.businesses b on b.agency_id = r.agency_id where b.id = $1 and r.scope = 'business' limit 1`,
        [b.id],
      );
      const invitation = await sql.one<{ id: string }>(
        `insert into tenancy.invitations (agency_id, business_id, role_id, email, token_hash, expires_at) values ($1, $2, $3, 'private@example.test', decode(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 'hex'), now() + interval '7 days') returning id`,
        [role.agency_id, b.id, role.id],
      );
      const membership = await sql.one<{ id: string }>(
        `insert into tenancy.memberships (agency_id, business_id, role_id, user_id) values ($1, $2, $3, $4) returning id`,
        [role.agency_id, b.id, role.id, user.id],
      );
      const key = await sql.one<{ id: string }>(
        `insert into tenancy.api_keys (agency_id, business_id, name, key_prefix, key_hash, scopes)
         values ($1, $2, 'Private', 'crm_live_' || substr(md5(gen_random_uuid()::text), 1, 12),
           sha256(gen_random_uuid()::text::bytea),
           array['tags.manage']) returning id`,
        [role.agency_id, b.id],
      );
      return {
        invitation: toPublicId('invitation', invitation.id),
        membership: toPublicId('membership', membership.id),
        api_key: toPublicId('api_key', key.id),
      };
    });
    const contactId = toPublicId('contact', (await database.fixtures.contact(b.context)).id);
    // A second contact of B's, which a merge names to merge into the first.
    const mergeContactId = toPublicId('contact', (await database.fixtures.contact(b.context)).id);
    // B's file is one of that contact's documents too, for the routes that take a record and
    // one of its files.
    await database.as('crm_owner', (sql) =>
      sql.query(
        `insert into crm.record_files (business_id, file_id, record_id, created_by_kind)
         values ($1, $2, $3, 'user')`,
        [
          b.id,
          parsePublicId('file', storedFile.parse(uploaded.json()).id),
          parsePublicId('contact', contactId),
        ],
      ),
    );
    // A note on that contact, for the routes that take a record and one of its notes.
    const createdNote = await call('POST', `/records/${contactId}/notes`, {
      payload: {
        body: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Business B only.' }] }],
        },
      },
    });
    expect(createdNote.statusCode, createdNote.body).toBe(201);
    const createdTask = await call('POST', '/tasks', {
      payload: { title: 'Business B only.', recordId: contactId },
    });
    expect(createdTask.statusCode, createdTask.body).toBe(201);
    // A private view of B's person, for the routes that take a saved view.
    const createdView = await call('POST', '/views', {
      payload: { objectKey: 'contact', name: 'Business B only.', state: {}, columns: ['name'] },
    });
    expect(createdView.statusCode, createdView.body).toBe(201);
    const login = {
      host: 'mail.example.test',
      port: 993,
      security: 'tls',
      username: 'private@example.test',
      password: 'fixture-only-password',
    };
    const attempt = await call('POST', '/mailbox-connection-attempts', {
      payload: {
        name: 'Business B only',
        email: 'private@example.test',
        smtp: { ...login, port: 465 },
        imap: login,
      },
    });
    expect(attempt.statusCode, attempt.body).toBe(201);
    const mailboxId = await withTenant(db, b.context, async (trx) => {
      const secretId = await sealer.store(
        trx,
        {
          agencyId: b.context.agencyId,
          businessId: b.id,
          purpose: 'mailbox.credentials',
        },
        JSON.stringify({
          name: 'Business B only',
          email: 'private@example.test',
          smtp: { ...login, port: 465 },
          imap: login,
        }),
      );
      const channel = await trx
        .insertInto('messaging.channel_accounts')
        .values({
          business_id: b.id,
          channel: 'email',
          name: 'Business B only',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('messaging.mailboxes')
        .values({
          business_id: b.id,
          id: channel.id,
          email_address: 'private@example.test',
          auth_method: 'password',
          smtp_host: login.host,
          smtp_port: 465,
          smtp_security: 'tls',
          smtp_username: login.username,
          secret_id: secretId,
        })
        .execute();
      return toPublicId('mailbox', channel.id);
    });
    // A conversation: the contact wrote to that mailbox, as the inbox sync stores it.
    const mailboxUuid = parsePublicId('mailbox', mailboxId) ?? '';
    const inbox = await database.as('crm_owner', async (sql) => {
      const identity = await sql.one<{ id: string }>(
        `insert into crm.contact_identities
           (business_id, contact_id, kind, value, value_normalized, is_primary)
         values ($1, $2, 'email', 'client@example.test', 'client@example.test', true) returning id`,
        [b.id, parsePublicId('contact', contactId)],
      );
      const conversation = await sql.one<{ id: string }>(
        'insert into messaging.conversations (business_id, contact_id) values ($1, $2) returning id',
        [b.id, parsePublicId('contact', contactId)],
      );
      const message = await sql.one<{ id: string }>(
        `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id,
           direction, status, subject, body_text, from_address, author_kind, author_id)
         values ($1, $2, 'email', $3, 'inbound', 'received', 'Private', 'Business B only.',
           'client@example.test', 'contact', $4) returning id`,
        [b.id, conversation.id, mailboxUuid, parsePublicId('contact', contactId)],
      );
      return {
        conversation: toPublicId('conversation', conversation.id),
        message: toPublicId('message', message.id),
        channel_account: toPublicId('channel_account', mailboxUuid),
        contact_identity: toPublicId('contact_identity', identity.id),
      };
    });
    const readConversation = await call('GET', `/conversations/${inbox.conversation}`);
    expect(readConversation.statusCode, readConversation.body).toBe(200);
    // The contact page's details, for the revision B's own member would change an address from.
    const readDetails = await call('GET', `/contacts/${contactId}/details`);
    expect(readDetails.statusCode, readDetails.body).toBe(200);
    // A bulk action of B's on that contact: its line in the Bulk Actions tab.
    const startedBulk = await call('POST', '/contacts/bulk', {
      payload: { action: 'assign_owner', owner: null, selection: { ids: [contactId] } },
    });
    expect(startedBulk.statusCode, startedBulk.body).toBe(201);
    // What B's assistant proposed for that conversation: a reply, waiting for a person of
    // B's to decide. Stored as the draft job stores one; nothing of it was sent.
    const reply = {
      channel: 'email',
      accountId: inbox.channel_account,
      to: inbox.contact_identity,
      subject: null,
      text: 'Drafted for business B only.',
    };
    const proposed = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        `insert into ai.proposals (business_id, agent, kind, conversation_id, summary, command,
           after, autonomy, revision)
         values ($1, 'inbox', 'reply', $2, 'Reply for business B only', $3, $4, 'ask', 'thread:1')
         returning id`,
        [
          b.id,
          parsePublicId('conversation', inbox.conversation),
          {
            name: 'conversation.reply',
            input: {
              id: inbox.conversation,
              reply: { ...reply, idempotencyKey: 'proposal-of-business-b-only-0001' },
            },
          },
          { kind: 'reply', ...reply },
        ],
      ),
    );
    // What B's assistant knows about that contact, and what it has read there and still
    // proposes: a fact it kept on its own, and a fact waiting for a person of B's. Stored
    // as the extraction job and its command store them. The event named is the message's
    // own id: well-formed, and never looked up, since nothing here applies it.
    const remembered = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        `insert into ai.contact_facts (business_id, contact_id, statement, kind, status,
           created_by_kind, conversation_id)
         values ($1, $2, 'Business B only: prefers a call after five', 'preference', 'proposed',
           'ai_agent', $3)
         returning id`,
        [
          b.id,
          parsePublicId('contact', contactId),
          parsePublicId('conversation', inbox.conversation),
        ],
      ),
    );
    const factToRemember = {
      statement: 'Business B only: works nights',
      quote: 'Business B only.',
    };
    const factProposed = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        `insert into ai.proposals (business_id, agent, kind, record_id, summary, command, after,
           autonomy, revision)
         values ($1, 'extraction', 'memory_fact', $2, 'Remember a fact about this contact', $3,
           $4, 'ask', 'contact')
         returning id`,
        [
          b.id,
          parsePublicId('contact', contactId),
          {
            name: 'contact_fact.remember',
            input: {
              id: contactId,
              ...factToRemember,
              kind: 'circumstance',
              conversationId: inbox.conversation,
              eventIds: [toPublicId('event', parsePublicId('message', inbox.message) ?? '')],
            },
          },
          { kind: 'memory_fact', ...factToRemember, factKind: 'circumstance' },
        ],
      ),
    );
    // Read as B's own member, for the fact's id and the revision they would rewrite it from.
    const readFacts = await call('GET', `/contacts/${contactId}/memory/facts`);
    expect(readFacts.statusCode, readFacts.body).toBe(200);
    const [knownFact] = contactFacts.parse(readFacts.json()).items;
    expect(knownFact?.id).toBe(toPublicId('contact_fact', remembered.id));
    // A calendar, for the routes that read and save one.
    const createdCalendar = await call('POST', '/calendars', {
      payload: {
        name: 'Business B only',
        kind: 'personal',
        timezone: 'UTC',
        bookingSlug: 'business-b-only',
        members: [],
        weeklyHours: [],
        dateOverrides: [],
      },
    });
    expect(createdCalendar.statusCode, createdCalendar.body).toBe(201);
    // A message template, for the routes that read, edit, archive and restore one.
    const createdTemplate = await call('POST', '/message-templates', {
      payload: {
        name: 'Business B only',
        subject: 'Private subject',
        body: 'Hi {{contact.firstName}}, for business B only.',
      },
    });
    expect(createdTemplate.statusCode, createdTemplate.body).toBe(201);
    const savedTemplate = messageTemplate.parse(createdTemplate.json());
    const createdTemplateFolder = await call('POST', '/message-template-folders', {
      payload: { name: 'Business B private library' },
    });
    expect(createdTemplateFolder.statusCode, createdTemplateFolder.body).toBe(201);
    const savedTemplateFolder = messageTemplateFolder.parse(createdTemplateFolder.json());
    // A Twilio account being checked, and one already connected with a number it owns.
    const smsAttempt = await call('POST', '/sms-connection-attempts', {
      payload: {
        provider: 'twilio',
        label: 'Business B only',
        accountSid: `AC${randomUUID().replaceAll('-', '')}`,
        authToken: 'fixture-only-token',
      },
    });
    expect(smsAttempt.statusCode, smsAttempt.body).toBe(201);
    const smsSecretId = await withTenant(db, b.context, (trx) =>
      sealer.store(
        trx,
        { agencyId: b.context.agencyId, businessId: b.id, purpose: 'sms.twilio.credentials' },
        'fixture-only-credentials',
      ),
    );
    const smsConnectionId = await database.as('crm_owner', async (sql) => {
      const connection = await sql.one<{ id: string }>(
        `insert into messaging.provider_connections (agency_id, business_id, provider, label, account_ref, secret_id)
         values ($1, $2, 'twilio', 'Business B only', $3, $4) returning id`,
        [b.context.agencyId, b.id, `AC${randomUUID().replaceAll('-', '')}`, smsSecretId],
      );
      await sql.query(
        `insert into messaging.provider_numbers (business_id, connection_id, provider_number_ref, e164, friendly_name, capabilities)
         values ($1, $2, $3, '+15005550006', 'Business B only', array['sms'])`,
        [b.id, connection.id, `PN${randomUUID().replaceAll('-', '')}`],
      );
      return toPublicId('sms_connection', connection.id);
    });
    // A number of B's that takes calls, registered from that connection, and the revision
    // B's own manager would save its Phone System settings from.
    const phoneNumberId = await database.as('crm_owner', async (sql) => {
      const channel = await sql.one<{ id: string }>(
        `insert into messaging.channel_accounts (business_id, channel, name)
         values ($1, 'sms', 'Business B line') returning id`,
        [b.id],
      );
      await sql.query(
        `insert into messaging.phone_numbers (business_id, id, e164, provider_connection_id, provider_number_ref, capabilities)
         values ($1, $2, $3, $4, $5, array['sms', 'voice'])`,
        [
          b.id,
          channel.id,
          // A number is one business's in the whole install, and B is made once per case.
          `+1500556${String(1000 + (phoneLines += 1))}`,
          parsePublicId('sms_connection', smsConnectionId),
          `PN${randomUUID().replaceAll('-', '')}`,
        ],
      );
      return toPublicId('phone_number', channel.id);
    });
    // A call of B's on that number, as a request leaves one before the worker places it.
    // Calls are asked for over the API only once calling is available.
    const callId = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        `insert into messaging.calls (business_id, direction, phone_number_id, provider_connection_id,
           local_e164, remote_e164, requested_by_kind, idempotency_key, request_hash)
         select n.business_id, 'outbound', n.id, n.provider_connection_id, n.e164, '+15005550006',
           'system', $3, repeat('b', 64)
         from messaging.phone_numbers n where n.business_id = $1 and n.id = $2 returning id`,
        [
          b.id,
          parsePublicId('phone_number', phoneNumberId),
          `b-only-${randomUUID().replaceAll('-', '')}`,
        ],
      ),
    );
    // Calling set up on B's account, and a calling token one of B's people asked for.
    const voiceGrantId = await database.as('crm_owner', async (sql) => {
      const connection = parsePublicId('sms_connection', smsConnectionId);
      const secret = await sql.one<{ secret_id: string; user_id: string }>(
        `select c.secret_id, m.user_id from messaging.provider_connections c
         join tenancy.memberships m on m.business_id = c.business_id
         where c.id = $1 limit 1`,
        [connection],
      );
      await sql.query(
        `insert into messaging.voice_setups (business_id, connection_id, status, key_sid, secret_id, finished_at)
         values ($1, $2, 'ready', 'SK' || repeat('b', 32), $3, now())`,
        [b.id, connection, secret.secret_id],
      );
      return sql.one<{ id: string }>(
        `insert into messaging.voice_grants (business_id, user_id, connection_id, status, token, token_expires_at, issued_at)
         values ($1, $2, $3, 'issued', 'token-of-b', now() + interval '10 minutes', now()) returning id`,
        [b.id, secret.user_id, connection],
      );
    });
    const phoneSettings = phoneNumberSettings.parse(
      (await call('GET', `/phone-numbers/${phoneNumberId}/settings`)).json(),
    );
    // A web chat widget that is on, with its public key.
    const createdWidget = await call('POST', '/webchat/widgets', { payload: webchatInput });
    expect(createdWidget.statusCode, createdWidget.body).toBe(201);
    const savedWidget = webchatWidget.parse(createdWidget.json());
    // An AI provider's key of B's own, sealed, with the test that was queued for it.
    const connectedAi = await call('POST', '/ai/connections', {
      payload: { provider: 'anthropic', apiKey: AI_KEY_OF_B },
    });
    expect(connectedAi.statusCode, connectedAi.body).toBe(201);
    const savedAi = aiConnectionSaved.parse(connectedAi.json());
    // A form, and a submission to it that reached no contact: the kind a team may discard.
    const createdForm = await call('POST', '/forms', { payload: { name: 'Business B only' } });
    expect(createdForm.statusCode, createdForm.body).toBe(201);
    const savedForm = formContract.parse(createdForm.json());
    const submission = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        `insert into forms.submissions (business_id, form_id, data, contact_outcome)
         values ($1, $2, '{"answers": [], "skipped": []}', 'unresolved') returning id`,
        [b.id, parsePublicId('form', savedForm.id)],
      ),
    );
    // A live automation with a version, a test run of its draft, and a contact in it.
    const createdAutomation = await call('POST', '/automations', {
      payload: { document: automationDocument },
    });
    expect(createdAutomation.statusCode, createdAutomation.body).toBe(201);
    const automationId = automationDraftSaved.parse(createdAutomation.json()).automation.id;
    const published = await call('POST', `/automations/${automationId}/publish`, {
      payload: { baseDraftVersion: 1, changeSummary: 'Business B only.' },
    });
    expect(published.statusCode, published.body).toBe(200);
    const testRun = await call('POST', `/automations/${automationId}/test-runs`, { payload: {} });
    expect(testRun.statusCode, testRun.body).toBe(201);
    const enrolment = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        `insert into automation.enrolments (business_id, automation_id, version_id, record_id, reentry_key, current_step, correlation_id)
         select business_id, automation_id, id, $2, $2, 'pause', gen_random_uuid()
         from automation.versions where automation_id = $1 returning id`,
        [parsePublicId('automation', automationId), parsePublicId('contact', contactId)],
      ),
    );
    // A call that run left for a person, and a snippet in a folder and a trigger link of
    // B's own.
    const queued = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        `insert into automation.manual_actions (business_id, automation_id, enrolment_id, step_key, contact_id, kind, body)
         select business_id, automation_id, id, 'pause', record_id, 'call', 'Said to business B only.'
         from automation.enrolments where id = $1 returning id`,
        [enrolment.id],
      ),
    );
    const createdSnippetFolder = await call('POST', '/snippet-folders', {
      payload: { name: 'Business B only' },
    });
    expect(createdSnippetFolder.statusCode, createdSnippetFolder.body).toBe(201);
    const savedSnippetFolder = snippetFolder.parse(createdSnippetFolder.json());
    const createdSnippet = await call('POST', '/snippets', {
      payload: {
        type: 'text',
        name: 'Business B only',
        body: 'Said to business B’s contacts only.',
        folderId: savedSnippetFolder.id,
      },
    });
    expect(createdSnippet.statusCode, createdSnippet.body).toBe(201);
    const savedSnippet = snippet.parse(createdSnippet.json());
    const createdLink = await call('POST', '/trigger-links', {
      payload: { name: 'Business B only', url: 'https://b-only.example/offer' },
    });
    expect(createdLink.statusCode, createdLink.body).toBe(201);
    const savedLink = triggerLink.parse(createdLink.json());
    // A folder for automations, with that automation filed in it.
    const createdFolder = await call('POST', '/automation-folders', {
      payload: { name: 'Business B only' },
    });
    expect(createdFolder.statusCode, createdFolder.body).toBe(201);
    const automationFolderId = automationFolder.parse(createdFolder.json()).id;
    const filed = await call('PUT', `/automations/${automationId}/folder`, {
      payload: { folderId: automationFolderId },
    });
    expect(filed.statusCode, filed.body).toBe(200);
    // A webhook secret of B's, which its own routes replace and delete by name.
    const storedSecret = await call('PUT', `/automations/webhook-secrets/${WEBHOOK_SECRET_OF_B}`, {
      payload: { value: WEBHOOK_SECRET_VALUE_OF_B },
    });
    expect(storedSecret.statusCode, storedSecret.body).toBe(200);
    const savedCalendar = calendarConfiguration.parse(createdCalendar.json());
    // A group for calendars (0074), which the group's own routes rename and delete.
    const createdCalendarGroup = await call('POST', '/calendar-groups', {
      payload: { name: 'Business B only' },
    });
    expect(createdCalendarGroup.statusCode, createdCalendarGroup.body).toBe(201);
    const savedCalendarGroup = calendarGroup.parse(createdCalendarGroup.json());
    // A blocked slot of that calendar, which its own routes read, change and remove.
    const createdBlock = await call('POST', '/calendars/blocked-slots', {
      payload: {
        calendarId: savedCalendar.calendar.id,
        title: 'Business B only',
        startsAt: '2026-11-03T06:00:00Z',
        endsAt: '2026-11-03T07:00:00Z',
      },
    });
    expect(createdBlock.statusCode, createdBlock.body).toBe(201);
    const savedBlock = blockedSlot.parse(createdBlock.json());
    // An appointment on that calendar, for the routes that read, move, cancel and mark one.
    const appointment = await database.withTenant(b.context, (sql) =>
      sql.one<{ id: string }>(
        `insert into calendar.appointments
           (business_id, calendar_id, contact_id, title, starts_at, ends_at, source)
         values (app.business_id(), $1, $2, 'Business B only', '2026-11-02T06:00:00Z',
                 '2026-11-02T07:00:00Z', 'user') returning id`,
        [parsePublicId('calendar', savedCalendar.calendar.id), parsePublicId('contact', contactId)],
      ),
    );
    // A custom object of B's (its key is a path parameter of its own, below) and an
    // association between it and contacts.
    const createdObject = await call('POST', '/objects', {
      payload: {
        singularLabel: 'Pet',
        pluralLabel: 'Pets',
        primaryField: { label: 'Pet name', valueType: 'text' },
      },
    });
    expect(createdObject.statusCode, createdObject.body).toBe(201);
    const createdAssociation = await call('POST', '/associations', {
      payload: {
        fromObjectKey: 'pet',
        toObjectKey: 'contact',
        label: 'Owner',
        fromLimit: 5,
        toLimit: 1,
      },
    });
    expect(createdAssociation.statusCode, createdAssociation.body).toBe(201);
    const ids = {
      ...teamRecords,
      ...inbox,
      link_type: association.parse(createdAssociation.json()).id,
      proposal: toPublicId('proposal', proposed.id),
      // The contact's memory: a fact, the revision B's member would rewrite it from, and
      // (not an id a path takes) the proposal about the contact that still waits.
      contact_fact: toPublicId('contact_fact', remembered.id),
      contact_fact_revision: knownFact?.revision ?? '',
      contact_proposal: toPublicId('proposal', factProposed.id),
      calendar: savedCalendar.calendar.id,
      calendar_group: savedCalendarGroup.id,
      blocked_slot: savedBlock.id,
      // Not an id, but B's alone: the revision B's manager would change the block from.
      blocked_slot_revision: savedBlock.revision,
      appointment: toPublicId('appointment', appointment.id),
      template: savedTemplate.id,
      template_folder: savedTemplateFolder.id,
      sms_attempt: smsConnectionStarted.parse(smsAttempt.json()).attempt.id,
      sms_connection: smsConnectionId,
      phone_number: phoneNumberId,
      call: toPublicId('call', callId.id),
      voice_grant: toPublicId('voice_grant', voiceGrantId.id),
      // Not an id, but B's alone: the revision B's manager would save the number from.
      phone_number_revision: phoneSettings.revision,
      webchat_widget: savedWidget.id,
      // Not an id an endpoint takes, but B's alone: no answer to A may hold it either.
      webchat_key: savedWidget.publicKey,
      ai_connection: savedAi.connection.id,
      ai_connection_test: savedAi.test.id,
      // Not an id at all, but B's alone and the most private thing it has: no answer to
      // anyone, B's own member included, may hold the key.
      ai_key: AI_KEY_OF_B,
      form: savedForm.id,
      form_submission: toPublicId('form_submission', submission.id),
      // Not ids an endpoint takes either: the form's public key, and the revision B's own
      // member would save it from.
      form_key: savedForm.publicKey,
      form_revision: savedForm.revision,
      automation: automationId,
      automation_test_run: automationTestRun.parse(testRun.json()).id,
      automation_enrolment: toPublicId('automation_enrolment', enrolment.id),
      automation_folder: automationFolderId,
      // Not ids, but B's alone: its webhook secret's name, which a path takes, and the
      // sealed value, which no answer to anyone may hold.
      webhook_secret_name: WEBHOOK_SECRET_OF_B,
      webhook_secret_value: WEBHOOK_SECRET_VALUE_OF_B,
      mailbox: mailboxId,
      mailbox_attempt: mailboxConnectionAttempt.parse(attempt.json()).id,
      company: company.parse(createdCompany.json()).id,
      deal: deal.parse(createdDeal.json()).id,
      bulk_action: contactBulkAction.parse(startedBulk.json()).id,
      // Not ids a path takes: B's pipeline and its stage, which A's requests for the board's
      // headers and the dashboard's numbers name in their queries below.
      pipeline: pipeline.id,
      stage: stage.id,
      // Not an id a path takes: the revision B's own member would move, copy or delete
      // that pipeline from.
      pipeline_revision: pipelineConfiguration.parse(pipelines.json()).revision,
      business: toPublicId('business', b.id),
      tag: tagId,
      tag_group: tagGroup.parse(group.json()).id,
      field: fieldDefinition.parse(field.json()).id,
      field_folder: savedFieldFolder.id,
      custom_value: savedValue.id,
      custom_value_folder: savedValueFolder.id,
      lead_source_rule: leadSourceRule.parse(createdRule.json()).id,
      score_rule: scoreRule.parse(createdScoreRule.json()).id,
      snippet: savedSnippet.id,
      snippet_folder: savedSnippetFolder.id,
      trigger_link: savedLink.id,
      manual_action: toPublicId('manual_action', queued.id),
      // Not ids a path takes: the revisions B's own member would save each from.
      snippet_revision: savedSnippet.revision,
      snippet_folder_revision: savedSnippetFolder.revision,
      trigger_link_revision: savedLink.revision,
      manual_action_revision: createHash('sha256')
        .update(JSON.stringify([queued.id, 'pending', null]))
        .digest('hex'),
      // Not ids an endpoint takes, but B's alone: the revisions B's own member would save
      // each from, and the key B's templates write the value under.
      field_folder_revision: savedFieldFolder.revision,
      // The one field in B's folder, and the confirmation that deletes B's other field.
      field_in_folder: fieldDefinition.parse(filedField.json()).id,
      field_deletion: fieldDeletion.parse(readDeletion.json()).confirmation,
      custom_value_revision: savedValue.revision,
      custom_value_folder_revision: savedValueFolder.revision,
      file: storedFile.parse(uploaded.json()).id,
      import: toPublicId('import', finishedImport.id),
      // Not an id a path takes: the CSV file B's import read, which A's requests name in
      // their bodies below.
      import_file: importFileId,
      contact: contactId,
      // Not an id a path takes: the contact a merge names beside it.
      merge_contact: mergeContactId,
      // Not an id a path takes: the revision of that contact's addresses.
      contact_addresses_revision: contactDetails.parse(readDetails.json()).addressesRevision,
      note: note.parse(createdNote.json()).id,
      task: task.parse(createdTask.json()).id,
      saved_view: savedView.parse(createdView.json()).id,
      event: toPublicId('event', tagCreated.id),
      notification: toPublicId('notification', told.id),
      assistant_thread: toPublicId('assistant_thread', talked.thread),
      assistant_turn: toPublicId('assistant_turn', talked.turn),
      // A funnel of B with everything a Sites endpoint takes by id.
      ...(await addSiteRecords(database, b.id)),
      // A product of B, an invoice for B's contact that names it, and a payment on that
      // invoice.
      ...(await addCommerceRecords(database, b.id, contactId)),
      // A folder of B's media library.
      media_folder: (await addMediaRecords(database, b.id)).media_folder,
      // A saved report of B.
      report: await addReport(database, b.id),
      // A delisted app installed in B, and its install: the agency's app, which its other
      // businesses can't see, as no other business has it installed.
      ...(await addMarketplaceRecords(database, b.id)),
      // An email campaign of B in a folder of campaigns.
      ...(await addCampaignRecords(database, b.id)),
      // Not an id: the Google account of B's member who connected one.
      ...(await addGoogleRecords(database, b.id)),
    };
    return {
      ids,
      calendarRevision: savedCalendar.revision,
      conversationRevision: conversation.parse(readConversation.json()).revision,
      templateRevision: savedTemplate.revision,
    };
  }

  /**
   * What an endpoint is sent besides its path, where an empty body or no query stops at
   * validation, before the isolation boundary. Each is an input B's own member could send
   * and have accepted, so the 403 and 404 below come from the tenant lookup alone.
   */
  function inputFor(
    operationId: string,
    calendarRevision: string,
    records: Readonly<Record<string, string>>,
    conversationRevision: string,
    templateRevision: string,
  ): { payload: unknown; query: string } {
    const calendarSettings = {
      name: 'Reached from A',
      kind: 'personal',
      timezone: 'UTC',
      bookingSlug: 'reached-from-a',
    };
    const availability = { members: [], weeklyHours: [], dateOverrides: [] };
    const inputs: Readonly<Record<string, { payload?: unknown; query?: string }>> = {
      // Sites: what B's own member could send about B's funnel and have accepted.
      ...siteInputs(records),
      // Commerce: what B's own member could send about B's product, invoice and payment and
      // have accepted.
      ...commerceInputs(records),
      // Media Storage: what B's own member could send about B's library.
      ...mediaInputs(records),
      // Reporting: a query, and B's report saved, copied and deleted.
      ...reportingInputs(),
      // The App Marketplace: an app as the agency would save it, and a request to connect
      // B's app, which A's business can't see.
      ...marketplaceInputs(records),
      // Google Calendar: a choice of calendars that passes validation, so the caller's own
      // connection decides the answer.
      chooseGoogleCalendars: { payload: { linkedCalendarId: null, conflictCalendarIds: [] } },
      // "Check a link", naming B's form: A's own business has no such form.
      previewLeadSource: {
        payload: { url: 'https://b-only.example/offer?gclid=abc', formId: records['form'] },
      },
      // Settings → Lead Sources: B's rule saved whole from the revision it was made at, and
      // named in an order. Each is what B's own member could send, so A's 404 (the rule)
      // and 409 (an order of rules A does not have) are the boundary.
      updateLeadSourceRule: {
        payload: {
          name: 'Reached from A',
          enabled: true,
          conditions: [{ fact: 'utm_campaign', op: 'contains', value: 'reached' }],
          source: 'Reached from A',
          tagIds: [],
          fieldWrites: [],
          revision: 1,
        },
      },
      reorderLeadSourceRules: {
        payload: { ruleIds: [records['lead_source_rule']], revision: 'a'.repeat(64) },
      },
      // Settings → Manage Scoring: B's profile and rule inputs.
      updateScoreProfile: {
        payload: { name: 'Reached from A', description: 'desc' },
      },
      publishScoreProfile: { payload: { revision: 0 } },
      createScoreRule: {
        payload: {
          when: { action: 'appointment_booked' },
          calculation: 'add',
          points: 10,
        },
      },
      updateScoreRule: {
        payload: {
          when: { action: 'appointment_booked' },
          calculation: 'add',
          points: 10,
          revision: 1,
        },
      },
      setContactScore: { payload: { score: 10 } },
      // Duplicate contacts: B's contact looked up by its email address, and named in a
      // rejection beside a contact nobody has. A's lookup finds nobody; A's rejection, 404.
      findDuplicateContact: { query: '?email=client%40example.test' },
      rejectDuplicateGroup: {
        payload: {
          by: 'email',
          valueKey: 'client@example.test',
          contactIds: [
            records['contact'],
            toPublicId('contact', '01890a5d-ac96-774b-bcce-b302099a8057'),
          ],
        },
      },
      // Merging contacts: B's second contact into B's first. A's preview and merge, 404;
      // B's own merge is refused for its stale revisions, and changes nothing.
      previewContactMerge: { query: `?mergeIds=${records['merge_contact'] ?? ''}` },
      mergeContacts: {
        payload: {
          mergeIds: [records['merge_contact']],
          revisions: {
            [records['contact'] ?? '']: 'a'.repeat(64),
            [records['merge_contact'] ?? '']: 'a'.repeat(64),
          },
        },
      },
      // Email campaigns: B's campaign saved, tested, sent and filed.
      ...campaignInputs(records),
      // A webhook secret's new value, as B's own member could replace B's with.
      putAutomationWebhookSecret: { payload: { value: 'reached-from-a' } },
      // Settings → Objects: B's object changed and deleted as B's member could, and B's
      // association relabelled. A's object list and associations hold nothing of B's.
      createObject: {
        payload: {
          singularLabel: 'Pet',
          pluralLabel: 'Pets',
          primaryField: { label: 'Pet name', valueType: 'text' },
        },
      },
      updateObject: {
        payload: {
          revision: 'a'.repeat(64),
          singularLabel: 'Animal',
          pluralLabel: 'Animals',
          description: '',
          icon: null,
          searchableFieldIds: [],
        },
      },
      deleteObject: { payload: { confirm: 'Pets' } },
      listAssociations: { query: '?objectKey=pet' },
      createAssociation: {
        payload: {
          fromObjectKey: 'pet',
          toObjectKey: 'contact',
          label: 'Carer',
          fromLimit: 1,
          toLimit: 1,
        },
      },
      updateAssociation: { payload: { label: 'Keeper', reverseLabel: 'Pet' } },
      // Settings → Custom Fields and Custom Values. Each is what B's own member could send
      // about B's folder, field or value and have accepted: A's 404, 409 and 422 are then
      // the boundary, and A's request names B's records without ever reaching them.
      renameFieldFolder: {
        payload: { name: 'Reached from A', revision: records['field_folder_revision'] },
      },
      moveFieldsToFolder: { payload: { fieldIds: [records['field']] } },
      reorderFieldFolders: {
        payload: { objectKey: 'contact', folderIds: [records['field_folder']] },
      },
      listCustomFields: { query: `?folderId=${records['field_folder'] ?? ''}` },
      // The order of B's folder as B's member could send it, B's folders searched by B's
      // own folder's name, and B's field deleted with the confirmation B's member read.
      reorderFolderFields: { payload: { fieldIds: [records['field_in_folder']] } },
      listFieldFolders: { query: '?q=Business%20B%20only&limit=5' },
      deleteField: { payload: { confirmation: records['field_deletion'] } },
      updateCustomValue: {
        payload: {
          name: 'Reached from A',
          value: 'Reached from A',
          folderId: records['custom_value_folder'],
          revision: records['custom_value_revision'],
        },
      },
      moveCustomValues: {
        payload: { valueIds: [records['custom_value']], folderId: records['custom_value_folder'] },
      },
      listCustomValues: { query: `?folder=${records['custom_value_folder'] ?? ''}` },
      // B's value in a delete of several, B's folders searched by B's own folder's name,
      // and the history of imports in another order: each as B's member could ask.
      deleteCustomValues: { payload: { valueIds: [records['custom_value']] } },
      listCustomValueFolders: { query: '?q=Business%20B%20only&limit=5' },
      listImports: { query: '?sort=importedBy&direction=asc' },
      // Snippets, trigger links and the manual actions queue: each what B's own member
      // could send about B's snippet, folder, link or action and have accepted.
      updateSnippet: {
        payload: {
          name: 'Reached from A',
          subject: null,
          body: 'Reached from A',
          folderId: records['snippet_folder'],
          revision: records['snippet_revision'],
        },
      },
      moveSnippets: {
        payload: { snippetIds: [records['snippet']], folderId: records['snippet_folder'] },
      },
      listSnippets: { query: `?folder=${records['snippet_folder'] ?? ''}` },
      renderSnippet: { payload: { contactId: records['contact'] } },
      renameSnippetFolder: {
        payload: { name: 'Reached from A', revision: records['snippet_folder_revision'] },
      },
      updateTriggerLink: {
        payload: {
          name: 'Reached from A',
          url: 'https://reached-from-a.example/',
          revision: records['trigger_link_revision'],
        },
      },
      listManualActions: { query: `?automationId=${records['automation'] ?? ''}` },
      // What B's automation did for B's contact: the contact is named in the query.
      explainAutomationContact: { query: `?contactId=${records['contact'] ?? ''}` },
      assignManualAction: {
        payload: { assignee: null, revision: records['manual_action_revision'] },
      },
      completeManualAction: { payload: { revision: records['manual_action_revision'] } },
      skipManualAction: { payload: { revision: records['manual_action_revision'] } },
      renameCustomValueFolder: {
        payload: { name: 'Reached from A', revision: records['custom_value_folder_revision'] },
      },
      // The settings that decide whether B's contact is sent anything, based on the
      // revision B's untouched contact has: valid for B's member, so A's 404 is the boundary.
      updateContact: {
        payload: {
          timeZone: 'UTC',
          doNotContact: true,
          doNotContactReason: 'Reached from A: asked not to be contacted.',
          preferencesRevision: createHash('sha256')
            .update(JSON.stringify([null, false]))
            .digest('hex'),
        },
      },
      // The contact page: an owner for B's contact from the revision of having none, and
      // B's own team member as a follower. Each is valid for B's member, so A's 404 is the
      // boundary.
      assignContactOwner: {
        payload: {
          owner: records['membership'],
          revision: createHash('sha256')
            .update(JSON.stringify(['owner', null]))
            .digest('hex'),
        },
      },
      // An address for B's contact, and a change to the one it has from the revision its
      // addresses are at.
      addContactAddress: { payload: { kind: 'email', value: 'reached-from-a@example.test' } },
      updateContactAddress: {
        payload: { primary: true, revision: records['contact_addresses_revision'] },
      },
      removeContactAddress: { payload: { revision: records['contact_addresses_revision'] } },
      // Do not disturb for B's untouched contact, from the revision of having none on.
      setContactDnd: {
        payload: {
          all: true,
          channels: ['email'],
          reason: 'Reached from A: asked not to be disturbed.',
          revision: createHash('sha256')
            .update(JSON.stringify(['dnd', false, []]))
            .digest('hex'),
        },
      },
      // B's fact about its contact, rewritten from the revision it is at: valid for B's
      // member, so A's 404 is the boundary.
      correctContactFact: {
        payload: { statement: 'Reached from A', revision: records['contact_fact_revision'] },
      },
      addContactFollowers: { payload: { followers: [records['membership']] } },
      removeContactFollowers: { payload: { followers: [records['membership']] } },
      // The opportunity dialog: an owner for B's deal from the revision of having none, B's
      // own team member as a follower, and B's own contact as its primary contact from the
      // revision of having no contacts. Each is valid for B's member, so A's 404 is the
      // boundary.
      assignDealOwner: {
        payload: {
          owner: records['membership'],
          revision: createHash('sha256')
            .update(JSON.stringify(['owner', null]))
            .digest('hex'),
        },
      },
      // One pipeline of B's moved, copied or deleted from the revision B's configuration is
      // at: valid for B's member (the delete is refused there only because the pipeline
      // holds a deal), so A's 404 is the boundary.
      movePipeline: { payload: { position: 1, revision: records['pipeline_revision'] } },
      duplicatePipeline: { payload: { revision: records['pipeline_revision'] } },
      deletePipeline: { payload: { revision: records['pipeline_revision'] } },
      addDealFollowers: { payload: { followers: [records['membership']] } },
      removeDealFollowers: { payload: { followers: [records['membership']] } },
      setDealContacts: {
        payload: {
          primaryContactId: records['contact'],
          additionalContactIds: [],
          revision: createHash('sha256')
            .update(JSON.stringify(['contacts', null, []]))
            .digest('hex'),
        },
      },
      updateMailboxSendingSettings: {
        payload: {
          dailyLimit: 80,
          pacingPerMinute: 2,
          warmupEnabled: true,
          useForConversations: true,
          useForCampaigns: false,
        },
      },
      recordContactConsent: {
        payload: {
          channel: 'email',
          purpose: 'marketing',
          status: 'granted',
          note: 'Asked by phone on 9 October.',
        },
      },
      updateCalendar: { payload: { ...calendarSettings, revision: calendarRevision } },
      createCalendarGroup: { payload: { name: 'Reached from A' } },
      // B's calendar is no calendar of A's: refused as one this business does not have.
      createBlockedSlot: {
        payload: {
          calendarId: records['calendar'],
          title: 'Reached from A',
          startsAt: '2026-11-04T06:00:00Z',
          endsAt: '2026-11-04T07:00:00Z',
        },
      },
      // A number's settings as B's own manager could save them, so A's 404 is the boundary.
      updatePhoneNumberSettings: {
        payload: {
          name: 'Reached from A',
          ownerId: null,
          voice: {
            recording: { enabled: false, announcement: { enabled: false, message: null } },
            routing: {
              primaryMemberId: null,
              forwardTo: null,
              useBusinessFallback: false,
              ringAlso: [],
              ringTimeoutSeconds: 20,
              voicemailBackup: true,
            },
            advanced: {
              callConnectConfirmation: false,
              whisper: { enabled: false, message: null },
              forwardedCallerId: 'caller',
              preferContactOwner: false,
            },
          },
          revision: records['phone_number_revision'],
        },
      },
      updateBlockedSlot: {
        payload: {
          calendarId: records['calendar'],
          title: 'Reached from A',
          startsAt: '2026-11-04T06:00:00Z',
          endsAt: '2026-11-04T07:00:00Z',
          revision: records['blocked_slot_revision'],
        },
      },
      renameCalendarGroup: { payload: { name: 'Reached from A' } },
      updateCalendarAvailability: { payload: { ...availability, revision: calendarRevision } },
      getCalendarAvailability: { query: '?date=2026-10-09' },
      // A whole schedule for B's team member, based on the revision of having none stored:
      // valid for B's own manager, so A's 404 is the boundary.
      updateCalendarUserAvailability: {
        payload: {
          revision: createHash('sha256').update(JSON.stringify(null)).digest('hex'),
          profile: {
            timezone: 'Africa/Nairobi',
            inheritCalendarHours: false,
            weeklyHours: [{ weekday: 1, startMinute: 540, endMinute: 1020 }],
            dateOverrides: [{ date: '2026-12-25', ranges: [] }],
          },
        },
      },
      replaceAutomationDraft: {
        payload: { baseDraftVersion: 1, document: { ...automationDocument, name: 'Reached' } },
      },
      copyWorkflowEmailTemplate: {
        payload: {
          baseDraftVersion: 1,
          step: 'email',
          template: records['template'],
          revision: templateRevision,
          document: {
            ...automationDocument,
            start: 'email',
            steps: {
              email: { type: 'email.send', config: { template: records['template'] } },
            },
          },
        },
      },
      // "Sync edits to template": on, and an edit made through the step.
      enableWorkflowEmailSync: {
        payload: {
          baseDraftVersion: 1,
          step: 'email',
          template: records['template'],
          revision: templateRevision,
          document: {
            ...automationDocument,
            start: 'email',
            steps: {
              email: { type: 'email.send', config: { template: records['template'] } },
            },
          },
        },
      },
      saveSyncedWorkflowEmail: {
        payload: {
          baseDraftVersion: 1,
          step: 'email',
          revision: templateRevision,
          subject: 'Reached',
          content: { format: 'text', text: 'Reached' },
          document: {
            ...automationDocument,
            start: 'email',
            steps: {
              email: {
                type: 'email.send',
                config: {
                  mode: 'sync',
                  source: { id: records['template'], revision: templateRevision },
                },
              },
            },
          },
        },
      },
      patchAutomationDraft: {
        payload: {
          baseDraftVersion: 1,
          patch: [{ op: 'replace', path: '/name', value: 'Reached' }],
        },
      },
      publishAutomation: { payload: { baseDraftVersion: 1 } },
      // A folder of A's own, a new name for B's from the revision it is at, and B's
      // automation moved to the top level: each valid for B's own member.
      createAutomationFolder: { payload: { name: 'Reached from A' } },
      updateAutomationFolder: { payload: { revision: 1, name: 'Reached from A' } },
      moveAutomation: { payload: { folderId: null } },
      updateMessageTemplate: {
        payload: {
          name: 'Reached from A',
          subject: 'Reached from A',
          body: 'Reached from A',
          revision: templateRevision,
        },
      },
      // A new key for B's provider, a test of it, and a provider and price of A's own: each
      // valid where it belongs, so A's 403 and 404 are the boundary.
      updateAiConnection: { payload: { apiKey: 'sk-ant-fixture-reached-from-a-0000' } },
      startAiConnectionTest: { payload: { connectionId: records['ai_connection'] } },
      connectAiProvider: {
        payload: {
          provider: 'openai',
          apiKey: 'sk-fixture-reached-from-a-0000',
          model: 'gpt-fixture',
        },
      },
      removeAiModelPrice: { query: '?provider=openai&model=gpt-fixture' },
      // B's own CSV file, looked at, previewed and imported as B's member could: from A it
      // is a file that isn't there.
      inspectImportFile: { payload: { fileId: records['import_file'], object: 'contact' } },
      previewImport: { payload: importOf(records['import_file']) },
      startImport: { payload: importOf(records['import_file']) },
      // A whole widget, as B's own member could save it: A's 404 is then the boundary.
      updateWebchatWidget: { payload: { ...webchatInput, name: 'Reached from A', enabled: false } },
      // A whole form, as B's own member could save it, and each change of its state from
      // the revision it is at: A's 404 is then the boundary.
      updateForm: {
        payload: {
          name: 'Reached from A',
          definition: { fields: [] },
          allowedOrigins: ['https://a-only.example'],
          revision: records['form_revision'],
        },
      },
      publishForm: { payload: { revision: records['form_revision'] } },
      unpublishForm: { payload: { revision: records['form_revision'] } },
      archiveForm: { payload: { revision: records['form_revision'] } },
      restoreForm: { payload: { revision: records['form_revision'] } },
      archiveMessageTemplate: { payload: { revision: templateRevision } },
      restoreMessageTemplate: { payload: { revision: templateRevision } },
      updateMessageTemplateFolder: { payload: { revision: 1, name: 'Reached from A' } },
      removeMessageTemplateFolder: { payload: { revision: 1 } },
      moveMessageTemplate: { payload: { revision: templateRevision, folderId: null } },
      deleteMessageTemplate: { payload: { revision: templateRevision } },
      duplicateMessageTemplate: { payload: {} },
      // B's own template in a bulk change, as B's member could send it. From A it is a skip
      // that tells nothing of the template.
      bulkMessageTemplates: {
        payload: { action: 'archive', ids: [records['template']] },
      },
      // The lists and boards, each asked about B's own records as B's member could ask: B's
      // pipeline for the board's headers and the dashboard's numbers, B's stage as a
      // column, B's calendar as a filter, B's conversation in a bulk change. From A they
      // name nothing: a refusal that repeats no id, an empty page, or a skip.
      getDeals: {
        query: `?pipelineId=${records['pipeline'] ?? ''}&stageId=${records['stage'] ?? ''}&status=all`,
      },
      getDealStageSummary: { query: `?pipelineId=${records['pipeline'] ?? ''}&status=all` },
      getOpportunityReport: {
        query: `?pipelineId=${records['pipeline'] ?? ''}&from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z&dateProperty=created`,
      },
      // The dashboard's email and booking numbers, over a year B's member could ask about.
      // They name no record: from A the header alone is the boundary.
      getEmailReport: { query: '?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z' },
      getAppointmentReport: {
        query: '?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z&dateProperty=created',
      },
      listContacts: { query: '?include=lastActivity,tags,company' },
      listConversations: { query: '?starred=only&status=all' },
      listCalendarEvents: {
        query: `?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z&calendars=${records['calendar'] ?? ''}`,
      },
      // B's calendar as a filter of the appointment list, B's calendar and contact in a
      // booking, and B's appointment moved, cancelled and marked as B's member could send
      // it (a revision that is no longer current is a conflict there, never a not-found).
      listAppointments: { query: `?view=all&calendar=${records['calendar'] ?? ''}` },
      createAppointment: {
        payload: {
          requestId: '0199b7a0-0000-4000-8000-0000000000b1',
          calendarId: records['calendar'],
          contactId: records['contact'],
          startsAt: '2026-11-03T09:00:00Z',
        },
      },
      rescheduleAppointment: {
        payload: { revision: 'a'.repeat(64), startsAt: '2026-11-03T09:00:00Z' },
      },
      cancelAppointment: { payload: { revision: 'a'.repeat(64) } },
      setAppointmentStatus: { payload: { revision: 'a'.repeat(64), status: 'confirmed' } },
      setAppointmentNotes: { payload: { revision: 'a'.repeat(64), notes: 'Bring the plans.' } },
      bulkUpdateConversations: { payload: { action: 'star', ids: [records['conversation']] } },
      // B's own deal in a bulk change, as B's member could send it. From A it is a skip
      // that tells nothing of the deal.
      bulkUpdateDeals: {
        payload: { action: 'set_status', ids: [records['deal']], status: 'won' },
      },
      // B's own contact in a bulk change, as B's member could send it. From A it is a skip
      // that tells nothing of the contact.
      bulkUpdateContacts: {
        payload: { action: 'trash', selection: { ids: [records['contact']] } },
      },
      // B's own contact in the preview of Verify emails. From A it counts nothing of it.
      previewContactEmailChecks: { payload: { selection: { ids: [records['contact']] } } },
      // B's own task in a bulk change, as B's member could send it. From A it is a skip
      // that tells nothing of the task.
      bulkUpdateTasks: { payload: { action: 'complete', ids: [records['task']] } },
      // B's own contact as the one thing to read the audit log of. From A it names nothing:
      // an empty page.
      listAudit: { query: `?subject=${records['contact'] ?? ''}` },
      assignConversation: { payload: { assignee: null, revision: conversationRevision } },
      setConversationStatus: { payload: { status: 'closed', revision: conversationRevision } },
      markConversationRead: { payload: { through: records['message'] } },
      addConversationNote: {
        payload: { text: 'Reached from A', idempotencyKey: 'reached-from-a-note' },
      },
      sendConversationReply: {
        payload: {
          channel: 'email',
          accountId: records['channel_account'],
          to: records['contact_identity'],
          text: 'Reached from A',
          idempotencyKey: 'reached-from-a-reply',
        },
      },
      // The bell. B's own notification as the mark to read up to, and a choice of kinds:
      // each is what its own person could send and have accepted. From A, the mark reaches
      // only A's own notifications (none), and the choice is A's own.
      markAllNotificationsRead: { payload: { through: records['notification'] } },
      // The in-app assistant: what B's own member could send and have accepted.
      getAssistantContext: { payload: { route: '/forms' } },
      createAssistantThread: { payload: { message: 'Reached from A', page: { route: '/forms' } } },
      postAssistantTurn: { payload: { message: 'Reached from A', page: { route: '/forms' } } },
      updateNotificationPreferences: {
        payload: { items: [{ kind: 'task.due', inApp: false }] },
      },
      // A person's details as Settings → Users saves them. The role is well formed and names
      // nothing (roles are the agency's, so a real one would be in A's own answers): from A
      // the person is not found before the role is looked at, and B's own member is told
      // the role is not one of theirs.
      updateUser: {
        payload: {
          firstName: 'Reached',
          lastName: 'From A',
          roleId: toPublicId(
            'role',
            parsePublicId('membership', records['membership'] ?? '') ?? '',
          ),
        },
      },
    };
    const input = inputs[operationId];
    return { payload: input?.payload ?? {}, query: input?.query ?? '' };
  }

  /** An import of a file's two columns, as the Import data page would start it. */
  const importOf = (fileId: string | undefined) => ({
    fileId,
    object: 'contact',
    mode: 'create',
    mapping: [
      { column: 0, target: { kind: 'attribute', attribute: 'firstName' } },
      { column: 1, target: { kind: 'attribute', attribute: 'email' } },
    ],
  });

  /** Made up for this file: no provider issued it. */
  const AI_KEY_OF_B = 'sk-ant-fixture-business-b-only-7c1d';

  /** B's webhook secret: its name, a key of B's choosing, and its sealed value. */
  const WEBHOOK_SECRET_OF_B = 'b_only_partner_key';
  const WEBHOOK_SECRET_VALUE_OF_B = 'fixture-webhook-secret-of-business-b-only-41e9';

  /**
   * Endpoints that store under a name the caller chooses (webhook secrets): a
   * name is no record of B's, so from A the call stores A's own secret by that name. The
   * boundary is that B's secret by the same name is untouched.
   */
  const storesUnderName: ReadonlySet<string> = new Set(['putAutomationWebhookSecret']);

  /** A web chat widget as its settings page saves one. */
  const webchatInput = {
    name: 'Business B only',
    allowedOrigins: ['https://b-only.example'],
    enabled: true,
    settings: {
      title: 'Chat with business B',
      greeting: '',
      emailRequired: true,
      marketingConsentWording: null,
    },
  };

  // Path parameters that aren't ids: B's automation has exactly one published version.
  // And a step's key, which names a step of the automation and no record of its own, and
  // the name of B's webhook secret.
  const numbered: Readonly<Record<string, string>> = {
    version: '1',
    from: '1',
    to: '1',
    step: 'email',
    name: WEBHOOK_SECRET_OF_B,
    // B's custom object: A's business has none by that key.
    key: 'pet',
  };

  function pathFor(endpoint: Endpoint, records: Record<string, string>): string {
    let path = endpoint.path;
    for (const [name, schema] of Object.entries(endpoint.params?.shape ?? {})) {
      const number = numbered[name];
      if (number !== undefined) {
        path = path.replace(`{${name}}`, number);
        continue;
      }
      const kind = kindOf(schema as z.ZodType);
      const id = records[kind];
      if (id === undefined) throw new Error(`Add a record of kind ${kind} to recordsOfB.`);
      path = path.replace(`{${name}}`, id);
    }
    return path;
  }

  // The suite below tries every published endpoint, but one without an id in its path
  // passes even when no route serves it (403 naming B, nothing else checked): Google's did,
  // being added by start.ts beside apiRoutes. So every endpoint must be served here.
  it('serves every endpoint the API publishes, so none passes without being tried', () => {
    const served = new Set(everyRoute().map((route) => route.endpoint.operationId));
    expect(
      endpoints
        .map((endpoint) => endpoint.operationId)
        // Who is signed in: the server answers GET /me itself (server.ts), with no route.
        .filter((operationId) => operationId !== 'getMe' && !served.has(operationId)),
    ).toEqual([]);
  });

  it.each(endpoints.map((endpoint) => [endpoint.operationId, endpoint] as const))(
    "%s: someone in business A can't reach business B",
    async (_operationId, endpoint) => {
      const agency = await database.fixtures.agency();
      const a = await database.fixtures.business(agency.id);
      const b = await database.fixtures.business(agency.id);
      const inB = await signedInAs(await person({ businesses: [b] }));
      const {
        ids: records,
        calendarRevision,
        conversationRevision,
        templateRevision,
      } = await recordsOfB(inB, b);
      const call = await signedInAs(await person({ businesses: [a] }));
      const method = endpoint.method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      const input = inputFor(
        endpoint.operationId,
        calendarRevision,
        records,
        conversationRevision,
        templateRevision,
      );
      const path = pathFor(endpoint, records);
      const payload = method === 'GET' ? undefined : input.payload;
      const secretsOfB = async () =>
        (await inB('GET', '/automations/webhook-secrets')).json<unknown>();
      const secretsBefore = await secretsOfB();
      const googleBefore = await googleConnectionsOf(database, b.id);

      const namingB = await call(method, `${path}${input.query}`, { business: b.id, payload });
      const namingA = await call(method, `${path}${input.query}`, { business: a.id, payload });

      expect(namingB.statusCode).toBe(403);
      if (storesUnderName.has(endpoint.operationId)) {
        // A's own secret by that name; B's stays as it was (checked below for every call).
        expect(namingA.statusCode, namingA.body).toBe(200);
        const ofA = await call('GET', '/automations/webhook-secrets', { business: a.id });
        expect(ofA.json()).toMatchObject({ items: [{ name: WEBHOOK_SECRET_OF_B }] });
      } else if (endpoint.params !== undefined && endpoint.path.startsWith('/agency/')) {
        // The agency's own work (its apps): refused in every business, A's too,
        // before any record is looked up.
        expect(namingA.statusCode, namingA.body).toBe(403);
        expect(namingA.json()).toMatchObject({
          detail: 'Change this for the whole agency, outside any business.',
        });
      } else if (endpoint.params !== undefined) expect(namingA.statusCode).toBe(404);
      // Nothing A sends changes B's webhook secrets, or its members' Google connections.
      expect(await secretsOfB()).toEqual(secretsBefore);
      expect(await googleConnectionsOf(database, b.id)).toEqual(googleBefore);
      // An answer may repeat an id the request itself sent, in its path, query or body
      // ("file … was not found").
      const unsent = [
        ...Object.values(records),
        calendarRevision,
        conversationRevision,
        templateRevision,
      ].filter(
        (id) =>
          !path.includes(id) &&
          !input.query.includes(id) &&
          !JSON.stringify(payload ?? {}).includes(id),
      );
      for (const response of [namingB, namingA]) {
        for (const id of unsent) expect(response.body).not.toContain(id);
      }
      // The same request from B's own member finds the record, so A's 404 above is the
      // tenant boundary and not a route that isn't served or an id that names nothing.
      if (endpoint.params !== undefined) {
        const own = await inB(method, `${path}${input.query}`, { payload });
        expect(own.statusCode, own.body).not.toBe(404);
        // B's provider key and webhook secret are write-only: not even B's own member is
        // answered with either.
        expect(own.body).not.toContain(records['ai_key']);
        expect(own.body).not.toContain(records['webhook_secret_value']);
      }
    },
  );

  // A business keeps businesses apart; a notification is narrower still: one person's.
  it("a notification is its person's alone: a colleague in the same business, the agency's staff and another business all get the same not-found", async () => {
    const agency = await database.fixtures.agency();
    const a = await database.fixtures.business(agency.id);
    const b = await database.fixtures.business(agency.id);
    const mine = await signedInAs(await person({ businesses: [b] }));
    const { ids: records } = await recordsOfB(mine, b);
    const id = records['notification'] ?? '';
    const colleague = await signedInAs(await person({ businesses: [b] }));
    const staff = await signedInAs(await person({ staffOf: agency.id }));
    const elsewhere = await signedInAs(await person({ businesses: [a] }));
    const missing = toPublicId(
      'notification',
      parsePublicId('business', records['business'] ?? '') ?? '',
    );

    const others = [
      { call: colleague, business: b.id },
      { call: staff, business: b.id },
      { call: elsewhere, business: a.id },
    ];
    const notFound = await mine('POST', `/notifications/${missing}/read`);
    expect(notFound.statusCode).toBe(404);
    const sameAs = (body: string, named: string) => body.replaceAll(named, 'ntf');
    for (const { call, business } of others) {
      const listed = await call('GET', '/notifications', { business });
      expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json()).toEqual({ items: [], nextCursor: null });
      const counted = await call('GET', '/notifications/unread-count', { business });
      expect(counted.json()).toEqual({ unread: 0, more: false });
      const marked = await call('POST', `/notifications/${id}/read`, { business });
      expect(marked.statusCode).toBe(404);
      // Word for word what an id that names nothing is answered with.
      expect(sameAs(marked.body, id)).toBe(sameAs(notFound.body, missing));
      const all = await call('POST', '/notifications/read-all', {
        business,
        payload: { through: id },
      });
      expect(all.json()).toEqual({ unread: 0, more: false });
    }
    // It is still there, unread, for the person it is for; and theirs to mark.
    const own = await mine('GET', '/notifications');
    expect(own.json()).toMatchObject({ items: [{ id, readAt: null }], nextCursor: null });
    expect((await mine('GET', '/notifications/unread-count')).json()).toEqual({
      unread: 1,
      more: false,
    });
    expect((await mine('POST', `/notifications/${id}/read`)).statusCode).toBe(200);
    expect((await mine('GET', '/notifications/unread-count')).json()).toEqual({
      unread: 0,
      more: false,
    });
  });
});

it('email verification commands refuse foreign contact/address ids and settings remain business-scoped', async () => {
  const agency = await database.fixtures.agency();
  const a = await database.fixtures.business(agency.id);
  const b = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(b.context, { email: 'private@example.com' });
  const identity = await database.withTenant(b.context, (sql) =>
    sql.one<{ id: string }>('select id from crm.contact_identities where contact_id=$1', [
      contact.id,
    ]),
  );
  const call = await signedInAs(await person({ businesses: [a, b] }));
  const payload = {
    contactId: toPublicId('contact', contact.id),
    addressId: toPublicId('contact_identity', identity.id),
  };
  for (const action of ['verify', 'exclude', 'include', 'block', 'unblock']) {
    const answer = await call('POST', `/email-verification/${action}`, { business: a.id, payload });
    expect(answer.statusCode, answer.body).toBe(404);
  }
  expect(
    (
      await call('PUT', '/email-verification/settings', {
        business: b.id,
        payload: { dailyLimit: 17 },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await call('GET', '/email-verification/settings', { business: a.id })).json(),
  ).toHaveProperty('dailyLimit', 1000);
  const own = await call('POST', '/email-verification/verify', { business: b.id, payload });
  expect(own.statusCode, own.body).toBe(200);
  expect(own.json()).toMatchObject({ status: 'unchecked', pending: true });
});
