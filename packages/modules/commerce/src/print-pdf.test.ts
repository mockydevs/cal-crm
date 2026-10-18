// The PDF itself, read back: its text and its pages, never its bytes. Each case draws a
// real PDF with pdfmake and reads it with pdf.js (unpdf), as a customer's reader would.
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';

import { invoice, manyLines, PNG, quote, receipt } from '../test/print-fixtures.js';
import { MAX_LOGO_BYTES, pdfDefinition, renderPdf } from './print-pdf.js';
import { printedDocument, printedReceipt } from './print.js';

async function read(pdf: Uint8Array): Promise<{ pages: string[]; text: string }> {
  // pdf.js takes the bytes for its own: it is handed a copy.
  const document = await getDocumentProxy(new Uint8Array(pdf));
  const { text } = await extractText(document, { mergePages: false });
  return { pages: text, text: text.join('\n') };
}

const isPdf = (bytes: Uint8Array): boolean =>
  Buffer.from(bytes.subarray(0, 5)).toString() === '%PDF-';

describe('an invoice as a PDF', () => {
  it('says its number, who it is from and for, every line, and every total', async () => {
    const pdf = await renderPdf(printedDocument(invoice()));
    expect(isPdf(pdf)).toBe(true);
    const { pages, text } = await read(pdf);
    expect(pages).toHaveLength(1);
    for (const words of [
      'INVOICE',
      'INV-0007',
      'Harbor Lights Events',
      '12 Riverside Drive',
      'Tax number: P051234567X',
      'Maya Thompson',
      'Thompson & Daughters Ltd',
      '12 Oct 2026',
      '26 Oct 2026',
      'Event planning',
      'Site visits, vendor calls and the run of show.',
      '3 hour',
      '333.335',
      '1,000.01',
      'Venue deposit',
      'KES 6,000.01',
      '-KES 125.00',
      'Tax 16% on 875.01',
      'KES 140.00',
      'KES 6,015.01',
      '-KES 2,000.00',
      'KES 4,015.01',
      'Thank you for choosing us.',
      'M-Pesa paybill 522522, account HARBOR.',
      'Payment within 14 days.',
      'Page 1 of 1',
    ])
      expect(text).toContain(words);
    // The team's own note is never printed, and an issued invoice carries no mark.
    expect(text).not.toContain('Margin is thin');
    expect(text).not.toContain('DRAFT');
  });

  it('runs over as many pages as its lines need, with the headings again on each', async () => {
    const long = invoice({ lines: manyLines(120) });
    const { pages } = await read(await renderPdf(printedDocument(long)));
    expect(pages.length).toBeGreaterThan(2);
    for (const [index, page] of pages.entries()) {
      expect(page).toContain(`Page ${String(index + 1)} of ${String(pages.length)}`);
      // Every page that holds lines starts its table with the headings.
      if (page.includes('of the long list')) expect(page).toContain('Amount (KES)');
    }
    const all = pages.join('\n');
    expect(all).toContain('Line 1 of the long list');
    expect(all).toContain('Line 120 of the long list');
    // The totals come once, after the last line.
    expect(all.match(/Balance due/g)).toHaveLength(1);
    expect(all.indexOf('Balance due')).toBeGreaterThan(all.indexOf('Line 120 of the long list'));
  });

  it('prints names in Latin with accents, Greek and Cyrillic', async () => {
    const names = 'Łódź Žižkov Nguyễn Ærø Ελένη Сергей';
    const { text } = await read(
      await renderPdf(
        printedDocument(invoice({ customer: { ...invoice().customer, name: names } })),
      ),
    );
    expect(text).toContain(names);
  });

  it('is still drawn when a name is in a script the font does not have', async () => {
    const pdf = await renderPdf(
      printedDocument(invoice({ customer: { ...invoice().customer, name: '山田太郎 محمد' } })),
    );
    const { text } = await read(pdf);
    expect(text).toContain('INV-0007');
    expect(text).toContain('KES 6,015.01');
  });
});

describe('a draft, a void invoice and a quote as PDFs', () => {
  it('marks a draft DRAFT and names it Draft', async () => {
    const draft = invoice({ status: 'draft', number: null, issueDate: null, dueDate: null });
    const { text } = await read(await renderPdf(printedDocument(draft)));
    expect(text).toContain('DRAFT');
    expect(text).toContain('Draft');
    expect(text).not.toContain('Balance due');
  });

  it('marks a void invoice VOID', async () => {
    const { text } = await read(await renderPdf(printedDocument(invoice({ status: 'void' }))));
    expect(text).toContain('VOID');
  });

  it('prints a quote with its last day and no balance', async () => {
    const { text } = await read(await renderPdf(printedDocument(quote())));
    for (const words of ['QUOTE', 'QUO-0003', 'Valid until', '11 Nov 2026', 'KES 1,500.00'])
      expect(text).toContain(words);
    expect(text).not.toContain('Balance due');
    expect(text).not.toContain('How to pay');
  });
});

describe('a receipt as a PDF', () => {
  it('says its number, the date, method and reference, the amount and the balance after', async () => {
    const { pages, text } = await read(await renderPdf(printedReceipt(receipt())));
    expect(pages).toHaveLength(1);
    for (const words of [
      'RECEIPT',
      'RCT-0003',
      '13 Oct 2026',
      'Mobile money',
      'SJK4H7T2QW',
      'INV-0007',
      'Amount received',
      'KES 2,000.00',
      'Balance after this payment',
      'KES 4,015.01',
      'Maya Thompson',
      'Harbor Lights Events',
    ])
      expect(text).toContain(words);
  });

  it('marks a reversed payment', async () => {
    const reversed = receipt({ status: 'reversed', reversalReason: 'Wrong invoice.' });
    const { text } = await read(await renderPdf(printedReceipt(reversed)));
    expect(text).toContain('REVERSED');
    expect(text).toContain('This payment was reversed: Wrong invoice.');
  });
});

describe('the logo on a PDF', () => {
  const printed = printedDocument(invoice());

  it('is embedded when it is a PNG or a JPEG of a size worth printing', () => {
    const logo = { contentType: 'image/png', bytes: PNG };
    expect(pdfDefinition(printed, logo).images).toEqual({
      logo: `data:image/png;base64,${PNG.toString('base64')}`,
    });
    expect(JSON.stringify(pdfDefinition(printed, logo).content)).toContain('"image":"logo"');
  });

  it('is left off when it is another kind of image, empty, or too large', () => {
    for (const logo of [
      { contentType: 'image/webp', bytes: PNG },
      { contentType: 'image/gif', bytes: PNG },
      { contentType: 'image/png', bytes: new Uint8Array() },
      { contentType: 'image/png', bytes: new Uint8Array(MAX_LOGO_BYTES + 1) },
    ]) {
      const definition = pdfDefinition(printed, logo);
      expect(definition.images).toBeUndefined();
      expect(JSON.stringify(definition.content)).not.toContain('"image"');
    }
    expect(pdfDefinition(printed).images).toBeUndefined();
  });

  it('is drawn with the document, which is larger for it', async () => {
    const bare = await renderPdf(printed);
    const withLogo = await renderPdf(printed, { contentType: 'image/png', bytes: PNG });
    expect(isPdf(withLogo)).toBe(true);
    expect(withLogo.byteLength).toBeGreaterThan(bare.byteLength);
    expect((await read(withLogo)).text).toContain('INV-0007');
  });

  it('never stops a document: one that is not the image it says it is is left off', async () => {
    const broken = { contentType: 'image/png', bytes: Buffer.from('not an image at all') };
    const pdf = await renderPdf(printed, broken);
    expect(isPdf(pdf)).toBe(true);
    expect((await read(pdf)).text).toContain('KES 6,015.01');
  });
});

describe('what the PDF is allowed to reach', () => {
  it('names the document in its properties and reaches for nothing outside itself', () => {
    const definition = pdfDefinition(printed());
    expect(definition.info).toMatchObject({
      title: 'Invoice INV-0007',
      author: 'Harbor Lights Events',
    });
    // No address is named anywhere in what pdfmake is handed: nothing can be fetched.
    expect(JSON.stringify(definition)).not.toMatch(/https?:\/\//);
  });

  it('writes whatever a customer typed as text, never as an address to load', async () => {
    const hostile = invoice({
      notes: 'https://attacker.example.test/pixel.png',
      customer: { ...invoice().customer, name: 'data:image/png;base64,AAAA' },
    });
    const { text } = await read(await renderPdf(printedDocument(hostile)));
    expect(text).toContain('https://attacker.example.test/pixel.png');
    expect(text).toContain('data:image/png;base64,AAAA');
  });

  function printed() {
    return printedDocument(invoice({ notes: '', terms: '' }));
  }
});
