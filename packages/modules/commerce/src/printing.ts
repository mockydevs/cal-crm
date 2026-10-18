// Reading a quote, an invoice or a receipt for print: the document as the API returns it,
// turned into what the page says (print.ts), with the logo its seller had. The PDF is then
// drawn from those two alone (print-pdf.ts).
import { requireBusiness, type Invocation } from '@repo/commands';
import type { FileDownload, Receipt, SalesDocument, SellerSnapshot } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';

import { readDocument } from './documents.js';
import { readReceipt } from './payment-reads.js';
import { MAX_LOGO_BYTES, renderPdf, type PrintedLogo } from './print-pdf.js';
import { printedDocument, printedReceipt, type Printed } from './print.js';
import { sellerOf } from './rules.js';
import { storedSettings } from './settings.js';
import type { CommerceFile, CommerceOptions } from './shared.js';

/** What a page is drawn from: what it says, and the logo to draw on it, if any. */
export interface Printable {
  readonly printed: Printed;
  readonly logo: CommerceFile | undefined;
}

/** The seller's logo as the files module holds it, when there is one and a role to read it. */
async function logoOf(
  options: CommerceOptions,
  trx: DatabaseTransaction,
  seller: SellerSnapshot | null,
): Promise<CommerceFile | undefined> {
  const fileId = seller?.logoFileId ?? null;
  if (options.files === undefined || fileId === null) return undefined;
  return options.files.read(trx, fileId);
}

/** A document as it is printed. A draft is printed with the business as it is now. */
export async function printableOf(
  options: CommerceOptions,
  trx: DatabaseTransaction,
  invocation: Invocation,
  document: SalesDocument,
): Promise<Printable> {
  let seller = document.seller;
  if (seller === null) {
    const businessId = requireBusiness(invocation.context);
    seller = sellerOf(
      await options.business.profile(trx, invocation),
      await storedSettings(trx, businessId),
    );
  }
  return {
    printed: printedDocument(document, seller),
    logo: await logoOf(options, trx, seller),
  };
}

/** One quote or invoice, read for print. */
export async function readPrintableDocument(
  options: CommerceOptions,
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
): Promise<Printable> {
  return printableOf(
    options,
    trx,
    invocation,
    await readDocument(options, trx, invocation, publicId),
  );
}

/** A receipt as it is printed. */
export async function printableReceipt(
  options: CommerceOptions,
  trx: DatabaseTransaction,
  receipt: Receipt,
): Promise<Printable> {
  return { printed: printedReceipt(receipt), logo: await logoOf(options, trx, receipt.seller) };
}

/** One payment, read for print as its receipt. */
export async function readPrintableReceipt(
  options: CommerceOptions,
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
): Promise<Printable> {
  return printableReceipt(options, trx, await readReceipt(trx, invocation, publicId));
}

/** A logo's bytes. One too large to print is left off, and is never read. */
export async function logoBytes(file: CommerceFile | undefined): Promise<PrintedLogo | undefined> {
  if (file === undefined || file.size > MAX_LOGO_BYTES) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of await file.open()) chunks.push(Buffer.from(chunk as Uint8Array));
  return { contentType: file.contentType, bytes: Buffer.concat(chunks) };
}

/** The PDF of what was read, named after its number. */
export async function pdfOf(printable: Printable): Promise<FileDownload> {
  return {
    content: await renderPdf(printable.printed, await logoBytes(printable.logo)),
    contentType: 'application/pdf',
    filename: printable.printed.fileName,
  };
}
