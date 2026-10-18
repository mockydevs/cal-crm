import { randomUUID } from 'node:crypto';
import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import { createContactInput } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';
import {
  createContactCommand,
  readContact,
  trashContactCommand,
  updateContactCommand,
} from './contacts.js';
import { intakeContact, type ContactIntakeOptions } from './intake.js';

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

const contactInput = z.strictObject({
  firstName: createContactInput.shape.firstName.unwrap().optional(),
  lastName: createContactInput.shape.lastName.unwrap().optional(),
  emails: createContactInput.shape.emails.unwrap().optional(),
  phones: createContactInput.shape.phones.unwrap().optional(),
});
const intake = defineCommand({
  name: 'test.contact.intake',
  permission: 'contacts.manage',
  input: contactInput,
  audit: () => ({ source: 'public_intake' }),
  handle: intakeContact,
});
/** The same intake, with a source and options, as a booking or a form passes them. */
const intakeWith = (source: 'booking' | undefined, options: ContactIntakeOptions) =>
  defineCommand({
    ...intake,
    name: 'test.contact.intake_with',
    handle: (trx, input: z.output<typeof contactInput>, command) =>
      intakeContact(trx, input, command, source, options),
  });
async function business(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const row = await database.fixtures.business(agency.id);
  return {
    context: { ...row.context, actorKind: 'form', correlationId: randomUUID() },
    permissions: 'all',
  };
}

/** The notes on a contact, as text, oldest first. */
const notesOf = (invocation: Invocation, contactId: string) =>
  database.withTenant(invocation.context, async (sql) =>
    (
      await sql.query<{ body_text: string }>(
        'select body_text from crm.notes where record_id = $1 order by created_at, id',
        [contactId],
      )
    ).map((row) => row.body_text),
  );
const read = (invocation: Invocation, contactId: string) =>
  withTenant(db, invocation.context, (trx) =>
    readContact(trx, invocation, toPublicId('contact', contactId)),
  );
async function staffContact(
  invocation: Invocation,
  input: z.input<typeof createContactInput>,
): Promise<string> {
  const contact = await runCommand(services, createContactCommand, input, invocation);
  const id = parsePublicId('contact', contact.id);
  if (id === undefined) throw new Error('A contact has an id.');
  return id;
}

it('never lets an anonymous submission replace the name, email or phone of a contact it finds', async () => {
  const invocation = await business();
  const victoria = await staffContact(invocation, {
    firstName: 'Victoria',
    lastName: 'Owner',
    emails: ['victoria@example.test'],
    phones: ['+12125550199'],
  });
  const result = await runCommand(
    services,
    intake,
    {
      firstName: 'Hacked',
      lastName: '<img src=x onerror=alert(1)>',
      emails: ['VICTORIA@example.test'],
      phones: ['+1 212 555 0666'],
    },
    invocation,
  );
  expect(result).toMatchObject({
    contactId: victoria,
    created: false,
    restored: false,
    addresses: ['victoria@example.test'],
  });
  expect(result.emailIdentityId).not.toBeNull();
  expect(await read(invocation, victoria)).toMatchObject({
    firstName: 'Victoria',
    lastName: 'Owner',
    emails: ['victoria@example.test'],
    phones: [{ number: '+12125550199' }],
  });
  // The team is told, and can accept what was sent by hand.
  const [note, ...others] = await notesOf(invocation, victoria);
  expect(others).toEqual([]);
  expect(note).toContain('A form submission sent details that were not applied');
  expect(note).toContain('First name given: "Hacked" (the contact has "Victoria").');
  expect(note).toContain('Last name given: "<img src=x onerror=alert(1)>"');
  expect(note).toContain('The phone number +12125550666 was given. It was not added.');
  // Nothing the visitor typed goes into the events, which can't be erased.
  const events = await database.withTenant(invocation.context, (sql) =>
    sql.query<{ type: string; payload: unknown }>(
      `select type, payload from events.events
       where type in ('contact.updated', 'note.created') order by recorded_at, id`,
    ),
  );
  expect(events).toEqual([
    { type: 'note.created', payload: { recordId: toPublicId('contact', victoria) } },
  ]);
});

it('fills in what a found contact lacks, and says nothing when the details agree', async () => {
  const invocation = await business();
  const first = await runCommand(services, intake, { emails: ['maya@example.test'] }, invocation);
  const second = await runCommand(
    services,
    intake,
    { firstName: 'Maya', lastName: 'Stone', emails: [' maya@EXAMPLE.test '] },
    invocation,
  );
  expect(second).toMatchObject({ contactId: first.contactId, created: false, review: [] });
  // The same again, written another way: the same person.
  await runCommand(
    services,
    intake,
    { firstName: 'MAYA', lastName: 'stone ', emails: ['maya@example.test'] },
    invocation,
  );
  expect(await read(invocation, first.contactId)).toMatchObject({
    firstName: 'Maya',
    lastName: 'Stone',
  });
  expect(await notesOf(invocation, first.contactId)).toEqual([]);
});

it('matches by email first: a new email with a known phone is a new person, not the phone holder', async () => {
  const invocation = await business();
  const household = await runCommand(
    services,
    intake,
    { firstName: 'Maya', phones: ['+44 7700 900123'] },
    invocation,
  );
  const partner = await runCommand(
    services,
    intake,
    { firstName: 'Sam', phones: ['+447700900123'], emails: ['sam@example.test'] },
    invocation,
  );
  expect(partner).toMatchObject({ created: true, addresses: ['sam@example.test'] });
  expect(partner.contactId).not.toBe(household.contactId);
  expect(await read(invocation, household.contactId)).toMatchObject({
    firstName: 'Maya',
    emails: [],
  });
  expect(await read(invocation, partner.contactId)).toMatchObject({
    firstName: 'Sam',
    emails: ['sam@example.test'],
    phones: [],
  });
  expect(await notesOf(invocation, partner.contactId)).toEqual([
    expect.stringContaining(
      'The phone number +447700900123 belongs to another contact, Maya. It was not added; they may be the same person.',
    ),
  ]);
});

it('takes a lead whose email and phone name two contacts to the email, and says so', async () => {
  const invocation = await business();
  const email = await runCommand(
    services,
    intake,
    { firstName: 'Private Maya', emails: ['maya@example.test'] },
    invocation,
  );
  await runCommand(
    services,
    intake,
    { firstName: 'Private Other', phones: ['+447700900123'] },
    invocation,
  );
  const lead = await runCommand(
    services,
    intake,
    { firstName: 'Overwrite', emails: ['maya@example.test'], phones: ['+447700900123'] },
    invocation,
  );
  expect(lead).toMatchObject({ contactId: email.contactId, created: false });
  expect(await read(invocation, email.contactId)).toMatchObject({
    firstName: 'Private Maya',
    phones: [],
  });
  const [note] = await notesOf(invocation, email.contactId);
  expect(note).toContain(
    'The phone number +447700900123 belongs to another contact, Private Other. It was not added',
  );
});

it('restores a contact in the trash that the details find, and keeps the lead on it', async () => {
  const invocation = await business();
  const email = await runCommand(
    services,
    intake,
    { firstName: 'Maya', emails: ['maya@example.test'] },
    invocation,
  );
  await runCommand(
    services,
    trashContactCommand,
    { id: toPublicId('contact', email.contactId) },
    invocation,
  );
  const lead = await runCommand(
    services,
    intake,
    { firstName: 'Maya', emails: ['maya@example.test'] },
    invocation,
  );
  expect(lead).toMatchObject({ contactId: email.contactId, created: false, restored: true });
  expect(await read(invocation, email.contactId)).toMatchObject({ trashedAt: null });
  expect(await notesOf(invocation, email.contactId)).toEqual([
    expect.stringContaining('This contact was in the trash. It was restored'),
  ]);
  const restored = await database.withTenant(invocation.context, (sql) =>
    sql.query<{ type: string }>(`select type from events.events where type = 'contact.restored'`),
  );
  expect(restored).toHaveLength(1);

  // Found by its phone alone, too.
  const phone = await runCommand(
    services,
    intake,
    { firstName: 'Ola', phones: ['+447700900124'] },
    invocation,
  );
  await runCommand(
    services,
    trashContactCommand,
    { id: toPublicId('contact', phone.contactId) },
    invocation,
  );
  expect(
    await runCommand(services, intake, { phones: ['+44 7700 900124'] }, invocation),
  ).toMatchObject({ contactId: phone.contactId, restored: true });
});

it("never finds a contact by a fictional number or by one of the business's own", async () => {
  const invocation = await business();
  await database.as('crm_owner', (sql) =>
    sql.query(`update tenancy.businesses set phone_e164 = '+12125550142' where id = $1`, [
      invocation.context.businessId,
    ]),
  );
  const fictional = await staffContact(invocation, {
    firstName: 'Tester',
    phones: ['+1 415 555 0100'],
  });
  const front = await staffContact(invocation, {
    firstName: 'Front desk',
    phones: ['+12125550142'],
  });
  const line = await staffContact(invocation, {
    firstName: 'SMS line',
    phones: ['+12125550143'],
  });
  // National numbers: a business with no address that trades in US dollars is in the US.
  const first = await runCommand(
    services,
    intake,
    { firstName: 'Bob', phones: ['(415) 555-0100'] },
    invocation,
  );
  const second = await runCommand(
    services,
    intake,
    { firstName: 'Ann', phones: ['212 555 0142'] },
    invocation,
  );
  const third = await runCommand(
    services,
    intakeWith(undefined, { ownPhones: ['+12125550143'] }),
    { firstName: 'Cy', phones: ['+12125550143'] },
    invocation,
  );
  for (const made of [first, second, third]) expect(made.created).toBe(true);
  expect(
    new Set([first.contactId, second.contactId, third.contactId, fictional, front, line]).size,
  ).toBe(6);
  expect(await read(invocation, front)).toMatchObject({ firstName: 'Front desk' });
  expect(await notesOf(invocation, second.contactId)).toEqual([
    expect.stringContaining("The phone number +12125550142 is this business's own number."),
  ]);
  expect(await notesOf(invocation, third.contactId)).toEqual([
    expect.stringContaining("The phone number +12125550143 is this business's own number."),
  ]);
});

it('refuses a number the North American plan cannot have', async () => {
  const invocation = await business();
  await expect(
    runCommand(
      services,
      intake,
      { emails: ['a@example.test'], phones: ['(123) 456-7890'] },
      invocation,
    ),
  ).rejects.toMatchObject({ issues: [{ path: '/phones/0', code: 'phone_invalid' }] });
  await expect(
    runCommand(services, intake, { phones: ['0000000000'] }, invocation),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('hands the review back to a caller that writes it itself, and names a booking', async () => {
  const invocation = await business();
  const first = await runCommand(
    services,
    intake,
    { firstName: 'Maya', emails: ['maya@example.test'] },
    invocation,
  );
  const deferred = await runCommand(
    services,
    intakeWith('booking', { deferReview: true }),
    { firstName: 'Mia', emails: ['maya@example.test'] },
    invocation,
  );
  expect(deferred.review).toEqual(['First name given: "Mia" (the contact has "Maya").']);
  expect(await notesOf(invocation, first.contactId)).toEqual([]);
  await runCommand(
    services,
    intakeWith('booking', {}),
    { firstName: 'Mia', emails: ['maya@example.test'] },
    invocation,
  );
  expect(await notesOf(invocation, first.contactId)).toEqual([
    expect.stringMatching(/^A booking sent details/),
  ]);
});

it('links the committed ordinary-create winner after a database identity conflict without orphan rows', async () => {
  const invocation = await business();
  const claimed = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const ordinary = defineCommand({
    ...createContactCommand,
    name: 'test.contact.ordinary_create',
    async handle(trx, input, command) {
      const contact = await createContactCommand.handle(trx, input, command);
      claimed.resolve(undefined);
      await release.promise;
      return contact;
    },
  });
  const created = runCommand(services, ordinary, { emails: ['race@example.test'] }, invocation);
  await claimed.promise;
  const incoming = runCommand(services, intake, { emails: ['race@example.test'] }, invocation).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    await expect
      .poll(
        async () => {
          const row = await database.as('crm_app', (sql) =>
            sql.one<{ waiting: boolean }>(
              "select exists(select from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%contact_identities%') as waiting",
            ),
          );
          return row.waiting;
        },
        { timeout: 5000 },
      )
      .toBe(true);
  } finally {
    release.resolve(undefined);
  }
  const winner = await created;
  expect(await incoming).toMatchObject({
    ok: true,
    result: { contactId: parsePublicId('contact', winner.id) },
  });
  const counts = await withTenant(db, invocation.context, async (trx) => ({
    contacts: await trx.selectFrom('crm.contacts').select('id').execute(),
    records: await trx.selectFrom('crm.records').select('id').execute(),
    events: await trx
      .selectFrom('events.events')
      .select('type')
      .where('type', '=', 'contact.created')
      .execute(),
  }));
  expect(counts.contacts).toHaveLength(1);
  expect(counts.records).toHaveLength(1);
  expect(counts.events).toHaveLength(1);
});

it('looks again when the found contact gives up the address while the intake waits for it', async () => {
  const invocation = await business();
  const original = await runCommand(
    services,
    intake,
    { firstName: 'Keep', emails: ['old@example.test'] },
    invocation,
  );
  const changed = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const ordinary = defineCommand({
    ...updateContactCommand,
    name: 'test.contact.ordinary_update',
    async handle(trx, input, command) {
      const saved = await updateContactCommand.handle(trx, input, command);
      changed.resolve(undefined);
      await release.promise;
      return saved;
    },
  });
  const updated = runCommand(
    services,
    ordinary,
    {
      id: toPublicId('contact', original.contactId),
      emails: ['kept@example.test'],
    },
    invocation,
  );
  await changed.promise;
  const incoming = runCommand(
    services,
    intake,
    { firstName: 'Newcomer', emails: ['old@example.test'] },
    invocation,
  );
  try {
    await expect
      .poll(
        async () => {
          const row = await database.as('crm_app', (sql) =>
            sql.one<{ waiting: boolean }>(
              "select exists(select from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%contacts%') as waiting",
            ),
          );
          return row.waiting;
        },
        { timeout: 5000 },
      )
      .toBe(true);
  } finally {
    release.resolve(undefined);
  }
  await updated;
  // The address is nobody's now: the lead becomes a contact of its own, and is not lost.
  const lead = await incoming;
  expect(lead).toMatchObject({ created: true });
  expect(lead.contactId).not.toBe(original.contactId);
  expect(await read(invocation, original.contactId)).toMatchObject({
    firstName: 'Keep',
    emails: ['kept@example.test'],
  });
  expect(await read(invocation, lead.contactId)).toMatchObject({
    firstName: 'Newcomer',
    emails: ['old@example.test'],
  });
});

it('refuses duplicate normalized phone aliases without silently collapsing them', async () => {
  const invocation = await business();
  const first = await runCommand(
    services,
    intake,
    { emails: ['aliases@example.test'] },
    invocation,
  );
  await expect(
    runCommand(
      services,
      intake,
      {
        emails: ['aliases@example.test'],
        phones: ['+44 7700 900123', '+447700900123'],
      },
      invocation,
    ),
  ).rejects.toMatchObject({
    issues: [
      { path: '/phones/1', code: 'repeated', message: 'This phone number is already listed.' },
    ],
  });
  expect(await read(invocation, first.contactId)).toMatchObject({ phones: [] });
});

it('refuses invalid phones and empty contacts using canonical validation', async () => {
  const invocation = await business();
  await expect(
    runCommand(
      services,
      intake,
      { emails: ['invalid-phone@example.test'], phones: ['not-a-phone'] },
      invocation,
    ),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(runCommand(services, intake, {}, invocation)).rejects.toMatchObject({
    issues: [
      {
        path: '',
        code: 'contact_empty',
        message: 'Give the contact a name, an email address or a phone number.',
      },
    ],
  });
});

it('gives a contact found by phone alone the last name it lacked, and keeps its name and email', async () => {
  const invocation = await business();
  const first = await runCommand(
    services,
    intake,
    { firstName: 'Maya', emails: ['preserved@example.test'], phones: ['+447700900123'] },
    invocation,
  );
  const second = await runCommand(
    services,
    intake,
    { firstName: 'Someone', lastName: 'Stone', phones: ['+44 7700 900123'] },
    invocation,
  );
  expect(second).toMatchObject({
    contactId: first.contactId,
    emailIdentityId: null,
    created: false,
    addresses: ['+447700900123'],
  });
  expect(await read(invocation, first.contactId)).toMatchObject({
    firstName: 'Maya',
    lastName: 'Stone',
    emails: ['preserved@example.test'],
  });
});

it('creates a permitted name-only contact and keeps identities isolated between businesses', async () => {
  const invocation = await business();
  const named = await runCommand(services, intake, { firstName: 'Maya' }, invocation);
  expect(named.emailIdentityId).toBeNull();
  const second = await business();
  const ours = await runCommand(services, intake, { emails: ['same@example.test'] }, invocation);
  const theirs = await runCommand(services, intake, { emails: ['same@example.test'] }, second);
  expect(ours.contactId).not.toBe(theirs.contactId);
});

// What a form also says about a contact: when they were born, and where they came from.
const describedIntake = defineCommand({
  name: 'test.contact.described_intake',
  permission: 'contacts.manage',
  input: contactInput.extend({
    dateOfBirth: createContactInput.shape.dateOfBirth,
    source: createContactInput.shape.source,
  }),
  audit: () => ({ source: 'public_intake' }),
  handle: intakeContact,
});

it('gives a new contact the date of birth and the source it was sent with', async () => {
  const invocation = await business();
  const made = await runCommand(
    services,
    describedIntake,
    { emails: ['maya@example.test'], dateOfBirth: '1990-04-23', source: 'Wedding enquiry' },
    invocation,
  );
  expect(made.created).toBe(true);
  expect(await read(invocation, made.contactId)).toMatchObject({
    dateOfBirth: '1990-04-23',
    source: 'Wedding enquiry',
  });
});

it('writes a source and a date of birth only to a contact that has none', async () => {
  const invocation = await business();
  const updates = () =>
    database.withTenant(invocation.context, (sql) =>
      sql.query<{ changed: string[] }>(
        `select payload->'changed' as changed from events.events
         where type = 'contact.updated' order by recorded_at, id`,
      ),
    );
  // Made with nothing said about either.
  const first = await runCommand(services, intake, { emails: ['maya@example.test'] }, invocation);
  expect(await read(invocation, first.contactId)).toMatchObject({
    dateOfBirth: null,
    source: null,
  });

  // Found again, with both: it had neither, so it gets both.
  const second = await runCommand(
    services,
    describedIntake,
    { emails: ['maya@example.test'], dateOfBirth: '1990-04-23', source: 'Wedding enquiry' },
    invocation,
  );
  expect(second).toMatchObject({ contactId: first.contactId, created: false });
  expect(await read(invocation, first.contactId)).toMatchObject({
    dateOfBirth: '1990-04-23',
    source: 'Wedding enquiry',
  });
  expect(await updates()).toEqual([{ changed: ['dateOfBirth', 'source'] }]);

  // Found a third time, from somewhere else: what it has stays, and the team is told of
  // the other date of birth. Where a contact came from is said once, and never noted.
  await runCommand(
    services,
    describedIntake,
    { emails: ['maya@example.test'], dateOfBirth: '1991-05-24', source: 'Trade fair 2026' },
    invocation,
  );
  expect(await read(invocation, first.contactId)).toMatchObject({
    dateOfBirth: '1990-04-23',
    source: 'Wedding enquiry',
  });
  expect(await updates()).toHaveLength(1);
  expect(await notesOf(invocation, first.contactId)).toEqual([
    expect.stringContaining('Date of birth given: "1991-05-24" (the contact has "1990-04-23").'),
  ]);

  // Sent with neither, or with nothing in them: nothing changes and nothing is noted.
  await runCommand(services, intake, { emails: ['maya@example.test'] }, invocation);
  await runCommand(
    services,
    describedIntake,
    { emails: ['maya@example.test'], dateOfBirth: null, source: null },
    invocation,
  );
  expect(await updates()).toHaveLength(1);
  expect(await notesOf(invocation, first.contactId)).toHaveLength(1);
});

it('refuses a date of birth in the future for a new contact and for one it found, and writes nothing', async () => {
  const invocation = await business();
  const future = { emails: ['maya@example.test'], dateOfBirth: '2990-01-01' };
  await expect(runCommand(services, describedIntake, future, invocation)).rejects.toMatchObject({
    issues: [{ path: '/dateOfBirth', code: 'in_future' }],
  });
  const made = await runCommand(services, intake, { emails: ['maya@example.test'] }, invocation);
  await expect(runCommand(services, describedIntake, future, invocation)).rejects.toBeInstanceOf(
    ValidationError,
  );
  expect(await read(invocation, made.contactId)).toMatchObject({ dateOfBirth: null });
});
