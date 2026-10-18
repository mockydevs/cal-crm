// The endpoint that lists field folders, in a module of its own so the contact list can ask
// for it when it reads them (field-column-choices.ts): the field folder contract stays out of
// what the list's page loads first.
export { listFieldFolders } from '@repo/contracts';
