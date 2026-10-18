// The appointment a run is about, as the fields a message can insert (contracts
// automationAppointmentFields): filled in when the workflow starts from an appointment, or
// waits for one. Only the lazy "Insert a field" lists read this, so the builder's first
// chunk does not carry it.
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { automationAppointmentFields } from '@repo/contracts';
import type { FieldChoice } from './automation-record-rules';

const labels: Readonly<Record<keyof typeof automationAppointmentFields, MessageDescriptor>> = {
  title: msg`Appointment title`,
  startTime: msg`Appointment time (in words)`,
  startsAt: msg`Appointment start (date and time)`,
  calendar: msg`Calendar name`,
  location: msg`Appointment location`,
  status: msg`Appointment status`,
  manageUrl: msg`Reschedule or cancel link`,
};

/** The appointment's fields under their own heading, in the order the contract lists them. */
export function appointmentMergeFields(): FieldChoice[] {
  const heading = i18n._(msg`Appointment`);
  return Object.entries(automationAppointmentFields).map(([key, type]) => ({
    path: `appointment.${key}`,
    label: i18n._(labels[key as keyof typeof automationAppointmentFields]),
    type,
    options: [],
    // Listed under a heading of its own, as a form's answers are.
    group: 'submission',
    heading,
  }));
}
