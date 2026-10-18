// The contact contracts are needed only once someone types in the list's search, so they
// are fetched then and stay out of the Inbox's own code.
import { listContacts, type ContactList } from '@repo/contracts';
import { apiIn } from './api';

/** The first few contacts that match what was typed. */
export function searchContacts(businessId: string, q: string): Promise<ContactList> {
  return apiIn(businessId).request(listContacts, { query: { q, limit: 6 } });
}
