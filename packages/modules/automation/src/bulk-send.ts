// Contacts → bulk actions → Send Email and Send SMS: what the CRM's bulk action needs of
// sending. Each contact's message is the one a workflow's Send Email or Send SMS step would
// queue for it: filled in with the contact's values, from the mailbox or number the step
// rules allow, and queued through messaging's one outbound path, so consent, do not
// disturb, suppressions, quiet hours and sending limits apply as to any other message.
// Nothing is sent from here: the dispatch job does that.
import type { DatabaseTransaction } from '@repo/db';
import type { Issue } from '@repo/kernel';
import type { BulkMessages, BulkSendRefusal } from '@repo/module-crm';
import { holdContactEmail } from '@repo/module-messaging';
import { sql } from 'kysely';

import {
  liveTemplate,
  senderOf as mailboxOf,
  sendAutomationEmail,
  type MessageSendResult,
} from './actions-email.js';
import { senderOf as numberOf, sendTextMessage } from './actions-sms.js';

/** The reason a refusal of the send steps, or of messaging's policy, skips a contact. */
const REFUSALS: Readonly<Record<string, BulkSendRefusal>> = {
  no_phone_number: 'no_address',
  no_email_address: 'no_address',
  do_not_contact: 'do_not_disturb',
  consent_required: 'no_consent',
  consent_withdrawn: 'no_consent',
  suppressed: 'suppressed',
  missing_values: 'missing_values',
  sms_unavailable: 'sender_unavailable',
  number_unavailable: 'sender_unavailable',
  number_required: 'sender_unavailable',
  mailbox_unavailable: 'sender_unavailable',
  mailbox_required: 'sender_unavailable',
  sender_inactive: 'sender_unavailable',
};

/** A sender that can't send, as an issue on the field that named it. */
function senderIssue(path: string, refusal: MessageSendResult): Issue {
  return refusal.ok
    ? { path, code: 'sender_unavailable', message: 'This sender cannot send now.' }
    : { path, code: refusal.code, message: refusal.explanation };
}

export function createBulkMessages(options: {
  /** Whether this install can hand a text message to its provider at all. */
  readonly smsAvailable: boolean;
  /** PUBLIC_URL: where a trigger link in a message gets its address. */
  readonly publicUrl?: string | undefined;
  /**
   * CAMPAIGN_AGENCY_DAILY_LIMIT: one agency's campaign emails in 24 hours, which bulk email
   * counts against as a campaign's emails do. Left out, there is none.
   */
  readonly agencyDailyLimit?: number | undefined;
}): BulkMessages {
  /** Room under the agency's ceiling now: the campaign and bulk emails of the last day. */
  const emailAllowance = async (trx: DatabaseTransaction): Promise<number | null> => {
    const limit = options.agencyDailyLimit;
    if (limit === undefined) return null;
    const { rows } = await sql<{ released: number }>`
      select private.agency_campaign_released()::integer as released
    `.execute(trx);
    return Math.max(limit - (rows[0]?.released ?? 0), 0);
  };
  return {
    async check(trx, _invocation, message) {
      if (message.channel === 'sms') {
        if (!options.smsAvailable)
          return {
            path: '/action',
            code: 'sms_unavailable',
            message:
              "This install can't send text messages: it needs a secrets vault and a public https address for delivery reports.",
          };
        const number = await numberOf(trx, message.number);
        return typeof number === 'string' ? undefined : senderIssue('/number', number);
      }
      const mailbox = await mailboxOf(trx, message.mailbox);
      if (typeof mailbox !== 'string') return senderIssue('/mailbox', mailbox);
      if ((await emailAllowance(trx)) === 0)
        return {
          path: '/action',
          code: 'daily_limit_reached',
          message: `This agency has sent the ${String(options.agencyDailyLimit)} campaign emails this install allows in a day. Try again once older ones are a day old.`,
        };
      if (
        message.templateId !== undefined &&
        (await liveTemplate(trx, message.templateId)) === undefined
      )
        return {
          path: '/templateId',
          code: 'template_unavailable',
          message: 'Choose an email template of this business that is not archived.',
        };
      return undefined;
    },

    async hold(trx, invocation) {
      await holdContactEmail(trx, invocation.context);
    },

    emailAllowance: (trx) => emailAllowance(trx),

    async send(trx, invocation, message, contact) {
      const result =
        message.channel === 'sms'
          ? await sendTextMessage(trx, invocation.context, {
              contactId: contact.id,
              message: message.message,
              number: message.number,
              idempotencyKey: contact.idempotencyKey,
              available: options.smsAvailable,
              publicUrl: options.publicUrl,
            })
          : await sendAutomationEmail(trx, invocation.context, {
              contactId: contact.id,
              idempotencyKey: contact.idempotencyKey,
              publicUrl: options.publicUrl,
              mailbox: message.mailbox,
              ...(message.fromName === undefined ? {} : { fromName: message.fromName }),
              ...(message.templateId === undefined
                ? { subject: message.subject ?? '', body: message.body ?? '' }
                : {
                    template: message.templateId,
                    ...(message.subject === undefined ? {} : { subject: message.subject }),
                  }),
            });
      return result.ok
        ? { queued: true }
        : { queued: false, reason: REFUSALS[result.code] ?? 'message_refused' };
    },
  };
}
