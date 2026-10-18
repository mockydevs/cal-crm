// The PDF of a quote, an invoice and a receipt, through the module's own routes on real
// Postgres with the real files service: what the PDF says, who may download it, and that
// one business never prints another's.
import type { FileDownload, Receipt, SalesDocument } from '@repo/contracts';
import { ForbiddenError, NotFoundError, ValidationError } from '@repo/kernel';
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';

import { refusalOf } from '../test/commerce-fixtures.js';
import { sharingSuite, type SharingFixture } from '../test/sharing-fixtures.js';

const suite = sharingSuite();

async function textOf(file: FileDownload): Promise<string> {
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(file.content)), {
    mergePages: true,
  });
  return text;
}

const pdf = (f: SharingFixture, id: string, invocation = f.manager): Promise<FileDownload> =>
  suite.api(f, 'getSalesDocumentPdf', { params: { id } }, invocation) as Promise<FileDownload>;

describe('the PDF of an invoice', () => {
  it('is a PDF named after the number, with the number, the customer and the total', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    const file = await pdf(f, invoice.id);
    expect(file.contentType).toBe('application/pdf');
    expect(file.filename).toBe(`${invoice.number ?? ''}.pdf`);
    expect(Buffer.from(file.content.subarray(0, 5)).toString()).toBe('%PDF-');
    const text = await textOf(file);
    for (const words of [
      'INVOICE',
      invoice.number ?? '',
      'Harbor Lights Events',
      'Maya Thompson',
      'PO Box 4410',
      'Wedding day coordination',
      'KES 1,500.00',
      'Balance due',
      'Thank you for choosing us.',
    ])
      expect(text).toContain(words);
    expect(text).not.toContain('DRAFT');
  });

  it('is read with payments.read or payments.manage, and by nobody else', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    expect((await pdf(f, invoice.id, f.withPermissions('payments.read'))).filename).toBe(
      `${invoice.number ?? ''}.pdf`,
    );
    expect((await pdf(f, invoice.id, f.withPermissions('payments.manage'))).contentType).toBe(
      'application/pdf',
    );
    const refused = await refusalOf(
      () => pdf(f, invoice.id, f.withPermissions('contacts.manage')),
      ForbiddenError,
    );
    expect(refused.message).toContain('payments.read');
  });

  it('is not found from another business, nor for an id that names nothing', async () => {
    const f = await suite.fixture();
    const other = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    await refusalOf(() => pdf(other, invoice.id), NotFoundError);
    await refusalOf(() => pdf(f, 'sdoc_01h455vb4pex5vsknk084sn02q'), NotFoundError);
    await refusalOf(() => pdf(f, 'not-an-id'), ValidationError);
  });

  it('carries the business’s logo as it was when the invoice was issued', async () => {
    const plain = await suite.fixture();
    const branded = await suite.fixture({ logo: true });
    const without = await pdf(plain, (await suite.issued(plain, 'invoice')).id);
    const invoice = await suite.issued(branded, 'invoice');
    expect(invoice.seller?.logoFileId).toMatch(/^file_/);
    const withLogo = await pdf(branded, invoice.id);
    expect(withLogo.content.byteLength).toBeGreaterThan(without.content.byteLength);
    expect(await textOf(withLogo)).toContain(invoice.number ?? '');
  });

  it('is printed without a logo by a role that has no files service', async () => {
    const f = await suite.fixture({ logo: true });
    const invoice = await suite.issued(f, 'invoice');
    const bare = (await suite.api(
      f,
      'getSalesDocumentPdf',
      { params: { id: invoice.id } },
      f.manager,
      suite.routesWith({ files: undefined }),
    )) as FileDownload;
    expect(bare.content.byteLength).toBeLessThan((await pdf(f, invoice.id)).content.byteLength);
    expect(await textOf(bare)).toContain(invoice.number ?? '');
  });
});

describe('the PDF of a draft', () => {
  it('is a preview marked DRAFT, from the business as it is now, with no number', async () => {
    const f = await suite.fixture();
    const draft = await suite.draft(f, 'quote');
    expect(draft.seller).toBeNull();
    const file = await pdf(f, draft.id);
    expect(file.filename).toBe('quote-draft.pdf');
    const text = await textOf(file);
    for (const words of ['DRAFT', 'QUOTE', 'Harbor Lights Events', 'KES 1,500.00'])
      expect(text).toContain(words);
    // Printing changed nothing: the draft is still a draft without a number.
    const after = (await suite.api(f, 'getSalesDocument', {
      params: { id: draft.id },
    })) as SalesDocument;
    expect(after).toMatchObject({ status: 'draft', number: null, revision: draft.revision });
  });
});

describe('the PDF of a receipt', () => {
  it('says the receipt number, the amount, the invoice and what was owed after it', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    const receipt = (await suite.api(f, 'recordPayment', {
      params: { id: invoice.id },
      body: {
        amount: '400.00',
        method: 'mobile_money',
        reference: 'SJK4H7T2QW',
        paidOn: '2026-10-12',
      },
    })) as Receipt;
    const file = (await suite.api(f, 'getReceiptPdf', {
      params: { id: receipt.id },
    })) as FileDownload;
    expect(file).toMatchObject({
      contentType: 'application/pdf',
      filename: `${receipt.number}.pdf`,
    });
    const text = await textOf(file);
    for (const words of [
      'RECEIPT',
      receipt.number,
      '12 Oct 2026',
      'Mobile money',
      'SJK4H7T2QW',
      invoice.number ?? '',
      'KES 400.00',
      'KES 1,100.00',
      'Maya Thompson',
    ])
      expect(text).toContain(words);
  });

  it('is read with payments.read, and is not found from another business', async () => {
    const f = await suite.fixture();
    const other = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    const receipt = (await suite.api(f, 'recordPayment', {
      params: { id: invoice.id },
      body: { amount: '1500.00', method: 'cash' },
    })) as Receipt;
    const read = (await suite.api(
      f,
      'getReceiptPdf',
      { params: { id: receipt.id } },
      f.withPermissions('payments.read'),
    )) as FileDownload;
    expect(read.filename).toBe(`${receipt.number}.pdf`);
    await refusalOf(
      () => suite.api(f, 'getReceiptPdf', { params: { id: receipt.id } }, f.withPermissions()),
      ForbiddenError,
    );
    await refusalOf(
      () => suite.api(other, 'getReceiptPdf', { params: { id: receipt.id } }),
      NotFoundError,
    );
  });
});
