/**
 * What verification says of a contact's address in one word, as the contact list's column
 * and filter and a workflow's If / else read it: a check's status, `unchecked` before any
 * check, or `excluded` for an address left out of verification, whatever it found before.
 * A module of its own, so a page that reads contacts carries only these six words.
 */
export const contactEmailVerifications = [
  'valid',
  'risky',
  'invalid',
  'unknown',
  'unchecked',
  'excluded',
] as const;
export type ContactEmailVerification = (typeof contactEmailVerifications)[number];
