// The numbers behind the Dashboard's email widgets: what was sent, what was not and why,
// what bounced, what came in and who unsubscribed, over a range of dates, with one row for
// each day. They are counted from the messages and the consent ledger in the request. Opens
// and clicks are not tracked, and are not here; neither is delivery, which a mail server
// never confirms.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { checkReportRange, reportDay, reportRange, reportRangeAnswer } from './report-range.js';

export const emailReportQuery = z
  .strictObject(reportRange)
  .superRefine(checkReportRange)
  .meta({ id: 'EmailReportQuery' });

/**
 * Who an email is from: a workflow's step, a person of the team, the assistant (its own
 * send, or a draft of its that a person approved), or anything else (a booking's
 * confirmation, an API key).
 */
export const emailReportSenders = ['workflow', 'person', 'assistant', 'other'] as const;
export type EmailReportSender = (typeof emailReportSenders)[number];

const count = z.int().min(0);
const counts = {
  sent: count.meta({
    description:
      'Emails a mail server accepted, on the day it did. One that bounced afterwards stays counted.',
  }),
  notSent: count.meta({
    description:
      'Emails that were refused before or at the mail server, on the day they were refused.',
  }),
  bounced: count.meta({
    description: 'Emails a delivery report came back for, on the day the report was recorded.',
  }),
  received: count.meta({ description: 'Emails that came in, on the day they were stored.' }),
  replies: count.meta({
    description:
      'Of the emails received, the ones that answer an email this business sent. Automatic answers (out of office) are left out.',
  }),
  unsubscribed: count.meta({
    description:
      'Contacts whose consent to marketing email was withdrawn, on the day it was: by the unsubscribe link or by the team. A withdrawal repeated while already withdrawn is not counted again, and neither is one brought in by an import.',
  }),
};

export const emailReport = z
  .looseObject({
    ...reportRangeAnswer,
    totals: z.looseObject({
      ...counts,
      hardBounced: count.meta({
        description: 'Of the bounced, the ones whose address was bad.',
      }),
    }),
    notSentReasons: z
      .array(
        z.looseObject({
          reason: z.string().meta({
            description:
              "Why, as the message keeps it: the outbound policy's refusal, the mailbox's, or the mail server's.",
            examples: ['consent_required', 'suppressed', 'delivery_rejected'],
          }),
          count,
        }),
      )
      .meta({
        description:
          'The emails not sent, by reason: the most common first. They add up to totals.notSent.',
      }),
    senders: z.array(z.looseObject({ sender: z.enum(emailReportSenders), count })).meta({
      description:
        'The emails sent, by who sent them. Always workflow, person, assistant and other, in that order; they add up to totals.sent.',
    }),
    days: z.array(z.looseObject({ date: reportDay, ...counts })).meta({
      description:
        "One row for each calendar day of the range in the business's time zone, in order, with zeros on a day nothing happened. The first and the last are part days when the range does not start and end at midnight there.",
    }),
  })
  .meta({ id: 'EmailReport' });
export type EmailReport = z.output<typeof emailReport>;

export const getEmailReport = defineEndpoint({
  operationId: 'getEmailReport',
  method: 'get',
  path: '/reports/email',
  summary: "Read the numbers of the dashboard's email widgets for a range of dates",
  group: 'Reports',
  query: emailReportQuery,
  response: {
    status: 200,
    description:
      'Counted from the email messages and the consent ledger. Each thing is counted on the day it happened, so an email sent before the range that bounced in it is a bounce of the range. Opens, clicks and delivery are not recorded, and are not answered.',
    schema: emailReport,
  },
});

export const emailReportEndpoints = [getEmailReport] as const;
