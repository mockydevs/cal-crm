// The contact list's `filter` query parameter: a ContactFilter as JSON text. A module of its
// own, so a page that only lists contacts (a contact picker) carries this one string schema
// and not the whole filter (contact-filters.ts), which the server reads the text with.
import * as z from 'zod';

/** The longest `filter` parameter, in characters. */
export const MAX_CONTACT_FILTER_LENGTH = 8000;

/** The `filter` query parameter: a ContactFilter as JSON text. */
export const contactFilterParameter = z
  .string()
  .max(MAX_CONTACT_FILTER_LENGTH, {
    error: `Use at most ${String(MAX_CONTACT_FILTER_LENGTH)} characters.`,
  })
  .optional()
  .meta({
    description:
      'Conditions on contacts, as JSON text of a ContactFilter: {"match":"all","groups":[{"match":"any","conditions":[{"field":"tags","operator":"any_of","values":["tag_…"]}]}]}.',
    examples: [
      '{"match":"all","groups":[{"match":"all","conditions":[{"field":"created","operator":"in_last","days":30}]}]}',
    ],
  });
