import * as z from 'zod';
import { automationReference, mergeText } from './automations-values.js';
import { EMAIL_CONTENT_LIMITS } from './email-content.js';
import { publicId } from './ids.js';
import { messageTemplateRevision } from './message-template-revision.js';

/** Provenance is retained even when the content is independent of the source. */
export const workflowEmailSource = z.strictObject({
  id: publicId('template'),
  revision: messageTemplateRevision,
});

const oneLine = /^[^\r\n]*$/;
const subject = mergeText(998).regex(oneLine).regex(/\S/);

/**
 * The formatted part of an email written in a step: HTML beside the plain-text `body`. It
 * is cleaned again when the email is sent, whatever a draft holds.
 */
const html = mergeText(EMAIL_CONTENT_LIMITS.html).regex(/\S/).meta({
  description:
    'The formatted part as HTML, sent beside the plain-text body. Cleaned by the same allowlist as a template when the email is sent.',
});

/**
 * One address in Reply-To, Cc or Bcc: an email address, or one merge field that holds one,
 * such as {{contact.email}}. A field with no address when the step runs fails the step.
 */
export const workflowEmailAddress = z
  .union([
    z
      .email({ error: 'Give an email address or one merge field.' })
      .max(EMAIL_CONTENT_LIMITS.address),
    z
      .string()
      .max(200)
      .regex(/^\{\{\s*[a-z][a-z_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\s*\}\}$/, {
        error: 'Give an email address or one merge field.',
      }),
  ])
  .meta({
    id: 'WorkflowEmailAddress',
    description: 'An email address, or one merge field that holds one.',
  });

const copies = z
  .array(workflowEmailAddress)
  .min(1)
  .max(EMAIL_CONTENT_LIMITS.copies, { error: 'Give at most 10 addresses.' });

/** What a workflow's message is, for consent and for the footer marketing mail carries. */
export const workflowMessagePurposes = ['marketing', 'transactional'] as const;

/**
 * Whether a Send email or Send text step's message is marketing (left out: every workflow
 * message was, and is) or transactional. Transactional is for a message about the
 * appointment the contact booked, such as a reminder: it needs the consent the booking
 * recorded, not marketing consent, and carries no unsubscribe footer. Only a workflow
 * started by an appointment trigger may send one (automations-validate.ts).
 */
export const workflowMessagePurpose = z.enum(workflowMessagePurposes).optional().meta({
  description:
    'marketing (left out) or transactional: about the appointment the contact booked, such as a reminder. Only an appointment-triggered workflow may send one.',
});

/**
 * What a Send email step says about the email besides its content. None of it is part of
 * a template, and none of it is changed by syncing with one.
 */
export const workflowEmailEnvelope = {
  purpose: workflowMessagePurpose,
  mailbox: automationReference.optional().meta({
    description:
      'The connected mailbox the email is from, by id or address. Left out, the business’s only working mailbox. An email is only ever from a connected mailbox.',
  }),
  fromName: mergeText(EMAIL_CONTENT_LIMITS.fromName)
    .regex(oneLine)
    .regex(/\S/)
    .optional()
    .meta({ description: 'The name the email is from. Left out, the mailbox’s own name.' }),
  replyTo: workflowEmailAddress.optional(),
  cc: copies.optional(),
  bcc: copies.optional(),
  preheader: mergeText(EMAIL_CONTENT_LIMITS.preheader).regex(oneLine).regex(/\S/).optional().meta({
    description:
      'The preview line mail apps show after the subject. Formatted emails only. Left out on a step that sends a template, the template’s own.',
  }),
  attachments: z
    .array(publicId('file'))
    .min(1)
    .max(EMAIL_CONTENT_LIMITS.attachments, { error: 'Attach at most 5 files.' })
    .refine((files) => new Set(files).size === files.length, { error: 'Attach each file once.' })
    .optional()
    .meta({
      description: 'Files of this business sent with the email, at most 5 and 15 MiB in all.',
    }),
} as const;

/** Authoring content; published binding identity and revisions are separate contracts. */
export const workflowEmailContent = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('copy'),
    subject,
    body: mergeText(1_000_000).regex(/\S/),
    html: html.optional(),
    source: workflowEmailSource.optional(),
  }),
  z.strictObject({ mode: z.literal('sync'), source: workflowEmailSource }),
]);

/**
 * The config of a Send email step, in each of its four forms: an independent copy, a step
 * that syncs with a template, an older reference to a template, and content written in the
 * step.
 */
export const workflowEmailStepConfig = z.union([
  workflowEmailContent.options[0].extend(workflowEmailEnvelope),
  workflowEmailContent.options[1].extend({
    ...workflowEmailEnvelope,
    subject: subject.optional().meta({
      description: 'This step’s own subject. Left out, the template’s.',
    }),
  }),
  z.strictObject({
    template: automationReference,
    subject: subject.optional().meta({
      description: 'This step’s own subject. Left out, the template’s.',
    }),
    ...workflowEmailEnvelope,
  }),
  z.strictObject({
    subject,
    body: mergeText(1_000_000).regex(/\S/),
    html: html.optional(),
    ...workflowEmailEnvelope,
  }),
]);

export type WorkflowEmailSource = z.output<typeof workflowEmailSource>;
export type WorkflowEmailContent = z.output<typeof workflowEmailContent>;
export type WorkflowEmailStepConfig = z.output<typeof workflowEmailStepConfig>;
