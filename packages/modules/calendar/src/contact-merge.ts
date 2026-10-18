// Calendar's part in a contact merge: a contact's appointments move to the contact kept, as
// GoHighLevel keeps them on the master. Booking requests are keyed by calendar and Google's
// copies by appointment, so nothing clashes, and nothing about the time changes: no invite
// is sent again and the calendar sync is not asked to run.
import { contactRowsParticipant } from '@repo/module-crm';

export const calendarContactMerge = contactRowsParticipant('calendar', {
  appointments: { table: 'calendar.appointments', column: 'contact_id' },
});
