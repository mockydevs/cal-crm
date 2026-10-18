// What stage 2 of commerce added to the contract: how an amount is printed, when a document
// can be sent and a quote answered, the name of a PDF, and the five endpoints.
import { describe, expect, it } from 'vitest';

import { formatDecimal, formatMoney } from './commerce-money.js';
import { documentSendRefusal, printedFileName, quoteAnswerRefusal } from './commerce-rules.js';
import {
  commerceEndpoints,
  createSalesDocumentLink,
  getReceiptPdf,
  getSalesDocumentPdf,
  payment,
  salesDocument,
  salesDocumentLinkInput,
  salesDocumentLinkToken,
  sendReceipt,
  sendReceiptInput,
  sendSalesDocument,
  sendSalesDocumentInput,
} from './commerce.js';
import { openApiDocument } from './openapi.js';

describe('an amount as it is printed', () => {
  it('groups thousands and keeps the places it needs, never fewer than asked', () => {
    expect(formatDecimal('1250.5000')).toBe('1,250.5');
    expect(formatDecimal('1250.5000', 2)).toBe('1,250.50');
    expect(formatDecimal('3.0000')).toBe('3');
    expect(formatDecimal('0.0000', 2)).toBe('0.00');
    expect(formatDecimal('999.9999', 2)).toBe('999.9999');
    expect(formatDecimal('1000')).toBe('1,000');
    expect(formatDecimal('1234567.8', 2)).toBe('1,234,567.80');
    expect(formatDecimal('12')).toBe('12');
    expect(formatDecimal('123')).toBe('123');
    expect(formatDecimal('-1250.5', 2)).toBe('-1,250.50');
  });

  it('rounds nothing: a rate prints with every place it has', () => {
    expect(formatDecimal('333.3350', 2)).toBe('333.335');
    expect(formatDecimal('0.0001', 2)).toBe('0.0001');
  });

  it('prints the largest amount the database holds, digit for digit', () => {
    expect(formatDecimal('999999999999999.9999', 2)).toBe('999,999,999,999,999.9999');
  });

  it('prints money with its currency code and the currency’s own places', () => {
    expect(formatMoney('1015.0100', 'KES')).toBe('KES 1,015.01');
    expect(formatMoney('1200.0000', 'JPY')).toBe('JPY 1,200');
    expect(formatMoney('15.5000', 'KWD')).toBe('KWD 15.500');
    expect(formatMoney('0.0000', 'USD')).toBe('USD 0.00');
  });
});

describe('when a document can be sent', () => {
  it('refuses a draft unless it is issued in the same step', () => {
    expect(documentSendRefusal({ kind: 'invoice', status: 'draft' })).toBe(
      'This invoice is a draft. Issue it first, or send it with issueIfDraft.',
    );
    expect(documentSendRefusal({ kind: 'quote', status: 'draft' })).toBe(
      'This quote is a draft. Issue it first, or send it with issueIfDraft.',
    );
    expect(documentSendRefusal({ kind: 'quote', status: 'draft' }, true)).toBeUndefined();
  });

  it('refuses a void invoice, whatever is asked', () => {
    expect(documentSendRefusal({ kind: 'invoice', status: 'void' }, true)).toBe(
      'A void invoice is not sent.',
    );
  });

  it('sends anything else that was issued, again and again', () => {
    for (const status of ['sent', 'partly_paid', 'paid'] as const)
      expect(documentSendRefusal({ kind: 'invoice', status })).toBeUndefined();
    for (const status of ['sent', 'accepted', 'declined'] as const)
      expect(documentSendRefusal({ kind: 'quote', status })).toBeUndefined();
  });
});

describe('when a customer can answer a quote on its public page', () => {
  it('can while it is sent and has not expired', () => {
    expect(quoteAnswerRefusal({ kind: 'quote', status: 'sent' }, false)).toBeUndefined();
  });

  it('cannot once it has expired, was answered, or is not a quote that was sent', () => {
    expect(quoteAnswerRefusal({ kind: 'quote', status: 'sent' }, true)).toBe(
      'This quote has expired. Ask for a new one.',
    );
    expect(quoteAnswerRefusal({ kind: 'quote', status: 'accepted' }, false)).toBe(
      'This quote was already accepted.',
    );
    expect(quoteAnswerRefusal({ kind: 'quote', status: 'declined' }, false)).toBe(
      'This quote was already declined.',
    );
    expect(quoteAnswerRefusal({ kind: 'quote', status: 'draft' }, false)).toBe(
      'This quote is not open for an answer.',
    );
    expect(quoteAnswerRefusal({ kind: 'invoice', status: 'sent' }, false)).toBe(
      'Only a quote is accepted or declined.',
    );
  });
});

describe('the name of a PDF', () => {
  it('is the number, with anything a file name cannot hold replaced', () => {
    expect(printedFileName('INV-0007', 'invoice-draft')).toBe('INV-0007.pdf');
    expect(printedFileName('2026/INV_12', 'invoice-draft')).toBe('2026-INV_12.pdf');
    expect(printedFileName(null, 'quote-draft')).toBe('quote-draft.pdf');
    expect(printedFileName('', 'receipt')).toBe('receipt.pdf');
  });
});

describe('the endpoints of printing, sharing and sending', () => {
  it('are registered once each, after the ones stage 1 serves', () => {
    const ids = commerceEndpoints.map((endpoint) => endpoint.operationId);
    expect(ids.slice(-5)).toEqual([
      'getSalesDocumentPdf',
      'getReceiptPdf',
      'createSalesDocumentLink',
      'sendSalesDocument',
      'sendReceipt',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('describes a PDF as the whole answer, with no JSON schema', () => {
    const document = openApiDocument([getSalesDocumentPdf, getReceiptPdf]);
    for (const path of ['/sales-documents/{id}/pdf', '/payments/{id}/pdf'])
      expect(document.paths?.[path]?.get?.responses?.['200']).toMatchObject({
        content: { 'application/pdf': {} },
      });
    expect(getSalesDocumentPdf.download.types).toEqual(['application/pdf']);
  });

  it('takes a send with nothing but the revision, and fills in the rest', () => {
    expect(sendSalesDocumentInput.parse({ revision: 3 })).toEqual({
      attachPdf: true,
      issueIfDraft: false,
      revision: 3,
    });
    expect(
      sendSalesDocumentInput.parse({
        to: ' Maya@Example.com ',
        subject: ' Your invoice ',
        message: ' As agreed. ',
        attachPdf: false,
        issueIfDraft: true,
        mailboxId: 'mbx_01h455vb4pex5vsknk084sn02q',
        revision: 1,
      }),
    ).toMatchObject({ to: 'Maya@Example.com', subject: 'Your invoice', message: 'As agreed.' });
  });

  it('refuses a send without a revision, with a subject over a line, or to no address', () => {
    expect(sendSalesDocumentInput.safeParse({}).success).toBe(false);
    expect(sendSalesDocumentInput.safeParse({ revision: 1, subject: 'a\nb' }).success).toBe(false);
    expect(sendSalesDocumentInput.safeParse({ revision: 1, to: 'not an address' }).success).toBe(
      false,
    );
    expect(sendSalesDocumentInput.safeParse({ revision: 1, other: true }).success).toBe(false);
  });

  it('takes a receipt’s send with a key for the press of Send', () => {
    const idempotencyKey = '0198a5d0-0000-7000-8000-000000000001';
    expect(sendReceiptInput.parse({ idempotencyKey })).toEqual({ attachPdf: true, idempotencyKey });
    expect(sendReceiptInput.safeParse({}).success).toBe(false);
    expect(sendReceipt.path).toBe('/payments/{id}/send');
    expect(sendSalesDocument.path).toBe('/sales-documents/{id}/send');
  });

  it('asks for a new address only when told to', () => {
    expect(salesDocumentLinkInput.parse({})).toEqual({ regenerate: false });
    expect(createSalesDocumentLink.method).toBe('post');
  });

  it('knows a token by its shape', () => {
    expect(salesDocumentLinkToken.safeParse('A'.repeat(43)).success).toBe(true);
    expect(salesDocumentLinkToken.safeParse('A'.repeat(42)).success).toBe(false);
    expect(salesDocumentLinkToken.safeParse(`${'A'.repeat(42)}/`).success).toBe(false);
  });
});

describe('what stage 2 added to a document and a payment', () => {
  it('is optional, so what was written before it still reads', () => {
    for (const field of ['sentAt', 'lastSentAt', 'sendCount', 'publicLink'] as const)
      expect(salesDocument.shape[field].safeParse(undefined).success).toBe(true);
    for (const field of ['lastSentAt', 'sendCount'] as const)
      expect(payment.shape[field].safeParse(undefined).success).toBe(true);
    expect(salesDocument.shape.publicLink.safeParse(null).success).toBe(true);
    expect(
      salesDocument.shape.publicLink.safeParse({
        url: `https://crm.example.test/d/${'A'.repeat(43)}`,
        createdAt: '2026-10-12T09:30:00.000Z',
      }).success,
    ).toBe(true);
  });
});
