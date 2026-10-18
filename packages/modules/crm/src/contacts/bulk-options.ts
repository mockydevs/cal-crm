// What bulk actions on contacts need of other modules, which this one can't import: sending
// through messaging's outbound path, keeping, linking and deleting a file through the files
// service, and what the person who started an action may do now. The server hands each in;
// left out, the actions that need it can't be started, or are not checked again.
import type { CommandContext, Invocation, Services } from '@repo/commands';
import type { ContactEmailCheckPreview, Permission, StoredFile } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import type { Issue, TenantContext } from '@repo/kernel';

import type { ContactDetailOptions } from './details.js';

/** One message of a bulk send, as the person wrote it, with the sender they chose. */
export type BulkMessage =
  | {
      readonly channel: 'sms';
      /** A phone number's public id; left out, the business's only one that can send. */
      readonly number?: string | undefined;
      readonly message: string;
    }
  | {
      readonly channel: 'email';
      /** A mailbox's public id; left out, the business's only working one. */
      readonly mailbox?: string | undefined;
      readonly fromName?: string | undefined;
      readonly subject?: string | undefined;
      readonly body?: string | undefined;
      /** An email template's public id, sent instead of a body. */
      readonly templateId?: string | undefined;
    };

/** Why a contact was not sent the message: the reasons a bulk action names. */
export type BulkSendRefusal =
  | 'no_address'
  | 'do_not_disturb'
  | 'no_consent'
  | 'suppressed'
  | 'missing_values'
  | 'sender_unavailable'
  | 'message_refused';

/** Sending through messaging's one outbound path, which the automation module wraps. */
export interface BulkMessages {
  /**
   * Whether the message can be sent at all: its sender can send now and its template is
   * there. A problem is an issue on the field to put right; undefined, it can.
   */
  check(
    trx: DatabaseTransaction,
    invocation: Invocation,
    message: BulkMessage,
  ): Promise<Issue | undefined>;
  /**
   * Takes the outbound path's own lock on the business. A batch takes it before it holds
   * any contact, as every command that sends does.
   */
  hold(trx: DatabaseTransaction, invocation: Invocation): Promise<void>;
  /**
   * How many more emails may go out now under the install's ceiling on one agency's
   * campaign emails in 24 hours, which bulk email counts against; null when there is none.
   */
  emailAllowance(trx: DatabaseTransaction, invocation: Invocation): Promise<number | null>;
  /**
   * Queues the message for one contact, filled in with its values, once for the key. Its
   * consent, do not disturb, suppressions, quiet hours and sending limits are messaging's
   * to apply: a deferral is still queued; a refusal says why.
   */
  send(
    trx: DatabaseTransaction,
    invocation: Invocation,
    message: BulkMessage,
    contact: { readonly id: string; readonly idempotencyKey: string },
  ): Promise<
    { readonly queued: true } | { readonly queued: false; readonly reason: BulkSendRefusal }
  >;
}

/**
 * What an export needs of the files service: keep the file it wrote in the command's own
 * transaction, as a file only its own link reaches and that counts against the business's
 * storage; link to it; and delete it when it has been kept long enough.
 */
export interface ContactExportFiles {
  /** The largest file kept, in bytes. */
  readonly maxBytes: number;
  store(
    trx: DatabaseTransaction,
    command: CommandContext,
    file: {
      readonly filename: string;
      readonly contentType: 'text/csv';
      readonly content: Uint8Array;
      readonly purpose: 'contact_export';
      readonly quota: true;
    },
  ): Promise<StoredFile>;
  link(
    services: Services,
    invocation: Invocation,
    fileId: string,
    lifetime: { readonly seconds: number; readonly purpose: 'contact_export' },
  ): Promise<{ path: string; expiresAt: string }>;
  discard(trx: DatabaseTransaction, command: CommandContext, fileId: string): Promise<void>;
}

/** What became of one contact's email check, as email verification decides it. */
export type BulkEmailCheckOutcome =
  'queued' | 'current' | 'no_email' | 'excluded' | 'daily_limit' | 'off';

/** Checking contacts' email addresses through messaging's email verification. */
export interface BulkEmailChecks {
  /** Whether email verification is on in the business. */
  enabled(trx: DatabaseTransaction, invocation: Invocation): Promise<boolean>;
  /** What checking these contacts' primary addresses would do, for the confirm dialog. */
  preview(
    trx: DatabaseTransaction,
    invocation: Invocation,
    contactIds: readonly string[],
  ): Promise<ContactEmailCheckPreview>;
  /** Starts one batch's checks, which reads the day's limit once and counts it down. */
  start(trx: DatabaseTransaction, invocation: Invocation): Promise<BulkEmailCheckBatch>;
}

/** One batch of checks: each contact's is queued behind other work, paced by its place. */
export interface BulkEmailCheckBatch {
  /**
   * Queues a check of one contact's primary address, unless it has a current result, is
   * excluded, or the day's provider checks are used up.
   */
  queue(
    trx: DatabaseTransaction,
    invocation: Invocation,
    contactId: string,
    place: { readonly position: number; readonly since: Date },
  ): Promise<BulkEmailCheckOutcome>;
}

/**
 * The permissions a person has in the context's business now, or undefined when they are
 * no longer on its team or may no longer sign in.
 */
export type BulkStarterGrants = (
  trx: DatabaseTransaction,
  context: TenantContext,
  userId: string,
) => Promise<ReadonlySet<Permission> | undefined>;

export interface ContactBulkOptions extends ContactDetailOptions {
  /** Left out, no email or text message can be sent in bulk. */
  readonly messages?: BulkMessages;
  /** Left out, no email address can be verified in bulk. */
  readonly emailChecks?: BulkEmailChecks;
  /** Left out, no export can be started. */
  readonly files?: ContactExportFiles;
  /** PUBLIC_URL/api/v1: a link to an export's file is absolute, under it. */
  readonly apiUrl?: string;
  /**
   * What the person who started an action may do now, read again before each batch the
   * worker runs. Left out, an action started by a person is not checked again.
   */
  readonly grants?: BulkStarterGrants;
}
