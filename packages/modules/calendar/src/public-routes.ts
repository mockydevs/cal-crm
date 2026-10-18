import type {
  BotChallengeView,
  BotProof,
  CreateContactInput,
  PublicAppointmentPage,
  PublicAppointmentReceipt,
  PublicBookingBody,
  PublicBookingReceipt,
  PublicCalendarPage,
  PublicCalendarParams,
  PublicCancellationInput,
  PublicRescheduleInput,
  PublicSlots,
  PublicVisit,
} from '@repo/contracts';
import type { CommandContext } from '@repo/commands';
import type { Database, DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import type { CalendarOptions } from './calendars.js';

/**
 * Proof of when the booking page was shown (the forms module's render token): bound to the
 * calendar and to the visitor's source, and checked when the booking is sent.
 */
export interface BookingShownProof {
  readonly issue: (calendarId: string, ipAddress: string) => string;
  readonly check: (
    calendarId: string,
    ipAddress: string,
    token: string,
  ) =>
    | { readonly accepted: true; readonly mark: string }
    | { readonly accepted: false; readonly reason: 'too_fast'; readonly retryAfterSeconds: number }
    | { readonly accepted: false; readonly reason: 'stale' };
  /** The mark of a token for this calendar and source, however fresh: what a bot challenge is bound to. */
  readonly mark: (calendarId: string, ipAddress: string, token: string) => string | undefined;
}

/**
 * The bot protection a calendar may ask for: the forms module's ALTCHA proof of work, bound
 * to one showing of the page by its render token's mark.
 */
export interface BookingBotCheck {
  readonly issue: (render: string) => Promise<BotChallengeView>;
  readonly verify: (render: string, proof: BotProof | undefined) => Promise<boolean>;
}

/** Who an invite is from and to, as messaging knows them: the sending mailbox and the booker. */
export interface InviteParties {
  readonly organizer: { readonly email: string; readonly name: string };
  readonly attendee: { readonly email: string; readonly name: string };
}

/** A calendar invite a confirmation carries: its method, and its text once the parties are known. */
export interface ConfirmationInvite {
  readonly method: 'REQUEST' | 'CANCEL';
  readonly build: (parties: InviteParties) => string;
}

/** Module owners supply their canonical facades; the calendar module owns no foreign tables. */
export interface PublicBookingOptions {
  readonly db: Database;
  readonly publicOrigin: string;
  readonly calendars: CalendarOptions;
  readonly shown: BookingShownProof;
  /**
   * Bot protection for calendars that ask for it. Left out, such a calendar gives no
   * challenge and takes no booking: it fails closed.
   */
  readonly bot?: BookingBotCheck;
  /**
   * The public address of a calendar's logo or cover in Media Storage, read in the
   * page's transaction; null while the file has none. Left out, the page shows no picture.
   */
  readonly media?: {
    readonly publicAddress: (trx: DatabaseTransaction, fileId: string) => Promise<string | null>;
  };
  /**
   * A fresh look at the hosts' Google Calendars just before a booking is decided. Left out,
   * bookings decide from the busy store alone.
   */
  readonly google?: {
    readonly freshen: (
      context: TenantContext,
      calendarId: string,
      range: { readonly from: Date; readonly to: Date },
    ) => Promise<unknown>;
  };
  /**
   * Text messages about a booking, as messaging knows them: whether the business can text
   * now, read in the page's transaction, and the "Text me reminders" consent the visitor
   * gives for the number they typed. Left out, the page offers no box and takes none.
   */
  readonly texts?: {
    readonly available: (trx: DatabaseTransaction) => Promise<boolean>;
    readonly recordConsent: (
      trx: DatabaseTransaction,
      input: {
        readonly contactId: string;
        readonly appointmentId: string;
        readonly phone: string;
        readonly ipAddress: string;
        /** The box's words, as the page showed them: the proof. */
        readonly wording: string;
      },
      command: CommandContext,
    ) => Promise<unknown>;
  };
  readonly contacts: {
    readonly lock: (
      trx: DatabaseTransaction,
      context: TenantContext,
      input: { readonly contactId: string },
    ) => Promise<boolean>;
    readonly intake: (
      trx: DatabaseTransaction,
      input: CreateContactInput,
      command: CommandContext,
    ) => Promise<{ readonly contactId: string; readonly emailIdentityId: string | null }>;
    readonly setTimezone: (
      trx: DatabaseTransaction,
      input: { readonly contactId: string; readonly timezone: string },
      command: CommandContext,
    ) => Promise<boolean>;
    /**
     * Records where the booker came from on their contact. Left out, a booking records
     * nothing of the visit.
     */
    readonly attribute?: (
      trx: DatabaseTransaction,
      input: {
        readonly contactId: string;
        readonly appointmentId: string;
        readonly visit?: PublicVisit | undefined;
      },
      command: CommandContext,
    ) => Promise<void>;
    /**
     * Makes the host the contact's owner, through the CRM's own command: the calendar's
     * "assign contacts to their calendar team members" setting. With `keepExisting`, a
     * contact that has an owner keeps them. Left out, a booking changes no owner.
     */
    readonly assignOwner?: (
      trx: DatabaseTransaction,
      input: {
        readonly contactId: string;
        readonly membershipId: string;
        readonly keepExisting: boolean;
      },
      command: CommandContext,
    ) => Promise<void>;
  };
  readonly notifications: {
    readonly recipient: (
      trx: DatabaseTransaction,
      context: TenantContext,
      input: { readonly appointmentId: string; readonly contactId: string },
    ) => Promise<string | null>;
    readonly recordConsent: (
      trx: DatabaseTransaction,
      input: {
        readonly contactId: string;
        readonly appointmentId: string;
        readonly notificationConsent: true;
        readonly ipAddress: string;
        /** The wording of the box the visitor ticked, kept as the proof. */
        readonly wording: string;
      },
      command: CommandContext,
    ) => Promise<void>;
    readonly queue: (
      trx: DatabaseTransaction,
      context: TenantContext,
      input: {
        readonly identityId: string;
        readonly accountId: string;
        readonly idempotencyKey: string;
        readonly subject: string;
        readonly text: string;
        /** A calendar invite to send with it (RFC 6047), built once the parties are known. */
        readonly invite?: ConfirmationInvite;
      },
    ) => Promise<
      { readonly outcome: 'queued'; readonly deferred: boolean } | { readonly outcome: 'refused' }
    >;
  };
}

/** Supplied by the transport after trusted-proxy configuration and input validation. */
export interface PublicBookingRequestContext {
  readonly requestId: string;
  readonly ipAddress: string;
  /**
   * Told which business the request is for, the moment the module knows it and before any
   * row is held: the transport counts the address's later requests toward that business's
   * own limit, and lets one request of a business at a time reach the database. Left out,
   * nobody is told. Never called for a link that names nothing.
   */
  readonly onBusiness?: ((businessId: string) => void) | undefined;
}

/** Framework-neutral ports; transport owns rate limits, validation and redaction. */
export interface PublicBookingHandlers {
  readonly appointmentSlots: (
    token: string,
    query: { readonly date: string },
    request: PublicBookingRequestContext,
  ) => Promise<PublicSlots>;
  readonly calendar: (
    params: PublicCalendarParams,
    request: PublicBookingRequestContext,
  ) => Promise<PublicCalendarPage>;
  readonly slots: (
    params: PublicCalendarParams,
    /** The local date, and the length chosen from the page's durations. */
    query: { readonly date: string; readonly minutes?: number | string | undefined },
    request: PublicBookingRequestContext,
  ) => Promise<PublicSlots>;
  /** A bot challenge for one showing of a page whose calendar asks for one. */
  readonly challenge: (
    params: PublicCalendarParams,
    input: { readonly renderToken: string },
    request: PublicBookingRequestContext,
  ) => Promise<BotChallengeView>;
  readonly book: (
    params: PublicCalendarParams,
    input: PublicBookingBody,
    request: PublicBookingRequestContext,
  ) => Promise<PublicBookingReceipt>;
  readonly appointment: (
    token: string,
    request: PublicBookingRequestContext,
  ) => Promise<PublicAppointmentPage>;
  readonly cancel: (
    token: string,
    input: PublicCancellationInput,
    request: PublicBookingRequestContext,
  ) => Promise<PublicAppointmentReceipt>;
  readonly reschedule: (
    token: string,
    input: PublicRescheduleInput,
    request: PublicBookingRequestContext,
  ) => Promise<PublicAppointmentReceipt>;
}
