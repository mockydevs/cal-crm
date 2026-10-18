// Creating, changing and trashing contacts, against a migrated Postgres as crm_app under
// row-level security.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { contact, type Contact } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type Issue,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { contactRoutes } from './routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;

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

/** Someone with every permission, in a new business whose address is in `country`. */
async function inBusiness(country?: string): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  if (country !== undefined)
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update tenancy.businesses set address = jsonb_build_object('country', $2::text) where id = $1`,
        [business.id, country],
      ),
    );
  return {
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
}

async function call(
  operationId: string,
  invocation: Invocation,
  request: { params?: unknown; body?: unknown } = {},
): Promise<Contact> {
  const route = contactRoutes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return contact.parse(
    await route.run(
      { invocation, params: request.params ?? {}, body: request.body, query: {} },
      services,
    ),
  );
}

const create = (invocation: Invocation, body: unknown) =>
  call('createContact', invocation, { body });
const update = (invocation: Invocation, id: string, body: unknown) =>
  call('updateContact', invocation, { params: { id }, body });
const trash = (invocation: Invocation, id: string) =>
  call('trashContact', invocation, { params: { id } });
const restore = (invocation: Invocation, id: string) =>
  call('restoreContact', invocation, { params: { id } });
const read = (invocation: Invocation, id: string) =>
  call('getContact', invocation, { params: { id } });

/** The issues of the validation error a call fails with. */
async function issuesOf(attempt: Promise<unknown>): Promise<readonly Issue[]> {
  const error: unknown = await attempt.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).issues;
}

/** The business's events, oldest first. */
const eventsOf = (invocation: Invocation) =>
  database.as('crm_owner', (sql) =>
    sql.query<{ type: string; subject_id: string; payload: unknown }>(
      `select type, subject_id, payload from events.events where business_id = $1 order by recorded_at, id`,
      [invocation.context.businessId],
    ),
  );

const contactCount = (invocation: Invocation) =>
  database.as('crm_owner', async (sql) => {
    const { count } = await sql.one<{ count: string }>(
      `select count(*) from crm.contacts where business_id = $1`,
      [invocation.context.businessId],
    );
    return Number(count);
  });

const uuid = (id: string) => parsePublicId('contact', id) ?? '';

describe('creating a contact', () => {
  it('creates phone labels, time zone and channel restrictions atomically and emits their events', async () => {
    const invocation = await inBusiness('KE');
    const created = await create(invocation, {
      firstName: 'Maya',
      phones: ['0712 345678', '0712 345679'],
      phoneLabels: [null, 'mobile'],
      timeZone: 'Africa/Nairobi',
      dnd: { all: true, channels: ['sms', 'email'] },
    });
    expect(created.timeZone).toBe('Africa/Nairobi');
    expect(created.doNotContact).toBe(true);
    const stored = await database.as('crm_owner', (sql) =>
      sql.query<{ value_normalized: string; label: string | null }>(
        `select value_normalized, label from crm.contact_identities
         where contact_id = $1 and kind = 'phone' order by value_normalized`,
        [uuid(created.id)],
      ),
    );
    expect(stored).toEqual([
      { value_normalized: '+254712345678', label: null },
      { value_normalized: '+254712345679', label: 'mobile' },
    ]);
    expect(await eventsOf(invocation)).toEqual([
      { type: 'contact.created', subject_id: uuid(created.id), payload: {} },
      { type: 'contact.do_not_contact_set', subject_id: uuid(created.id), payload: {} },
      {
        type: 'contact.dnd_changed',
        subject_id: uuid(created.id),
        payload: {
          channels: ['email', 'sms'],
          enabled: ['email', 'sms'],
          disabled: [],
          doNotContact: 'set',
        },
      },
    ]);
  });

  it('accepts an explicitly cleared initial time zone without adding a restriction event', async () => {
    const invocation = await inBusiness('KE');
    const created = await create(invocation, {
      firstName: 'Maya',
      timeZone: null,
      dnd: { all: false, channels: [] },
    });
    expect(created.timeZone).toBeNull();
    expect(created.doNotContact).toBe(false);
    expect(await eventsOf(invocation)).toEqual([
      { type: 'contact.created', subject_id: uuid(created.id), payload: {} },
    ]);
  });

  it('writes the registry row, the contact and its identities together, and puts it on its timeline', async () => {
    const invocation = await inBusiness('KE');

    const created = await create(invocation, {
      firstName: ' Maya ',
      lastName: 'Thompson',
      emails: ['Maya@Example.com', 'maya.work@example.com'],
      phones: ['0712 345678'],
    });

    expect(created).toEqual({
      id: expect.stringMatching(/^con_/) as string,
      firstName: 'Maya',
      lastName: 'Thompson',
      name: 'Maya Thompson',
      dateOfBirth: null,
      source: null,
      type: null,
      emails: ['maya@example.com', 'maya.work@example.com'],
      phones: [{ number: '+254712345678', display: '0712 345678' }],
      timeZone: null,
      doNotContact: false,
      preferencesRevision: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      trashedAt: null,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      canManage: true,
    });
    const stored = await database.as('crm_owner', (sql) =>
      sql.query<{ kind: string; value_normalized: string; is_primary: boolean; record: string }>(
        `select i.kind, i.value_normalized, i.is_primary, r.kind as record
         from crm.contact_identities i join crm.records r on r.business_id = i.business_id and r.id = i.contact_id
         where i.contact_id = $1 order by i.kind, i.id`,
        [uuid(created.id)],
      ),
    );
    expect(stored).toEqual([
      { kind: 'email', value_normalized: 'maya@example.com', is_primary: true, record: 'contact' },
      {
        kind: 'email',
        value_normalized: 'maya.work@example.com',
        is_primary: false,
        record: 'contact',
      },
      { kind: 'phone', value_normalized: '+254712345678', is_primary: true, record: 'contact' },
    ]);
    // No personal data in the event: the event log can't be erased.
    expect(await eventsOf(invocation)).toEqual([
      { type: 'contact.created', subject_id: uuid(created.id), payload: {} },
    ]);
    const timeline = await database.as('crm_owner', (sql) =>
      sql.query<{ event_type: string }>(
        `select event_type from crm.timeline_entries where record_id = $1`,
        [uuid(created.id)],
      ),
    );
    expect(timeline).toEqual([{ event_type: 'contact.created' }]);
  });

  it("writes phone numbers in E.164, and shows them as the business's country writes them", async () => {
    const invocation = await inBusiness('US');

    const created = await create(invocation, { phones: ['(213) 373-4253', '+254 712 345 678'] });

    expect(created.name).toBeNull();
    expect(created.phones).toEqual([
      { number: '+12133734253', display: '(213) 373-4253' },
      { number: '+254712345678', display: '+254 712 345678' },
    ]);
  });

  it("refuses each phone number that isn't one, and writes nothing", async () => {
    // A business with nothing that says where it is: a national number needs its code.
    const invocation = await inBusiness();
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update tenancy.businesses set currency = 'EUR', timezone = 'Europe/Berlin' where id = $1`,
        [invocation.context.businessId],
      ),
    );

    const issues = await issuesOf(
      create(invocation, {
        firstName: 'Maya',
        phones: [
          '0712 345678',
          '+1 213 373 4253',
          '+12',
          '+1 213 373 4253 ext. 12',
          '+12133734253',
        ],
      }),
    );

    expect(issues.map(({ path, code }) => ({ path, code }))).toEqual([
      { path: '/phones/0', code: 'phone_country_unknown' },
      { path: '/phones/2', code: 'phone_invalid' },
      { path: '/phones/3', code: 'phone_extension' },
      { path: '/phones/4', code: 'repeated' },
    ]);
    expect(await contactCount(invocation)).toBe(0);
  });

  it('reads a national US number in a new business that has no address yet (US first)', async () => {
    const invocation = await inBusiness();

    const created = await create(invocation, { phones: ['(212) 555-0142'] });

    expect(created.phones).toEqual([{ number: '+12125550142', display: '(212) 555-0142' }]);
  });

  it('refuses a NUL in a name with a field issue, before it reaches the database', async () => {
    const invocation = await inBusiness();

    expect(await issuesOf(create(invocation, { firstName: 'Ma\u0000ya' }))).toEqual([
      expect.objectContaining({ path: '/firstName' }),
    ]);
    expect(await contactCount(invocation)).toBe(0);
  });

  it('refuses a contact with nothing to know it by', async () => {
    const invocation = await inBusiness();

    expect(await issuesOf(create(invocation, { firstName: ' ' }))).toEqual([
      expect.objectContaining({ path: '', code: 'contact_empty' }),
    ]);
  });
});

describe('creating a contact with custom field values', () => {
  /** A contact field of the business, by its public id. */
  const fieldOf = async (
    invocation: Invocation,
    key: string,
    valueType: string,
    options: readonly { key: string; label: string }[] = [],
  ) => {
    const { id } = await database.withTenant(invocation.context, (sql) =>
      sql.one<{ id: string }>(
        `insert into crm.field_definitions
           (business_id, object_type_id, key, label, description, value_type, options, created_by_kind)
         select app.business_id(), id, $1::text, $1::text, 'A field of the test.', $2::text, $3::jsonb, 'system'
         from crm.object_types where kind = 'contact'
         returning id`,
        [
          key,
          valueType,
          JSON.stringify(options.map((each) => ({ ...each, description: '', archived: false }))),
        ],
      ),
    );
    return toPublicId('field', id);
  };
  const valuesOf = (contactId: string) =>
    database.as('crm_owner', (sql) =>
      sql.query<{
        key: string;
        text: string | null;
        options: string[] | null;
        number: string | null;
      }>(
        `select f.key, v.value_text as text, v.value_options as options, v.value_number::text as number
         from crm.field_values v join crm.field_definitions f on f.id = v.field_id
         where v.record_id = $1 order by f.key`,
        [uuid(contactId)],
      ),
    );

  it('writes them with the contact, by key or id, a choice by its label, and tells of each', async () => {
    const invocation = await inBusiness();
    await fieldOf(invocation, 'service_interest', 'single_choice', [
      { key: 'dj', label: 'DJ' },
      { key: 'photo_video', label: 'Photo/Video' },
    ]);
    const budget = await fieldOf(invocation, 'budget', 'number');
    await fieldOf(invocation, 'notes', 'text');
    const made = await create(invocation, {
      firstName: 'Ada',
      fields: { service_interest: 'Photo/Video', [budget]: '5000', notes: null },
    });
    expect(await valuesOf(made.id)).toEqual([
      { key: 'budget', text: null, options: null, number: '5000' },
      { key: 'service_interest', text: null, options: ['photo_video'], number: null },
    ]);
    // One change: the contact first, then each value, all of one request.
    const events = await eventsOf(invocation);
    expect(events.map((each) => each.type)).toEqual([
      'contact.created',
      'field.value_set',
      'field.value_set',
    ]);
    const correlations = await database.as('crm_owner', (sql) =>
      sql.query<{ count: number }>(
        `select count(distinct correlation_id)::int as count from events.events where business_id = $1`,
        [invocation.context.businessId],
      ),
    );
    expect(correlations).toEqual([{ count: 1 }]);
  });

  it('refuses a field it does not know or a value the field refuses, and writes nothing', async () => {
    const invocation = await inBusiness();
    await fieldOf(invocation, 'service_interest', 'single_choice', [{ key: 'dj', label: 'DJ' }]);
    expect(
      await issuesOf(create(invocation, { firstName: 'Ada', fields: { venue: 'Harbor' } })),
    ).toEqual([expect.objectContaining({ path: '/fields/venue', code: 'unknown_field' })]);
    expect(
      await issuesOf(
        create(invocation, { firstName: 'Ada', fields: { service_interest: 'Harp' } }),
      ),
    ).toEqual([expect.objectContaining({ path: '/fields/service_interest' })]);
    expect(await contactCount(invocation)).toBe(0);
  });

  it.each([{ value: 'DJ, Photo/Video' }, { value: ['DJ', 'photo_video'] }])(
    'stores the canonical keys of multi-choice values given when a contact is created (%j)',
    async ({ value }) => {
      const invocation = await inBusiness();
      await fieldOf(invocation, 'services', 'multi_choice', [
        { key: 'dj', label: 'DJ' },
        { key: 'photo_video', label: 'Photo/Video' },
      ]);
      const made = await create(invocation, { firstName: 'Ada', fields: { services: value } });
      expect(await valuesOf(made.id)).toEqual([
        { key: 'services', text: null, options: ['dj', 'photo_video'], number: null },
      ]);
    },
  );

  it('keeps a false boolean and an ordinary text value in the new contact’s fields', async () => {
    const invocation = await inBusiness();
    await fieldOf(invocation, 'approved', 'boolean');
    await fieldOf(invocation, 'notes', 'text');
    const made = await create(invocation, {
      firstName: 'Ada',
      fields: { approved: false, notes: 'Call on Tuesday' },
    });
    const values = await database.withTenant(invocation.context, (sql) =>
      sql.query<{ key: string; boolean: boolean | null; text: string | null }>(
        `select f.key, v.value_bool as boolean, v.value_text as text
         from crm.field_values v join crm.field_definitions f on f.id = v.field_id
         where v.record_id = $1 order by f.key`,
        [uuid(made.id)],
      ),
    );
    expect(values).toEqual([
      { key: 'approved', boolean: false, text: null },
      { key: 'notes', boolean: null, text: 'Call on Tuesday' },
    ]);
  });

  it.each([
    { type: 'single_choice', value: ['DJ'] },
    { type: 'multi_choice', value: ['DJ', 'Harp'] },
    { type: 'multi_choice', value: 'Harp' },
  ])(
    'refuses a mismatched or unknown choice and rolls back the contact (%j)',
    async ({ type, value }) => {
      const invocation = await inBusiness();
      await fieldOf(invocation, 'services', type, [{ key: 'dj', label: 'DJ' }]);
      await expect(
        create(invocation, { firstName: 'Ada', fields: { services: value } }),
      ).rejects.toThrow(ValidationError);
      expect(await contactCount(invocation)).toBe(0);
      expect(await eventsOf(invocation)).toEqual([]);
    },
  );

  it('needs the permission to set field values when it is given some', async () => {
    const invocation = await inBusiness();
    await fieldOf(invocation, 'notes', 'text');
    const limited: Invocation = { ...invocation, permissions: new Set(['contacts.manage']) };
    await expect(
      create(limited, { firstName: 'Ada', fields: { notes: 'Hello' } }),
    ).rejects.toMatchObject({ name: 'ForbiddenError', permission: 'fields.values' });
    expect((await create(limited, { firstName: 'Grace' })).firstName).toBe('Grace');
  });
});

describe('a duplicate email address or phone number', () => {
  it('gets an issue on the field that links the contact holding it, and nothing is written', async () => {
    const invocation = await inBusiness('KE');
    const maya = await create(invocation, {
      firstName: 'Maya',
      emails: ['maya@example.com'],
      phones: ['+254712345678'],
    });

    const issues = await issuesOf(
      create(invocation, {
        firstName: 'Someone else',
        emails: ['other@example.com', 'MAYA@example.com'],
        phones: ['0712 345678'],
      }),
    );

    const existing = { id: maya.id, name: 'Maya', trashed: false };
    expect(issues).toEqual([
      {
        path: '/emails/1',
        code: 'taken',
        message: 'Another contact has this email address.',
        existing,
      },
      {
        path: '/phones/0',
        code: 'taken',
        message: 'Another contact has this phone number.',
        existing,
      },
    ]);
    expect(await contactCount(invocation)).toBe(1);
  });

  it('offers to restore the contact holding it when that contact is in the trash', async () => {
    const invocation = await inBusiness();
    const maya = await create(invocation, { firstName: 'Maya', emails: ['maya@example.com'] });
    await trash(invocation, maya.id);

    const [issue] = await issuesOf(create(invocation, { emails: ['maya@example.com'] }));

    expect(issue).toEqual({
      path: '/emails/0',
      code: 'taken',
      message: 'A contact in the trash has this email address. Restore it instead.',
      existing: { id: maya.id, name: 'Maya', trashed: true },
    });
    const restored = await restore(invocation, maya.id);
    expect(restored).toMatchObject({ id: maya.id, trashedAt: null, emails: ['maya@example.com'] });
  });

  it('goes to one of two people adding it at once; the other is told who has it', async () => {
    const invocation = await inBusiness();

    const attempts = await Promise.allSettled(
      ['First', 'Second'].map((firstName) =>
        create(invocation, { firstName, emails: ['same@example.com'] }),
      ),
    );

    const created = attempts.flatMap((attempt) =>
      attempt.status === 'fulfilled' ? [attempt.value] : [],
    );
    const refused = attempts.flatMap((attempt) =>
      attempt.status === 'rejected' ? [attempt.reason as unknown] : [],
    );
    expect(created).toHaveLength(1);
    expect(refused).toEqual([expect.any(ValidationError)]);
    expect((refused[0] as ValidationError).issues[0].existing?.id).toBe(created[0]?.id);
    expect(await contactCount(invocation)).toBe(1);
  });

  it('is refused on a change too, and the contact stays as it was', async () => {
    const invocation = await inBusiness();
    const maya = await create(invocation, { firstName: 'Maya', emails: ['maya@example.com'] });
    const dana = await create(invocation, { firstName: 'Dana', emails: ['dana@example.com'] });

    const issues = await issuesOf(
      update(invocation, dana.id, { lastName: 'Brooks', emails: ['maya@example.com'] }),
    );

    expect(issues).toEqual([
      expect.objectContaining({
        path: '/emails/0',
        existing: { id: maya.id, name: 'Maya', trashed: false },
      }),
    ]);
    expect(await read(invocation, dana.id)).toEqual(dana);
  });
});

describe('changing a contact', () => {
  it('changes what it names, replaces identities, and records which fields changed', async () => {
    const invocation = await inBusiness('KE');
    const maya = await create(invocation, {
      firstName: 'Maya',
      lastName: 'Thompson',
      emails: ['maya@example.com'],
      phones: ['0712 345678'],
    });

    const changed = await update(invocation, maya.id, {
      lastName: 'Okafor',
      emails: ['new@example.com', 'maya@example.com'],
      phones: [],
    });

    expect(changed).toMatchObject({
      firstName: 'Maya',
      lastName: 'Okafor',
      name: 'Maya Okafor',
      emails: ['new@example.com', 'maya@example.com'],
      phones: [],
    });
    expect(Date.parse(changed.updatedAt)).toBeGreaterThan(Date.parse(maya.updatedAt));
    const events = await eventsOf(invocation);
    expect(events.at(-1)).toEqual({
      type: 'contact.updated',
      subject_id: uuid(maya.id),
      payload: { changed: ['lastName', 'emails', 'phones'] },
    });
  });

  it('records nothing when nothing changes, however the identities are ordered after the first', async () => {
    const invocation = await inBusiness();
    const maya = await create(invocation, {
      firstName: 'Maya',
      emails: ['maya@example.com', 'a@example.com', 'b@example.com'],
    });

    expect(await update(invocation, maya.id, {})).toEqual(maya);
    expect(
      await update(invocation, maya.id, {
        firstName: 'Maya',
        emails: ['maya@example.com', 'b@example.com', 'a@example.com'],
      }),
    ).toEqual(maya);
    expect((await eventsOf(invocation)).map((event) => event.type)).toEqual(['contact.created']);
  });

  it('makes the first email address the primary one', async () => {
    const invocation = await inBusiness();
    const maya = await create(invocation, { emails: ['maya@example.com', 'work@example.com'] });

    const changed = await update(invocation, maya.id, {
      emails: ['work@example.com', 'maya@example.com'],
    });

    expect(changed.emails).toEqual(['work@example.com', 'maya@example.com']);
  });

  it('refuses to leave a contact with nothing to know it by', async () => {
    const invocation = await inBusiness();
    const maya = await create(invocation, { firstName: 'Maya', emails: ['maya@example.com'] });

    const issues = await issuesOf(update(invocation, maya.id, { firstName: '', emails: [] }));

    expect(issues).toEqual([expect.objectContaining({ path: '', code: 'contact_empty' })]);
  });
});

describe('the trash', () => {
  it('keeps the contact and its identities, and says when it went there', async () => {
    const invocation = await inBusiness();
    const maya = await create(invocation, { firstName: 'Maya', emails: ['maya@example.com'] });

    const trashed = await trash(invocation, maya.id);

    expect(trashed.trashedAt).not.toBeNull();
    expect(await read(invocation, maya.id)).toEqual(trashed);
    expect(trashed.emails).toEqual(['maya@example.com']);
  });

  it('moves a contact there and back once, however often it is asked', async () => {
    const invocation = await inBusiness();
    const maya = await create(invocation, { firstName: 'Maya' });

    await trash(invocation, maya.id);
    await trash(invocation, maya.id);
    await restore(invocation, maya.id);
    await restore(invocation, maya.id);

    expect((await eventsOf(invocation)).map((event) => event.type)).toEqual([
      'contact.created',
      'contact.trashed',
      'contact.restored',
    ]);
    const timeline = await database.as('crm_owner', (sql) =>
      sql.query<{ event_type: string }>(
        `select event_type from crm.timeline_entries where record_id = $1 order by event_recorded_at`,
        [uuid(maya.id)],
      ),
    );
    expect(timeline.map((entry) => entry.event_type)).toEqual([
      'contact.created',
      'contact.trashed',
      'contact.restored',
    ]);
  });

  it('holds a contact unchanged until it is restored', async () => {
    const invocation = await inBusiness();
    const maya = await create(invocation, { firstName: 'Maya' });
    await trash(invocation, maya.id);

    await expect(update(invocation, maya.id, { lastName: 'Okafor' })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe('who can see and change a contact', () => {
  it("can't find another business's contact by its id", async () => {
    const owner = await inBusiness();
    const other = await inBusiness();
    const maya = await create(owner, { firstName: 'Maya', emails: ['maya@example.com'] });

    // One at a time: a call started early could reject before anything awaits it.
    for (const attempt of [
      () => read(other, maya.id),
      () => update(other, maya.id, { firstName: 'Taken' }),
      () => trash(other, maya.id),
      () => restore(other, maya.id),
    ])
      await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
    expect(await read(owner, maya.id)).toEqual(maya);
    // Each business keeps its own identities: the same address is free in another.
    await expect(create(other, { emails: ['maya@example.com'] })).resolves.toMatchObject({
      emails: ['maya@example.com'],
    });
  });

  it("refuses an id that isn't a contact's", async () => {
    const invocation = await inBusiness();

    await expect(
      read(invocation, toPublicId('deal', '01890a5d-ac96-774b-bcce-b302099a8057')),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      read(invocation, toPublicId('contact', '01890a5d-ac96-774b-bcce-b302099a8057')),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('says whether the reader may change it', async () => {
    const invocation = await inBusiness();
    const maya = await create(invocation, { firstName: 'Maya' });

    expect((await read({ ...invocation, permissions: new Set() }, maya.id)).canManage).toBe(false);
  });
});
