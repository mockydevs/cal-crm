// Forms' part in a contact merge: a contact's submissions move to the contact kept, as
// GoHighLevel shows a merged contact's form submissions on the master.
import { contactRowsParticipant } from '@repo/module-crm';

export const formsContactMerge = contactRowsParticipant('forms', {
  submissions: { table: 'forms.submissions', column: 'contact_id' },
  // External Tracking: forms sent on the business's other websites, the page views a form
  // linked to the contact, and the visitor ids known to be the contact.
  externalSubmissions: { table: 'forms.external_submissions', column: 'contact_id' },
  trackingEvents: { table: 'forms.tracking_events', column: 'contact_id' },
  trackingVisitors: { table: 'forms.tracking_visitors', column: 'contact_id' },
});
