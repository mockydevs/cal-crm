// What a contact is called, in a module of its own: the contacts list names the contact it
// has just added, and should not bring the contact form (contacts.tsx) with it to do so.
import type { Contact } from '@repo/contracts';

/** What a contact is called: its name, else its first email address or phone number. */
export function contactTitle(contact: Contact): string | undefined {
  return contact.name ?? contact.emails[0] ?? contact.phones[0]?.display;
}
