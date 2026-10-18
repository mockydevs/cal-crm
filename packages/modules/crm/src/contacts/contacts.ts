// Contacts: one registry row, one contact row and its identities, written together in the
// command's transaction. Each email address and phone number belongs to one contact in a
// business, even one in the trash, so a duplicate is refused with a field-level issue that
// names the contact holding it.
import {
  defineCommand,
  requireBusiness,
  type CommandContext,
  type Invocation,
} from '@repo/commands';
import {
  contactIdInput,
  contactTypes,
  createContactInput,
  dndChannelsOf,
  updateContactCommandInput,
  type Contact,
  type ContactSource,
  type ContactType,
} from '@repo/contracts';
import type { DatabaseTransaction, DB } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type ActorKind,
  type Issue,
} from '@repo/kernel';
import { sql, type Selectable } from 'kysely';
import type * as z from 'zod';
import type { CountryCode } from 'libphonenumber-js';

import { recordCreationTouch } from '../attribution/touches.js';
import { writeCreatedFields } from './create-fields.js';
import { changeContactPreferences, preferencesOf, resolveTimeZone } from './contact-settings.js';
import { countryOf } from './country.js';
import { asContactPhone, normalizePhone } from './phones.js';

export type IdentityKind = 'email' | 'phone';

/** An email address or phone number: as given, and as the database matches it. */
export interface Identity {
  readonly kind: IdentityKind;
  readonly value: string;
  readonly normalized: string;
}

/** Where each kind sits in the input, for issues that point at one entry. */
const fieldOf = { email: 'emails', phone: 'phones' } as const satisfies Record<
  IdentityKind,
  string
>;

const nothingToKnowItBy = () =>
  new ValidationError([
    {
      path: '',
      code: 'contact_empty',
      message: 'Give the contact a name, an email address or a phone number.',
    },
  ]);

const notFound = (id: string) => new NotFoundError('Contact', id);

/** A contact merged into another is gone: it answers not found, naming where it went. */
const mergedAway = (id: string, mergedInto: string) =>
  new NotFoundError('Contact', id, { mergedInto: toPublicId('contact', mergedInto) });

/** The contact's UUID. A valid id of another kind finds no contact. */
function uuidOf(id: string): string {
  const uuid = parsePublicId('contact', id);
  if (uuid === undefined) throw notFound(id);
  return uuid;
}

/** A name as stored: blank is no name. */
const nameOf = (name: string | null): string | null => (name === null || name === '' ? null : name);

export { countryOf };

/**
 * The email addresses and phone numbers given, normalized: emails come lowercased from the
 * contract, phones become E.164. Refuses a phone number that isn't one, or that repeats an
 * earlier one however it's written.
 */
export function identitiesOf(
  input: {
    readonly emails?: readonly string[] | undefined;
    readonly phones?: readonly string[] | undefined;
  },
  country: CountryCode | undefined,
): { emails?: Identity[]; phones?: Identity[] } {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const phones = input.phones?.flatMap((value, index): Identity[] => {
    const normalized = normalizePhone(value, country);
    const path = `/phones/${String(index)}`;
    if (typeof normalized !== 'string') {
      issues.push({ path, ...normalized });
      return [];
    }
    if (seen.has(normalized)) {
      issues.push({ path, code: 'repeated', message: 'This phone number is already listed.' });
      return [];
    }
    seen.add(normalized);
    return [{ kind: 'phone', value, normalized }];
  });
  const [first, ...rest] = issues;
  if (first !== undefined) throw new ValidationError([first, ...rest]);
  return {
    ...(input.emails === undefined
      ? {}
      : {
          emails: input.emails.map((value) => ({
            kind: 'email' as const,
            value,
            normalized: value,
          })),
        }),
    ...(phones === undefined ? {} : { phones }),
  };
}

const takenMessages = {
  email: {
    live: 'Another contact has this email address.',
    trashed: 'A contact in the trash has this email address. Restore it instead.',
  },
  phone: {
    live: 'Another contact has this phone number.',
    trashed: 'A contact in the trash has this phone number. Restore it instead.',
  },
} as const;

/**
 * Gives the contact each identity no contact holds yet. One another contact holds is an
 * issue naming that contact. Inserting with ON CONFLICT DO NOTHING waits for a concurrent
 * transaction claiming the same value, then reads its committed holder, so two requests
 * can't both claim one address.
 */
export async function claim(
  trx: DatabaseTransaction,
  businessId: string,
  contactId: string,
  identities: readonly Identity[],
  primary: boolean,
): Promise<Issue[]> {
  if (identities.length === 0) return [];
  const claimed = await trx
    .insertInto('crm.contact_identities')
    .values(
      identities.map((identity, index) => ({
        business_id: businessId,
        contact_id: contactId,
        kind: identity.kind,
        value: identity.value,
        value_normalized: identity.normalized,
        is_primary: primary && index === 0,
      })),
    )
    .onConflict((conflict) => conflict.constraint('contact_identities_value_unique').doNothing())
    .returning(['kind', 'value_normalized'])
    .execute();
  const unclaimed = identities.filter(
    (identity) =>
      !claimed.some(
        (row) => row.kind === identity.kind && row.value_normalized === identity.normalized,
      ),
  );
  if (unclaimed.length === 0) return [];
  const holders = await trx
    .selectFrom('crm.contact_identities as identity')
    .innerJoin('crm.contacts as contact', (join) =>
      join
        .onRef('contact.business_id', '=', 'identity.business_id')
        .onRef('contact.id', '=', 'identity.contact_id'),
    )
    .select([
      'identity.kind',
      'identity.value_normalized',
      'contact.id',
      'contact.display_name',
      'contact.deleted_at',
    ])
    .where('identity.business_id', '=', businessId)
    .where((where) =>
      where.or(
        unclaimed.map((identity) =>
          where.and([
            where('identity.kind', '=', identity.kind),
            where('identity.value_normalized', '=', identity.normalized),
          ]),
        ),
      ),
    )
    .execute();
  return unclaimed.flatMap((identity): Issue[] => {
    const holder = holders.find(
      (row) => row.kind === identity.kind && row.value_normalized === identity.normalized,
    );
    // Deleted by a concurrent purge after it blocked this claim: nothing to name, so retry.
    if (holder === undefined)
      throw new ConflictError('Contact details changed at the same time. Try again.');
    if (holder.id === contactId) return [];
    const trashed = holder.deleted_at !== null;
    return [
      {
        path: `/${fieldOf[identity.kind]}/${String(identities.indexOf(identity))}`,
        code: 'taken',
        message: takenMessages[identity.kind][trashed ? 'trashed' : 'live'],
        existing: { id: toPublicId('contact', holder.id), name: holder.display_name, trashed },
      },
    ];
  });
}

/** Makes the first identity of the kind the contact's primary one. */
export async function makePrimary(
  trx: DatabaseTransaction,
  businessId: string,
  contactId: string,
  kind: IdentityKind,
  first: Identity | undefined,
): Promise<void> {
  const ofContact = trx
    .updateTable('crm.contact_identities')
    .where('business_id', '=', businessId)
    .where('contact_id', '=', contactId)
    .where('kind', '=', kind);
  // Two statements: the one-primary index is checked row by row, not at the statement's end.
  await ofContact.set({ is_primary: false }).where('is_primary', '=', true).execute();
  if (first !== undefined)
    await ofContact
      .set({ is_primary: true })
      .where('value_normalized', '=', first.normalized)
      .execute();
}

/**
 * Makes the contact's identities of one kind exactly these, the first as primary. Gives an
 * issue for each another contact holds.
 */
async function replaceIdentities(
  trx: DatabaseTransaction,
  businessId: string,
  contactId: string,
  kind: IdentityKind,
  identities: readonly Identity[],
): Promise<Issue[]> {
  let removed = trx
    .deleteFrom('crm.contact_identities')
    .where('business_id', '=', businessId)
    .where('contact_id', '=', contactId)
    .where('kind', '=', kind);
  if (identities.length > 0)
    removed = removed.where(
      'value_normalized',
      'not in',
      identities.map((identity) => identity.normalized),
    );
  await removed.execute();
  const issues = await claim(trx, businessId, contactId, identities, false);
  if (issues.length === 0) await makePrimary(trx, businessId, contactId, kind, identities[0]);
  return issues;
}

const contactColumns = [
  'id',
  'first_name',
  'last_name',
  'display_name',
  'timezone',
  'do_not_contact',
  'deleted_at',
  'merged_into_id',
  'created_at',
  'updated_at',
] as const;

/**
 * The contact, locked for a change, or not found. FOR NO KEY UPDATE, as lockLiveContact
 * (details.ts) explains: it leaves foreign keys to the contact free.
 */
export async function lockContact(
  trx: DatabaseTransaction,
  businessId: string,
  id: string,
): Promise<Pick<Selectable<DB['crm.contacts']>, (typeof contactColumns)[number]>> {
  const row = await trx
    .selectFrom('crm.contacts')
    .select(contactColumns)
    .where('business_id', '=', businessId)
    .where('id', '=', uuidOf(id))
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (row === undefined) throw notFound(id);
  return row;
}

/**
 * Holds these contacts (stored ids) FOR NO KEY UPDATE, in id order: the order every writer
 * of more than one contact in one transaction takes them in (a merge, a bulk action's
 * batch, an import's batch), so two of them never wait for each other in opposite orders.
 * Ids of no contact of the business are passed over. Each writer reads its contact again
 * once it holds it.
 */
export async function lockContactsInOrder(
  trx: DatabaseTransaction,
  businessId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  // Sorted, then locked in that order (the lock is taken above the sort).
  await sql`
    select id from crm.contacts
    where business_id = ${businessId} and id = any (${sql.val([...new Set(ids)])}::uuid[])
    order by id
    for no key update
  `.execute(trx);
}

/** The contact's identities of each kind: the primary first, then in the order added. */
async function storedIdentities(
  trx: DatabaseTransaction,
  businessId: string,
  contactId: string,
): Promise<Record<IdentityKind, string[]>> {
  const rows = await trx
    .selectFrom('crm.contact_identities')
    .select(['kind', 'value_normalized'])
    .where('business_id', '=', businessId)
    .where('contact_id', '=', contactId)
    .where('kind', 'in', ['email', 'phone'])
    .orderBy('is_primary', 'desc')
    .orderBy('id')
    .execute();
  const of = (kind: IdentityKind) =>
    rows.filter((row) => row.kind === kind).map((row) => row.value_normalized);
  return { email: of('email'), phone: of('phone') };
}

/** What a contact is beside its names and addresses, as the API shows it. */
interface ContactAttributes {
  readonly dateOfBirth: string | null;
  readonly source: string | null;
  readonly type: ContactType | null;
}

/**
 * The contact's date of birth, source and type. The date is read as text: it is a calendar
 * day, and must not pass through a moment in some time zone on its way out.
 */
async function storedAttributes(
  trx: DatabaseTransaction,
  businessId: string,
  contactId: string,
): Promise<ContactAttributes> {
  const row = await trx
    .selectFrom('crm.contacts')
    .select(['source', 'contact_type'])
    .select(sql<string | null>`date_of_birth::text`.as('born'))
    .where('business_id', '=', businessId)
    .where('id', '=', contactId)
    .executeTakeFirstOrThrow();
  return {
    dateOfBirth: row.born,
    source: row.source,
    type: contactTypes.find((type) => type === row.contact_type) ?? null,
  };
}

/** Refuses a date of birth after today. A day's slack covers every time zone's today. */
function requireBorn(dateOfBirth: string | null | undefined): void {
  if (dateOfBirth === null || dateOfBirth === undefined) return;
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  if (dateOfBirth > tomorrow)
    throw new ValidationError([
      {
        path: '/dateOfBirth',
        code: 'in_future',
        message: 'A date of birth cannot be in the future.',
      },
    ]);
}

/** A contact of the transaction's business, as the API shows it, or not found. */
export async function readContact(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
): Promise<Contact> {
  const businessId = requireBusiness(invocation.context);
  const row = await trx
    .selectFrom('crm.contacts')
    .select(contactColumns)
    .where('business_id', '=', businessId)
    .where('id', '=', uuidOf(id))
    .executeTakeFirst();
  if (row === undefined) throw notFound(id);
  if (row.merged_into_id !== null) throw mergedAway(id, row.merged_into_id);
  const identities = await storedIdentities(trx, businessId, row.id);
  const country = await countryOf(trx, businessId);
  const attributes = await storedAttributes(trx, businessId, row.id);
  return {
    id: toPublicId('contact', row.id),
    firstName: row.first_name,
    lastName: row.last_name,
    name: row.display_name,
    emails: identities.email,
    phones: identities.phone.map((number) => asContactPhone(number, country)),
    ...preferencesOf(row),
    ...attributes,
    trashedAt: row.deleted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    canManage: invocation.permissions === 'all' || invocation.permissions.has('contacts.manage'),
  };
}

function refuse(issues: readonly Issue[]): void {
  const [first, ...rest] = issues;
  if (first !== undefined) throw new ValidationError([first, ...rest]);
}

/**
 * How a contact comes to be when whoever makes it doesn't say: by the kind of actor. The
 * system and a contact acting for themselves make contacts in several ways (mail, a text
 * message, a web chat, a booking), so those callers say which (createContact's `source`).
 */
const sourceOfActor: Readonly<Record<ActorKind, ContactSource>> = {
  user: 'user',
  api_key: 'api',
  form: 'form',
  import: 'import',
  automation: 'automation',
  ai_agent: 'assistant',
  system: 'unknown',
  contact: 'unknown',
};

/**
 * Makes a contact: the canonical command's handler. `source` is for the modules that make
 * one for the system or for the contact themselves, to say how it came to be; the API's
 * own callers never choose it.
 */
export async function createContact(
  trx: DatabaseTransaction,
  input: z.output<typeof createContactInput>,
  command: CommandContext,
  source?: ContactSource,
): Promise<Contact> {
  const businessId = requireBusiness(command.context);
  const { emails = [], phones = [] } = identitiesOf(input, await countryOf(trx, businessId));
  requireBorn(input.dateOfBirth);
  // The Add Contact panel's own fields: checked before anything is written, and written
  // with the contact, so a contact is made whole or not at all.
  const timeZone =
    input.timeZone === undefined || input.timeZone === null
      ? null
      : await resolveTimeZone(trx, input.timeZone);
  const dndChannels = dndChannelsOf(input.dnd?.channels ?? []);
  const objectType = await trx
    .selectFrom('crm.object_types')
    .select('id')
    .where('business_id', '=', businessId)
    .where('kind', '=', 'contact')
    .executeTakeFirstOrThrow();
  const createdSource = source ?? sourceOfActor[command.context.actorKind];
  const { id } = await trx
    .insertInto('crm.records')
    .values({ business_id: businessId, kind: 'contact', object_type_id: objectType.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('crm.contacts')
    .values({
      business_id: businessId,
      id,
      first_name: nameOf(input.firstName),
      last_name: nameOf(input.lastName),
      created_by_kind: command.context.actorKind,
      created_by_id: command.context.actorId ?? null,
      created_source: createdSource,
      date_of_birth: input.dateOfBirth ?? null,
      source: input.source ?? null,
      contact_type: input.type ?? null,
      timezone: timeZone,
      do_not_contact: input.dnd?.all ?? false,
      dnd_channels: dndChannels,
    })
    .execute();
  // Every contact has a first touch: how it came to be. A form, a booking or a chat that
  // made it fills the touch in with its visit (attribution/touches.ts).
  await recordCreationTouch(trx, businessId, id, createdSource);
  refuse([
    ...(await claim(trx, businessId, id, emails, true)),
    ...(await claim(trx, businessId, id, phones, true)),
  ]);
  for (const [index, label] of (input.phoneLabels ?? []).entries()) {
    const phone = phones[index];
    if (label === null || phone === undefined) continue;
    await trx
      .updateTable('crm.contact_identities')
      .set({ label })
      .where('business_id', '=', businessId)
      .where('contact_id', '=', id)
      .where('kind', '=', 'phone')
      .where('value_normalized', '=', phone.normalized)
      .execute();
  }
  await command.emit({
    type: 'contact.created',
    subject: { kind: 'contact', id },
    records: [id],
  });
  // Its custom field values, in this same change: whatever the creation starts reads them.
  await writeCreatedFields(trx, command, { id, objectTypeId: objectType.id }, input.fields);
  // The same events a later change writes, so a timeline and an automation see do not
  // disturb however it came to be.
  if (input.dnd?.all === true)
    await command.emit({
      type: 'contact.do_not_contact_set',
      subject: { kind: 'contact', id },
      records: [id],
    });
  if (dndChannels.length > 0)
    await command.emit({
      type: 'contact.dnd_changed',
      subject: { kind: 'contact', id },
      records: [id],
      payload: {
        channels: dndChannels,
        enabled: dndChannels,
        disabled: [],
        // The same save turned do not contact on (dnd.ts says why it is named).
        ...(input.dnd?.all === true ? { doNotContact: 'set' } : {}),
      },
    });
  return readContact(trx, command, toPublicId('contact', id));
}

export const createContactCommand = defineCommand({
  name: 'contact.create',
  permission: 'contacts.manage',
  input: createContactInput,
  handle: (trx, input, command): Promise<Contact> => createContact(trx, input, command),
});

const sameList = (stored: readonly string[], given: readonly Identity[] | undefined) =>
  given === undefined ||
  (stored.length === given.length &&
    stored[0] === given[0]?.normalized &&
    given.every((identity) => stored.includes(identity.normalized)));

export const updateContactCommand = defineCommand({
  name: 'contact.update',
  permission: 'contacts.manage',
  input: updateContactCommandInput,
  async handle(trx, input, command): Promise<Contact> {
    const businessId = requireBusiness(command.context);
    const row = await lockContact(trx, businessId, input.id);
    if (row.deleted_at !== null)
      throw new ConflictError('Restore the contact from the trash before changing it.');
    // The time zone and do not contact: checked against their revision, written, and do
    // not contact reported, in contact-settings.ts. What comes back goes into the event.
    const preferenceFields = await changeContactPreferences(trx, command, businessId, row, input);
    const given = identitiesOf(input, await countryOf(trx, businessId));
    const stored = await storedIdentities(trx, businessId, row.id);
    const firstName = input.firstName === undefined ? row.first_name : nameOf(input.firstName);
    const lastName = input.lastName === undefined ? row.last_name : nameOf(input.lastName);
    requireBorn(input.dateOfBirth);
    const attributes = await storedAttributes(trx, businessId, row.id);
    const dateOfBirth =
      input.dateOfBirth === undefined ? attributes.dateOfBirth : input.dateOfBirth;
    const source = input.source === undefined ? attributes.source : input.source;
    const type = input.type === undefined ? attributes.type : input.type;
    const changed = [
      ...(firstName === row.first_name ? [] : ['firstName']),
      ...(lastName === row.last_name ? [] : ['lastName']),
      ...(dateOfBirth === attributes.dateOfBirth ? [] : ['dateOfBirth']),
      ...(source === attributes.source ? [] : ['source']),
      ...(type === attributes.type ? [] : ['type']),
      ...(sameList(stored.email, given.emails) ? [] : ['emails']),
      ...(sameList(stored.phone, given.phones) ? [] : ['phones']),
      ...preferenceFields,
    ];
    if (changed.length === 0) return readContact(trx, command, input.id);
    const emailCount = given.emails?.length ?? stored.email.length;
    const phoneCount = given.phones?.length ?? stored.phone.length;
    if (firstName === null && lastName === null && emailCount === 0 && phoneCount === 0)
      throw nothingToKnowItBy();
    // Also marks it changed when only its identities do.
    await trx
      .updateTable('crm.contacts')
      .set({
        first_name: firstName,
        last_name: lastName,
        date_of_birth: dateOfBirth,
        source,
        contact_type: type,
      })
      .where('business_id', '=', businessId)
      .where('id', '=', row.id)
      .execute();
    refuse([
      ...(changed.includes('emails') && given.emails !== undefined
        ? await replaceIdentities(trx, businessId, row.id, 'email', given.emails)
        : []),
      ...(changed.includes('phones') && given.phones !== undefined
        ? await replaceIdentities(trx, businessId, row.id, 'phone', given.phones)
        : []),
    ]);
    // Which fields changed, not their values: events can't be erased.
    await command.emit({
      type: 'contact.updated',
      subject: { kind: 'contact', id: row.id },
      payload: { changed },
      records: [row.id],
    });
    return readContact(trx, command, input.id);
  },
});

/** Moves the contact into or out of the trash, if it isn't there already, and says so. */
async function setTrashed(
  trx: DatabaseTransaction,
  id: string,
  command: CommandContext,
  trashed: boolean,
): Promise<Contact> {
  const businessId = requireBusiness(command.context);
  const row = await lockContact(trx, businessId, id);
  // A merge cannot be undone: the contact merged away stays in the trash.
  if (!trashed && row.merged_into_id !== null)
    throw new ConflictError(
      `This contact was merged into ${toPublicId('contact', row.merged_into_id)}. A merge cannot be undone, so it cannot be restored.`,
    );
  if ((row.deleted_at !== null) !== trashed) {
    await trx
      .updateTable('crm.contacts')
      .set({ deleted_at: trashed ? sql<Date>`now()` : null })
      .where('business_id', '=', businessId)
      .where('id', '=', row.id)
      .execute();
    await command.emit({
      type: trashed ? 'contact.trashed' : 'contact.restored',
      subject: { kind: 'contact', id: row.id },
      records: [row.id],
    });
  }
  return readContact(trx, command, id);
}

export const trashContactCommand = defineCommand({
  name: 'contact.trash',
  permission: 'contacts.manage',
  input: contactIdInput,
  handle: (trx, input, command) => setTrashed(trx, input.id, command, true),
});

export const restoreContactCommand = defineCommand({
  name: 'contact.restore',
  permission: 'contacts.manage',
  input: contactIdInput,
  handle: (trx, input, command) => setTrashed(trx, input.id, command, false),
});
