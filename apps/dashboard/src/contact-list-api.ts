// The endpoints that read the contact list and count it, in a module of their own so the
// list asks for them when it reads (contact-pages.ts): the contact contract brings schemas
// a list's page starts without.
export { countContacts, listContacts } from '@repo/contracts';
