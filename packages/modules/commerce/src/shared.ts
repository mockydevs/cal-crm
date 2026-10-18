// What every part of the commerce module shares: what it asks of the modules that own
// businesses, contacts and deals (the server hands those over), who may read and who may
// change, and the ids the API shows.
import type { Readable } from 'node:stream';

import {
  requireBusiness,
  requirePermission,
  type CommandContext,
  type Invocation,
  type Services,
} from '@repo/commands';
import { todayIn, type BusinessProfile, type Contact } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, type TenantContext } from '@repo/kernel';

/**
 * The other modules' public readers, handed over by whoever registers the routes (the
 * server): commerce owns none of these rows and reads none of their tables.
 */
export interface CommerceOptions {
  readonly business: {
    /**
     * Holds the business as it is until the transaction ends, and says whether it is
     * active (tenancy: holdActiveBusiness). Every write takes it first.
     */
    readonly holdActive: (trx: DatabaseTransaction, context: TenantContext) => Promise<boolean>;
    /** The business's name, time zone, address and logo (tenancy: readBusinessProfile). */
    readonly profile: (
      trx: DatabaseTransaction,
      invocation: Invocation,
    ) => Promise<Pick<BusinessProfile, 'name' | 'timezone' | 'address' | 'logoFileId'>>;
  };
  readonly contacts: {
    /** A contact of the business by its public id, or a NotFoundError (the CRM: readContact). */
    readonly read: (
      trx: DatabaseTransaction,
      invocation: Invocation,
      id: string,
    ) => Promise<Pick<Contact, 'name' | 'emails' | 'phones' | 'trashedAt'>>;
  };
  readonly deals: {
    /** A deal of the business by its public id, or a NotFoundError (the CRM: readDeal). */
    readonly read: (
      trx: DatabaseTransaction,
      invocation: Invocation,
      id: string,
    ) => Promise<unknown>;
  };
  /**
   * The files module, where this role has one: a logo is read from it to print a
   * document, and the PDF an email carries is kept in it. Without it a document is printed
   * without a logo, and an email goes without its PDF.
   */
  readonly files?: CommerceFiles | undefined;
  /**
   * What a document's public address is made with: the install's public intake secret and
   * its public address. Without them no document has a public address.
   */
  readonly links?: CommerceLinks | undefined;
  /**
   * Messaging's own way out for an email to a contact (queueContactEmail). Without it
   * nothing can be sent.
   */
  readonly mail?: CommerceMail | undefined;
  /** The clock. Tests pass their own. */
  readonly now?: (() => Date) | undefined;
}

/** A stored file as commerce reads one: what it is, and the way to its bytes. */
export interface CommerceFile {
  readonly contentType: string;
  /** In bytes. */
  readonly size: number;
  /** Opens the bytes, from their start. */
  open(): Promise<Readable>;
}

export interface CommerceFiles {
  /** A file the transaction's business can see, by its public id (files: Files.contentIn). */
  readonly read: (trx: DatabaseTransaction, fileId: string) => Promise<CommerceFile | undefined>;
  /** Keeps a PDF the server made as a file of the business; gives its public id (Files.store). */
  readonly store: (
    trx: DatabaseTransaction,
    command: CommandContext,
    file: { readonly filename: string; readonly content: Uint8Array },
  ) => Promise<string>;
}

export interface CommerceLinks {
  /** Keys the tokens (PUBLIC_INTAKE_SECRET). The digests are labelled, so no use elsewhere. */
  readonly secret: string;
  /** PUBLIC_URL: where /d/<token> is served. */
  readonly publicUrl: string;
}

/** Why messaging did not take an email, in its own words for the reason. */
export type MailRefusal =
  | 'no_mailbox'
  | 'not_contacts_address'
  | 'contact_inactive'
  | 'sender_inactive'
  | 'do_not_contact'
  | 'suppressed'
  | 'consent_withdrawn'
  | 'consent_required'
  | 'timing_unknown';

/** An email messaging did not take, and why. */
export interface MailRefused {
  readonly outcome: 'refused';
  readonly reason: MailRefusal;
  /** A suppression's category, or `channel` for do not disturb on email alone. */
  readonly detail?: string;
}

/** An email as messaging queued it. Ids are public ids. */
export interface QueuedMail {
  readonly outcome: 'queued';
  readonly messageId: string;
  readonly conversationId: string;
  readonly to: string;
  /** Held for later by quiet hours or a limit. */
  readonly deferred: boolean;
  /** The same idempotency key was sent before: this is that message. */
  readonly repeated: boolean;
}

export interface CommerceMail {
  /**
   * Takes the outbound pipeline's own lock on the business. A command that will send calls
   * it before it holds anything else (messaging: holdContactEmail).
   */
  readonly hold: (trx: DatabaseTransaction, context: TenantContext) => Promise<void>;
  /** The email queued under this key before, if one was (messaging: findContactEmail). */
  readonly find: (
    trx: DatabaseTransaction,
    context: TenantContext,
    idempotencyKey: string,
  ) => Promise<QueuedMail | undefined>;
  /**
   * Whether an email to this address of the contact would be taken now: undefined when it
   * would, else why not. Asked before a PDF is drawn and kept (messaging: checkContactEmail).
   */
  readonly check: (
    trx: DatabaseTransaction,
    context: TenantContext,
    email: {
      readonly contactId: string;
      readonly to: string;
      readonly mailboxId?: string | undefined;
    },
  ) => Promise<MailRefused | undefined>;
  /**
   * Queues one transactional email to one of the contact's own addresses, through the
   * outbound pipeline: consent, suppressions, do not contact, quiet hours and the mailbox's
   * limits all apply, and the message is stored in the contact's conversation.
   */
  readonly send: (
    trx: DatabaseTransaction,
    context: TenantContext,
    email: {
      /** crm.contacts.id. */
      readonly contactId: string;
      /** One of the contact's addresses. */
      readonly to: string;
      /** A mailbox's public id; left out, the business's first that sends conversations. */
      readonly mailboxId?: string | undefined;
      readonly idempotencyKey: string;
      readonly subject: string;
      readonly text: string;
      /** Public ids of files to attach. */
      readonly attachments: readonly string[];
    },
  ) => Promise<QueuedMail | MailRefused>;
}

export const READ = 'payments.read';
export const MANAGE = 'payments.manage';

/** Whether the role keeps the catalogue, writes documents and records payments. */
export const canManage = (invocation: Invocation): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has(MANAGE);

/**
 * Lets through whoever may see quotes, invoices, payments and their settings: a role with
 * payments.read, or with payments.manage, which includes seeing them. A refusal is kept
 * in the audit log under the read's name, as a refused command is.
 */
export async function requireRead(
  services: Services,
  invocation: Invocation,
  name: string,
): Promise<void> {
  requireBusiness(invocation.context);
  if (canManage(invocation)) return;
  await requirePermission(services, { name, permission: READ }, invocation);
}

/** The business a write acts in, held active until the command ends. */
export async function heldBusiness(
  options: CommerceOptions,
  trx: DatabaseTransaction,
  command: CommandContext,
): Promise<string> {
  const businessId = requireBusiness(command.context);
  if (!(await options.business.holdActive(trx, command.context)))
    throw new ConflictError('This business is not active.');
  return businessId;
}

const labels = {
  contact: 'Contact',
  deal: 'Deal',
  product: 'Product',
  sales_document: 'Sales document',
  payment: 'Payment',
  mailbox: 'Mailbox',
} as const;

/** The row id inside a public id of this kind; one that names nothing is not found. */
export function rowId(kind: keyof typeof labels, publicId: string): string {
  const id = parsePublicId(kind, publicId);
  if (id === undefined) throw new NotFoundError(labels[kind], publicId);
  return id;
}

export const notFound = (kind: keyof typeof labels, publicId: string): NotFoundError =>
  new NotFoundError(labels[kind], publicId);

/** Today's date where the business is, and the profile it was read from. */
export async function businessToday(
  options: CommerceOptions,
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<{
  readonly today: string;
  readonly profile: Awaited<ReturnType<CommerceOptions['business']['profile']>>;
}> {
  const profile = await options.business.profile(trx, invocation);
  return { today: todayIn(profile.timezone, (options.now ?? (() => new Date()))()), profile };
}

/** Who acts, as the created_by, recorded_by and reversed_by columns hold it. */
export const actorOf = (
  context: TenantContext,
): { readonly kind: TenantContext['actorKind']; readonly id: string | null } => ({
  kind: context.actorKind,
  id: context.actorId ?? null,
});
