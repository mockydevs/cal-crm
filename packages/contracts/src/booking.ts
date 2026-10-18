import * as z from 'zod';
import { createContactInput } from './contacts.js';
import { timestamp } from './timestamps.js';
import { SLUG } from './businesses.js';
import { defineEndpoint } from './endpoints.js';
import { isTimeZone } from '@repo/kernel';
import { publicVisit } from './reporting-attribution.js';
import { botChallenge, botChallengeRequest, botProof, botProtection } from './bot-protection.js';
import { CALENDAR_LIMITS } from './calendars.js';

const bookingContact = z.strictObject({
  firstName: createContactInput.shape.firstName.unwrap().optional(),
  lastName: createContactInput.shape.lastName.unwrap().optional(),
  email: createContactInput.shape.emails.unwrap().element,
  phone: createContactInput.shape.phones.unwrap().element.optional(),
});

const bookingInstant = timestamp.refine((value) => !value.startsWith('0000-'), {
  error: 'Choose an instant in year 1 or later.',
});

export const BOOKING_NOTIFICATION_WORDING =
  'Email me confirmations and updates for this appointment.';

/**
 * The words beside the booking page's "Text me reminders" box, kept with the consent as
 * its proof. They say what the texts are for, how often, that the carrier may charge, and
 * how to get help or stop, as a call to action should: CTIA Messaging Principles and Best
 * Practices (May 2023) 5.1.1 and 5.1.3; Twilio's opt-in guidance lists the same (purpose,
 * frequency, data rates, HELP). 5.1.1 also expects the call to action to name who sends:
 * the business, by its name when the page is read and when the booking is made. The server
 * renders the words itself, on the page and as the proof; the browser never sends them.
 * The box is never ticked for the visitor.
 */
export function bookingTextWording(businessName: string): string {
  return `Text me reminders about this appointment from ${businessName.trim()}. Message frequency varies. Message and data rates may apply. Reply HELP for help or STOP to opt out.`;
}

/** The most characters of a calendar's own wording for its confirmation box. */
export const BOOKING_WORDING_LENGTH = 1000;

/**
 * Proof of when the booking page was shown, from the page's answer: the same shape as a
 * form's (forms.ts), bound to the visitor who loaded the page and good for one booking.
 */
export const bookingRenderToken = z.string().regex(/^[0-9]{13}\.[A-Za-z0-9_-]{43}$/);

export const publicBookingInput = z.strictObject({
  bookingRequestId: z.uuid(),
  startsAt: bookingInstant,
  contact: bookingContact,
  /**
   * Ticked by the visitor when the calendar asks for it (publicCalendarPage's
   * notificationWording). A calendar that asks for none sends no email, and takes none.
   */
  notificationConsent: z.literal(true).optional(),
  /**
   * "Text me reminders", ticked by the visitor beside the phone number they gave, when the
   * page offers it (publicCalendarPage's textWording). Left out: no texts about it.
   */
  textConsent: z.literal(true).optional(),
  contactTimezone: z.string().refine(isTimeZone),
  /** The length the visitor chose, from the page's durations. Left out: the first. */
  minutes: z.int().min(5).max(480).optional(),
  renderToken: bookingRenderToken,
  /** A field people cannot see. Anything in it means a program filled the page. */
  trap: z.string().max(200).default(''),
  /** The solved challenge, when the calendar asks for one (the page's botProtection). */
  botProof: botProof.optional(),
  /** The visit that led here, for the contact's attribution. A page may leave it out. */
  visit: publicVisit.optional(),
});

/** Exactly 32 random bytes in canonical unpadded base64url (the final two bits are zero). */
export const appointmentCapability = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);

export const publicCancellationInput = z.strictObject({
  operationRequestId: z.uuid(),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
});
export const publicRescheduleInput = publicCancellationInput.extend({ startsAt: bookingInstant });

export const publicAppointmentReceipt = z.strictObject({
  status: z.enum(['booked', 'confirmed', 'cancelled', 'completed', 'no_show', 'invalid']),
  startsAt: bookingInstant,
  endsAt: bookingInstant,
});
export const publicBookingReceipt = publicAppointmentReceipt.extend({
  managementUrl: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .optional(),
  /**
   * Whether a confirmation email was queued. False when the calendar has no mailbox to send
   * from or asks for no consent box: the page then says to keep the management link.
   */
  emailed: z.boolean().optional(),
});

export const publicCalendarParams = z.strictObject({
  agencySlug: z.string().regex(SLUG),
  businessSlug: z.string().regex(SLUG),
  calendarSlug: z.string().regex(SLUG),
});
export const publicSlotQuery = z.strictObject({
  date: z.iso.date().refine((value) => !value.startsWith('0000-'), {
    error: 'Choose a date in year 1 or later.',
  }),
  /** The length the visitor chose, from the page's durations. Left out: the first. */
  minutes: z.coerce.number().int().min(5).max(480).optional(),
});

const appearanceColor = z.string().regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
const publicImage = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .nullable()
  .meta({ description: 'Its public address in Media Storage. Null: none, or not public.' });

/**
 * How the calendar's owner styled its booking page (Widget appearance): the style, two
 * colours, the button's words and the two pictures, by their public addresses only.
 */
export const publicCalendarAppearance = z
  .strictObject({
    style: z.enum(['neo', 'classic']),
    primaryColor: appearanceColor,
    backgroundColor: appearanceColor,
    /** The booking button's words. Empty: the page's own. */
    buttonText: z.string().max(CALENDAR_LIMITS.buttonText),
    logoUrl: publicImage,
    coverUrl: publicImage,
  })
  .meta({ id: 'PublicCalendarAppearance' });
export type PublicCalendarAppearance = z.output<typeof publicCalendarAppearance>;

export const publicCalendarPage = z.strictObject({
  name: z.string().max(120),
  description: z.string().max(4000),
  timezone: z.string().refine(isTimeZone),
  slotMinutes: z.int().min(5).max(480),
  /** The lengths the visitor may choose, the calendar's own first. */
  durations: z.array(z.int().min(5).max(480)).min(1).max(6),
  /**
   * The wording of the box the visitor ticks to be emailed confirmations. Null: the
   * calendar asks for none, and no email is sent.
   */
  notificationWording: z.string().min(1).max(BOOKING_WORDING_LENGTH).nullable(),
  /**
   * The words of the optional "Text me reminders" box, shown beside the phone number. Left
   * out: the business can't send text messages, and no box is shown.
   */
  textWording: z.string().min(1).max(BOOKING_WORDING_LENGTH).optional(),
  renderToken: bookingRenderToken,
  /** Left out, off. Otherwise the page asks for a challenge and solves it before booking. */
  botProtection: botProtection.optional(),
  appearance: publicCalendarAppearance,
});
export const publicAppointmentPage = publicAppointmentReceipt.extend({
  calendarName: z.string().max(120),
  timezone: z.string().refine(isTimeZone),
  revision: publicCancellationInput.shape.revision,
});
export const publicSlots = z.strictObject({
  slots: z.array(z.strictObject({ startsAt: bookingInstant, endsAt: bookingInstant })).max(600),
});
const calendarPath = '/public/book/{agencySlug}/{businessSlug}/{calendarSlug}';
const capabilityParams = z.strictObject({ token: appointmentCapability });

export const getPublicCalendar = defineEndpoint({
  audience: 'public',
  operationId: 'getPublicCalendar',
  method: 'get',
  path: calendarPath,
  summary: 'Read a public booking calendar',
  group: 'Public booking',
  params: publicCalendarParams,
  response: { status: 200, description: 'Public calendar details.', schema: publicCalendarPage },
});
export const getPublicCalendarSlots = defineEndpoint({
  audience: 'public',
  operationId: 'getPublicCalendarSlots',
  method: 'get',
  path: `${calendarPath}/slots`,
  summary: 'Read available slots for one local date',
  group: 'Public booking',
  params: publicCalendarParams,
  query: publicSlotQuery,
  response: { status: 200, description: 'Available appointment instants.', schema: publicSlots },
});
export const bookPublicAppointment = defineEndpoint({
  audience: 'public',
  operationId: 'bookPublicAppointment',
  method: 'post',
  path: `${calendarPath}/appointments`,
  summary: 'Book an available appointment',
  group: 'Public booking',
  params: publicCalendarParams,
  body: publicBookingInput,
  response: {
    status: 200,
    description: 'Booking receipt; the management link is returned only on first creation.',
    schema: publicBookingReceipt,
  },
});
/**
 * A challenge for one showing of a booking page whose calendar asks for bot protection,
 * bound to the page's render token. A calendar that asks for none answers 404.
 */
export const getPublicCalendarChallenge = defineEndpoint({
  audience: 'public',
  operationId: 'getPublicCalendarChallenge',
  method: 'post',
  path: `${calendarPath}/challenge`,
  summary: 'Get the proof-of-work challenge for a shown booking page',
  group: 'Public booking',
  params: publicCalendarParams,
  body: botChallengeRequest,
  response: { status: 200, description: 'The challenge to solve.', schema: botChallenge },
});
export const getPublicAppointment = defineEndpoint({
  audience: 'public',
  operationId: 'getPublicAppointment',
  method: 'get',
  path: '/public/appointments/{token}',
  summary: 'Read an appointment using its management capability',
  group: 'Public booking',
  params: capabilityParams,
  response: {
    status: 200,
    description: 'Minimal appointment details.',
    schema: publicAppointmentPage,
  },
});
export const cancelPublicAppointment = defineEndpoint({
  audience: 'public',
  operationId: 'cancelPublicAppointment',
  method: 'post',
  path: '/public/appointments/{token}/cancel',
  summary: 'Cancel an appointment using its management capability',
  group: 'Public booking',
  params: capabilityParams,
  body: publicCancellationInput,
  response: {
    status: 200,
    description: 'Durable cancellation receipt.',
    schema: publicAppointmentReceipt,
  },
});
export const reschedulePublicAppointment = defineEndpoint({
  audience: 'public',
  operationId: 'reschedulePublicAppointment',
  method: 'post',
  path: '/public/appointments/{token}/reschedule',
  summary: 'Reschedule an appointment using its management capability',
  group: 'Public booking',
  params: capabilityParams,
  body: publicRescheduleInput,
  response: {
    status: 200,
    description: 'Durable rescheduling receipt.',
    schema: publicAppointmentReceipt,
  },
});
export const getPublicAppointmentSlots = defineEndpoint({
  audience: 'public',
  operationId: 'getPublicAppointmentSlots',
  method: 'get',
  path: '/public/appointments/{token}/slots',
  summary: 'Read available rescheduling slots using an appointment capability',
  group: 'Public booking',
  params: capabilityParams,
  query: publicSlotQuery,
  response: {
    status: 200,
    description: 'Available instants for the original host.',
    schema: publicSlots,
  },
});

export const publicBookingEndpoints = [
  getPublicCalendar,
  getPublicCalendarSlots,
  bookPublicAppointment,
  getPublicAppointment,
  cancelPublicAppointment,
  reschedulePublicAppointment,
  getPublicAppointmentSlots,
  getPublicCalendarChallenge,
] as const;

export type PublicCalendarParams = z.output<typeof publicCalendarParams>;
export type PublicBookingInput = z.output<typeof publicBookingInput>;
/** A booking as it is sent: the hidden field may be left out. */
export type PublicBookingBody = z.input<typeof publicBookingInput>;
export type PublicCancellationInput = z.output<typeof publicCancellationInput>;
export type PublicRescheduleInput = z.output<typeof publicRescheduleInput>;
export type PublicCalendarPage = z.output<typeof publicCalendarPage>;
export type PublicAppointmentPage = z.output<typeof publicAppointmentPage>;
export type PublicAppointmentReceipt = z.output<typeof publicAppointmentReceipt>;
export type PublicBookingReceipt = z.output<typeof publicBookingReceipt>;
export type PublicSlots = z.output<typeof publicSlots>;
