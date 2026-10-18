// The client's "New Lead Workflow Communication/Assigning Rules", authored through the MCP
// stdio bridge with a real scoped API key against the canonical HTTP API on migrated
// Postgres, then run by the server's own composed worker tasks.
//
// What is real here: the MCP process, the API, validation, publishing, enrolment, every
// step (tag, removal, child start, notification, email queueing) and the notifications
// written. What is stood in for, and marked where it happens:
// - PLACEHOLDER copy and cadence in every sequence (the client's are missing inputs);
// - a PLACEHOLDER services field, `placeholder_services_requested` (the client's real
//   field and its values are a missing input); it is made and set through the bridge, as
//   the enquiry form would set it;
// - the lead itself is made through the HTTP API, standing in for the enquiry's ingress;
// - the booking and the reply are events emitted by a test command (no calendar booking
//   and no inbound mail is exercised);
// - the worker's tasks are called by the test, one job at a time, instead of being polled
//   from the queue, and a wait is ended by moving its wake time into the past;
// - the team, a mailbox row and marketing consent are inserted by SQL so the email steps
//   can queue and someone can be told; nothing is handed to a mail server.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { allowEveryone, defineCommand, runCommand, type Services } from '@repo/commands';
import {
  automationDraftSaved,
  automationView,
  createdApiKey,
  type AutomationCondition,
  type AutomationDocumentInput,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId, type TenantContext } from '@repo/kernel';
import { createAuthentication, type Authentication } from '@repo/module-auth';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { apiRoutes } from './api-routes.js';
import type { Config } from './config.js';
import { API_PREFIX, buildServer, type Server } from './server.js';
import { workerTasks } from './worker-tasks.js';

const PLACEHOLDER = 'PLACEHOLDER COPY: the client has not supplied this email.';
const SERVICES = 'placeholder_services_requested';
const SERVICES_PATH = `contact.custom.${SERVICES}`;
const RULES_NOTE = 'Rules: New Lead Workflow Communication/Assigning Rules.';

const NAMES = {
  education: 'TEST — 2026 Wedding Requested Info Sequence',
  dj: 'TEST — DJ Lead Sequence',
  photoVideo: 'TEST — Photo/Video Lead Sequence',
  combined: 'TEST — DJ/Photo/Video Lead Sequence',
  booked: 'TEST — Consultation Booked Sequence',
  master: 'TEST — Consultation Booked Master Rule',
  replied: 'TEST — Sales reply: notify',
  repliedVariant: 'TEST — Sales reply: notify (replied-to variant)',
} as const;
type Sequence = keyof typeof NAMES;
const SALES = [NAMES.dj, NAMES.photoVideo, NAMES.combined];
const TAG = 'Booked Consultation';

const has = (service: string): AutomationCondition => ({
  field: SERVICES_PATH,
  operator: 'includes',
  value: service,
});
const lacks = (service: string): AutomationCondition => ({
  field: SERVICES_PATH,
  operator: 'excludes',
  value: service,
});

/** Two placeholder emails two days apart: the real steps and cadence are missing inputs. */
const twoEmails = (subject: string): AutomationDocumentInput['steps'] => ({
  first_email: {
    type: 'email.send',
    config: { subject: `${subject} 1 (placeholder)`, body: PLACEHOLDER },
    next: 'pause',
  },
  pause: { type: 'wait', config: { duration: 'P2D' }, next: 'second_email' },
  second_email: {
    type: 'email.send',
    config: { subject: `${subject} 2 (placeholder)`, body: PLACEHOLDER },
  },
});

/** R3 to R5 and R7: one sales sequence, started by its services rule, ended by a reply or a booking. */
const salesDocument = (name: string, services: AutomationCondition): AutomationDocumentInput => ({
  name,
  description: `${RULES_NOTE} Placeholder steps.`,
  // The enquiry's ingress is a missing input; a new contact stands in for it.
  triggers: [{ id: 'enquiry', type: 'contact.created', config: {}, if: services }],
  stopWhen: [{ event: 'message.received', from: 'contact' }, { event: 'appointment.booked' }],
  start: 'first_email',
  steps: twoEmails(name),
});

const documents: Record<Sequence, AutomationDocumentInput> = {
  // R1, R2, R19: no stop condition at all, and a lead goes through it once.
  education: {
    name: NAMES.education,
    description: `${RULES_NOTE} Runs to completion; never ended by a reply or a booking.`,
    triggers: [{ id: 'enquiry', type: 'contact.created', config: {} }],
    stopWhen: [],
    start: 'first_email',
    steps: twoEmails('Education'),
    settings: { reEnrollment: 'never' },
  },
  // R3: DJ only.
  dj: salesDocument(NAMES.dj, { all: [has('dj'), lacks('photo'), lacks('video')] }),
  // R4: photo and/or video, and no DJ.
  photoVideo: salesDocument(NAMES.photoVideo, {
    all: [{ any: [has('photo'), has('video')] }, lacks('dj')],
  }),
  // R5: DJ with photo, with video, or with both.
  combined: salesDocument(NAMES.combined, {
    all: [has('dj'), { any: [has('photo'), has('video')] }],
  }),
  // R10: started by the master rule only, so it has no trigger of its own.
  booked: {
    name: NAMES.booked,
    description: `${RULES_NOTE} Placeholder steps; started by the master rule.`,
    triggers: [],
    start: 'first_email',
    steps: twoEmails('Consultation booked'),
  },
  // R8 to R12 and R18. Which calendar is "a consultation" is a missing input: any booking.
  master: {
    name: NAMES.master,
    description: `${RULES_NOTE} The master rule.`,
    triggers: [{ id: 'consultation_booked', type: 'appointment.booked', config: {} }],
    settings: { reEnrollment: 'after_finished' },
    start: 'tag',
    steps: {
      tag: { type: 'tag.add', config: { tag: TAG }, next: 'end_sales' },
      end_sales: {
        type: 'automation.remove',
        config: { from: 'automations', automations: SALES },
        next: 'start_booked',
      },
      start_booked: {
        type: 'automation.run',
        config: { automation: NAMES.booked },
        next: 'tell',
      },
      tell: {
        type: 'team.notify',
        config: {
          to: 'owner_or_everyone',
          message: '{{contact.firstName}} booked a consultation.',
        },
      },
    },
  },
  // R14: a sales sequence that a reply stopped tells the salesperson. It starts on the
  // run ending, so it does not matter which sequence emailed the lead last.
  replied: {
    name: NAMES.replied,
    description: `${RULES_NOTE} Tells the salesperson when a reply ends a sales sequence.`,
    triggers: [
      {
        id: 'sales_run_stopped_by_reply',
        type: 'automation.run_ended',
        config: { automations: SALES, stoppedBy: ['message.received'] },
      },
    ],
    settings: { reEnrollment: 'after_finished' },
    start: 'tell',
    steps: {
      tell: {
        type: 'team.notify',
        config: {
          to: 'owner_or_everyone',
          message: '{{contact.firstName}} replied to a sales email.',
        },
      },
    },
  },
  // R14, the second documented path: the reply itself starts it, when the lead's most
  // recent automated email came from a sales sequence. It has the limit the first has not.
  repliedVariant: {
    name: NAMES.repliedVariant,
    description: `${RULES_NOTE} The replied-to variant of the reply notification.`,
    triggers: [{ id: 'sales_reply', type: 'message.received', config: { repliedTo: SALES } }],
    settings: { reEnrollment: 'after_finished' },
    start: 'tell',
    steps: {
      tell: {
        type: 'team.notify',
        config: {
          to: 'owner_or_everyone',
          message: '{{contact.firstName}} replied to a sales email (replied-to variant).',
        },
      },
    },
  },
};

let database: TestDatabase;
let db: Database;
let services: Services;
let authentication: Authentication;
const servers: Server[] = [];
const clients: Client[] = [];

// An event on the contact's timeline, as the calendar and messaging emit theirs.
const happen = defineCommand({
  name: 'test.lead_event',
  permission: 'contacts.manage',
  input: z.strictObject({
    recordId: z.uuid(),
    type: z.enum(['appointment.booked', 'message.received']),
  }),
  async handle(_trx, input, command) {
    return command.emit({
      type: input.type,
      subject: {
        kind: input.type === 'message.received' ? 'message' : 'appointment',
        id: randomUUID(),
      },
      records: [input.recordId],
      payload: input.type === 'message.received' ? { channel: 'email' } : {},
    });
  },
});

interface World {
  readonly tenant: TenantContext & { readonly businessId: string };
  readonly app: Server['app'];
  readonly ai: Client;
  /** Each sequence's stored id, by its key. */
  readonly ids: Readonly<Record<Sequence, string>>;
  readonly publicIds: Readonly<Record<Sequence, string>>;
  readonly owner: string;
  readonly teammate: string;
}

let world: World;

async function server(tenant: Config['devTenantContext']): Promise<Server> {
  const config: Config = {
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
    devTenantContext: tenant,
    publicUrl: 'https://crm.example.test',
    authentication: undefined,
    trustProxy: [],
    mail: undefined,
    files: undefined,
    vault: undefined,
  };
  const built = await buildServer({
    config,
    logger: pino({ level: 'silent' }),
    serveApi: true,
    routes: apiRoutes(tenant === undefined ? authentication : undefined),
    ...(tenant === undefined ? { authentication } : {}),
    services,
    readinessChecks: {},
  });
  servers.push(built);
  return built;
}

const structured = (result: Awaited<ReturnType<Client['callTool']>>, what: string) => {
  if (result.isError === true) throw new Error(`${what}: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
};

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  authentication = createAuthentication({
    connectionString: database.url('crm_auth'),
    secret: 'a-test-secret-that-is-at-least-32-characters-long',
    publicUrl: 'https://crm.example.test',
    onConnectionError: () => undefined,
    log: () => undefined,
    sendMail: () => Promise.resolve(),
  });

  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const admin = await database.fixtures.user();
  const owner = await database.fixtures.user();
  const teammate = await database.fixtures.user();
  const tenant = { ...business.context, businessId: business.id, correlationId: randomUUID() };
  // The team, a mailbox the email steps can queue through, and quiet hours off.
  await database.as('postgres', async (sql) => {
    const [role] = await sql.query<{ id: string }>(
      `insert into tenancy.roles (agency_id,scope,key,name,is_builtin,permissions)
       values ($1,'business','member','Member',true,'{}') returning id`,
      [agency.id],
    );
    for (const user of [owner, teammate])
      await sql.query(
        `insert into tenancy.memberships(user_id,agency_id,business_id,role_id)
         values ($1,$2,$3,$4)`,
        [user.id, agency.id, business.id, role?.id],
      );
    await sql.query(
      `insert into messaging.settings (business_id, quiet_hours_enabled) values ($1, false)
       on conflict (business_id) do update set quiet_hours_enabled = false`,
      [business.id],
    );
    const [secret] = await sql.query<{ id: string }>(
      `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       values ($1, $2, 'mailbox.password', 1, decode(repeat('01', 32), 'hex'), decode(repeat('ab', 32), 'hex'))
       returning id`,
      [agency.id, business.id],
    );
    const [account] = await sql.query<{ id: string }>(
      `insert into messaging.channel_accounts (business_id, channel, name, status)
       values ($1, 'email', 'Sales', 'active') returning id`,
      [business.id],
    );
    await sql.query(
      `insert into messaging.mailboxes (business_id, id, email_address, auth_method, smtp_host,
         smtp_port, smtp_security, smtp_username, imap_host, imap_port, imap_security,
         imap_username, secret_id, use_for_conversations)
       values ($1, $2, $3, 'password', 'mail.example.test', 587, 'starttls', $3,
         'mail.example.test', 993, 'tls', $3, $4, true)`,
      [business.id, account?.id, `${randomUUID()}@example.test`, secret?.id],
    );
  });

  // The setup a person does in the app: a key for the AI.
  const setup = await server({ agencyId: agency.id, businessId: business.id, userId: admin.id });
  const issued = await setup.app.inject({
    method: 'POST',
    url: `${API_PREFIX}/api-keys`,
    payload: {
      name: 'Lead rules authoring acceptance',
      scopes: [
        'automations.manage',
        'automations.publish',
        'fields.manage',
        'fields.values',
        'tags.manage',
        'tags.configure',
      ],
    },
  });
  expect(issued.statusCode, issued.body).toBe(201);

  const live = await server(undefined);
  const address = await live.app.listen({ host: '127.0.0.1', port: 0 });
  const ai = new Client({ name: 'lead-rules-acceptance', version: '1.0.0' });
  clients.push(ai);
  await ai.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../../../packages/mcp/dist/main.js', import.meta.url))],
      env: {
        CRM_API_URL: `${address}${API_PREFIX}`,
        CRM_API_KEY: createdApiKey.parse(issued.json()).key,
        CRM_MCP_ALLOW_PUBLISH: 'true',
      },
      stderr: 'pipe',
    }),
  );

  // Authoring, as an AI given the rules document would do it: the tag the master rule
  // adds, the placeholder field, then every sequence as a draft (names stand for ids: the
  // server resolves them), then publish.
  structured(
    await ai.callTool({ name: 'crm_createTag', arguments: { body: { name: TAG } } }),
    'createTag',
  );
  structured(
    await ai.callTool({
      name: 'crm_createField',
      arguments: {
        body: {
          objectKey: 'contact',
          key: SERVICES,
          label: 'PLACEHOLDER services requested',
          description: 'PLACEHOLDER for the client field that holds the services asked for.',
          valueType: 'multi_choice',
          currency: null,
          options: [
            { key: 'dj', label: 'DJ', description: 'PLACEHOLDER value.', archived: false },
            { key: 'photo', label: 'Photo', description: 'PLACEHOLDER value.', archived: false },
            { key: 'video', label: 'Video', description: 'PLACEHOLDER value.', archived: false },
          ],
          aiFillSources: [],
          aiOverwrite: 'never',
          archived: false,
        },
      },
    }),
    'createField',
  );
  const saved = {} as Record<Sequence, { id: string; draftVersion: number }>;
  for (const key of Object.keys(documents) as Sequence[]) {
    const created = automationDraftSaved.parse(
      structured(
        await ai.callTool({
          name: 'crm_createAutomation',
          arguments: { body: { document: documents[key] } },
        }),
        `createAutomation ${key}`,
      ),
    );
    saved[key] = created.automation;
  }
  for (const key of Object.keys(documents) as Sequence[]) {
    const checked = structured(
      await ai.callTool({
        name: 'crm_validateAutomation',
        arguments: { body: { document: documents[key] } },
      }),
      `validateAutomation ${key}`,
    ) as { valid: boolean; errors: unknown[] };
    expect(checked.errors, key).toEqual([]);
    const published = z.looseObject({ status: z.string(), liveVersion: z.int().nullable() }).parse(
      structured(
        await ai.callTool({
          name: 'crm_publishAutomation',
          arguments: {
            params: { id: saved[key].id },
            body: { baseDraftVersion: saved[key].draftVersion },
          },
        }),
        `publishAutomation ${key}`,
      ),
    );
    expect(published, key).toMatchObject({ status: 'active', liveVersion: 1 });
  }
  const stored = (key: Sequence) => parsePublicId('automation', saved[key].id) ?? '';
  world = {
    tenant,
    app: setup.app,
    ai,
    ids: Object.fromEntries(
      (Object.keys(documents) as Sequence[]).map((key) => [key, stored(key)]),
    ) as Record<Sequence, string>,
    publicIds: Object.fromEntries(
      (Object.keys(documents) as Sequence[]).map((key) => [key, saved[key].id]),
    ) as Record<Sequence, string>,
    owner: owner.id,
    teammate: teammate.id,
  };
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await Promise.all(servers.map((built) => built.close(1000)));
  await authentication.close();
  await db.destroy();
  await database.close();
});

// The server's own worker composition: the same tasks its worker process runs.
const task = (name: string) => {
  const found = workerTasks().find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`The worker has no ${name} task.`);
  return found;
};
const asEngine = () => ({
  services,
  invocation: {
    context: { ...world.tenant, correlationId: randomUUID() },
    permissions: 'all' as const,
  },
});
const match = (eventId: string) => {
  const job = task('automations.match_event');
  return job.run(job.data.parse({ eventId }), asEngine());
};

interface Run {
  id: string;
  automation_id: string;
  status: string;
  exit_reason: string | null;
  current_step: string | null;
  wake_at: Date | null;
  sequence: number;
  state: Record<string, unknown>;
}

const runsOf = (contactId: string) =>
  database.withTenant(world.tenant, (sql) =>
    sql.query<Run>(
      `select id, automation_id, status, exit_reason, current_step, wake_at, state,
              coalesce((state ->> 'sequence')::int, 0) as sequence
       from automation.enrolments where record_id = $1 order by id`,
      [contactId],
    ),
  );

/** The contact's newest run in a sequence, if it has one. */
async function runIn(contactId: string, key: Sequence): Promise<Run | undefined> {
  return (await runsOf(contactId)).findLast((run) => run.automation_id === world.ids[key]);
}

/** Which sequences the contact has a run in, by key, sorted. */
async function sequencesOf(contactId: string): Promise<string[]> {
  const byId = new Map(Object.entries(world.ids).map(([key, id]) => [id, key]));
  return [
    ...new Set((await runsOf(contactId)).map((run) => byId.get(run.automation_id) ?? '?')),
  ].sort();
}

/** Runs every step job that is due for the contact's runs, until each waits or has ended. */
async function work(contactId: string, only?: Sequence): Promise<void> {
  const job = task('automations.run_step');
  for (let round = 0; round < 40; round += 1) {
    const due = (await runsOf(contactId)).filter(
      (run) =>
        run.status === 'running' && (only === undefined || run.automation_id === world.ids[only]),
    );
    if (due.length === 0) return;
    for (const run of due)
      await job.run(job.data.parse({ enrolmentId: run.id, sequence: run.sequence }), asEngine());
  }
  throw new Error('The runs never came to rest.');
}

/**
 * A new lead through the real API, with the services it asked for written to the
 * PLACEHOLDER field before its enquiry is matched, and consent to be emailed.
 */
async function lead(
  firstName: string,
  servicesAsked: readonly string[],
  as: { owned?: boolean } = {},
): Promise<string> {
  const created = await world.app.inject({
    method: 'POST',
    url: `${API_PREFIX}/contacts`,
    payload: { firstName, emails: [`${randomUUID()}@example.test`] },
  });
  expect(created.statusCode, created.body).toBe(201);
  const contactId = parsePublicId('contact', created.json<{ id: string }>().id) ?? '';
  if (servicesAsked.length > 0) {
    // Through the bridge: read the field on the record for its revision, then set it.
    const publicId = created.json<{ id: string }>().id;
    const fields = structured(
      await world.ai.callTool({
        name: 'crm_getRecordFields',
        arguments: { params: { id: publicId } },
      }),
      'getRecordFields',
    ) as { items: { definition: { id: string; key: string }; revision: string }[] };
    const services = fields.items.find((item) => item.definition.key === SERVICES);
    structured(
      await world.ai.callTool({
        name: 'crm_setRecordField',
        arguments: {
          params: { id: publicId, fieldId: services?.definition.id },
          body: { value: [...servicesAsked], revision: services?.revision },
        },
      }),
      'setRecordField',
    );
  }
  await database.as('postgres', async (sql) => {
    await sql.query(
      `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
       values ($1, $2, 'email', 'marketing', 'granted', 'user', 'user')`,
      [world.tenant.businessId, contactId],
    );
    if (as.owned === true)
      await sql.query('update crm.contacts set owner_user_id = $2 where id = $1', [
        contactId,
        world.owner,
      ]);
  });
  const [event] = await database.withTenant(world.tenant, (sql) =>
    sql.query<{ id: string }>(
      "select id from events.events where type = 'contact.created' and subject_id = $1",
      [contactId],
    ),
  );
  await match(event?.id ?? '');
  return contactId;
}

/** Something happens to the lead, and the worker matches it and runs what it started. */
async function then(
  contactId: string,
  type: 'appointment.booked' | 'message.received',
): Promise<void> {
  const eventId = await runCommand(
    services,
    happen,
    { recordId: contactId, type },
    { context: { ...world.tenant, correlationId: randomUUID() }, permissions: 'all' },
  );
  await match(eventId);
  // A run the event stopped said so in an event of its own, which the database queued for
  // matching like any other; the worker would take those jobs next.
  await matchEndings();
  for (const key of ['master', 'booked', 'replied', 'repliedVariant'] as const)
    await work(contactId, key);
  await matchEndings();
}

const matchedEndings = new Set<string>();
/** Matches every "a run ended" event of the business not yet matched, oldest first. */
async function matchEndings(): Promise<void> {
  const events = await database.withTenant(world.tenant, (sql) =>
    sql.query<{ id: string }>(
      `select id from events.events where type like 'automation.run.%' order by recorded_at, id`,
    ),
  );
  for (const event of events) {
    if (matchedEndings.has(event.id)) continue;
    matchedEndings.add(event.id);
    await match(event.id);
  }
}

const noticesFor = (contactId: string) =>
  database.withTenant(world.tenant, (sql) =>
    sql.query<{ user_id: string; title: string; body: string }>(
      `select user_id, title, body from notifications.notifications
       where kind = 'automation.notice' and record_id = $1 order by title, user_id`,
      [contactId],
    ),
  );

const tagsOf = (contactId: string) =>
  database.withTenant(world.tenant, (sql) =>
    sql.query<{ name: string }>(
      `select t.name from crm.record_tags r join crm.tags t on t.id = r.tag_id
       where r.record_id = $1`,
      [contactId],
    ),
  );

const stepOutputs = (enrolmentId: string) =>
  database.withTenant(world.tenant, (sql) =>
    sql.query<{ step_key: string; status: string; output: Record<string, unknown> }>(
      `select step_key, status, output from automation.step_runs
       where enrolment_id = $1 order by started_at, id`,
      [enrolmentId],
    ),
  );

describe('authored through the MCP bridge', () => {
  it('finds the steps the rules need in the catalog the bridge serves', async () => {
    const catalog = structured(
      await world.ai.callTool({ name: 'crm_getAutomationCatalog', arguments: {} }),
      'catalog',
    ) as {
      steps: { type: string; outputs: { key: string }[]; config: unknown }[];
      triggers: { type: string; config: unknown }[];
      setup: {
        unavailableSteps: string[];
        automations: { name: string; starts?: string[]; startsAfter?: string[] }[];
      };
    };
    const step = (type: string) => catalog.steps.find((each) => each.type === type);
    expect(step('automation.run')?.outputs.map((output) => output.key)).toEqual([
      'enrolmentId',
      'outcome',
    ]);
    expect(step('automation.remove')?.outputs.map((output) => output.key)).toEqual(['removed']);
    expect(JSON.stringify(step('team.notify')?.config)).toContain('owner_or_everyone');
    expect(
      JSON.stringify(catalog.triggers.find((each) => each.type === 'message.received')?.config),
    ).toContain('repliedTo');
    for (const type of ['automation.run', 'automation.remove', 'team.notify'])
      expect(catalog.setup.unavailableSteps).not.toContain(type);
    // The master rule is listed with what it starts, which the loop check reads.
    expect(catalog.setup.automations.find((each) => each.name === NAMES.master)?.starts).toEqual([
      world.publicIds.booked,
    ]);
    // The reply notification is listed with the sequences whose runs ending start it.
    expect(
      [
        ...(catalog.setup.automations.find((each) => each.name === NAMES.replied)?.startsAfter ??
          []),
      ].sort(),
    ).toEqual([world.publicIds.dj, world.publicIds.photoVideo, world.publicIds.combined].sort());
    expect(catalog.triggers.map((each) => each.type)).toContain('automation.run_ended');
    // The booked sequence was published with no trigger, and is listed all the same.
    expect(catalog.setup.automations.map((each) => each.name)).toContain(NAMES.booked);
    const tags = structured(
      await world.ai.callTool({ name: 'crm_listTags', arguments: {} }),
      'tags',
    ) as { items: { name: string }[] };
    expect(tags.items.map((each) => each.name)).toContain(TAG);
  });

  it('R1, R19: the published info sequence has no end rule, for a reply or for a booking', async () => {
    const read = automationView.parse(
      structured(
        await world.ai.callTool({
          name: 'crm_getAutomation',
          arguments: { params: { id: world.publicIds.education } },
        }),
        'getAutomation',
      ),
    );
    expect(read.live?.document['stopWhen']).toEqual([]);
    expect(read.live?.document['settings']).toMatchObject({ reEnrollment: 'never' });
    // R20: the note pointing back to the rules document comes back with it.
    expect(read.live?.document['description']).toContain(RULES_NOTE);
  });

  it('R18: the master rule is one document: tag, remove from the three, start, notify', async () => {
    const read = automationView.parse(
      structured(
        await world.ai.callTool({
          name: 'crm_getAutomation',
          arguments: { params: { id: world.publicIds.master } },
        }),
        'getAutomation',
      ),
    );
    const live = read.live?.document as {
      start: string;
      triggers: { type: string }[];
      steps: Record<string, { type: string; next?: string; config: Record<string, unknown> }>;
    };
    expect(live.triggers.map((trigger) => trigger.type)).toEqual(['appointment.booked']);
    const order: string[] = [];
    for (let key: string | undefined = live.start; key !== undefined; key = live.steps[key]?.next)
      order.push(live.steps[key]?.type ?? '?');
    expect(order).toEqual(['tag.add', 'automation.remove', 'automation.run', 'team.notify']);
    // Published with names resolved to ids: the three sales sequences, and never education.
    expect(live.steps['end_sales']?.config).toEqual({
      from: 'automations',
      automations: [world.publicIds.dj, world.publicIds.photoVideo, world.publicIds.combined],
    });
    expect(live.steps['start_booked']?.config).toEqual({ automation: world.publicIds.booked });
    expect(live.steps['tell']?.config).toMatchObject({ to: 'owner_or_everyone' });
  });
});

describe('run by the composed worker tasks', () => {
  it.each<[string[], Sequence]>([
    [['dj'], 'dj'],
    [['photo'], 'photoVideo'],
    [['video'], 'photoVideo'],
    [['photo', 'video'], 'photoVideo'],
    [['dj', 'photo'], 'combined'],
    [['dj', 'video'], 'combined'],
    [['dj', 'photo', 'video'], 'combined'],
  ])('R3 to R6: a lead asking for %j enters education and exactly %s', async (asked, sales) => {
    const contactId = await lead('Routed', asked);
    expect(await sequencesOf(contactId)).toEqual(['education', sales].sort());
  });

  it('a lead who asked for nothing enters education alone', async () => {
    expect(await sequencesOf(await lead('Unsure', []))).toEqual(['education']);
  });

  it('R8 to R12, R18: a booked consultation is tagged, leaves sales, starts the booked sequence, tells the owner, and stays in education', async () => {
    const contactId = await lead('Ada', ['dj', 'photo'], { owned: true });
    await work(contactId);
    const before = await runIn(contactId, 'education');
    expect(before).toMatchObject({ status: 'waiting', current_step: 'second_email' });
    expect(await runIn(contactId, 'combined')).toMatchObject({ status: 'waiting' });

    await then(contactId, 'appointment.booked');
    // R8
    expect(await tagsOf(contactId)).toEqual([{ name: TAG }]);
    // R7 and R9: the sales run is over. Its own stop condition heard the booking first
    // (stops are applied before anything is started), so the master rule's removal found
    // nothing left to remove; either way no sales run is live.
    expect(await runIn(contactId, 'combined')).toMatchObject({
      status: 'exited',
      exit_reason: 'stop:appointment.booked',
    });
    const master = await runIn(contactId, 'master');
    expect(master).toMatchObject({ status: 'completed' });
    const started = await runIn(contactId, 'booked');
    expect(await stepOutputs(master?.id ?? '')).toMatchObject([
      { step_key: 'tag', status: 'succeeded' },
      { step_key: 'end_sales', status: 'succeeded', output: { removed: 0 } },
      { step_key: 'start_booked', status: 'succeeded', output: { outcome: 'started' } },
      { step_key: 'tell', status: 'succeeded' },
    ]);
    // R10: started by the master rule's step, and already at work.
    expect(started).toMatchObject({
      status: 'waiting',
      state: { startedBy: { enrolmentId: master?.id, stepKey: 'start_booked' } },
    });
    // R11: the contact's owner, and only the owner.
    expect(await noticesFor(contactId)).toEqual([
      { user_id: world.owner, title: NAMES.master, body: 'Ada booked a consultation.' },
    ]);
    // R12: education is exactly where it was, to its wake time.
    expect(await runIn(contactId, 'education')).toEqual(before);
    expect(before?.wake_at).toBeInstanceOf(Date);
    // A booking is not a reply: the sales run it stopped starts no reply notification.
    expect(await runIn(contactId, 'replied')).toBeUndefined();
    expect(await runIn(contactId, 'repliedVariant')).toBeUndefined();
  });

  it('R9: the master rule itself removes a lead from a sales sequence that did not hear the booking', async () => {
    const contactId = await lead('Bea', ['dj']);
    await work(contactId);
    const sales = await runIn(contactId, 'dj');
    // The safety net of R7 taken away for this one run, so the removal is what ends it.
    await database.as('postgres', (sql) =>
      sql.query(
        `delete from automation.event_waits
         where enrolment_id = $1 and kind = 'stop' and event_type = 'appointment.booked'`,
        [sales?.id],
      ),
    );
    await then(contactId, 'appointment.booked');
    expect(await runIn(contactId, 'dj')).toMatchObject({
      status: 'exited',
      exit_reason: `removed:${world.publicIds.master}`,
    });
    const master = await runIn(contactId, 'master');
    expect((await stepOutputs(master?.id ?? ''))[1]).toMatchObject({
      step_key: 'end_sales',
      output: { removed: 1 },
    });
    expect(await runIn(contactId, 'education')).toMatchObject({ status: 'waiting' });
    // R11, without an owner: everyone on the team is told.
    expect((await noticesFor(contactId)).map((notice) => notice.user_id).sort()).toEqual(
      [world.owner, world.teammate].sort(),
    );
  });

  it('R13 to R15: a reply to a sales email ends the sales sequence, tells the team, and starts no booked sequence', async () => {
    const contactId = await lead('Cy', ['photo']);
    // Education's email first, then the sales email: the sales one is the most recent.
    await work(contactId, 'education');
    await work(contactId, 'photoVideo');
    const education = await runIn(contactId, 'education');

    await then(contactId, 'message.received');
    // R13
    expect(await runIn(contactId, 'photoVideo')).toMatchObject({
      status: 'exited',
      exit_reason: 'stop:message.received',
    });
    // R14: the sales run ending on the reply started the notification, once.
    const told = await runIn(contactId, 'replied');
    expect(told).toMatchObject({
      status: 'completed',
      state: { endedRun: { automationId: world.ids.photoVideo } },
    });
    // The replied-to variant started too: here the sales email was the most recent.
    expect(await runIn(contactId, 'repliedVariant')).toMatchObject({ status: 'completed' });
    expect(await noticesFor(contactId)).toEqual([
      ...[world.owner, world.teammate].sort().map((user) => ({
        user_id: user,
        title: NAMES.replied,
        body: 'Cy replied to a sales email.',
      })),
      ...[world.owner, world.teammate].sort().map((user) => ({
        user_id: user,
        title: NAMES.repliedVariant,
        body: 'Cy replied to a sales email (replied-to variant).',
      })),
    ]);
    // R15: nothing put the lead in the booked sequence, or tagged it.
    expect(await runIn(contactId, 'booked')).toBeUndefined();
    expect(await runIn(contactId, 'master')).toBeUndefined();
    expect(await tagsOf(contactId)).toEqual([]);
    // R1: education did not stop on the reply.
    expect(await runIn(contactId, 'education')).toEqual(education);
  });

  it('R14 whatever was emailed last: after a later education email the reply still tells the team, where the replied-to variant cannot', async () => {
    const contactId = await lead('Di', ['dj'], { owned: true });
    await work(contactId, 'dj');
    await work(contactId, 'education');
    await then(contactId, 'message.received');
    expect(await runIn(contactId, 'dj')).toMatchObject({
      status: 'exited',
      exit_reason: 'stop:message.received',
    });
    // The run-ended trigger does not look at messages at all.
    expect(await runIn(contactId, 'replied')).toMatchObject({ status: 'completed' });
    // The replied-to variant's stated limit: the most recent automated email was education's.
    expect(await runIn(contactId, 'repliedVariant')).toBeUndefined();
    expect(await noticesFor(contactId)).toEqual([
      { user_id: world.owner, title: NAMES.replied, body: 'Di replied to a sales email.' },
    ]);
  });

  it('R17: a lead who neither replies nor books finishes the sales sequence, stays in education, and is never put in the booked sequence', async () => {
    const contactId = await lead('Eve', ['dj', 'photo', 'video']);
    await work(contactId);
    const sales = await runIn(contactId, 'combined');
    expect(sales).toMatchObject({ status: 'waiting', current_step: 'second_email' });
    // Two days pass for the sales sequence: its wake time is moved into the past, and the
    // job the wait queued is run.
    await database.as('postgres', (sql) =>
      sql.query(
        `update automation.enrolments set wake_at = now() - interval '1 minute' where id = $1`,
        [sales?.id],
      ),
    );
    const job = task('automations.run_step');
    await job.run(
      job.data.parse({ enrolmentId: sales?.id, sequence: sales?.sequence }),
      asEngine(),
    );
    expect(await runIn(contactId, 'combined')).toMatchObject({
      status: 'completed',
      exit_reason: null,
    });
    expect(await runIn(contactId, 'education')).toMatchObject({ status: 'waiting' });
    expect(await runIn(contactId, 'booked')).toBeUndefined();
    await matchEndings();
    // Completing is not being stopped by a reply: nobody is told.
    expect(await sequencesOf(contactId)).toEqual(['combined', 'education']);
    // Both sales emails were queued for the contact, and none was handed to a mail server.
    const queued = await database.withTenant(world.tenant, (sql) =>
      sql.query<{ subject: string; status: string }>(
        `select m.subject, m.status from messaging.messages m
         join messaging.conversations c on c.id = m.conversation_id
         where c.contact_id = $1 and m.idempotency_key like $2 order by m.created_at, m.id`,
        [contactId, `automation:${sales?.id ?? ''}:%`],
      ),
    );
    expect(queued).toEqual([
      { subject: `${NAMES.combined} 1 (placeholder)`, status: 'queued' },
      { subject: `${NAMES.combined} 2 (placeholder)`, status: 'queued' },
    ]);
  });

  it('no run of any lead in this case failed', async () => {
    const failed = await database.withTenant(world.tenant, (sql) =>
      sql.query(
        `select a.name, e.exit_reason from automation.enrolments e
         join automation.automations a on a.id = e.automation_id where e.status = 'failed'`,
      ),
    );
    expect(failed).toEqual([]);
  });
});
