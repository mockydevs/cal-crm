// What a contact's consent means for sending, worked out the way the send check does
// (messaging's evaluateOutboundPolicy): do not contact first, then an address that can't
// be sent to, then consent. Quiet hours and the daily limit only delay a message, so they
// are not part of the answer here.
import type { ConsentState, ContactConsent } from '@repo/contracts';

export type Verdict = 'do_not_contact' | 'suppressed' | 'withdrawn' | 'no_consent' | 'allowed';

/** Whether a message of this channel and purpose would be let through, and if not, why. */
export function verdictOf(
  consent: Pick<ContactConsent, 'doNotContact' | 'suppressions'>,
  state: Pick<ConsentState, 'channel' | 'status'>,
): Verdict {
  if (consent.doNotContact) return 'do_not_contact';
  if (consent.suppressions.some((suppression) => suppression.channel === state.channel))
    return 'suppressed';
  if (state.status === 'withdrawn') return 'withdrawn';
  if (state.status === 'unknown') return 'no_consent';
  return 'allowed';
}

// The channels the product sends on today. The others show once something is recorded.
const always: readonly ConsentState['channel'][] = ['email', 'sms'];

/** The rows the panel shows: email and text messages always, others once they have a record. */
export function shownStates(current: readonly ConsentState[]): ConsentState[] {
  return current.filter((state) => always.includes(state.channel) || state.status !== 'unknown');
}

/** The change a row's button offers: withdraw what was given, otherwise record consent. */
export function offeredChange(state: Pick<ConsentState, 'status'>): 'granted' | 'withdrawn' {
  return state.status === 'granted' ? 'withdrawn' : 'granted';
}

/** Giving consent over a withdrawal needs the person to confirm the contact asked again. */
export function needsConfirmation(
  state: Pick<ConsentState, 'status'>,
  change: 'granted' | 'withdrawn',
): boolean {
  return change === 'granted' && state.status === 'withdrawn';
}

/** Whether quiet hours run overnight, past midnight, or within one day. */
export function quietHoursSpan(start: string, end: string): 'overnight' | 'same_day' | 'none' {
  if (start === end) return 'none';
  return start > end ? 'overnight' : 'same_day';
}
