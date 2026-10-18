// The contact list's page size, the count the server stops at, and what a row may also
// carry: the contract's (packages/contracts/src/contacts.ts), written again here so the
// list's page does not bring the contact schemas with it. The types refuse an extra that is
// not the contract's, and contact-list-sizes.test.ts holds every value equal.
import type { contactListExtras as contractExtras } from '@repo/contracts';

/** How many contacts a page of the list holds. */
export const CONTACT_PAGE_SIZE = 50;

/** The count the server stops at when a search or a filter narrows the list. */
export const CONTACT_COUNT_LIMIT = 10_000;

type Extra = (typeof contractExtras)[number];

/** What a row may also carry, each read only when its column shows: the server's include. */
export const contactListExtras = [
  'lastActivity',
  'tags',
  'company',
  'emailVerification',
] as const satisfies readonly Extra[];
