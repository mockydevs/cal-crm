// The words of the email that carries a quote, an invoice or a receipt: a short plain-text
// message with the link to the document, and a line for the PDF when one is attached. Plain
// text, so it reads the same in every mail reader and nothing a business types can be
// markup. Nothing here reads a database or a clock.
import { formatMoney, type Receipt, type SalesDocument } from '@repo/contracts';

import { printedDate } from './print.js';
import type { MailRefused } from './shared.js';

export interface MailText {
  readonly subject: string;
  readonly text: string;
}

export interface MailWords {
  /** The sender's own subject; left out, one naming the document and the business. */
  readonly subject?: string | undefined;
  /** The sender's own words, in place of the line that says what is sent. */
  readonly message?: string | undefined;
  /** The document's public address, where the install gives it one. */
  readonly url: string | null;
  readonly attachedPdf: boolean;
}

/** A header is one line: whatever a name holds, the subject has no line break. */
const oneLine = (text: string): string => text.replaceAll(/\s+/g, ' ').trim();

function compose(
  customer: string,
  seller: string,
  fallbackSubject: string,
  fallbackMessage: string,
  viewed: string,
  words: MailWords,
): MailText {
  return {
    subject: oneLine(words.subject ?? fallbackSubject).slice(0, 200),
    text: [
      customer.trim() === '' ? 'Hello,' : `Hello ${customer.trim()},`,
      words.message ?? fallbackMessage,
      ...(words.url === null ? [] : [`${viewed}: ${words.url}`]),
      ...(words.attachedPdf ? ['A PDF copy is attached.'] : []),
      ...(seller.trim() === '' ? [] : [seller.trim()]),
    ].join('\n\n'),
  };
}

/** The email of an issued quote or invoice. */
export function documentMail(document: SalesDocument, words: MailWords): MailText {
  const seller = document.seller?.name ?? '';
  const from = seller === '' ? '' : ` from ${seller}`;
  const number = document.number ?? '';
  const total = formatMoney(document.totals.total, document.currency);
  if (document.kind === 'quote')
    return compose(
      document.customer.name,
      seller,
      `Quote ${number}${from}`,
      `Here is quote ${number}${from} for ${total}.${
        document.dueDate === null
          ? ''
          : ` It can be accepted until ${printedDate(document.dueDate)}.`
      }`,
      'View it online, and accept or decline it there',
      words,
    );
  return compose(
    document.customer.name,
    seller,
    `Invoice ${number}${from}`,
    `Here is invoice ${number}${from} for ${total}.${
      document.dueDate === null ? '' : ` It is due on ${printedDate(document.dueDate)}.`
    }`,
    'View it online',
    words,
  );
}

/** The email of a payment's receipt. The link, when there is one, is the invoice's. */
export function receiptMail(receipt: Receipt, words: MailWords): MailText {
  const seller = receipt.seller.name;
  const from = seller === '' ? '' : ` from ${seller}`;
  return compose(
    receipt.customer.name,
    seller,
    `Receipt ${receipt.number}${from}`,
    `Thank you. Here is receipt ${receipt.number} for ${formatMoney(receipt.amount, receipt.currency)}, received on ${printedDate(receipt.paidOn)} for invoice ${receipt.invoiceNumber}.`,
    'View the invoice online',
    words,
  );
}

const SUPPRESSIONS: Readonly<Record<string, string>> = {
  hard_bounce: 'mail to it bounced',
  complaint: 'its owner reported a message as spam',
  unsubscribe: 'its owner unsubscribed',
  invalid: 'it is not a working address',
  manual: 'someone on the team added it',
};

/**
 * Why messaging did not take the email, in words for the person sending, and the part of
 * the request it is about. An invoice is a transactional message: it needs no marketing
 * consent, and every other rule of the outbound pipeline still holds for it.
 */
export function mailRefusalIssue(refused: MailRefused): {
  readonly path: string;
  readonly code: string;
  readonly message: string;
} {
  const issue = (path: string, message: string) => ({ path, code: refused.reason, message });
  switch (refused.reason) {
    case 'no_mailbox':
      return issue(
        '/mailboxId',
        'There is no mailbox to send from. Connect one that sends conversations in Settings, or choose another.',
      );
    case 'sender_inactive':
      return issue('/mailboxId', 'The mailbox, or the business, is not active.');
    case 'not_contacts_address':
      return issue(
        '/to',
        "This is not one of the contact's email addresses. Add it to the contact first.",
      );
    case 'contact_inactive':
      return issue('/to', 'This contact is in the trash. Restore the contact first.');
    case 'do_not_contact':
      return issue(
        '/to',
        refused.detail === 'channel'
          ? 'This contact has do not disturb switched on for email.'
          : 'This contact is marked do not contact.',
      );
    case 'suppressed':
      return issue(
        '/to',
        `This address is on the suppression list${
          refused.detail === undefined || SUPPRESSIONS[refused.detail] === undefined
            ? ''
            : ` (${SUPPRESSIONS[refused.detail] ?? ''})`
        }, so nothing is sent to it.`,
      );
    case 'consent_withdrawn':
      return issue('/to', 'This contact withdrew their consent to email.');
    case 'consent_required':
      return issue(
        '/to',
        "No consent to transactional email is recorded for this contact. Record it on the contact's consent first.",
      );
    case 'timing_unknown':
      return issue(
        '/to',
        "Quiet hours are on and this contact has no time zone to keep them in. Set the contact's time zone first.",
      );
  }
}
