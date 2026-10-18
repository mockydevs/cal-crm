// Bulk actions on contacts beyond tags, trash, owner and workflows: export as CSV, send an
// email or a text message, set do not disturb, and add an opportunity; and running an
// action later or in timed batches. Against a migrated Postgres as crm_app under row-level
// security, through the routes the server registers and the job the worker runs. Sending
// and the files service are the other modules' (bulk-options.ts), so stand-ins take their
// place here: what each was asked, and what it answered.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import {
  contactBulkAction,
  contactBulkItemList,
  contactDetails,
  fileLink,
  recordFields,
  type ContactBulkAction,
  type Permission,
  type StoredFile,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { detailOptions, team, type Team } from '../../test/contact-details.js';
import { dealScene } from '../../test/deal-people.js';
import { seedContacts } from '../../test/contacts.js';
import { createCrmRoutes } from '../index.js';
import type { BulkMessage, BulkMessages, ContactBulkOptions } from './bulk-options.js';
import { contactBulkRoutes, createContactBulkTasks } from './bulk-routes.js';
import { contactBulkCommands } from './bulk.js';
import { contactDetailRoutes } from './detail-routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;

/** What the stand-in for sending was asked, and what it answers for a contact. */
const sent: { contactId: string; key: string; message: BulkMessage }[] = [];
const refusals = new Map<string, 'no_consent' | 'do_not_disturb' | 'no_address'>();
const held: string[] = [];
/** Room under the agency's daily ceiling on campaign emails: null is no ceiling. */
let emailRoom: number | null = null;
const UNUSABLE_NUMBER = toPublicId('phone_number', '0198de17-876e-7000-aac7-9bc8ac229101');
const messages: BulkMessages = {
  check: (_trx, _invocation, message) =>
    Promise.resolve(
      message.channel === 'sms' && message.number === UNUSABLE_NUMBER
        ? { path: '/number', code: 'number_unavailable', message: 'That number cannot send.' }
        : undefined,
    ),
  hold: (_trx, invocation) => {
    held.push(invocation.context.correlationId);
    return Promise.resolve();
  },
  emailAllowance: () => Promise.resolve(emailRoom),
  send: (_trx, _invocation, message, contact) => {
    const refusal = refusals.get(contact.id);
    if (refusal !== undefined) return Promise.resolve({ queued: false, reason: refusal });
    // The same key again is the message queued before, as messaging's own key makes it.
    if (!sent.some((each) => each.key === contact.idempotencyKey)) {
      sent.push({ contactId: contact.id, key: contact.idempotencyKey, message });
      if (message.channel === 'email' && emailRoom !== null) emailRoom -= 1;
    }
    return Promise.resolve({ queued: true });
  },
};

/**
 * The stand-in for the files service: keeps a file as its row, in the command's own
 * transaction as the real one does, and its text beside; links only by the purpose it was
 * kept for; and deletes as it is asked to.
 */
const kept = new Map<string, string>();
const discarded: string[] = [];
let tooLarge = false;
let storageFull = false;
const files: NonNullable<ContactBulkOptions['files']> = {
  get maxBytes() {
    return tooLarge ? 10 : 1_000_000;
  },
  async store(trx, command, file): Promise<StoredFile> {
    if (storageFull)
      throw new ValidationError([
        { path: '', code: 'storage_full', message: "This business's storage is full." },
      ]);
    const text = Buffer.from(file.content).toString('utf8');
    const row = await trx
      .insertInto('files.files')
      .values({
        agency_id: command.context.agencyId,
        business_id: command.context.businessId ?? null,
        storage: 'local',
        storage_key: randomUUID(),
        filename: file.filename,
        content_type: file.contentType,
        size_bytes: file.content.length,
        sha256: Buffer.alloc(32),
        uploaded_by_kind: command.context.actorKind,
        purpose: file.purpose,
      })
      .returning(['id', 'created_at'])
      .executeTakeFirstOrThrow();
    kept.set(row.id, text);
    return {
      id: toPublicId('file', row.id),
      filename: file.filename,
      contentType: 'text/csv',
      size: file.content.length,
      sha256: '0'.repeat(64),
      createdAt: row.created_at.toISOString(),
    };
  },
  link: (_services, _invocation, fileId, lifetime) =>
    Promise.resolve({
      path: `/files/${fileId}/content?expires=${String(lifetime.seconds)}&for=${lifetime.purpose}`,
      expiresAt: new Date(Date.now() + lifetime.seconds * 1000).toISOString(),
    }),
  async discard(trx, _command, fileId) {
    discarded.push(fileId);
    await trx
      .updateTable('files.files')
      .set({ deleted_at: new Date() })
      .where('id', '=', fileId)
      .execute();
  },
};

/** Who is on the team now, and with what, as the server's grants say; unset, all of it. */
const grants = new Map<string, ReadonlySet<Permission> | 'gone'>();
const options: ContactBulkOptions = {
  ...detailOptions(),
  messages,
  files,
  apiUrl: 'https://crm.example.com/api/v1',
  grants: (_trx, _context, userId) => {
    const granted = grants.get(userId);
    return Promise.resolve(
      granted === 'gone'
        ? undefined
        : (granted ??
            new Set<Permission>([
              'contacts.manage',
              'contacts.export',
              'tags.manage',
              'campaigns.send',
              'deals.manage',
              'automations.manage',
            ])),
    );
  },
};
const routes = [
  ...createCrmRoutes({}, options),
  ...contactDetailRoutes(options),
  ...contactBulkRoutes(options),
];
const [task, expireTask] = createContactBulkTasks(options);
const commands = contactBulkCommands(options);

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

function call(
  operationId: string,
  invocation: Invocation,
  request: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {},
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return Promise.resolve(
    route.run(
      { invocation, params: request.params ?? {}, query: request.query ?? {}, body: request.body },
      services,
    ),
  );
}

const bulk = async (invocation: Invocation, body: unknown): Promise<ContactBulkAction> =>
  contactBulkAction.parse(await call('bulkUpdateContacts', invocation, { body }));
const read = async (invocation: Invocation, id: string): Promise<ContactBulkAction> =>
  contactBulkAction.parse(await call('getContactBulkAction', invocation, { params: { id } }));
const cancel = async (invocation: Invocation, id: string): Promise<ContactBulkAction> =>
  contactBulkAction.parse(await call('cancelContactBulkAction', invocation, { params: { id } }));
const itemsOf = async (invocation: Invocation, id: string, query: Record<string, string> = {}) =>
  contactBulkItemList.parse(
    await call('listContactBulkActionItems', invocation, { params: { id }, query }),
  ).items;
const linkTo = async (invocation: Invocation, id: string) =>
  fileLink.parse(await call('createContactExportLink', invocation, { params: { id } }));

const person = async (
  t: Team,
  firstName: string,
  extra: Record<string, unknown> = {},
): Promise<string> =>
  (
    (await call('createContact', t.system(), {
      body: { firstName, lastName: 'Example', ...extra },
    })) as { id: string }
  ).id;

const owner = (run: string, values: readonly unknown[] = []) =>
  database.as('crm_owner', (sql) => sql.query(run, [...values]));

const uuid = (kind: 'contact' | 'bulk_action', id: string) => parsePublicId(kind, id) ?? '';

/** Runs the worker's job for an action, as the queue would: as the system, in the business. */
const runJob = (t: Team, action: ContactBulkAction): Promise<void> => {
  if (task === undefined) throw new Error('No bulk task.');
  return task.run(
    { bulkActionId: uuid('bulk_action', action.id) },
    { invocation: t.system(), services },
  );
};

/** The job queued for an action at a time, as the queue holds it. */
const queuedAt = async (action: ContactBulkAction): Promise<Date[]> =>
  (
    await owner(
      `select run_at from graphile_worker._private_jobs where key = $1 and locked_at is null`,
      [`contacts.bulk_run:${uuid('bulk_action', action.id)}`],
    )
  ).map((row) => row['run_at'] as Date);

/** Moves an action's next time into the past, as the clock would. */
const timePasses = (action: ContactBulkAction) =>
  owner(
    `update crm.contact_bulk_actions set next_run_at = now() - interval '1 second' where id = $1`,
    [uuid('bulk_action', action.id)],
  );

const eventsOf = (t: Team, type: string) =>
  owner(
    `select e.actor_id, e.subject_id, e.payload from events.events e
     where e.business_id = $1 and e.type = $2 order by e.recorded_at, e.id`,
    [t.businessId, type],
  );

describe('exporting contacts as CSV', () => {
  /** A contact field of the business, by its public id. */
  const fieldOf = async (t: Team, key: string, valueType: string, choices: string[] = []) => {
    const [row] = await database.withTenant(t.context, (sql) =>
      sql.query<{ id: string }>(
        `insert into crm.field_definitions
           (business_id, object_type_id, key, label, description, value_type, options, created_by_kind)
         select app.business_id(), id, $1::text, $2::text, 'A field of the test.', $3::text, $4::jsonb, 'system'
         from crm.object_types where kind = 'contact'
         returning id`,
        [
          key,
          key === 'service' ? 'Service wanted' : key,
          valueType,
          JSON.stringify(
            choices.map((label) => ({
              key: label.toLowerCase(),
              label,
              description: '',
              archived: false,
            })),
          ),
        ],
      ),
    );
    return toPublicId('field', row?.id ?? '');
  };

  it('writes the chosen columns of the contacts, in the background, and links to the file', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const service = await fieldOf(t, 'service', 'single_choice', ['Wedding', 'Portrait']);
    const ada = await person(t, 'Ada', {
      emails: ['ada@example.com'],
      phones: ['+14155550101'],
      fields: { service: 'Wedding' },
    });
    // A name that a spreadsheet would run as a formula is written as text.
    const formula = await person(t, '=HYPERLINK("x")');
    const gone = await person(t, 'Gone');
    await call('trashContact', t.system(), { params: { id: gone } });

    const action = await bulk(dana.as(), {
      action: 'export',
      name: 'Fair leads',
      columns: ['name', 'email', 'phone', service, 'tags'],
      selection: { ids: [ada, formula, gone] },
    });
    // An export is always the worker's: it writes the file.
    expect(action).toMatchObject({
      action: 'export',
      status: 'queued',
      requested: 3,
      file: null,
      failure: null,
    });
    await runJob(t, action);
    const done = await read(dana.as(), action.id);
    expect(done).toMatchObject({
      status: 'completed',
      done: 2,
      skipped: 1,
      file: { filename: expect.stringMatching(/^Fair_leads_\d{4}-\d{2}-\d{2}\.csv$/) as unknown },
    });
    const [file] = await owner(
      'select file_id, content from crm.contact_bulk_actions where id = $1',
      [uuid('bulk_action', action.id)],
    );
    expect(file?.['content']).toBeNull();
    const text = kept.get(String(file?.['file_id']));
    expect(text).toBe(
      '﻿"Contact Name","Email","Phone","Service wanted","Tags"\r\n' +
        '"Ada Example","ada@example.com","(415) 555-0101","Wedding",""\r\n' +
        `"'=HYPERLINK(""x"") Example","","","",""\r\n`,
    );
    expect((await itemsOf(dana.as(), action.id, { outcome: 'skipped' }))[0]).toMatchObject({
      contactId: gone,
      reason: { code: 'in_trash' },
    });

    const link = await linkTo(dana.as(), action.id);
    expect(link.url).toMatch(
      /^https:\/\/crm\.example\.com\/api\/v1\/files\/file_[0-9a-z]+\/content\?expires=900&for=contact_export$/,
    );
  });

  it('exports booleans, multiple choices and labelled text boxes beside the built-in columns', async () => {
    const t = await team(database);
    const approved = await fieldOf(t, 'approved', 'boolean');
    const preferences = await fieldOf(t, 'preferences', 'multi_choice', ['Home', 'Work']);
    const references = await fieldOf(t, 'references', 'text_list', ['Home', 'Work']);
    const ada = await person(t, 'Ada', {
      fields: { approved: true, preferences: ['Home', 'Work'] },
    });
    const grace = await person(t, 'Grace', { fields: { approved: false } });
    const boxes = recordFields
      .parse(await call('getRecordFields', t.system(), { params: { id: ada } }))
      .items.find((field) => field.definition.id === references);
    if (boxes === undefined) throw new Error('The text box field is missing.');
    await call('setRecordField', t.system(), {
      params: { id: ada, fieldId: references },
      body: { value: { home: 'Desk', work: 'Mobile' }, revision: boxes.revision },
    });
    const action = await bulk(t.system(), {
      action: 'export',
      columns: ['name', 'company', 'added', 'lastActivity', approved, preferences, references],
      selection: { ids: [ada, grace] },
    });
    await runJob(t, action);
    expect(await read(t.system(), action.id)).toMatchObject({ status: 'completed', done: 2 });
    const [stored] = await owner('select file_id from crm.contact_bulk_actions where id = $1', [
      uuid('bulk_action', action.id),
    ]);
    const text = kept.get(String(stored?.['file_id']));
    expect(text).toContain(
      '"Contact Name","Business Name","Created","Last Activity","approved","preferences","references"\r\n',
    );
    expect(text).toContain('"Yes","Home, Work","Home: Desk; Work: Mobile"\r\n');
    expect(text).toContain('"No","",""\r\n');
  });

  it('needs contacts.export to start one and to download its file, and stays in its business', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const ada = await person(t, 'Ada');
    const body = { action: 'export', columns: ['name'], selection: { ids: [ada] } };
    await expect(
      bulk(dana.as(new Set<Permission>(['contacts.manage'])), body),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const action = await bulk(
      dana.as(new Set<Permission>(['contacts.manage', 'contacts.export'])),
      body,
    );
    // No file yet: nothing to download.
    await expect(linkTo(t.system(), action.id)).rejects.toBeInstanceOf(ConflictError);
    await runJob(t, action);
    await expect(
      linkTo(dana.as(new Set<Permission>(['contacts.manage'])), action.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Another business's action is not found, and nothing of it is told.
    const other = await team(database);
    await expect(linkTo(other.system(), action.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(read(other.system(), action.id)).rejects.toBeInstanceOf(NotFoundError);
    // A field that is not one of this business's contact fields is refused with its place.
    const theirs = await fieldOf(other, 'theirs', 'text');
    await expect(bulk(t.system(), { ...body, columns: ['name', theirs] })).rejects.toMatchObject({
      issues: [{ path: '/columns/1', code: 'unknown_field' }],
    });
  });

  it('fails saying why when the file is more than the install keeps', async () => {
    const t = await team(database);
    const ada = await person(t, 'Ada');
    tooLarge = true;
    try {
      const action = await bulk(t.system(), {
        action: 'export',
        columns: ['name'],
        selection: { ids: [ada] },
      });
      await runJob(t, action);
      expect(await read(t.system(), action.id)).toMatchObject({
        status: 'failed',
        file: null,
        failure: { code: 'file_too_large', message: expect.any(String) as unknown },
        canCancel: false,
      });
    } finally {
      tooLarge = false;
    }
  });

  it('cannot be started where the install keeps no files', async () => {
    const t = await team(database);
    const ada = await person(t, 'Ada');
    const start = contactBulkRoutes({ ...detailOptions() }).find(
      (each) => each.endpoint.operationId === 'bulkUpdateContacts',
    );
    await expect(
      Promise.resolve(
        start?.run(
          {
            invocation: t.system(),
            params: {},
            query: {},
            body: { action: 'export', columns: ['name'], selection: { ids: [ada] } },
          },
          services,
        ),
      ),
    ).rejects.toMatchObject({ issues: [{ code: 'export_unavailable' }] });
  });
});

describe('sending an email or a text message to the contacts', () => {
  it('queues one message for each contact through the outbound path, and says why one was not sent', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const [ada, grace, alan] = [
      await person(t, 'Ada'),
      await person(t, 'Grace'),
      await person(t, 'Alan'),
    ];
    refusals.set(uuid('contact', grace), 'no_consent');
    refusals.set(uuid('contact', alan), 'do_not_disturb');
    const action = await bulk(dana.as(), {
      action: 'send_sms',
      message: 'Hi {{contact.first_name}}, we open Saturday.',
      selection: { ids: [ada, grace, alan] },
    });
    expect(action).toMatchObject({
      action: 'send_sms',
      status: 'completed',
      done: 1,
      skipped: 2,
    });
    const mine = sent.filter((each) => each.key.includes(uuid('bulk_action', action.id)));
    expect(mine).toEqual([
      {
        contactId: uuid('contact', ada),
        key: `contact-bulk:${uuid('bulk_action', action.id)}:${uuid('contact', ada)}`,
        message: {
          channel: 'sms',
          message: 'Hi {{contact.first_name}}, we open Saturday.',
          number: undefined,
        },
      },
    ]);
    expect(
      (await itemsOf(dana.as(), action.id)).map((item) => [item.outcome, item.reason?.code]),
    ).toEqual([
      ['done', undefined],
      ['skipped', 'no_consent'],
      ['skipped', 'do_not_disturb'],
    ]);
    // The batch took the outbound path's lock before any contact.
    expect(held.length).toBeGreaterThan(0);
    // What was written is not kept once the action has ended.
    const [row] = await owner('select content from crm.contact_bulk_actions where id = $1', [
      uuid('bulk_action', action.id),
    ]);
    expect(row?.['content']).toBeNull();
  });

  it('sends an email of its own or a template, and refuses a sender that cannot send', async () => {
    const t = await team(database);
    const ada = await person(t, 'Ada');
    const email = await bulk(t.system(), {
      action: 'send_email',
      subject: 'Open Saturday',
      body: 'Hi {{contact.first_name}}',
      fromName: 'Calari',
      selection: { ids: [ada] },
    });
    expect(email).toMatchObject({ done: 1 });
    expect(sent.find((each) => each.key.includes(uuid('bulk_action', email.id)))?.message).toEqual({
      channel: 'email',
      mailbox: undefined,
      fromName: 'Calari',
      subject: 'Open Saturday',
      body: 'Hi {{contact.first_name}}',
      templateId: undefined,
    });
    for (const body of [
      { action: 'send_email', body: 'No subject', selection: { ids: [ada] } },
      {
        action: 'send_email',
        subject: 'Both',
        body: 'x',
        templateId: 'tmpl_01h455vb4pex5vsknk084sn02q',
        selection: { ids: [ada] },
      },
      { action: 'send_sms', message: '', selection: { ids: [ada] } },
      { action: 'send_sms', message: 'x'.repeat(1601), selection: { ids: [ada] } },
    ])
      await expect(bulk(t.system(), body)).rejects.toBeInstanceOf(ValidationError);
    await expect(
      bulk(t.system(), {
        action: 'send_sms',
        message: 'Hi',
        number: UNUSABLE_NUMBER,
        selection: { ids: [ada] },
      }),
    ).rejects.toMatchObject({ issues: [{ path: '/number', code: 'number_unavailable' }] });
  });

  it('needs the permission that sends a campaign, and an install that can send', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const ada = await person(t, 'Ada');
    const body = { action: 'send_sms', message: 'Hi', selection: { ids: [ada] } };
    await expect(
      bulk(dana.as(new Set<Permission>(['contacts.manage', 'conversations.reply'])), body),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      await bulk(dana.as(new Set<Permission>(['contacts.manage', 'campaigns.send'])), body),
    ).toMatchObject({ done: 1 });
    const start = contactBulkRoutes(detailOptions()).find(
      (each) => each.endpoint.operationId === 'bulkUpdateContacts',
    );
    await expect(
      Promise.resolve(
        start?.run({ invocation: t.system(), params: {}, query: {}, body }, services),
      ),
    ).rejects.toMatchObject({ issues: [{ code: 'sending_unavailable' }] });
  });

  it('drips: a batch, then a wait, then the next, until every contact is reached', async () => {
    const t = await team(database);
    await seedContacts(database, t.businessId, 250);
    const action = await bulk(t.system(), {
      action: 'send_sms',
      message: 'Hi',
      delivery: { drip: { batchSize: 120, intervalMinutes: 60 } },
      selection: { all: true },
    });
    expect(action).toMatchObject({
      status: 'queued',
      requested: 250,
      done: 0,
      drip: { batchSize: 120, intervalMinutes: 60 },
    });
    expect(await queuedAt(action)).toHaveLength(1);

    await runJob(t, action);
    const first = await read(t.system(), action.id);
    expect(first).toMatchObject({ status: 'running', done: 120, canCancel: true });
    // The next batch is an hour on, and its job is queued for then.
    const next = new Date(first.nextBatchAt ?? '');
    expect(next.getTime() - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    expect((await queuedAt(action)).map((at) => at.toISOString())).toEqual([next.toISOString()]);
    // A run before its time reaches nobody.
    await runJob(t, action);
    expect(await read(t.system(), action.id)).toMatchObject({ done: 120 });

    await timePasses(action);
    await runJob(t, action);
    expect(await read(t.system(), action.id)).toMatchObject({ status: 'running', done: 240 });
    await timePasses(action);
    await runJob(t, action);
    expect(await read(t.system(), action.id)).toMatchObject({
      status: 'completed',
      done: 250,
      nextBatchAt: null,
    });
    // Each contact once, however the runs fell.
    const mine = sent.filter((each) => each.key.includes(uuid('bulk_action', action.id)));
    expect(new Set(mine.map((each) => each.contactId)).size).toBe(250);
    expect(mine).toHaveLength(250);
  });

  it('waits for a later start, and stops at once when cancelled while it waits', async () => {
    const t = await team(database);
    const ada = await person(t, 'Ada');
    const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const later = await bulk(t.system(), {
      action: 'send_sms',
      message: 'Tomorrow',
      delivery: { startAt },
      selection: { ids: [ada] },
    });
    expect(later).toMatchObject({ status: 'queued', done: 0, nextBatchAt: startAt });
    expect((await queuedAt(later)).map((at) => at.toISOString())).toEqual([startAt]);
    await runJob(t, later);
    expect(await read(t.system(), later.id)).toMatchObject({ status: 'queued', done: 0 });
    const stopped = await cancel(t.system(), later.id);
    expect(stopped).toMatchObject({ status: 'cancelled', canCancel: false, nextBatchAt: null });
    await timePasses(later);
    await runJob(t, later);
    expect(await read(t.system(), later.id)).toMatchObject({ status: 'cancelled', done: 0 });
    expect(sent.some((each) => each.key.includes(uuid('bulk_action', later.id)))).toBe(false);

    // A start time already past is now.
    const now = await bulk(t.system(), {
      action: 'send_sms',
      message: 'Now',
      delivery: { startAt: new Date(Date.now() - 60_000).toISOString() },
      selection: { ids: [ada] },
    });
    expect(now).toMatchObject({ status: 'completed', done: 1 });
  });
});

describe('setting do not disturb', () => {
  const dndOf = async (t: Team, id: string) =>
    contactDetails.parse(await call('getContactDetails', t.system(), { params: { id } })).dnd;

  it('turns channels on and off, or every channel, by the single change, and keeps the reason in the audit log', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const [ada, grace] = [await person(t, 'Ada'), await person(t, 'Grace')];
    const reason = 'Asked at the fair to get no more texts.';
    const on = await bulk(dana.as(), {
      action: 'set_dnd',
      dnd: 'on',
      channels: ['sms', 'email'],
      reason,
      selection: { ids: [ada, grace] },
    });
    expect(on).toMatchObject({ done: 2, unchanged: 0 });
    expect(await dndOf(t, ada)).toMatchObject({ all: false, channels: ['email', 'sms'] });
    // Again: nothing changes, and nothing is written.
    expect(
      await bulk(dana.as(), {
        action: 'set_dnd',
        dnd: 'on',
        channels: ['sms'],
        reason,
        selection: { ids: [ada, grace] },
      }),
    ).toMatchObject({ done: 0, unchanged: 2 });
    expect(
      await bulk(dana.as(), {
        action: 'set_dnd',
        dnd: 'off',
        channels: ['sms'],
        reason,
        selection: { ids: [ada] },
      }),
    ).toMatchObject({ done: 1 });
    expect(await dndOf(t, ada)).toMatchObject({ all: false, channels: ['email'] });
    await bulk(dana.as(), {
      action: 'set_dnd',
      dnd: 'on',
      channels: 'all',
      reason,
      selection: { ids: [ada] },
    });
    expect(await dndOf(t, ada)).toMatchObject({ all: true, channels: ['email'] });
    await bulk(dana.as(), {
      action: 'set_dnd',
      dnd: 'off',
      channels: 'all',
      reason,
      selection: { ids: [ada] },
    });
    expect(await dndOf(t, ada)).toMatchObject({ all: false, channels: [] });

    // The single change's events, in the name of the person who started the action.
    const changed = await eventsOf(t, 'contact.dnd_changed');
    expect(changed.length).toBe(4);
    expect(new Set(changed.map((event) => event['actor_id']))).toEqual(new Set([dana.userId]));
    expect(await eventsOf(t, 'contact.do_not_contact_set')).toHaveLength(1);
    const audit = await owner(
      `select input from audit.commands where business_id = $1 and command = 'contact.bulk'
       order by recorded_at, id limit 1`,
      [t.businessId],
    );
    expect(audit[0]?.['input']).toMatchObject({ action: 'set_dnd', reason });
    // A reason too short to say anything is refused, as the single change refuses it.
    await expect(
      bulk(dana.as(), {
        action: 'set_dnd',
        dnd: 'on',
        channels: 'all',
        reason: 'x',
        selection: { ids: [ada] },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('adding an opportunity for each contact', () => {
  it('makes one in the pipeline for each contact, named after it, and skips one that has one', async () => {
    const scene = await dealScene(database);
    const dana = await scene.member('Dana Brooks');
    const [ada, grace] = [await scene.contact('Ada'), await scene.contact('Grace')];
    const action = await bulk(dana.as(), {
      action: 'add_opportunity',
      pipelineId: scene.pipelineId,
      amount: '1500',
      source: 'Trade fair',
      selection: { ids: [ada, grace] },
    });
    expect(action).toMatchObject({ action: 'add_opportunity', done: 2, skipped: 0 });
    const deals = await owner(
      `select d.name, d.amount::text as amount, d.currency, d.status, d.source, s.name as stage,
         d.created_by_id
       from crm.deals d join crm.pipeline_stages s on s.business_id = d.business_id and s.id = d.stage_id
       where d.business_id = $1 order by d.name`,
      [scene.businessId],
    );
    // The pipeline's first stage, as none was named.
    expect(deals).toEqual([
      expect.objectContaining({
        name: 'Ada',
        amount: expect.stringMatching(/^1500(.0+)?$/) as unknown,
        status: 'open',
        source: 'Trade fair',
        stage: 'New lead',
        created_by_id: dana.userId,
      }),
      expect.objectContaining({ name: 'Grace', stage: 'New lead' }),
    ]);

    // Again: each is with one now, so each is skipped, unless duplicates are allowed.
    const again = await bulk(dana.as(), {
      action: 'add_opportunity',
      pipelineId: scene.pipelineId,
      stageId: scene.secondStageId,
      opportunityName: 'Second look',
      selection: { ids: [ada, grace] },
    });
    expect(again).toMatchObject({ done: 0, skipped: 2 });
    expect((await itemsOf(dana.as(), again.id))[0]?.reason?.code).toBe('has_opportunity');
    const twice = await bulk(dana.as(), {
      action: 'add_opportunity',
      pipelineId: scene.pipelineId,
      stageId: scene.secondStageId,
      opportunityName: 'Second look',
      allowDuplicates: true,
      selection: { ids: [ada] },
    });
    expect(twice).toMatchObject({ done: 1 });
    expect(
      await owner(
        `select count(*)::int as n from crm.deals where business_id = $1 and name = 'Second look'`,
        [scene.businessId],
      ),
    ).toEqual([{ n: 1 }]);
  });

  it('needs deals.manage and an active pipeline of the business', async () => {
    const scene = await dealScene(database);
    const dana = await scene.member('Dana Brooks');
    const ada = await scene.contact('Ada');
    const body = {
      action: 'add_opportunity',
      pipelineId: scene.pipelineId,
      selection: { ids: [ada] },
    };
    await expect(
      bulk(dana.as(new Set<Permission>(['contacts.manage'])), body),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const other = await dealScene(database);
    await expect(
      bulk(scene.system(), { ...body, pipelineId: other.pipelineId }),
    ).rejects.toMatchObject({ issues: [{ path: '/pipelineId', code: 'unavailable' }] });
    await expect(bulk(scene.system(), { ...body, stageId: other.stageId })).rejects.toMatchObject({
      issues: [{ path: '/stageId', code: 'unavailable' }],
    });
  });
});

describe('a bulk action of another business', () => {
  it('is not found, and its job changes nothing there', async () => {
    const t = await team(database);
    const other = await team(database);
    const ada = await person(t, 'Ada');
    const action = await bulk(t.system(), {
      action: 'send_sms',
      message: 'Hi',
      delivery: { startAt: new Date(Date.now() + 60_000).toISOString() },
      selection: { ids: [ada] },
    });
    await expect(cancel(other.system(), action.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(itemsOf(other.system(), action.id)).rejects.toBeInstanceOf(NotFoundError);
    // The job run in the other business finds nothing to do.
    await timePasses(action);
    if (task === undefined) throw new Error('No bulk task.');
    await task.run(
      { bulkActionId: uuid('bulk_action', action.id) },
      { invocation: other.system(), services },
    );
    expect(await read(t.system(), action.id)).toMatchObject({ status: 'queued', done: 0 });
    // The batch command itself, run there, ends at once.
    expect(
      await runCommand(
        services,
        commands.applyBatch,
        { bulkActionId: uuid('bulk_action', action.id) },
        other.system(),
      ),
    ).toEqual({ state: 'ended' });
  });
});

describe('a whole list narrowed by a custom field', () => {
  it('takes only the contacts the field filter keeps, as the list shows them', async () => {
    const t = await team(database);
    const [row] = await database.withTenant(t.context, (sql) =>
      sql.query<{ id: string }>(
        `insert into crm.field_definitions
           (business_id, object_type_id, key, label, description, value_type, created_by_kind)
         select app.business_id(), id, 'city', 'City', 'Where they live.', 'text', 'system'
         from crm.object_types where kind = 'contact'
         returning id`,
      ),
    );
    const city = toPublicId('field', row?.id ?? '');
    const ada = await person(t, 'Ada', { fields: { city: 'Austin' } });
    await person(t, 'Grace', { fields: { city: 'Boston' } });
    await person(t, 'Alan');
    const action = await bulk(t.system(), {
      action: 'set_dnd',
      dnd: 'on',
      channels: ['sms'],
      reason: 'Austin office asked us to stop.',
      selection: { all: true, fieldId: city, fieldOperator: 'equals', fieldValue: 'Austin' },
    });
    expect(action).toMatchObject({ requested: 1, done: 1 });
    expect((await itemsOf(t.system(), action.id)).map((item) => item.contactId)).toEqual([ada]);
    // A field filter says how to match.
    await expect(
      bulk(t.system(), {
        action: 'trash',
        selection: { all: true, fieldId: city },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('what the review of the bulk actions found', () => {
  const exportOf = (t: Team, ids: string[], invocation = t.system()) =>
    bulk(invocation, { action: 'export', columns: ['name'], selection: { ids } });
  const exportFiles = (t: Team) =>
    owner(
      `select id, deleted_at from files.files where business_id = $1 and purpose = 'contact_export'`,
      [t.businessId],
    );

  it('ends an export as failed when the business’s storage is full, rather than running on', async () => {
    const t = await team(database);
    const action = await exportOf(t, [await person(t, 'Ada')]);
    storageFull = true;
    try {
      await runJob(t, action);
    } finally {
      storageFull = false;
    }
    expect(await read(t.system(), action.id)).toMatchObject({
      status: 'failed',
      failure: { code: 'storage_full' },
      canCancel: false,
      file: null,
    });
    expect(await exportFiles(t)).toEqual([]);
  });

  it('keeps one file however often its job runs, and none for an export stopped first', async () => {
    const t = await team(database);
    const ada = await person(t, 'Ada');
    const action = await exportOf(t, [ada]);
    await runJob(t, action);
    await runJob(t, action);
    expect(await exportFiles(t)).toHaveLength(1);

    const stopped = await exportOf(t, [ada]);
    expect(await cancel(t.system(), stopped.id)).toMatchObject({ status: 'cancelled' });
    await runJob(t, stopped);
    expect(await read(t.system(), stopped.id)).toMatchObject({ status: 'cancelled', file: null });
    expect(await exportFiles(t)).toHaveLength(1);
  });

  it('leaves out of the file a contact moved to the trash after it was counted', async () => {
    const t = await team(database);
    const [ada, grace] = [await person(t, 'Ada'), await person(t, 'Grace')];
    const action = await exportOf(t, [ada, grace]);
    // The contacts are settled, then Grace goes to the trash before the file is written.
    await runCommand(
      services,
      commands.applyBatch,
      { bulkActionId: uuid('bulk_action', action.id) },
      t.system(),
    );
    await call('trashContact', t.system(), { params: { id: grace } });
    await runJob(t, action);
    const [row] = await owner('select file_id from crm.contact_bulk_actions where id = $1', [
      uuid('bulk_action', action.id),
    ]);
    const text = kept.get(String(row?.['file_id'])) ?? '';
    expect(text).toContain('"Ada Example"');
    expect(text).not.toContain('Grace');
  });

  it('removes an export’s file after thirty days, and then says it has expired', async () => {
    const t = await team(database);
    const action = await exportOf(t, [await person(t, 'Ada')]);
    await runJob(t, action);
    const done = await read(t.system(), action.id);
    expect(done.file).not.toBeNull();
    const finished = new Date(done.finishedAt ?? '').getTime();
    expect(new Date(done.fileExpiresAt ?? '').getTime() - finished).toBe(30 * 24 * 60 * 60 * 1000);
    // The removal is queued for that time.
    const [job] = await owner(`select run_at from graphile_worker._private_jobs where key = $1`, [
      `contacts.bulk_expire_export:${uuid('bulk_action', action.id)}`,
    ]);
    expect((job?.['run_at'] as Date).toISOString()).toBe(done.fileExpiresAt);
    if (expireTask === undefined) throw new Error('No expiry task.');
    const expire = () =>
      expireTask.run(
        { bulkActionId: uuid('bulk_action', action.id) },
        { invocation: t.system(), services },
      );
    // Early by the clock, it waits for its time again.
    await expire();
    expect((await read(t.system(), action.id)).file).not.toBeNull();
    await owner(
      `update crm.contact_bulk_actions set finished_at = now() - interval '31 days' where id = $1`,
      [uuid('bulk_action', action.id)],
    );
    await expire();
    const expired = await read(t.system(), action.id);
    expect(expired).toMatchObject({ status: 'completed', file: null });
    expect(new Date(expired.fileExpiresAt ?? '').getTime()).toBeLessThan(Date.now());
    expect(discarded).toHaveLength(1);
    expect((await exportFiles(t))[0]?.['deleted_at']).not.toBeNull();
    await expect(linkTo(t.system(), action.id)).rejects.toThrow(/expired/);
  });

  it('stops a running action at once, even when its job died', async () => {
    const t = await team(database);
    await seedContacts(database, t.businessId, 150);
    const action = await bulk(t.system(), { action: 'trash', selection: { all: true } });
    // One batch, then the job is gone.
    await runCommand(
      services,
      commands.applyBatch,
      { bulkActionId: uuid('bulk_action', action.id) },
      t.system(),
    );
    expect(await read(t.system(), action.id)).toMatchObject({ status: 'running', done: 100 });
    const stopped = await cancel(t.system(), action.id);
    expect(stopped).toMatchObject({ status: 'cancelled', done: 100, canCancel: false });
    expect(stopped.finishedAt).not.toBeNull();
  });

  it('stops an action whose starter has left the team, or may no longer do it', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const lee = await t.member('Lee Park');
    const ada = await person(t, 'Ada');
    const [tagRow] = await owner(
      `insert into crm.tags (business_id, name, created_by_kind) values ($1, 'VIP', 'system') returning id`,
      [t.businessId],
    );
    const vip = toPublicId('tag', String(tagRow?.['id']));
    const later = { startAt: new Date(Date.now() + 60_000).toISOString() };
    const left = await bulk(dana.as(), {
      action: 'add_tags',
      tagIds: [vip],
      delivery: later,
      selection: { ids: [ada] },
    });
    const narrowed = await bulk(lee.as(), {
      action: 'add_tags',
      tagIds: [vip],
      delivery: later,
      selection: { ids: [ada] },
    });
    grants.set(dana.userId, 'gone');
    grants.set(lee.userId, new Set<Permission>(['contacts.manage']));
    try {
      for (const each of [left, narrowed]) {
        await timePasses(each);
        await runJob(t, each);
      }
    } finally {
      grants.clear();
    }
    expect(await read(t.system(), left.id)).toMatchObject({
      status: 'failed',
      done: 0,
      failure: { code: 'starter_removed' },
    });
    expect(await read(t.system(), narrowed.id)).toMatchObject({
      status: 'failed',
      done: 0,
      failure: { code: 'starter_not_allowed' },
    });
  });

  it('waits for room under the agency’s daily ceiling on campaign emails', async () => {
    const t = await team(database);
    const ids = [await person(t, 'Ada'), await person(t, 'Grace'), await person(t, 'Alan')];
    emailRoom = 0;
    try {
      const action = await bulk(t.system(), {
        action: 'send_email',
        subject: 'Open Saturday',
        body: 'Hi',
        selection: { ids },
      });
      // No room: nothing is sent, and the action waits a quarter of an hour.
      expect(action).toMatchObject({ status: 'running', done: 0 });
      const wait = new Date(action.nextBatchAt ?? '').getTime() - Date.now();
      expect(wait).toBeGreaterThan(14 * 60 * 1000);
      expect(wait).toBeLessThanOrEqual(15 * 60 * 1000);
      // Room for two: two go, and the third waits for more.
      emailRoom = 2;
      await timePasses(action);
      await runJob(t, action);
      expect(await read(t.system(), action.id)).toMatchObject({ status: 'running', done: 2 });
      emailRoom = null;
      await timePasses(action);
      await runJob(t, action);
      expect(await read(t.system(), action.id)).toMatchObject({ status: 'completed', done: 3 });
    } finally {
      emailRoom = null;
    }
  });

  it('never shows a next batch time that has passed, and starts at most thirty days ahead', async () => {
    const t = await team(database);
    const ada = await person(t, 'Ada');
    const action = await bulk(t.system(), {
      action: 'send_sms',
      message: 'Hi',
      delivery: { startAt: new Date(Date.now() + 60_000).toISOString() },
      selection: { ids: [ada] },
    });
    await timePasses(action);
    expect(await read(t.system(), action.id)).toMatchObject({
      status: 'queued',
      nextBatchAt: null,
    });
    await expect(
      bulk(t.system(), {
        action: 'send_sms',
        message: 'Hi',
        delivery: { startAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString() },
        selection: { ids: [ada] },
      }),
    ).rejects.toMatchObject({ issues: [{ path: '/delivery/startAt', code: 'too_far' }] });
  });
});
