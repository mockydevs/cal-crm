export { createMailer, type MailMessage, type Mailer, type MailerOptions } from './mailer.js';
export {
  discoverMailbox,
  type MailboxDiscoveryOptions,
  type MailboxDiscoveryResult,
  type MailServerSuggestion,
} from './mailbox-discovery.js';
export {
  createMailboxConnector,
  type MailboxConnector,
  type MailboxConnectorOptions,
  type MailboxSender,
  type MailAttachment,
  type MailboxSubmitter,
  type MailboxSubmissionResult,
  type MailboxProbe,
  type MailboxReader,
  type MailboxInboxCursor,
  type MailboxInboxMessage,
  MailboxDeliveryError,
  type MailConnectionCode,
  type MailConnectionResult,
  type MailServerLogin,
} from './mailbox-connection.js';
export { MailboxProbeError } from './mailbox-probe.js';
export {
  DELIVERY_REPORT_LIMITS,
  classifyDelivery,
  parseDeliveryReport,
  parseFeedbackReport,
  type FeedbackReport,
  type BounceKind,
  type DeliveryAction,
  type DeliveryRecipient,
  type DeliveryReport,
} from './delivery-report.js';
export {
  INBOUND_LIMITS,
  parseInboundMessage,
  type InboundAddress,
  type InboundMessage,
  type InboundSender,
  type ParsedInbound,
} from './inbound-message.js';
export {
  REPLY_HEADER_LIMITS,
  msgIdOf,
  replyHeadersOf,
  safeReplyHeaders,
  type ReplyHeaders,
  type ReplyParent,
} from './reply-headers.js';
