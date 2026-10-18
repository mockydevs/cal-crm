// The forms module's proof of when a page was shown (render-token.ts), lent to the public
// booking page: the page's answer carries a token bound to the calendar and to the
// visitor's source, and the booking must hand it back after a person's pause. The calendar
// module keeps each spent token with its booking, so one showing of the page is good for
// one booking.
import { FORM_LIMITS } from '@repo/contracts';

import {
  checkRenderToken,
  issueRenderToken,
  renderMarkOf,
  type RenderDecision,
} from './render-token.js';
import { visitorSource } from './visitor-source.js';

/** A calendar is never published as a form is: one fixed moment stands for its version. */
const CALENDAR_VERSION = new Date(0);

export interface BookingShownProof {
  readonly issue: (calendarId: string, ipAddress: string) => string;
  readonly check: (
    calendarId: string,
    ipAddress: string,
    token: string,
  ) =>
    | { readonly accepted: true; readonly mark: string }
    | Exclude<RenderDecision, { readonly accepted: true }>;
  /**
   * The mark of a token of this calendar shown to this source, not too old, however soon it
   * is asked for: what the page's bot challenge is bound to. Undefined for any other token.
   */
  readonly mark: (calendarId: string, ipAddress: string, token: string) => string | undefined;
}

export function createBookingShownProof(
  secret: string,
  now: () => number = () => Date.now(),
): BookingShownProof {
  // As for forms: each showing this process signs has a moment of its own.
  let last = 0;
  const subject = (calendarId: string, ipAddress: string) => ({
    // Labelled apart from any form's id, so a token of one is never the other's.
    formId: `calendar:${calendarId}`,
    publishedAt: CALENDAR_VERSION,
    visitor: visitorSource(ipAddress).key,
  });
  return {
    issue(calendarId, ipAddress) {
      last = Math.max(Math.trunc(now()), last + 1);
      return issueRenderToken(secret, subject(calendarId, ipAddress), last);
    },
    check(calendarId, ipAddress, token) {
      const decision = checkRenderToken(secret, subject(calendarId, ipAddress), token, now(), {
        minFillSeconds: FORM_LIMITS.minFillSeconds,
        renderHours: FORM_LIMITS.renderHours,
      });
      return decision.accepted ? { accepted: true, mark: decision.mark } : decision;
    },
    mark: (calendarId, ipAddress, token) =>
      renderMarkOf(secret, subject(calendarId, ipAddress), token, now(), FORM_LIMITS.renderHours),
  };
}
