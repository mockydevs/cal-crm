import { describe, expect, it } from 'vitest';

import { invoice, quote, receipt, SELLER } from '../test/print-fixtures.js';
import { documentMail, mailRefusalIssue, receiptMail } from './mail-text.js';
import type { MailRefusal } from './shared.js';

const URL = `https://crm.example.test/d/${'A'.repeat(43)}`;

describe('the email of an invoice', () => {
  it('greets the customer, says what is sent, gives the link and says the PDF is attached', () => {
    expect(documentMail(invoice(), { url: URL, attachedPdf: true })).toEqual({
      subject: 'Invoice INV-0007 from Harbor Lights Events',
      text: [
        'Hello Maya Thompson,',
        'Here is invoice INV-0007 from Harbor Lights Events for KES 6,015.01. It is due on 26 Oct 2026.',
        `View it online: ${URL}`,
        'A PDF copy is attached.',
        'Harbor Lights Events',
      ].join('\n\n'),
    });
  });

  it('takes the sender’s own subject and words in place of its own', () => {
    const mail = documentMail(invoice(), {
      subject: 'Your invoice\r\nBcc: someone@example.test',
      message: 'As agreed on the phone.',
      url: URL,
      attachedPdf: false,
    });
    // A subject is one line, whatever was typed.
    expect(mail.subject).toBe('Your invoice Bcc: someone@example.test');
    expect(mail.text).toBe(
      [
        'Hello Maya Thompson,',
        'As agreed on the phone.',
        `View it online: ${URL}`,
        'Harbor Lights Events',
      ].join('\n\n'),
    );
  });

  it('goes without a link where the install gives none, and without names it does not have', () => {
    const bare = invoice({
      dueDate: null,
      customer: { ...invoice().customer, name: ' ' },
      seller: { ...SELLER, name: '' },
    });
    expect(documentMail(bare, { url: null, attachedPdf: true })).toEqual({
      subject: 'Invoice INV-0007',
      text: [
        'Hello,',
        'Here is invoice INV-0007 for KES 6,015.01.',
        'A PDF copy is attached.',
      ].join('\n\n'),
    });
  });
});

describe('the email of a quote', () => {
  it('says until when it can be accepted, and that the link is where to answer', () => {
    const mail = documentMail(quote(), { url: URL, attachedPdf: false });
    expect(mail.subject).toBe('Quote QUO-0003 from Harbor Lights Events');
    expect(mail.text).toContain(
      'Here is quote QUO-0003 from Harbor Lights Events for KES 1,500.00. It can be accepted until 11 Nov 2026.',
    );
    expect(mail.text).toContain(`View it online, and accept or decline it there: ${URL}`);
    expect(documentMail(quote({ dueDate: null }), { url: URL, attachedPdf: false }).text).toContain(
      'for KES 1,500.00.\n\n',
    );
  });
});

describe('the email of a receipt', () => {
  it('thanks the customer, names the payment and its invoice, and links to the invoice', () => {
    expect(receiptMail(receipt(), { url: URL, attachedPdf: true })).toEqual({
      subject: 'Receipt RCT-0003 from Harbor Lights Events',
      text: [
        'Hello Maya Thompson,',
        'Thank you. Here is receipt RCT-0003 for KES 2,000.00, received on 13 Oct 2026 for invoice INV-0007.',
        `View the invoice online: ${URL}`,
        'A PDF copy is attached.',
        'Harbor Lights Events',
      ].join('\n\n'),
    });
    const anonymous = receipt({ seller: { ...receipt().seller, name: '' } });
    expect(receiptMail(anonymous, { url: null, attachedPdf: false }).subject).toBe(
      'Receipt RCT-0003',
    );
  });
});

describe('why messaging did not take an email, in words', () => {
  const issue = (reason: MailRefusal, detail?: string) =>
    mailRefusalIssue({ outcome: 'refused', reason, ...(detail === undefined ? {} : { detail }) });

  it('points at the mailbox when there is none to send from', () => {
    expect(issue('no_mailbox')).toMatchObject({ path: '/mailboxId', code: 'no_mailbox' });
    expect(issue('sender_inactive')).toMatchObject({ path: '/mailboxId', code: 'sender_inactive' });
  });

  it('points at the address for everything about the contact', () => {
    for (const reason of [
      'not_contacts_address',
      'contact_inactive',
      'do_not_contact',
      'suppressed',
      'consent_withdrawn',
      'consent_required',
      'timing_unknown',
    ] as const) {
      const found = issue(reason);
      expect(found).toMatchObject({ path: '/to', code: reason });
      expect(found.message.length).toBeGreaterThan(20);
    }
  });

  it('says why an address is suppressed, and which kind of do not contact it is', () => {
    expect(issue('suppressed', 'hard_bounce').message).toBe(
      'This address is on the suppression list (mail to it bounced), so nothing is sent to it.',
    );
    expect(issue('suppressed', 'something_new').message).toBe(
      'This address is on the suppression list, so nothing is sent to it.',
    );
    expect(issue('suppressed').message).toBe(
      'This address is on the suppression list, so nothing is sent to it.',
    );
    expect(issue('do_not_contact', 'channel').message).toBe(
      'This contact has do not disturb switched on for email.',
    );
    expect(issue('do_not_contact').message).toBe('This contact is marked do not contact.');
  });
});
