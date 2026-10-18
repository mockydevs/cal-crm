// Commerce's part in a contact merge: a contact's estimates, invoices and receipts move to
// the contact kept, as GoHighLevel's payments default to the master. Payments hang off the
// documents, and a document keeps its number, so nothing else changes.
import { contactRowsParticipant } from '@repo/module-crm';

export const commerceContactMerge = contactRowsParticipant('commerce', {
  documents: { table: 'commerce.documents', column: 'contact_id' },
});
