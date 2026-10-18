// Contact contracts are needed only when someone searches the automation history.
import { listContacts, type ContactList } from '@repo/contracts';
import { apiIn } from './api';

export function searchContacts(businessId: string, q: string): Promise<ContactList> {
  return apiIn(businessId).request(listContacts, { query: { q } });
}
