// A rendered preview: a saved template or unsaved content, filled in for a real contact or
// from sample values, with what a workflow email is sent with. It reads; nothing is saved,
// queued or issued.
import { requireBusiness, type Invocation } from '@repo/commands';
import type {
  ConditionValues,
  RenderedEmailPreview,
  RenderEmailPreviewInput,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, ValidationError } from '@repo/kernel';

import { previewEmail, readPostalAddressLine, type EmailParts } from './email-compose.js';
import { emailTextOf, sanitizeEmailHtml } from './email-html.js';

export interface PreviewOptions {
  /** A contact's values by merge field (automation's contactValues). Left out, none. */
  readonly values?:
    ((trx: DatabaseTransaction, contactId: string) => Promise<ConditionValues>) | undefined;
  /** PUBLIC_URL: where an image from the media library gets its address. */
  readonly publicUrl?: string | undefined;
}

const invalid = (path: string, code: string, message: string): ValidationError =>
  new ValidationError([{ path, code, message }]);

const given = (text: string | undefined): text is string =>
  text !== undefined && text.trim() !== '';

async function partsOf(
  trx: DatabaseTransaction,
  input: RenderEmailPreviewInput,
): Promise<EmailParts> {
  if (input.template !== undefined) {
    if (input.content !== undefined)
      throw invalid('/content', 'content_twice', 'Preview a template or content, not both.');
    const id = parsePublicId('template', input.template);
    const row =
      id === undefined
        ? undefined
        : await trx
            .selectFrom('messaging.templates')
            .select(['subject', 'body', 'body_html', 'preheader'])
            .where('id', '=', id)
            .where('channel', '=', 'email')
            .executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Template', input.template);
    // A step's own subject and preview text stand in for the template's when it has them.
    return {
      subject: given(input.subject) ? input.subject : row.subject,
      text: row.body,
      html: row.body_html,
      preheader: given(input.preheader) ? input.preheader : row.preheader,
    };
  }
  if (input.content === undefined)
    throw invalid('/content', 'content_required', 'Give a template, or a subject and content.');
  const subject = input.subject ?? '';
  if (input.content.format === 'text') return { subject, text: input.content.text };
  // As a save would store it: cleaned, with the text part written from it when none is given.
  const html = sanitizeEmailHtml(input.content.html);
  return {
    subject,
    text: given(input.content.text) ? input.content.text : emailTextOf(html),
    html,
    preheader: given(input.preheader) ? input.preheader : null,
  };
}

export async function readEmailPreview(
  trx: DatabaseTransaction,
  invocation: Invocation,
  input: RenderEmailPreviewInput,
  options: PreviewOptions = {},
): Promise<RenderedEmailPreview> {
  requireBusiness(invocation.context);
  const parts = await partsOf(trx, input);
  let values: ConditionValues = {};
  if (input.contact !== undefined) {
    const id = parsePublicId('contact', input.contact);
    const contact =
      id === undefined
        ? undefined
        : await trx
            .selectFrom('crm.contacts')
            .select('id')
            .where('id', '=', id)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
    if (contact === undefined) throw new NotFoundError('Contact', input.contact);
    values = (await options.values?.(trx, contact.id)) ?? {};
  }
  return previewEmail({
    parts,
    values: { ...values, ...input.values },
    publicUrl: options.publicUrl,
    addressLine: input.footer ? await readPostalAddressLine(trx, invocation.context) : null,
    footer: input.footer,
  });
}
