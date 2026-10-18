// What Twilio says about an outbound message, and how far along that is. Twilio does not
// promise the order of status callbacks: "there is no guarantee that the status callback
// requests always arrive at your endpoint in the order they were sent"
// (https://www.twilio.com/docs/messaging/guides/track-outbound-message-status). So each
// status has a rank, and a message only moves to a higher one.

/** Twilio's message_enum_status (OpenAPI, Api v2010). */
export const TWILIO_STATUSES = [
  'accepted',
  'scheduled',
  'queued',
  'sending',
  'sent',
  'partially_delivered',
  'delivered',
  'undelivered',
  'failed',
  'canceled',
  'read',
  'receiving',
  'received',
] as const;
export type TwilioStatus = (typeof TWILIO_STATUSES)[number];

/** Twilio's statuses, and ours for a send the create call refused. */
export type SmsDeliveryStatus = TwilioStatus | 'rejected';

/** The statuses an outbound message can have; the rest describe inbound messages only. */
export type OutboundSmsStatus = Exclude<SmsDeliveryStatus, 'receiving' | 'received'>;

export function isTwilioStatus(value: string): value is TwilioStatus {
  return TWILIO_STATUSES.some((each) => each === value);
}

export function isOutboundStatus(status: SmsDeliveryStatus): status is OutboundSmsStatus {
  return status !== 'receiving' && status !== 'received';
}

/**
 * 0: says nothing about an outbound message (inbound only). 1: Twilio has it. 2: on its way
 * to the carrier. 3: the carrier has it. 4: final. 5: read (channels with read receipts).
 */
export function statusRank(status: SmsDeliveryStatus): 0 | 1 | 2 | 3 | 4 | 5 {
  switch (status) {
    case 'receiving':
    case 'received':
      return 0;
    case 'accepted':
    case 'scheduled':
    case 'queued':
      return 1;
    case 'sending':
      return 2;
    // partially_delivered is deprecated by Twilio; it never ends a message here.
    case 'sent':
    case 'partially_delivered':
      return 3;
    case 'delivered':
    case 'undelivered':
    case 'failed':
    case 'canceled':
    case 'rejected':
      return 4;
    case 'read':
      return 5;
  }
}

const failed = (status: SmsDeliveryStatus) =>
  status === 'undelivered' || status === 'failed' || status === 'canceled' || status === 'rejected';

/**
 * What a newly reported status does to a message that already has one:
 * - advance: it is further along, so it becomes the message's status;
 * - ignore: it is late, repeated, or not about outbound messages;
 * - conflict: it contradicts a final status already recorded. The first one is kept.
 */
export function advanceStatus(
  current: SmsDeliveryStatus | null,
  incoming: TwilioStatus,
): 'advance' | 'ignore' | 'conflict' {
  const rank = statusRank(incoming);
  if (rank === 0) return 'ignore';
  if (current === null) return 'advance';
  // A failed message was neither delivered nor read, and a delivered or read one did not fail.
  if (failed(current) !== failed(incoming) && statusRank(current) >= 4 && rank >= 4)
    return 'conflict';
  return rank > statusRank(current) ? 'advance' : 'ignore';
}

/** The messaging.messages status for a provider status; null for inbound-only ones. */
export function messageStatusOf(
  status: SmsDeliveryStatus,
): 'sent' | 'delivered' | 'failed' | 'read' | null {
  if (statusRank(status) === 0) return null;
  if (failed(status)) return 'failed';
  if (status === 'delivered') return 'delivered';
  if (status === 'read') return 'read';
  return 'sent';
}
