// The names Settings → Calendars shows for what the contract keeps as keys: a calendar's
// type with the sentence and example the chooser gives it, the editor's sections with their
// tips, the units and the kinds of meeting location. The four first types' sentences are
// GoHighLevel's, from the owner's screenshot; "Service booking" and "Event" were not in it,
// so theirs are ours.
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { CalendarKind } from '@repo/contracts';
import type { LocationKind, Section, Unit } from './calendar-settings-rules';

export const kindNames: Readonly<Record<CalendarKind, MessageDescriptor>> = {
  personal: msg`Personal booking`,
  round_robin: msg`Round robin`,
  class: msg`Class booking`,
  collective: msg`Collective booking`,
  service: msg`Service booking`,
  event: msg`Event`,
};

export const kindCards: Readonly<
  Record<CalendarKind, { readonly text: MessageDescriptor; readonly example: MessageDescriptor }>
> = {
  personal: {
    text: msg`Schedules one-on-one meetings with a specific team member.`,
    example: msg`E.g.: Client meetings, private consultations.`,
  },
  round_robin: {
    text: msg`Distributes appointments among team members in a rotating order.`,
    example: msg`E.g.: Sales calls, onboarding sessions.`,
  },
  class: {
    text: msg`One host meets with multiple participants.`,
    example: msg`E.g.: Webinars, group training, online classes.`,
  },
  collective: {
    text: msg`Multiple hosts meet with one participant.`,
    example: msg`E.g.: Panel interviews, committee reviews.`,
  },
  service: {
    text: msg`Offers services that customers choose from, each with its own length.`,
    example: msg`E.g.: Haircuts, treatments, repairs.`,
  },
  event: {
    text: msg`A meeting at a set time that people sign up for.`,
    example: msg`E.g.: Open days, launches, meetups.`,
  },
};

export const sectionNames: Readonly<Record<Section, MessageDescriptor>> = {
  basic: msg`Basic details`,
  staff: msg`Staff & location`,
  availability: msg`Availability`,
  booking: msg`Booking rules`,
  forms: msg`Confirmation consent`,
  policies: msg`Notifications & policies`,
  appearance: msg`Widget appearance`,
};

/** The "Quick tip" under the section list: each says only what is true of this version. */
export const quickTips: Readonly<Record<Section, MessageDescriptor>> = {
  basic: msg`Groups keep related calendars together in the calendars list.`,
  staff: msg`Choose Custom as the meeting location to enter any address or link of your choice.`,
  availability: msg`Each person's own hours are set in Settings, Users. This calendar's time zone is in Basic details.`,
  booking: msg`Booking rules apply to all meetings on this calendar, regardless of staff availability.`,
  forms: msg`Confirmation emails go out only when a sender is chosen in Notifications & policies.`,
  policies: msg`For more, use an automation that starts when an appointment is booked.`,
  appearance: msg`Colours are written as six or eight hexadecimal digits, such as #178af6.`,
};

export const unitNames: Readonly<Record<Unit, MessageDescriptor>> = {
  minutes: msg`Minutes`,
  hours: msg`Hours`,
  days: msg`Days`,
};

export const locationKindNames: Readonly<Record<LocationKind, MessageDescriptor>> = {
  custom: msg`Custom`,
  phone: msg`Phone`,
  address: msg`Address`,
  google_meet: msg`Google Meet`,
};

/** Said in the editor of a draft whose type can't be booked yet (decision 1). */
export const draftOnlyNote = msg`This type of calendar can't take bookings yet, so it stays a draft. To take bookings, change its type to Personal booking or Round robin.`;
