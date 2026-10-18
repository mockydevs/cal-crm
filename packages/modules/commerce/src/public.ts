// The public side of quotes and invoices: what whoever holds a document's address may do
// with it, with no sign-in. The transport (apps/server) owns HTTP: the shared rate limit,
// the headers, the redirect after an answer. This file owns everything read and written.
//
// The rules it keeps:
// - the token is the whole request. Its digest finds the document's business through one
//   narrow lookup (private.commerce_document_link_scope), and the row is then read again
//   under row-level security, in that business alone;
// - an address answers only while its document is in force: one that is void, or back to a
//   draft to be corrected, is "no longer available", and so is one whose address was
//   replaced or whose business is not active;
// - the page shows what the PDF shows and nothing else: never the team's own note;
// - a sent quote that has not expired can be accepted or declined, once. The answer runs
//   the quote's own command as the contact the quote is for, under the quote's row lock,
//   with the address checked again there. Pressing the same button again changes nothing
//   and says what already stands.
import type { Readable } from 'node:stream';

import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  isExpired,
  quoteAnswerRefusal,
  quoteAnswers,
  salesDocumentLinkToken,
  SALES_DOCUMENT_LINK_PATH,
  type FileDownload,
  type QuoteAnswer,
  type SalesDocument,
} from '@repo/contracts';
import { withTenant, type Database, type DatabaseTransaction } from '@repo/db';
import { AppError, ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { createDocumentCommands, lockedDocument, readDocument, stateOf } from './documents.js';
import { linkDigest } from './links.js';
import { documentPage, unavailablePage } from './print-html.js';
import { MAX_LOGO_BYTES } from './print-pdf.js';
import { printedDate } from './print.js';
import { pdfOf, printableOf, type Printable } from './printing.js';
import { kindOf, statusOf } from './rules.js';
import { businessToday, heldBusiness, MANAGE, type CommerceOptions } from './shared.js';

/** What the transport says about a request. The address is the one the server saw. */
export interface PublicDocumentRequest {
  readonly requestId: string;
  readonly ipAddress: string;
  readonly userAgent?: string | undefined;
}

/**
 * What an address answers with: the thing asked for; `gone` for a document that is void,
 * withdrawn or whose address was replaced after it was read; `unknown` for anything that
 * is not an address of this install. The transport shows the last two the same way.
 */
export type PublicAnswer<Value> =
  | { readonly outcome: 'ok'; readonly value: Value }
  | { readonly outcome: 'gone' }
  | { readonly outcome: 'unknown' };

export interface PublicDocumentHandlers {
  /** The document's page, as HTML. */
  readonly page: (token: string, request: PublicDocumentRequest) => Promise<PublicAnswer<string>>;
  readonly pdf: (
    token: string,
    request: PublicDocumentRequest,
  ) => Promise<PublicAnswer<FileDownload>>;
  /** The seller's logo, for the page's own image. */
  readonly logo: (
    token: string,
    request: PublicDocumentRequest,
  ) => Promise<
    PublicAnswer<{
      readonly contentType: string;
      readonly size: number;
      readonly body: Readable;
    }>
  >;
  /**
   * The customer's answer to a quote. `answered` says the quote now stands as they asked
   * (also when it already did); otherwise the page says why not.
   */
  readonly answer: (
    token: string,
    answer: QuoteAnswer,
    request: PublicDocumentRequest,
  ) => Promise<PublicAnswer<{ readonly answered: boolean; readonly html: string }>>;
  /** The page of an address that opens nothing. */
  readonly unavailable: () => string;
}

interface Scope {
  readonly agencyId: string;
  readonly businessId: string;
  readonly documentId: string;
  readonly digest: string;
  readonly token: string;
}

/** The image types a browser shows on the page. */
const PAGE_LOGO_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const answerInput = z.strictObject({
  documentId: z.uuid(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});

/** What stands above the document: what happened to it, in words for its customer. */
function noticeOf(document: SalesDocument): string | undefined {
  const on = (moment: string | null): string =>
    moment === null ? '' : ` on ${printedDate(moment.slice(0, 10))}`;
  if (document.kind === 'quote') {
    if (document.status === 'accepted') return `This quote was accepted${on(document.acceptedAt)}.`;
    if (document.status === 'declined') return `This quote was declined${on(document.declinedAt)}.`;
    if (document.expired)
      return `This quote expired${document.dueDate === null ? '' : ` on ${printedDate(document.dueDate)}`}. Ask for a new one.`;
    return undefined;
  }
  if (document.status === 'paid') return 'This invoice is paid. Thank you.';
  return undefined;
}

export function createPublicDocumentHandlers(
  db: Database,
  options: CommerceOptions,
): PublicDocumentHandlers {
  const services: Services = { db, authorize: allowEveryone };
  const documents = createDocumentCommands(options);

  /** The one way across businesses: a token's digest names its document and its business. */
  async function scopeOf(token: string): Promise<Scope | undefined> {
    if (!salesDocumentLinkToken.safeParse(token).success) return undefined;
    const digest = linkDigest(token);
    const {
      rows: [found],
    } = await sql<{ agency_id: string; business_id: string; document_id: string }>`
      select agency_id, business_id, document_id
      from private.commerce_document_link_scope(${digest})
    `.execute(db);
    if (found === undefined) return undefined;
    return {
      agencyId: found.agency_id,
      businessId: found.business_id,
      documentId: found.document_id,
      digest,
      token,
    };
  }

  /** Whoever holds the address reads as the contact, with no permission of anyone's. */
  const reader = (scope: Scope, request: PublicDocumentRequest): Invocation => ({
    context: {
      agencyId: scope.agencyId,
      businessId: scope.businessId,
      actorKind: 'contact',
      correlationId: z.uuid().parse(request.requestId),
    },
    permissions: new Set(),
  });

  /**
   * The document behind an address, read under row-level security in its own business, or
   * nothing when the address was replaced meanwhile or the document is not in force.
   */
  async function open(
    trx: DatabaseTransaction,
    scope: Scope,
    invocation: Invocation,
  ): Promise<SalesDocument | undefined> {
    const link = await trx
      .selectFrom('commerce.document_links')
      .select('id')
      .where('document_id', '=', scope.documentId)
      .where('digest', '=', scope.digest)
      .executeTakeFirst();
    if (link === undefined) return undefined;
    const document = await readDocument(
      options,
      trx,
      invocation,
      toPublicId('sales_document', scope.documentId),
    );
    return document.status === 'draft' || document.status === 'void' ? undefined : document;
  }

  /** Reads the document and what it is printed from, in one transaction. */
  async function read(
    scope: Scope,
    request: PublicDocumentRequest,
  ): Promise<{ readonly document: SalesDocument; readonly printable: Printable } | undefined> {
    const invocation = reader(scope, request);
    return withTenant(db, invocation.context, async (trx) => {
      const document = await open(trx, scope, invocation);
      if (document === undefined) return undefined;
      return { document, printable: await printableOf(options, trx, invocation, document) };
    });
  }

  const shownLogo = (printable: Printable): boolean =>
    printable.logo !== undefined &&
    PAGE_LOGO_TYPES.has(printable.logo.contentType) &&
    printable.logo.size <= MAX_LOGO_BYTES;

  const pageOf = (
    scope: Scope,
    found: { readonly document: SalesDocument; readonly printable: Printable },
    notice?: string,
  ): string =>
    documentPage({
      printed: found.printable.printed,
      path: `${SALES_DOCUMENT_LINK_PATH}/${scope.token}`,
      logo: shownLogo(found.printable),
      answerable:
        found.document.contactId !== null &&
        quoteAnswerRefusal(found.document, found.document.expired) === undefined,
      notice: notice ?? noticeOf(found.document),
    });

  /** The quote's own command, run as its contact, with the address checked under its lock. */
  const answerCommand = (answer: QuoteAnswer) =>
    defineCommand({
      name: answer === 'accept' ? 'sales_document.accept' : 'sales_document.decline',
      permission: MANAGE,
      input: answerInput,
      // The digest is the capability's: the log names the document and how it was answered.
      audit: ({ documentId }) => ({
        id: toPublicId('sales_document', documentId),
        source: 'public_link',
      }),
      async handle(trx, input, command): Promise<{ readonly repeated: boolean }> {
        await heldBusiness(options, trx, command);
        const id = toPublicId('sales_document', input.documentId);
        const row = await lockedDocument(trx, id);
        const link = await trx
          .selectFrom('commerce.document_links')
          .select('id')
          .where('document_id', '=', row.id)
          .where('digest', '=', input.digest)
          .executeTakeFirst();
        // An address replaced since the page was shown opens nothing; neither does a quote
        // that is now someone else's.
        if (link === undefined || row.contact_id !== command.context.actorId)
          throw new NotFoundError('Sales document', 'unavailable');
        const kind = kindOf(row.kind);
        const status = statusOf(row.status);
        // The same answer again is the answer that stands: nothing is written twice.
        if (kind === 'quote' && status === (answer === 'accept' ? 'accepted' : 'declined'))
          return { repeated: true };
        const { today } = await businessToday(options, trx, command);
        const refusal = quoteAnswerRefusal(
          stateOf(row),
          isExpired({ kind, status, dueDate: row.due_date }, today),
        );
        if (refusal !== undefined) throw new ConflictError(refusal);
        await (answer === 'accept' ? documents.accept : documents.decline).handle(
          trx,
          { id },
          command,
        );
        return { repeated: false };
      },
    });
  const commands = { accept: answerCommand('accept'), decline: answerCommand('decline') };

  return {
    async page(token, request) {
      const scope = await scopeOf(token);
      if (scope === undefined) return { outcome: 'unknown' };
      const found = await read(scope, request);
      return found === undefined
        ? { outcome: 'gone' }
        : { outcome: 'ok', value: pageOf(scope, found) };
    },

    async pdf(token, request) {
      const scope = await scopeOf(token);
      if (scope === undefined) return { outcome: 'unknown' };
      const found = await read(scope, request);
      return found === undefined
        ? { outcome: 'gone' }
        : { outcome: 'ok', value: await pdfOf(found.printable) };
    },

    async logo(token, request) {
      const scope = await scopeOf(token);
      if (scope === undefined) return { outcome: 'unknown' };
      const found = await read(scope, request);
      const logo = found?.printable.logo;
      if (found === undefined || logo === undefined || !shownLogo(found.printable))
        return { outcome: 'gone' };
      return {
        outcome: 'ok',
        value: { contentType: logo.contentType, size: logo.size, body: await logo.open() },
      };
    },

    async answer(token, answer, request) {
      if (!quoteAnswers.includes(answer)) return { outcome: 'unknown' };
      const scope = await scopeOf(token);
      if (scope === undefined) return { outcome: 'unknown' };
      const before = await read(scope, request);
      if (before === undefined) return { outcome: 'gone' };
      const contactId =
        before.document.contactId === null
          ? undefined
          : parsePublicId('contact', before.document.contactId);
      // A quote whose contact was deleted for good has nobody to answer as.
      if (contactId === undefined)
        return {
          outcome: 'ok',
          value: {
            answered: false,
            html: pageOf(scope, before, 'This quote can no longer be answered here.'),
          },
        };
      const base = reader(scope, request);
      try {
        await runCommand(
          services,
          commands[answer],
          { documentId: scope.documentId, digest: scope.digest },
          {
            context: { ...base.context, actorId: contactId },
            // The one thing the address lets its holder do; row-level security and the
            // command's own checks keep it to this quote.
            permissions: new Set([MANAGE]),
            // Kept with the audit row: who answered a quote is worth knowing later.
            ip: request.ipAddress,
            ...(request.userAgent === undefined ? {} : { userAgent: request.userAgent }),
          },
        );
      } catch (error) {
        if (error instanceof NotFoundError) return { outcome: 'gone' };
        if (!(error instanceof AppError)) throw error;
        // Refused as it stands (expired, already answered the other way): the page says why.
        const now = await read(scope, request);
        return now === undefined
          ? { outcome: 'gone' }
          : { outcome: 'ok', value: { answered: false, html: pageOf(scope, now, error.message) } };
      }
      const after = await read(scope, request);
      return after === undefined
        ? { outcome: 'gone' }
        : { outcome: 'ok', value: { answered: true, html: pageOf(scope, after) } };
    },

    unavailable: unavailablePage,
  };
}
