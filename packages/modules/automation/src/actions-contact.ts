// contact.update for the contact's built-in fields: its names, and its primary email
// address and phone number, changed through the CRM's own contact command, so the same
// checks and the same contact.updated event apply as when a person edits the contact.
import type { CommandContext } from '@repo/commands';
import { parseInput, updateContactCommandInput } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ValidationError, type Issue } from '@repo/kernel';
import { readContact, updateContactCommand } from '@repo/module-crm';
import { sql } from 'kysely';

import { runActionCommand } from './actions-command.js';

export type FieldValue = string | number | boolean | null;

/** The change to a contact that its built-in fields in a step's config ask for. */
export interface ContactChanges {
  firstName?: string | null;
  lastName?: string | null;
  emails?: string[];
  phones?: string[];
}

const refuse = (path: string, code: string, message: string): ValidationError =>
  new ValidationError([{ path: `/config/fields/${path}`, code, message }]);

/**
 * What the contact command should be given for these fields, by path. An email address or
 * phone number becomes the contact's primary one, and the others it has are kept after it:
 * a step sets one value, so it never removes the rest. Refuses a field or value that can't
 * be written this way.
 */
export function contactChanges(
  fields: Readonly<Record<string, FieldValue>>,
  current: { readonly emails: readonly string[]; readonly phones: readonly string[] },
): ContactChanges {
  const changes: ContactChanges = {};
  for (const [path, value] of Object.entries(fields)) {
    if (typeof value !== 'string' && value !== null)
      throw refuse(path, 'invalid_value', `${path} takes text.`);
    if (path === 'contact.firstName' || path === 'contact.lastName') {
      changes[path === 'contact.firstName' ? 'firstName' : 'lastName'] = value;
    } else if (path === 'contact.email' || path === 'contact.phone') {
      // Emptying it would have to pick which of several addresses to drop, so it's refused.
      if (value === null || value.trim() === '')
        throw refuse(path, 'unsupported_value', `${path} can be set, but not emptied.`);
      if (path === 'contact.email') {
        // Stored addresses are trimmed and lowercased, as the contact command makes them.
        const address = value.trim().toLowerCase();
        changes.emails = [address, ...current.emails.filter((each) => each !== address)];
      } else {
        const phone = value.trim();
        changes.phones = [phone, ...current.phones.filter((each) => each !== phone)];
      }
    } else throw refuse(path, 'unsupported_field', `${path} can't be set by an automation.`);
  }
  return changes;
}

/**
 * The phone numbers without the ones the contact command found written twice, or nothing
 * when that isn't all it refused. The first, the step's own number, is always kept.
 */
export function withoutRepeatedPhones(
  phones: readonly string[],
  issues: readonly Issue[],
): string[] | undefined {
  const repeated = new Set<number>();
  for (const issue of issues) {
    const index = /^\/phones\/([1-9]\d*)$/.exec(issue.path)?.[1];
    if (issue.code !== 'repeated' || index === undefined) return undefined;
    repeated.add(Number(index));
  }
  return phones.filter((_, index) => !repeated.has(index));
}

/** Changes the contact's built-in fields named in the step. Custom fields go their own way. */
export async function updateContactFields(
  trx: DatabaseTransaction,
  command: CommandContext,
  id: string,
  fields: Readonly<Record<string, FieldValue>>,
): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  const current = await readContact(trx, command, id);
  const changes = contactChanges(fields, {
    emails: current.emails,
    phones: current.phones.map((phone) => phone.number),
  });
  const update = (given: ContactChanges) =>
    runActionCommand(
      command,
      updateContactCommand,
      parseInput(updateContactCommandInput, { id, ...given }),
    );
  await sql`savepoint automation_contact`.execute(trx);
  try {
    await update(changes);
  } catch (error) {
    // The step's number may be one the contact already has, written another way: only the
    // CRM can tell, and it says which entries repeat. Those go, and the change is made.
    const phones =
      error instanceof ValidationError && changes.phones !== undefined
        ? withoutRepeatedPhones(changes.phones, error.issues)
        : undefined;
    if (phones === undefined) throw error;
    // Nothing of the refused try is kept before the second one.
    await sql`rollback to savepoint automation_contact`.execute(trx);
    await update({ ...changes, phones });
  }
  await sql`release savepoint automation_contact`.execute(trx);
}
