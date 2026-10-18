// The door for contact details nobody has verified: a public form, a booking page. They
// find or make a contact by these rules:
// - the details find a contact in the order of the business's deduplication preferences
//   (duplicate-settings.ts): by default by email address first, and by phone number only
//   when no email address was given; never by a fictional number or one of the business's
//   own;
// - a contact found keeps every name, email address, phone number and date of birth it
//   has. A detail it lacks is filled in; any other is not applied, and goes into a note on
//   the contact for the team to accept by hand;
// - an email address or phone number is never added to a contact that was found, since
//   messages are matched and sent on them: a stranger's number on someone else's contact
//   would receive that person's messages;
// - a contact in the trash that the details find is restored, with its history, opt-outs
//   included, rather than leaving the lead without a contact;
// - details that also name a second contact never stop the lead: the contact the order
//   finds first takes it, and the note says which address belongs to whom.
import type { CommandContext } from '@repo/commands';
import { requireBusiness } from '@repo/commands';
import {
  createContactInput,
  parseInput,
  type Contact,
  type ContactSource,
  type CreateContactInput,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import type * as z from 'zod';

import {
  countryOf,
  createContact,
  identitiesOf,
  readContact,
  restoreContactCommand,
  updateContactCommand,
} from './contacts.js';
import { matchFields, readMatchSettings, type MatchSettings } from './duplicate-settings.js';
import { writeIntakeReview, type IntakeVia } from './intake-review.js';
import { isMatchablePhone } from './phones.js';

export interface ContactIntakeResult {
  readonly contactId: string;
  readonly emailIdentityId: string | null;
  /** Whether this intake made the contact, rather than finding one that held its details. */
  readonly created: boolean;
  /** Whether the contact it found was in the trash, and this intake restored it. */
  readonly restored: boolean;
  /** The email addresses and phone numbers given (normalized) that the contact holds. */
  readonly addresses: readonly string[];
  /**
   * What was given and not applied, in words for the team: written as a note on the
   * contact, or handed back when the caller asked to write it with its own (`deferReview`).
   */
  readonly review: readonly string[];
}

export interface ContactIntakeOptions {
  /** The business's own numbers beside its profile's (its SMS lines): never a match key. */
  readonly ownPhones?: readonly string[];
  /** Hand the review back instead of writing it: the caller adds its own lines and writes. */
  readonly deferReview?: boolean;
}

type ParsedInput = z.output<typeof createContactInput>;

interface Holder {
  readonly kind: string;
  readonly value: string;
  readonly contactId: string;
  readonly name: string | null;
  readonly trashed: boolean;
}

/** Who holds each of the given addresses, in the trash or not. */
async function holdersOf(
  trx: DatabaseTransaction,
  businessId: string,
  emails: readonly string[],
  phones: readonly string[],
): Promise<Holder[]> {
  const wanted = [
    ...emails.map((value) => ({ kind: 'email', value })),
    ...phones.map((value) => ({ kind: 'phone', value })),
  ];
  if (wanted.length === 0) return [];
  const rows = await trx
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
    .where((eb) =>
      eb.or(
        wanted.map((each) =>
          eb.and([
            eb('identity.kind', '=', each.kind),
            eb('identity.value_normalized', '=', each.value),
          ]),
        ),
      ),
    )
    .execute();
  return rows.map((row) => ({
    kind: row.kind,
    value: row.value_normalized,
    contactId: row.id,
    name: row.display_name,
    trashed: row.deleted_at !== null,
  }));
}

/**
 * The contact the details find, in the business's order (matchFields): by default by email
 * first, and by phone only when no email was given. A number that can't be matched on is
 * not given, as far as the order goes.
 */
function chosen(
  holders: readonly Holder[],
  emails: readonly string[],
  phones: readonly string[],
  own: ReadonlySet<string>,
  settings: MatchSettings,
): Holder | undefined {
  const matchable = {
    email: emails,
    phone: phones.filter((phone) => isMatchablePhone(phone, own)),
  };
  const order = matchFields(settings, {
    email: matchable.email.length > 0,
    phone: matchable.phone.length > 0,
  });
  for (const kind of order)
    for (const value of matchable[kind]) {
      const holder = holders.find((each) => each.kind === kind && each.value === value);
      if (holder !== undefined) return holder;
    }
  return undefined;
}

/** The business's own numbers: its profile's and the ones its caller names. */
async function ownNumbers(
  trx: DatabaseTransaction,
  businessId: string,
  given: readonly string[],
): Promise<ReadonlySet<string>> {
  const business = await trx
    .selectFrom('tenancy.businesses')
    .select('phone_e164')
    .where('id', '=', businessId)
    .executeTakeFirst();
  const profile = business?.phone_e164 ?? null;
  return new Set([...given, ...(profile === null ? [] : [profile])]);
}

const same = (left: string, right: string) =>
  left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

/** A name given that is not blank, or nothing. */
const given = (name: string | null | undefined): string | undefined =>
  name === null || name === undefined || name.trim() === '' ? undefined : name;

const quoted = (text: string) => `"${text}"`;

/** Who sent the details, as the review note names them. */
export function intakeVia(command: CommandContext, source?: ContactSource): IntakeVia {
  if (source === 'booking') return 'booking';
  return command.context.actorKind === 'form' ? 'form' : 'public';
}

/** Says, for the note, what became of each address given that the contact does not hold. */
function addressLines(
  holders: readonly Holder[],
  contactId: string | undefined,
  emails: readonly string[],
  phones: readonly string[],
  own: ReadonlySet<string>,
): string[] {
  const lineOf = (kind: 'email' | 'phone', value: string): string | undefined => {
    const what = kind === 'email' ? 'The email address' : 'The phone number';
    if (kind === 'phone' && own.has(value))
      return `${what} ${value} is this business's own number. It was not added.`;
    const holder = holders.find((each) => each.kind === kind && each.value === value);
    if (holder?.contactId === contactId) return undefined;
    if (holder !== undefined)
      return `${what} ${value} belongs to another contact${
        holder.name === null ? '' : `, ${holder.name}`
      }${holder.trashed ? ' (in the trash)' : ''}. It was not added; they may be the same person.`;
    return contactId === undefined ? undefined : `${what} ${value} was given. It was not added.`;
  };
  return [
    ...emails.map((value) => lineOf('email', value)),
    ...phones.map((value) => lineOf('phone', value)),
  ].filter((line) => line !== undefined);
}

const RETRY = Symbol('retry');

interface Attempt {
  readonly trx: DatabaseTransaction;
  readonly command: CommandContext;
  readonly businessId: string;
  readonly parsed: ParsedInput;
  readonly emails: readonly string[];
  readonly phones: readonly string[];
  readonly own: ReadonlySet<string>;
  readonly source: ContactSource | undefined;
  readonly settings: MatchSettings;
}

/** Makes a contact of the addresses nobody else holds. Another claim meanwhile: try again. */
async function createFrom(
  attempt: Attempt,
  holders: readonly Holder[],
): Promise<Contact | typeof RETRY> {
  const { trx, parsed, emails, phones, own } = attempt;
  const free = (kind: string, value: string) =>
    !holders.some((holder) => holder.kind === kind && holder.value === value);
  const keptPhones = phones.filter((phone) => !own.has(phone) && free('phone', phone));
  const { phoneLabels, ...rest } = parsed;
  const input: ParsedInput = {
    ...rest,
    emails: emails.filter((email) => free('email', email)),
    phones: keptPhones,
    // Labels go by position: they stay only when every number does.
    ...(phoneLabels === undefined || keptPhones.length !== phones.length ? {} : { phoneLabels }),
  };
  await sql`savepoint contact_intake_create`.execute(trx);
  try {
    const contact = await createContact(trx, input, attempt.command, attempt.source);
    await sql`release savepoint contact_intake_create`.execute(trx);
    return contact;
  } catch (error) {
    await sql`rollback to savepoint contact_intake_create`.execute(trx);
    await sql`release savepoint contact_intake_create`.execute(trx);
    // A concurrent claim waited on the unique index and won: find its holder next time.
    if (error instanceof ValidationError && error.issues.every((issue) => issue.code === 'taken'))
      return RETRY;
    throw error;
  }
}

/**
 * Applies what the found contact lacks, and says what it has otherwise. Restores it from
 * the trash first, if it is there.
 */
async function fillFound(
  attempt: Attempt,
  holder: Holder,
): Promise<{ contact: Contact; restored: boolean; lines: string[] } | typeof RETRY> {
  const { trx, command, businessId, parsed } = attempt;
  const locked = await trx
    .selectFrom('crm.contacts')
    .select(['id', 'deleted_at'])
    .where('business_id', '=', businessId)
    .where('id', '=', holder.contactId)
    // Leaves foreign keys to the contact free, as lockLiveContact (details.ts) explains.
    .forNoKeyUpdate()
    .executeTakeFirst();
  // Purged, or its addresses moved, while this waited for it: look again.
  if (locked === undefined) return RETRY;
  const again = chosen(
    await holdersOf(trx, businessId, attempt.emails, attempt.phones),
    attempt.emails,
    attempt.phones,
    attempt.own,
    attempt.settings,
  );
  if (again?.contactId !== holder.contactId) return RETRY;
  const id = toPublicId('contact', holder.contactId);
  const lines: string[] = [];
  const restored = locked.deleted_at !== null;
  if (restored) {
    await restoreContactCommand.handle(trx, { id }, command);
    lines.push('This contact was in the trash. It was restored because these details matched it.');
  }
  const saved = await readContact(trx, command, id);
  const changes: Record<string, string> = {};
  const compare = (
    key: 'firstName' | 'lastName' | 'dateOfBirth',
    label: string,
    held: string | null,
    sent: string | undefined,
  ) => {
    if (sent === undefined) return;
    if (held === null) changes[key] = sent;
    else if (!same(held, sent))
      lines.push(`${label} given: ${quoted(sent)} (the contact has ${quoted(held)}).`);
  };
  compare('firstName', 'First name', saved.firstName, given(parsed.firstName));
  compare('lastName', 'Last name', saved.lastName, given(parsed.lastName));
  compare(
    'dateOfBirth',
    'Date of birth',
    saved.dateOfBirth ?? null,
    parsed.dateOfBirth ?? undefined,
  );
  // Where a contact came from is said once: one that has a source keeps it.
  const source = parsed.source ?? undefined;
  if (source !== undefined && (saved.source ?? null) === null) changes['source'] = source;
  if (Object.keys(changes).length === 0) return { contact: saved, restored, lines };
  const contact = await updateContactCommand.handle(
    trx,
    parseInput(updateContactCommand.input, { id, ...changes }),
    command,
  );
  return { contact, restored, lines };
}

/**
 * Finds or makes the contact for details nobody has verified (the rules at the top).
 * `source` says how a contact this makes came to be, where the actor's kind doesn't: a
 * booking acts as the contact, as a web chat does. No stored contact data returns to the
 * caller beyond the contact's id and which of the given addresses it holds.
 */
export async function intakeContact(
  trx: DatabaseTransaction,
  input: CreateContactInput,
  command: CommandContext,
  source?: ContactSource,
  options: ContactIntakeOptions = {},
): Promise<ContactIntakeResult> {
  const parsed = parseInput(createContactInput, input);
  const businessId = requireBusiness(command.context);
  const normalized = identitiesOf(parsed, await countryOf(trx, businessId));
  const attempt: Attempt = {
    trx,
    command,
    businessId,
    parsed,
    emails: parsed.emails,
    phones: (normalized.phones ?? []).map((phone) => phone.normalized),
    own: await ownNumbers(trx, businessId, options.ownPhones ?? []),
    source,
    settings: await readMatchSettings(trx, businessId),
  };
  // Twice is enough: a retry follows a commit that settled who holds the addresses.
  for (let tries = 0; tries < 3; tries++) {
    const holders = await holdersOf(trx, businessId, attempt.emails, attempt.phones);
    const holder = chosen(holders, attempt.emails, attempt.phones, attempt.own, attempt.settings);
    const found = holder === undefined ? await createFrom(attempt, holders) : undefined;
    if (found === RETRY) continue;
    const filled = holder === undefined ? undefined : await fillFound(attempt, holder);
    if (filled === RETRY) continue;
    const contact = found ?? filled?.contact;
    if (contact === undefined) throw new TypeError('An intake ends with a contact.');
    const contactId = parsePublicId('contact', contact.id);
    if (contactId === undefined) throw new Error('Canonical contact has no permanent ID.');
    const review = [
      ...(filled?.lines ?? []),
      ...addressLines(
        holders,
        holder === undefined ? undefined : contactId,
        attempt.emails,
        attempt.phones,
        attempt.own,
      ),
    ];
    if (options.deferReview !== true)
      await writeIntakeReview(trx, command, contactId, review, intakeVia(command, source));
    const addresses = [...contact.emails, ...contact.phones.map((phone) => phone.number)].filter(
      (address) => attempt.emails.includes(address) || attempt.phones.includes(address),
    );
    return {
      contactId,
      emailIdentityId: await emailIdentityOf(trx, businessId, contactId, attempt.emails),
      created: found !== undefined,
      restored: filled?.restored ?? false,
      addresses,
      review,
    };
  }
  throw new ConflictError('Contact details changed at the same time. Try again.');
}

/** The identity of the first email address given, when the contact holds it. */
async function emailIdentityOf(
  trx: DatabaseTransaction,
  businessId: string,
  contactId: string,
  emails: readonly string[],
): Promise<string | null> {
  const first = emails[0];
  if (first === undefined) return null;
  const identity = await trx
    .selectFrom('crm.contact_identities')
    .select('id')
    .where('business_id', '=', businessId)
    .where('contact_id', '=', contactId)
    .where('kind', '=', 'email')
    .where('value_normalized', '=', first)
    .executeTakeFirst();
  return identity?.id ?? null;
}
