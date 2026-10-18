import { describe, expect, it } from 'vitest';

import {
  addDays,
  allowedDocumentActions,
  DEFAULT_NUMBER_PREFIXES,
  documentActionRefusal,
  formatDocumentNumber,
  invoiceStatuses,
  invoiceStatusFor,
  isExpired,
  isOverdue,
  paymentRefusal,
  quoteStatuses,
  salesDocumentActions,
  salesDocumentStatuses,
  todayIn,
  type DocumentState,
} from './commerce-rules.js';

const quote = (change: Partial<DocumentState> = {}): DocumentState => ({
  kind: 'quote',
  status: 'draft',
  number: null,
  amountPaid: '0.0000',
  converted: false,
  ...change,
});
const invoice = (change: Partial<DocumentState> = {}): DocumentState => ({
  ...quote(),
  kind: 'invoice',
  ...change,
});

describe('numbers', () => {
  it('are the prefix and the counter, with at least four digits', () => {
    expect(formatDocumentNumber('INV-', 1)).toBe('INV-0001');
    expect(formatDocumentNumber('QUO-', 42)).toBe('QUO-0042');
    expect(formatDocumentNumber('RCT-', 9999)).toBe('RCT-9999');
    expect(formatDocumentNumber('RCT-', 10000)).toBe('RCT-10000');
    expect(formatDocumentNumber('', 7)).toBe('0007');
    expect(formatDocumentNumber('2026/', 123456789012)).toBe('2026/123456789012');
    expect(DEFAULT_NUMBER_PREFIXES).toEqual({ quote: 'QUO-', invoice: 'INV-', receipt: 'RCT-' });
  });
});

describe('statuses', () => {
  it('are those of a quote and those of an invoice, together', () => {
    expect(new Set([...quoteStatuses, ...invoiceStatuses])).toEqual(new Set(salesDocumentStatuses));
  });
});

describe('what a document allows', () => {
  it('lets a new draft be edited, issued, deleted and copied, and nothing else', () => {
    expect(allowedDocumentActions(quote())).toEqual(['update', 'delete', 'issue', 'duplicate']);
    expect(allowedDocumentActions(invoice())).toEqual(['update', 'delete', 'issue', 'duplicate']);
  });

  it('freezes an issued document: no edit, no second issue, no delete', () => {
    for (const state of [
      quote({ status: 'sent', number: 'QUO-0001' }),
      quote({ status: 'accepted', number: 'QUO-0001' }),
      quote({ status: 'declined', number: 'QUO-0001' }),
      invoice({ status: 'sent', number: 'INV-0001' }),
      invoice({ status: 'partly_paid', number: 'INV-0001', amountPaid: '10.0000' }),
      invoice({ status: 'paid', number: 'INV-0001', amountPaid: '100.0000' }),
      invoice({ status: 'void', number: 'INV-0001' }),
    ]) {
      const noun = state.kind;
      expect(documentActionRefusal('update', state)).toBe(
        `This ${noun} has been issued. Revise it to change it.`,
      );
      expect(documentActionRefusal('issue', state)).toBe(
        `This ${noun} has been issued. Revise it to change it.`,
      );
      expect(documentActionRefusal('delete', state)).toBe(
        `An issued ${noun} is kept. It cannot be deleted.`,
      );
      expect(documentActionRefusal('duplicate', state)).toBeUndefined();
    }
  });

  it('keeps a revised draft, which has a number, from being deleted', () => {
    expect(documentActionRefusal('delete', quote({ number: 'QUO-0003' }))).toBe(
      'This quote already has a number, so it is kept. Issue it again.',
    );
    expect(documentActionRefusal('delete', invoice({ number: 'INV-0003' }))).toBe(
      'This invoice already has a number, so it is kept. Issue it again or void it.',
    );
    // Such an invoice can still be voided, which keeps the number accounted for.
    expect(documentActionRefusal('void', invoice({ number: 'INV-0003' }))).toBeUndefined();
    expect(documentActionRefusal('void', invoice())).toBe(
      'This draft was never issued. Delete it instead.',
    );
  });

  it('answers a sent quote once, and turns a sent or accepted one into an invoice once', () => {
    const sent = quote({ status: 'sent', number: 'QUO-0001' });
    expect(allowedDocumentActions(sent)).toEqual([
      'revise',
      'accept',
      'decline',
      'convert',
      'duplicate',
    ]);
    const accepted = quote({ status: 'accepted', number: 'QUO-0001' });
    expect(allowedDocumentActions(accepted)).toEqual(['revise', 'convert', 'duplicate']);
    const declined = quote({ status: 'declined', number: 'QUO-0001' });
    expect(allowedDocumentActions(declined)).toEqual(['revise', 'duplicate']);
    expect(documentActionRefusal('accept', accepted)).toBe(
      'Only a quote that was sent can be answered.',
    );
    expect(documentActionRefusal('decline', quote())).toBe(
      'Only a quote that was sent can be answered.',
    );
    expect(documentActionRefusal('convert', declined)).toBe(
      'Only a quote that was sent or accepted becomes an invoice.',
    );
    expect(documentActionRefusal('convert', quote())).toBe(
      'Only a quote that was sent or accepted becomes an invoice.',
    );
    const converted = quote({ status: 'accepted', number: 'QUO-0001', converted: true });
    expect(documentActionRefusal('convert', converted)).toBe(
      'An invoice was already made from this quote.',
    );
    expect(documentActionRefusal('revise', converted)).toBe(
      'An invoice was made from this quote, so it can no longer change.',
    );
    expect(allowedDocumentActions(converted)).toEqual(['duplicate']);
  });

  it('keeps the actions of one kind from the other', () => {
    const sent = invoice({ status: 'sent', number: 'INV-0001' });
    expect(documentActionRefusal('accept', sent)).toBe('Only a quote is accepted or declined.');
    expect(documentActionRefusal('decline', sent)).toBe('Only a quote is accepted or declined.');
    expect(documentActionRefusal('convert', sent)).toBe('Only a quote becomes an invoice.');
    const quoted = quote({ status: 'sent', number: 'QUO-0001' });
    expect(documentActionRefusal('void', quoted)).toBe('Only an invoice is voided.');
    expect(documentActionRefusal('record_payment', quoted)).toBe(
      'A payment is recorded against an invoice.',
    );
  });

  it('revises and voids an invoice only while nothing is paid on it', () => {
    const sent = invoice({ status: 'sent', number: 'INV-0001' });
    expect(allowedDocumentActions(sent)).toEqual(['revise', 'void', 'record_payment', 'duplicate']);
    const part = invoice({ status: 'partly_paid', number: 'INV-0001', amountPaid: '0.0100' });
    expect(allowedDocumentActions(part)).toEqual(['record_payment', 'duplicate']);
    expect(documentActionRefusal('revise', part)).toBe(
      'This invoice has a payment on it. Reverse the payment before changing the invoice.',
    );
    expect(documentActionRefusal('void', part)).toBe(
      'This invoice has a payment on it. Reverse the payment before voiding the invoice.',
    );
    const paid = invoice({ status: 'paid', number: 'INV-0001', amountPaid: '50.0000' });
    expect(allowedDocumentActions(paid)).toEqual(['duplicate']);
    expect(documentActionRefusal('record_payment', paid)).toBe(
      'This invoice is already paid in full.',
    );
    // An invoice that came to nothing is paid with nothing on it: it can still be undone.
    const free = invoice({ status: 'paid', number: 'INV-0002' });
    expect(allowedDocumentActions(free)).toEqual(['revise', 'void', 'duplicate']);
    const voided = invoice({ status: 'void', number: 'INV-0001' });
    expect(allowedDocumentActions(voided)).toEqual(['duplicate']);
    expect(documentActionRefusal('revise', voided)).toBe(
      'A void invoice cannot change. Duplicate it instead.',
    );
    expect(documentActionRefusal('void', voided)).toBe('This invoice is already void.');
    expect(documentActionRefusal('record_payment', voided)).toBe('This invoice is void.');
    expect(documentActionRefusal('record_payment', invoice())).toBe(
      'Issue this invoice before recording a payment.',
    );
    expect(documentActionRefusal('revise', invoice())).toBe('This invoice is already a draft.');
    expect(documentActionRefusal('revise', quote())).toBe('This quote is already a draft.');
  });

  it('answers for every action in every state', () => {
    for (const status of quoteStatuses)
      for (const action of salesDocumentActions)
        expect(['string', 'undefined']).toContain(
          typeof documentActionRefusal(action, quote({ status })),
        );
    for (const status of invoiceStatuses)
      for (const action of salesDocumentActions)
        expect(['string', 'undefined']).toContain(
          typeof documentActionRefusal(action, invoice({ status })),
        );
  });
});

describe('what payments make of an invoice', () => {
  it('is sent with nothing paid, partly paid with something, paid with everything', () => {
    expect(invoiceStatusFor('116.0000', '0.0000')).toBe('sent');
    expect(invoiceStatusFor('116.0000', '0.0100')).toBe('partly_paid');
    expect(invoiceStatusFor('116.0000', '115.9900')).toBe('partly_paid');
    expect(invoiceStatusFor('116.0000', '116.0000')).toBe('paid');
    // An invoice that comes to nothing owes nothing the moment it is issued.
    expect(invoiceStatusFor('0.0000', '0.0000')).toBe('paid');
  });

  it('refuses a payment of nothing, of less than the smallest unit, or of more than is owed', () => {
    expect(paymentRefusal('50', '116.0000', 'KES')).toBeUndefined();
    expect(paymentRefusal('116.00', '116.0000', 'KES')).toBeUndefined();
    expect(paymentRefusal('0', '116.0000', 'KES')?.code).toBe('invalid_amount');
    expect(paymentRefusal('-5', '116.0000', 'KES')?.code).toBe('invalid_amount');
    expect(paymentRefusal('ten', '116.0000', 'KES')?.code).toBe('invalid_amount');
    expect(paymentRefusal('10.005', '116.0000', 'KES')?.code).toBe('amount_precision');
    expect(paymentRefusal('10.5', '116.0000', 'JPY')?.code).toBe('amount_precision');
    expect(paymentRefusal('116.01', '116.0000', 'KES')).toEqual({
      code: 'overpayment',
      message: 'This is more than is still owed on the invoice.',
    });
    expect(paymentRefusal('0.01', '0.0000', 'KES')?.code).toBe('overpayment');
  });
});

describe('dates', () => {
  it('reads today in the business’s time zone, not the server’s', () => {
    const moment = new Date('2026-10-11T21:30:00Z');
    expect(todayIn('Africa/Nairobi', moment)).toBe('2026-10-12');
    expect(todayIn('UTC', moment)).toBe('2026-10-11');
    expect(todayIn('America/Los_Angeles', moment)).toBe('2026-10-11');
    expect(todayIn('Pacific/Kiritimati', moment)).toBe('2026-10-12');
  });

  it('adds days across months, years and leap days', () => {
    expect(addDays('2026-10-12', 0)).toBe('2026-10-12');
    expect(addDays('2026-10-12', 14)).toBe('2026-10-26');
    expect(addDays('2026-10-25', 30)).toBe('2026-11-24');
    expect(addDays('2026-12-20', 30)).toBe('2027-01-19');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(() => addDays('12/10/2026', 1)).toThrow(TypeError);
  });

  it('calls an invoice overdue the day after its due date, while something is owed', () => {
    const owed = {
      kind: 'invoice',
      status: 'sent',
      dueDate: '2026-10-12',
      balanceDue: '116.0000',
    } as const;
    expect(isOverdue(owed, '2026-10-11')).toBe(false);
    // Due through the whole of its due date.
    expect(isOverdue(owed, '2026-10-12')).toBe(false);
    expect(isOverdue(owed, '2026-10-13')).toBe(true);
    expect(isOverdue({ ...owed, status: 'partly_paid' }, '2026-10-13')).toBe(true);
    for (const status of ['draft', 'paid', 'void'] as const)
      expect(isOverdue({ ...owed, status }, '2026-10-13')).toBe(false);
    expect(isOverdue({ ...owed, balanceDue: '0.0000' }, '2026-10-13')).toBe(false);
    expect(isOverdue({ ...owed, dueDate: null }, '2026-10-13')).toBe(false);
    expect(isOverdue({ ...owed, kind: 'quote' }, '2026-10-13')).toBe(false);
  });

  it('calls a quote expired the day after its last day, while it has no answer', () => {
    const sent = { kind: 'quote', status: 'sent', dueDate: '2026-10-12' } as const;
    expect(isExpired(sent, '2026-10-12')).toBe(false);
    expect(isExpired(sent, '2026-10-13')).toBe(true);
    for (const status of ['draft', 'accepted', 'declined'] as const)
      expect(isExpired({ ...sent, status }, '2026-10-13')).toBe(false);
    expect(isExpired({ ...sent, dueDate: null }, '2026-10-13')).toBe(false);
    expect(isExpired({ ...sent, kind: 'invoice' }, '2026-10-13')).toBe(false);
  });
});
