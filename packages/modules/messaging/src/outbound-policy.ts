/** Trusted, current facts loaded in the dispatch transaction; no recipient data. */
export interface OutboundPolicyFacts {
  readonly contactActive: boolean;
  readonly senderActive: boolean;
  readonly doNotContact: boolean;
  /**
   * Do not disturb is on for the message's own channel (crm.contacts.dnd_channels). Left
   * out by a caller that knows of no such setting, which is the same as off.
   */
  readonly channelDoNotDisturb?: boolean;
  readonly consent: 'granted' | 'withdrawn' | 'unknown';
  readonly suppression: SuppressionReason | null;
  readonly timing: 'open' | 'quiet' | 'unknown';
  /**
   * The message is transactional and about the contact's own appointment, which is booked
   * or confirmed and has not ended: a reminder of it. Quiet hours do not hold it, so a
   * reminder an hour before a 7:00 appointment is not sent after it starts. The US rule
   * they follow, 47 CFR 64.1200(c)(1), is about telephone solicitations, and a reminder of
   * a person's own booking is not one. Left out, false.
   */
  readonly ownAppointment?: boolean;
  /** Workflow and campaign messages reserved for the contact in the last 24 hours. */
  readonly recentMessages: number;
  readonly frequencyLimit: number;
  /**
   * The lane the message is on. Quiet hours hold every lane; the daily cap protects people
   * from automated messages, so it holds only workflow and campaign mail, and mail of no
   * known lane.
   */
  readonly lane?: OutboundLane;
  /**
   * The contact wrote to the business by email from the very address an answer goes to.
   * That is the basis for a person's 1:1 answer (the reply lane) when no transactional
   * consent was recorded: nobody needs to opt in to be answered.
   */
  readonly inboundBasis?: boolean;
}

export type SuppressionReason = 'hard_bounce' | 'complaint' | 'unsubscribe' | 'invalid' | 'manual';
export type OutboundLane = 'reply' | 'transactional' | 'automation' | 'campaign';

/** Whether the daily cap holds a message on this lane. */
export const isAutomatedLane = (lane: OutboundLane | undefined): boolean =>
  lane === undefined || lane === 'automation' || lane === 'campaign';
export type OutboundPolicyDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'defer'; readonly reason: 'quiet_hours' | 'frequency_cap' }
  | {
      readonly action: 'refuse';
      readonly reason: 'suppressed';
      readonly suppressionReason: SuppressionReason;
    }
  /**
   * Do not disturb for the message's channel alone. It is the same refusal as do not
   * contact, under the same reason, so every reader of the reason shows it as they show
   * that one; `scope` tells the two apart for whoever stores the refusal.
   */
  | { readonly action: 'refuse'; readonly reason: 'do_not_contact'; readonly scope: 'channel' }
  | {
      readonly action: 'refuse';
      readonly reason:
        | 'contact_inactive'
        | 'sender_inactive'
        | 'do_not_contact'
        | 'consent_withdrawn'
        | 'consent_required'
        | 'timing_unknown';
    };

/** Do not contact (no scope), or do not disturb for the message's channel alone. */
export type DoNotDisturbRefusal =
  | { readonly action: 'refuse'; readonly reason: 'do_not_contact' }
  | { readonly action: 'refuse'; readonly reason: 'do_not_contact'; readonly scope: 'channel' };

/**
 * Do not contact, then do not disturb for the message's channel: the refusal either gives,
 * or undefined when neither is on. A web chat reply has no address, consent or quiet hours
 * to check, and is held to this part of the policy alone (inbox-reply.ts).
 */
export function evaluateDoNotDisturb(
  facts: Pick<OutboundPolicyFacts, 'doNotContact' | 'channelDoNotDisturb'>,
): DoNotDisturbRefusal | undefined {
  if (facts.doNotContact) return { action: 'refuse', reason: 'do_not_contact' };
  if (facts.channelDoNotDisturb === true)
    return { action: 'refuse', reason: 'do_not_contact', scope: 'channel' };
  return undefined;
}

/** Permanent refusals take precedence over temporary scheduling restrictions. */
export function evaluateOutboundPolicy(facts: OutboundPolicyFacts): OutboundPolicyDecision {
  if (!facts.contactActive) return { action: 'refuse', reason: 'contact_inactive' };
  if (!facts.senderActive) return { action: 'refuse', reason: 'sender_inactive' };
  const disturbed = evaluateDoNotDisturb(facts);
  if (disturbed !== undefined) return disturbed;
  if (facts.suppression !== null)
    return { action: 'refuse', reason: 'suppressed', suppressionReason: facts.suppression };
  if (facts.consent === 'withdrawn') return { action: 'refuse', reason: 'consent_withdrawn' };
  if (facts.consent === 'unknown' && !(facts.lane === 'reply' && facts.inboundBasis === true))
    return { action: 'refuse', reason: 'consent_required' };
  // Quiet hours, and the zone they are judged in, do not apply to a reminder of the
  // contact's own appointment. Everything above (consent, suppressions, do not contact)
  // and the daily cap below still do.
  if (facts.ownAppointment !== true) {
    if (facts.timing === 'unknown') return { action: 'refuse', reason: 'timing_unknown' };
    if (facts.timing === 'quiet') return { action: 'defer', reason: 'quiet_hours' };
  }
  if (isAutomatedLane(facts.lane) && facts.recentMessages >= facts.frequencyLimit)
    return { action: 'defer', reason: 'frequency_cap' };
  return { action: 'allow' };
}

/** Matches messaging.messages.priority: lower lanes are acquired first. */
export function outboundLanePriority(lane: OutboundLane): 0 | 1 | 2 {
  switch (lane) {
    case 'reply':
    case 'transactional':
      return 0;
    case 'automation':
      return 1;
    case 'campaign':
      return 2;
  }
}
