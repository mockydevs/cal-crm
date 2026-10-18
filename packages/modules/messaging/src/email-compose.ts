// A workflow's email made ready to queue, and the same made ready to look at. One place
// turns what was written (a subject, a plain-text part, perhaps a formatted part and a
// preview line) into what leaves, so a preview shows what a send would send:
//
// - the formatted part is cleaned (email-html.ts), filled in with escaped values, and
//   cleaned again, so no value becomes markup or a script address;
// - marketing email shows how to unsubscribe and where the business is. The FTC's CAN-SPAM
//   compliance guide (ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business,
//   read 2026-10-13) asks every commercial message for "a clear and conspicuous explanation
//   of how the recipient can opt out" and "your valid physical postal address". The link is
//   the recipient's own one-click address (unsubscribe.ts); the address is the business
//   profile's, when it has one. Both are added as the email leaves (deliveredText), so the
//   queued message holds what the author wrote and nothing else;
// - the preview line is the hidden first text of the formatted part, written as campaigns
//   write it (campaign-rules.ts).
import { requireBusiness } from '@repo/commands';
import {
  EMAIL_UNSUBSCRIBE_MERGE_FIELD,
  mergeTokens,
  renderMessageTemplate,
  requiredMergeTokens,
  triggerLinkMergeKey,
  type ConditionValues,
  type RenderedEmailPreview,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';

import {
  escapeHtml,
  hasUnsubscribeField,
  htmlMergeValues,
  showsUnsubscribeField,
  showsUnsubscribePlaceholder,
  UNSUBSCRIBE_PLACEHOLDER,
  withUnsubscribeAddress,
} from './campaign-rules.js';
import { finalEmailHtml, sanitizeEmailHtml } from './email-html.js';
import { renderWithTriggerLinks } from './trigger-link-tokens.js';

/** An email as it was written, merge fields and all. */
export interface EmailParts {
  readonly subject: string;
  readonly text: string;
  readonly html?: string | null | undefined;
  readonly preheader?: string | null | undefined;
}

export type ComposedEmail =
  | {
      readonly ok: true;
      readonly subject: string;
      readonly text: string;
      readonly html: string | null;
    }
  | {
      readonly ok: false;
      readonly code: 'missing_values' | 'subject_line_break';
      readonly fields: readonly string[];
    };

const filled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * A business's postal address on one line, under its name, as an email's last line shows
 * it: "Bluebird Dental, 12 High St, Suite 4, Austin, TX 78701, US". Nothing without a
 * street line: a city alone is not an address anyone could write to.
 */
export function postalAddressLine(name: string, address: unknown): string | null {
  if (typeof address !== 'object' || address === null) return null;
  const part = (key: string): string | undefined => {
    const value: unknown = (address as Readonly<Record<string, unknown>>)[key];
    return filled(value) ? value.trim() : undefined;
  };
  const line1 = part('line1');
  if (line1 === undefined) return null;
  const region = [part('region'), part('postalCode')].filter(filled).join(' ');
  return [name.trim(), line1, part('line2'), part('city'), region, part('country')]
    .filter(filled)
    .join(', ')
    .replace(/[\r\n]+/g, ' ');
}

/** The business's postal address line, or null when its profile has no address. */
export async function readPostalAddressLine(
  trx: DatabaseTransaction,
  context: TenantContext,
): Promise<string | null> {
  const business = await trx
    .selectFrom('tenancy.businesses')
    .select(['name', 'address'])
    .where('id', '=', requireBusiness(context))
    .executeTakeFirst();
  return business === undefined ? null : postalAddressLine(business.name, business.address);
}

/**
 * A plain-text body with the marketing footer: the business's address, and an unsubscribe
 * line unless the body places the link itself. What the author wrote is not changed; the
 * footer follows it.
 */
export function textWithFooter(text: string, addressLine: string | null): string {
  const lines = [
    ...(addressLine === null ? [] : [addressLine]),
    ...(hasUnsubscribeField(text) ? [] : [`Unsubscribe: {{${EMAIL_UNSUBSCRIBE_MERGE_FIELD}}}`]),
  ];
  return lines.length === 0 ? text : `${text.trimEnd()}\n\n--\n${lines.join('\n')}\n`;
}

/** The same footer for the formatted part, as its last paragraph. */
export function htmlWithFooter(html: string, addressLine: string | null): string {
  const lines = [
    ...(addressLine === null ? [] : [escapeHtml(addressLine)]),
    ...(showsUnsubscribeField(html)
      ? []
      : [`<a href="{{${EMAIL_UNSUBSCRIBE_MERGE_FIELD}}}">Unsubscribe</a>`]),
  ];
  return lines.length === 0
    ? html
    : `${html}<p style="font-size:12px;color:#666666">${lines.join('<br>')}</p>`;
}

/**
 * The preview line as the hidden first text of the formatted part: the block campaigns
 * use (campaign-rules.ts htmlWithUnsubscribe). `display:none` keeps it from being shown or
 * read out; the other declarations are for mail apps that ignore that one. `text` is
 * already escaped.
 */
export const hiddenPreheader = (text: string): string =>
  `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${text}</div>`;

/**
 * A workflow email's text as it leaves (smtp-outbound.ts): the recipient's unsubscribe
 * address where the body was waiting for it, then the footer. What was queued is what the
 * author wrote, byte for byte; the footer is added here, to the mail alone.
 */
export function deliveredText(text: string, address: string, addressLine: string | null): string {
  const lines = [
    ...(addressLine === null ? [] : [addressLine]),
    ...(text.includes(UNSUBSCRIBE_PLACEHOLDER) ? [] : [`Unsubscribe: ${address}`]),
  ];
  const body = withUnsubscribeAddress(text, address);
  return lines.length === 0 ? body : `${body.trimEnd()}\n\n--\n${lines.join('\n')}\n`;
}

/** The same for the formatted part, as its last paragraph. */
export function deliveredHtml(html: string, address: string, addressLine: string | null): string {
  const lines = [
    ...(addressLine === null ? [] : [escapeHtml(addressLine)]),
    ...(showsUnsubscribePlaceholder(html)
      ? []
      : [`<a href="${escapeHtml(address)}">Unsubscribe</a>`]),
  ];
  const body = withUnsubscribeAddress(html, address);
  if (lines.length === 0) return body;
  const footer = `<p style="font-size:12px;color:#666666">${lines.join('<br>')}</p>`;
  const close = body.search(/<\/body\s*>/i);
  return close === -1 ? `${body}${footer}` : `${body.slice(0, close)}${footer}${body.slice(close)}`;
}

/** What stands where the unsubscribe link would be, in the text of a copy. */
const COPY_LINK_TEXT = '[removed from this copy]';

/** The last lines of a copy: whose email it is a copy of, and why it has no link. */
const copyNotice = (recipient: string): string =>
  `This is a copy of an email sent to ${recipient}. Only their own email has a working unsubscribe link.`;

/**
 * A marketing email's text as a COPY leaves, to an address in Cc or Bcc. The unsubscribe
 * link is the contact's own: one request to it withdraws the contact's consent, from
 * whoever holds the message (RFC 8058 section 6: "This specification allows anyone with
 * access to a message to unsubscribe the recipient of the message"). So a copy carries no
 * link: where the body placed one there are plain words, and the footer says whose email
 * this is a copy of.
 */
export function copiedText(text: string, recipient: string, addressLine: string | null): string {
  const lines = [...(addressLine === null ? [] : [addressLine]), copyNotice(recipient)];
  return `${withUnsubscribeAddress(text, COPY_LINK_TEXT).trimEnd()}\n\n--\n${lines.join('\n')}\n`;
}

/**
 * The same for the formatted part. A link the body placed goes nowhere ("#"): its words
 * stay, since the author's markup is not rewritten as the email leaves.
 */
export function copiedHtml(html: string, recipient: string, addressLine: string | null): string {
  const lines = [
    ...(addressLine === null ? [] : [escapeHtml(addressLine)]),
    escapeHtml(copyNotice(recipient)),
  ];
  const body = withUnsubscribeAddress(html, '#');
  const footer = `<p style="font-size:12px;color:#666666">${lines.join('<br>')}</p>`;
  const close = body.search(/<\/body\s*>/i);
  return close === -1 ? `${body}${footer}` : `${body.slice(0, close)}${footer}${body.slice(close)}`;
}

/**
 * An email filled in for one contact, as it is queued. Stops, as every send does, at a
 * merge field with no value or a line break in the subject. For marketing email the
 * unsubscribe field is filled with a placeholder the dispatcher replaces as the email
 * leaves; the footer is not written here but there (deliveredText).
 */
export async function composeEmail(
  trx: DatabaseTransaction,
  context: TenantContext,
  input: {
    readonly contactId: string;
    readonly parts: EmailParts;
    readonly values: ConditionValues;
    readonly publicUrl: string | undefined;
    readonly marketing: boolean;
  },
): Promise<ComposedEmail> {
  const { parts } = input;
  const values = input.marketing
    ? { ...input.values, [EMAIL_UNSUBSCRIBE_MERGE_FIELD]: UNSUBSCRIBE_PLACEHOLDER }
    : input.values;
  const text = await renderWithTriggerLinks(trx, context, {
    contactId: input.contactId,
    text: { subject: parts.subject, body: parts.text },
    values,
    publicUrl: input.publicUrl,
  });
  if (!text.ok) return text;
  if (parts.html === undefined || parts.html === null)
    return { ok: true, subject: text.subject, text: text.body, html: null };
  // The preview line rides as the subject of this second filling-in, so it is checked and
  // escaped as the body's values are.
  const html = await renderWithTriggerLinks(trx, context, {
    contactId: input.contactId,
    text: { subject: parts.preheader ?? '', body: sanitizeEmailHtml(parts.html) },
    values: htmlMergeValues(values),
    publicUrl: input.publicUrl,
  });
  if (!html.ok) return html;
  const preheader = html.subject.trim();
  return {
    ok: true,
    subject: text.subject,
    text: text.body,
    html: `${preheader === '' ? '' : hiddenPreheader(preheader)}${finalEmailHtml(html.body, input.publicUrl)}`,
  };
}
export type EmailPreview = RenderedEmailPreview;

/**
 * The same email for looking at: nothing is stored, no link is issued, and a merge field
 * with no value is left as it was written and listed, where a send would stop.
 */
export function previewEmail(input: {
  readonly parts: EmailParts;
  readonly values: ConditionValues;
  readonly publicUrl: string | undefined;
  readonly addressLine: string | null;
  readonly footer: boolean;
}): EmailPreview {
  const { parts } = input;
  const text = input.footer ? textWithFooter(parts.text, input.addressLine) : parts.text;
  const cleaned =
    parts.html === undefined || parts.html === null ? null : sanitizeEmailHtml(parts.html);
  const html =
    cleaned === null ? null : input.footer ? htmlWithFooter(cleaned, input.addressLine) : cleaned;
  const written = mergeTokens({
    subject: parts.subject,
    body: text,
    html,
    preheader: html === null ? null : parts.preheader,
  });
  const values: Record<string, ConditionValues[string]> = { ...input.values };
  if (input.footer) values[EMAIL_UNSUBSCRIBE_MERGE_FIELD] = UNSUBSCRIBE_PLACEHOLDER;
  const blank = (field: string): boolean => {
    const value = values[field];
    return value === undefined || value === null || String(value).trim() === '';
  };
  const linkPrefix = triggerLinkMergeKey('');
  // A trigger link becomes the contact's own address at a send; here it only has to look
  // like one, and `.invalid` never resolves (RFC 2606).
  for (const field of written)
    if (field.startsWith(linkPrefix) && blank(field))
      values[field] = `https://trigger-link.invalid/${field.slice(linkPrefix.length)}`;
  // A field written with a fallback ({{contact.firstName | default: "there"}}) is never
  // missing: a send writes the fallback.
  const required = new Set(
    requiredMergeTokens({
      subject: parts.subject,
      body: text,
      html,
      preheader: html === null ? null : parts.preheader,
    }),
  );
  const missingFields = written.filter((field) => required.has(field) && blank(field));
  for (const field of missingFields) values[field] = `{{${field}}}`;
  const subjectLineBreak = mergeTokens({ subject: parts.subject, body: '' }).filter((field) =>
    /[\r\n]/.test(String(values[field])),
  );
  // One line, wherever a line is wanted: the subject and the preview text.
  const oneLine = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ') : value,
    ]),
  );
  const subject = renderMessageTemplate({ subject: parts.subject, body: '' }, oneLine);
  const plain = renderMessageTemplate({ subject: '', body: text }, values);
  const formatted =
    html === null
      ? undefined
      : renderMessageTemplate(
          { subject: (parts.preheader ?? '').replace(/[\r\n]+/g, ' '), body: html },
          htmlMergeValues(oneLine),
        );
  // Every field has a value by now, so neither rendering can stop.
  if (!subject.ok || !plain.ok || formatted?.ok === false)
    throw new Error('A preview could not be filled in.');
  const hidden = formatted === undefined ? '' : formatted.subject.trim();
  // The same line as text, for whoever shows it beside the subject.
  const shown =
    hidden === ''
      ? undefined
      : renderMessageTemplate({ subject: (parts.preheader ?? '').trim(), body: '' }, oneLine);
  return {
    subject: subject.subject,
    preheader: shown?.ok === true ? shown.subject : null,
    html:
      formatted === undefined
        ? null
        : `${hidden === '' ? '' : hiddenPreheader(hidden)}${finalEmailHtml(formatted.body, input.publicUrl)}`,
    text: plain.body,
    mergeFields: written.filter((field) => field !== EMAIL_UNSUBSCRIBE_MERGE_FIELD),
    missingFields,
    subjectLineBreak,
  };
}
