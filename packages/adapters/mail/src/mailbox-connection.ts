import { createConnection, isIP, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { connect as connectTls } from 'node:tls';
import { AuthenticationFailure, ImapFlow, ImapFlowErrorCode } from 'imapflow';
import nodemailer from 'nodemailer';
import type { MailMessage } from './mailer.js';
import { MailboxProbeError, readProbeCopy } from './mailbox-probe.js';
import { safeReplyHeaders, type ReplyHeaders } from './reply-headers.js';
import {
  mailboxAddress,
  mailboxDeadline,
  mailboxTimeout,
  MailboxNetworkError,
  type MailboxNetworkCode,
  type MailboxNetworkOptions,
} from './mailbox-network.js';

export interface MailServerLogin {
  readonly host: string;
  readonly port: number;
  readonly security: 'tls' | 'starttls';
  readonly username: string;
  readonly password: string;
}

export type MailConnectionCode =
  | MailboxNetworkCode
  | 'authentication'
  | 'certificate'
  | 'tls_required'
  | 'unreachable'
  | 'connection';

export type MailConnectionResult =
  | { readonly status: 'pass'; readonly code: 'connected'; readonly port: number }
  | { readonly status: 'fail'; readonly code: MailConnectionCode; readonly port: number };

export interface MailboxConnectorOptions extends MailboxNetworkOptions {
  /** Trusted install certificate authority; a business cannot disable verification. */
  readonly ca?: string;
}

export interface MailboxConnector {
  verify(settings: { readonly smtp: MailServerLogin; readonly imap: MailServerLogin }): Promise<{
    smtp: MailConnectionResult;
    imap: MailConnectionResult;
  }>;
}

export interface MailboxSender {
  send(
    login: MailServerLogin,
    from: { readonly address: string; readonly name: string },
    message: MailMessage,
  ): Promise<void>;
}

export type MailboxSubmissionResult =
  | { readonly outcome: 'accepted'; readonly messageId: string }
  | { readonly outcome: 'rejected'; readonly temporary: boolean }
  | { readonly outcome: 'unknown' };

/** A file a message carries, as bytes already in hand: nothing is read from a path or a URL. */
export interface MailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Uint8Array;
}

/** A calendar invite sent with an email (RFC 6047): its iTIP method and iCalendar text. */
export interface CalendarInvite {
  readonly method: 'REQUEST' | 'CANCEL';
  readonly content: string;
}

export interface MailboxSubmitter {
  /** SMTP acceptance is responsibility transfer, not proof of final inbox delivery. */
  submit(
    login: MailServerLogin,
    from: { readonly address: string; readonly name: string },
    message: MailMessage & {
      readonly messageId: string;
      readonly unsubscribeUrl?: string;
      /**
       * Sent by a program, not a person answering (a workflow or a campaign): carries
       * Auto-Submitted: auto-generated (RFC 3834 section 5.2), so out-of-office responders
       * stay quiet ("SHOULD NOT be issued in response to any message which contains an
       * Auto-Submitted header field ... other than 'no'", section 2).
       */
      readonly autoSubmitted?: boolean;
      /** Where answers go instead of the mailbox itself: one address, as a campaign sets. */
      readonly replyTo?: string;
      /** The thread a reply belongs to. Every id is checked again here, whoever built it. */
      readonly reply?: ReplyHeaders;
      /** Files sent with the message, such as an invoice's PDF. */
      readonly attachments?: readonly MailAttachment[];
      /** A calendar invite (RFC 6047): its iTIP method and iCalendar text. */
      readonly calendarInvite?: CalendarInvite;
      /** Who else gets it, named in the message (Cc) or not (Bcc): addresses only, no names. */
      readonly cc?: readonly string[];
      readonly bcc?: readonly string[];
    },
  ): Promise<MailboxSubmissionResult>;
}

export interface MailboxInboxCursor {
  readonly uidValidity: string;
  readonly lastUid: number;
}

export type MailboxInboxMessage =
  | {
      readonly outcome: 'source';
      readonly uid: number;
      readonly source: Buffer;
      /** Server INTERNALDATE, separate from the untrusted Date header. */
      readonly internalDate: Date | null;
    }
  | {
      readonly outcome: 'refused';
      readonly uid: number;
      readonly reason: 'message_too_large';
      readonly source?: never;
    };

export interface MailboxReader {
  /**
   * Null captures the current end without importing history. Persist this baseline
   * when connecting, then persist each batch's outcomes and cursor atomically.
   */
  readInbox(
    login: MailServerLogin,
    cursor: MailboxInboxCursor | null,
  ): Promise<{
    readonly cursor: MailboxInboxCursor;
    readonly messages: readonly MailboxInboxMessage[];
  }>;
}

export interface MailboxProbe {
  /** Worker-only raw copy. Never persist or expose it through an API or task payload. */
  probe(settings: {
    readonly email: string;
    readonly smtp: MailServerLogin;
    readonly imap: MailServerLogin;
  }): Promise<{
    readonly source: Buffer;
    readonly messageId: string;
    readonly smtpTls: true;
    readonly imapTls: true;
  }>;
}

export class MailboxDeliveryError extends Error {
  override readonly name = 'MailboxDeliveryError';
  constructor(readonly code: MailConnectionCode) {
    super(`Mail delivery failed (${code}).`);
  }
}

function failureCode(failure: unknown): MailConnectionCode {
  if (failure instanceof MailboxNetworkError) return failure.code;
  if (
    failure instanceof AuthenticationFailure ||
    (failure instanceof Error &&
      'authenticationFailed' in failure &&
      failure.authenticationFailed === true)
  )
    return 'authentication';
  const code =
    failure instanceof Error && 'code' in failure && typeof failure.code === 'string'
      ? failure.code
      : '';
  if (code === 'EAUTH') return 'authentication';
  // Nodemailer 10's _formatError replaces the TLS code with ESOCKET on STARTTLS.
  // Preserve this observed Node certificate failure as a safe cause, without returning its text.
  if (
    code === 'ESOCKET' &&
    failure instanceof Error &&
    failure.message.startsWith('self-signed certificate')
  )
    return 'certificate';
  if (
    code === 'ETIMEDOUT' ||
    code === ImapFlowErrorCode.ETIMEOUT ||
    code === ImapFlowErrorCode.CONNECT_TIMEOUT ||
    code === ImapFlowErrorCode.GREETING_TIMEOUT ||
    code === ImapFlowErrorCode.UPGRADE_TIMEOUT
  )
    return 'timeout';
  if (code === 'ECONNREFUSED' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH')
    return 'unreachable';
  if (
    code.startsWith('CERT_') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  )
    return 'certificate';
  if (
    code === 'ETLS' ||
    (failure instanceof Error && 'tlsFailed' in failure && failure.tlsFailed === true)
  )
    return 'tls_required';
  return 'connection';
}

/**
 * Nodemailer's own options for a reply's thread (nodemailer 10.0.15, mail-composer and
 * mime-node): `inReplyTo` is one id and `references` a list, each written as given once
 * line breaks and control characters are taken out and missing angle brackets added.
 * It checks no grammar, so only ids that already passed ours are handed to it, and it has
 * nothing left to take out or add.
 */
function threading(reply: ReplyHeaders | undefined): {
  inReplyTo?: string;
  references?: string[];
} {
  if (reply === undefined) return {};
  const safe = safeReplyHeaders(reply);
  return {
    ...(safe.inReplyTo === null ? {} : { inReplyTo: safe.inReplyTo }),
    ...(safe.references.length === 0 ? {} : { references: [...safe.references] }),
  };
}

export function createMailboxConnector(
  options: MailboxConnectorOptions = {},
): MailboxConnector & MailboxSender & MailboxProbe & MailboxSubmitter & MailboxReader {
  const timeoutMs = mailboxTimeout(options);
  const tlsOptions = (host: string) => ({
    minVersion: 'TLSv1.2' as const,
    rejectUnauthorized: true,
    ...(isIP(host) === 0 ? { servername: host } : {}),
    ...(options.ca === undefined ? {} : { ca: options.ca }),
  });
  async function smtp(
    login: MailServerLogin,
    address: string,
    delivery?: {
      readonly from: { readonly address: string; readonly name: string };
      readonly message: MailMessage;
      readonly messageId?: string;
      readonly unsubscribeUrl?: string;
      readonly autoSubmitted?: boolean;
      readonly replyTo?: string;
      readonly reply?: ReplyHeaders;
      readonly attachments?: readonly MailAttachment[];
      readonly calendarInvite?: CalendarInvite;
      readonly cc?: readonly string[];
      readonly bcc?: readonly string[];
    },
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    let socket: Socket | undefined;
    const transport = nodemailer.createTransport({
      host: address,
      port: login.port,
      secure: login.security === 'tls',
      requireTLS: login.security === 'starttls',
      tls: tlsOptions(login.host),
      auth: { user: login.username, pass: login.password },
      forceAuth: true,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      // Nodemailer10.0.15 mailer/index.js counts the envelope's recipients (To, Cc and Bcc)
      // and refuses a message over this; mail-message.js forces the transport's value onto
      // every message, so it is set here, to exactly the recipients this message names.
      maxRecipients: 1 + (delivery?.cc?.length ?? 0) + (delivery?.bcc?.length ?? 0),
      getSocket: (_settings, callback) => {
        if (signal?.aborted === true) {
          callback(new MailboxNetworkError('timeout'));
          return;
        }
        const connection =
          login.security === 'tls'
            ? connectTls({ host: address, port: login.port, ...tlsOptions(login.host) })
            : createConnection({ host: address, port: login.port });
        socket = connection;
        const failed = (error: Error) => {
          callback(error);
        };
        connection.once('error', failed);
        connection.once(login.security === 'tls' ? 'secureConnect' : 'connect', () => {
          connection.removeListener('error', failed);
          callback(null, { connection, secured: login.security === 'tls' });
        });
      },
    });
    const abort = () => {
      socket?.destroy();
      transport.close();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await mailboxDeadline(
        async () => {
          if (delivery === undefined) {
            await transport.verify();
            return undefined;
          } else {
            const receipt = await transport.sendMail({
              to: delivery.message.to,
              subject: delivery.message.subject,
              text: delivery.message.text,
              ...(delivery.message.html === undefined ? {} : { html: delivery.message.html }),
              from: delivery.from,
              // Nodemailer10.0.15 mail-message treats replyTo as an address field. Given as
              // an address object, the value is never parsed for a display name or a list.
              ...(delivery.replyTo === undefined
                ? {}
                : { replyTo: { name: '', address: delivery.replyTo } }),
              // Address objects, as replyTo above: no value is parsed for a name or a list.
              ...(delivery.cc === undefined || delivery.cc.length === 0
                ? {}
                : { cc: delivery.cc.map((address) => ({ name: '', address })) }),
              ...(delivery.bcc === undefined || delivery.bcc.length === 0
                ? {}
                : { bcc: delivery.bcc.map((address) => ({ name: '', address })) }),
              ...(delivery.messageId === undefined ? {} : { messageId: delivery.messageId }),
              ...threading(delivery.reply),
              // Nodemailer10.0.15 mail-composer: an attachment given as `content` is used as
              // it is. The transport above has file and URL access off, so nothing else
              // could be attached even by mistake.
              ...(delivery.attachments === undefined || delivery.attachments.length === 0
                ? {}
                : {
                    attachments: delivery.attachments.map((file) => ({
                      filename: file.filename,
                      contentType: file.contentType,
                      content: Buffer.from(file.content),
                      contentDisposition: 'attachment',
                    })),
                  }),
              // Nodemailer10.0.15 mail-composer (getAlternatives): icalEvent becomes a
              // text/calendar alternative whose Content-Type carries the same method
              // (RFC 6047 2.4), and an application/ics attachment of the same text.
              ...(delivery.calendarInvite === undefined
                ? {}
                : {
                    icalEvent: {
                      method: delivery.calendarInvite.method,
                      content: delivery.calendarInvite.content,
                    },
                  }),
              // Nodemailer10.0.15 mail-composer accepts named headers. Only these controlled
              // fields enter the transport (RFC8058 and RFC 3834), never arbitrary headers.
              ...(delivery.unsubscribeUrl === undefined && delivery.autoSubmitted !== true
                ? {}
                : {
                    headers: {
                      ...(delivery.unsubscribeUrl === undefined
                        ? {}
                        : {
                            'List-Unsubscribe': `<${delivery.unsubscribeUrl}>`,
                            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                          }),
                      ...(delivery.autoSubmitted === true
                        ? { 'Auto-Submitted': 'auto-generated' }
                        : {}),
                    },
                  }),
            });
            return receipt.messageId;
          }
        },
        timeoutMs,
        () => {
          socket?.destroy();
        },
      );
    } finally {
      signal?.removeEventListener('abort', abort);
      socket?.destroy();
      transport.close();
    }
  }
  function imapClient(
    login: MailServerLogin,
    address: string,
    verifyOnly: boolean,
    maximumSourceBytes = 512 * 1024,
  ): ImapFlow {
    const client = new ImapFlow({
      host: address,
      port: login.port,
      secure: login.security === 'tls',
      ...(login.security === 'starttls' ? { doSTARTTLS: true } : {}),
      ...(isIP(login.host) === 0 ? { servername: login.host } : {}),
      tls: tlsOptions(login.host),
      auth: { user: login.username, pass: login.password },
      verifyOnly,
      includeMailboxes: false,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
      logger: false,
      logRaw: false,
      disableAutoIdle: true,
      maxLiteralSize: maximumSourceBytes + 1,
      maxResponseSize: maximumSourceBytes + 128 * 1024,
      maxLineLength: 64 * 1024,
    });
    // connect() owns the failure result; consume the parallel EventEmitter error too.
    client.on('error', () => undefined);
    return client;
  }
  async function imap(login: MailServerLogin, address: string): Promise<void> {
    const client = imapClient(login, address, true);
    try {
      await mailboxDeadline(
        () => client.connect(),
        timeoutMs,
        () => {
          client.close();
        },
      );
    } finally {
      client.close();
    }
  }
  async function check(
    protocol: 'smtp' | 'imap',
    login: MailServerLogin,
  ): Promise<MailConnectionResult> {
    try {
      const address = await mailboxAddress(login.host, options);
      await (protocol === 'smtp' ? smtp(login, address) : imap(login, address));
      return { status: 'pass', code: 'connected', port: login.port };
    } catch (failure) {
      return { status: 'fail', code: failureCode(failure), port: login.port };
    }
  }
  return {
    async submit(login, from, message) {
      try {
        const messageId = await smtp(login, await mailboxAddress(login.host, options), {
          from,
          message,
          messageId: message.messageId,
          ...(message.reply === undefined ? {} : { reply: message.reply }),
          ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
          ...(message.calendarInvite === undefined
            ? {}
            : { calendarInvite: message.calendarInvite }),
          ...(message.unsubscribeUrl === undefined
            ? {}
            : { unsubscribeUrl: message.unsubscribeUrl }),
          ...(message.autoSubmitted === true ? { autoSubmitted: true } : {}),
          ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
          ...(message.cc === undefined ? {} : { cc: message.cc }),
          ...(message.bcc === undefined ? {} : { bcc: message.bcc }),
        });
        if (messageId === undefined) return { outcome: 'unknown' };
        return { outcome: 'accepted', messageId };
      } catch (failure) {
        // Nodemailer10.0.15 _formatError exposes this numeric SMTP reply. Never retain
        // its response/message: those can contain recipient addresses and credentials.
        // RFC5321 4.2.1: a complete 4yz/5yz reply explicitly refuses the action.
        const code =
          failure instanceof Error && 'responseCode' in failure ? failure.responseCode : undefined;
        if (typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599)
          return { outcome: 'rejected', temporary: code < 500 };
        return { outcome: 'unknown' };
      }
    },
    async readInbox(login, cursor) {
      const maximumSourceBytes = 5 * 1024 * 1024;
      const targetPageBytes = 8 * 1024 * 1024;
      const maximumUid = 4294967295;
      if (
        cursor !== null &&
        (!/^[1-9][0-9]{0,9}$/.test(cursor.uidValidity) ||
          BigInt(cursor.uidValidity) > BigInt(maximumUid) ||
          !Number.isInteger(cursor.lastUid) ||
          cursor.lastUid < 0 ||
          cursor.lastUid > maximumUid)
      )
        throw new RangeError('Invalid IMAP cursor.');
      let client: ImapFlow | undefined;
      let completed: Awaited<ReturnType<MailboxReader['readInbox']>> | undefined;
      try {
        return await mailboxDeadline(
          async () => {
            const address = await mailboxAddress(login.host, options);
            client = imapClient(login, address, false, maximumSourceBytes);
            await client.connect();
            if (!client.secureConnection) throw new MailboxDeliveryError('tls_required');
            const lock = await client.getMailboxLock('INBOX', { readOnly: true });
            try {
              const mailbox = client.mailbox;
              // ImapFlow leaves missing or unusable SELECT/EXAMINE fields unset.
              if (
                mailbox === false ||
                !Number.isInteger(mailbox.uidNext) ||
                mailbox.uidNext < 1 ||
                mailbox.uidNext > maximumUid
              )
                throw new MailboxDeliveryError('connection');
              const uidValidity = mailbox.uidValidity.toString();
              const lastUid = cursor?.uidValidity === uidValidity ? cursor.lastUid : 0;
              const highestUid = Math.min(maximumUid, mailbox.uidNext - 1);
              if (cursor === null)
                return { cursor: { uidValidity, lastUid: highestUid }, messages: [] };
              if (lastUid >= highestUid) return { cursor: { uidValidity, lastUid }, messages: [] };
              // Numeric UID windows bound metadata even on a very large mailbox. The
              // snapshot end avoids IMAP's surprising n:* result when n exceeds the last UID.
              const end = Math.min(lastUid + 1000, highestUid);
              const metadata = await client.fetchAll(
                `${String(lastUid + 1)}:${String(end)}`,
                { uid: true, size: true, internalDate: true },
                { uid: true },
              );
              const candidates = metadata
                .filter((message) => message.uid > lastUid && message.uid <= end)
                .sort((a, b) => a.uid - b.uid);
              const page = candidates.slice(0, 20);
              const messages: MailboxInboxMessage[] = [];
              let fetchedBytes = 0;
              const record = (message: MailboxInboxMessage) => {
                messages.push(message);
                // Snapshot only completed UIDs. Closing a timed-out client can settle
                // a pending FETCH later; it cannot mutate this returned prefix.
                completed = {
                  cursor: { uidValidity, lastUid: message.uid },
                  messages: [...messages],
                };
              };
              // All metadata FETCH has finished before issuing any source FETCH.
              for (const message of page) {
                if (
                  message.size === undefined ||
                  !Number.isInteger(message.size) ||
                  message.size < 0
                ) {
                  // A missing attribute can recover on the next read. Never consume
                  // this UID on an incomplete server response.
                  throw new MailboxDeliveryError('connection');
                }
                if (message.size > maximumSourceBytes) {
                  record({
                    outcome: 'refused',
                    uid: message.uid,
                    reason: 'message_too_large',
                  });
                  continue;
                }
                // Count actual bytes as well as the next advertised size: a peer may
                // underreport RFC822.SIZE. Always allow the first bounded source.
                if (fetchedBytes > 0 && fetchedBytes + message.size > targetPageBytes) break;
                const fetched = await client.fetchOne(
                  String(message.uid),
                  { source: { start: 0, maxLength: maximumSourceBytes + 1 } },
                  { uid: true },
                );
                fetchedBytes += fetched && fetched.source !== undefined ? fetched.source.length : 0;
                if (!fetched || fetched.source === undefined) {
                  throw new MailboxDeliveryError('connection');
                } else if (fetched.source.length > maximumSourceBytes) {
                  record({
                    outcome: 'refused',
                    uid: message.uid,
                    reason: 'message_too_large',
                  });
                } else if (fetched.source.length < message.size) {
                  throw new MailboxDeliveryError('connection');
                } else {
                  // The bounded BODY.PEEK from zero returned below the requested cap.
                  // Reject a truncated source, but tolerate underestimated RFC822.SIZE
                  // (GreenMail 2.1.9, for example, reports only the MIME body size).
                  const date =
                    typeof message.internalDate === 'string'
                      ? new Date(message.internalDate)
                      : message.internalDate;
                  record({
                    outcome: 'source',
                    uid: message.uid,
                    source: fetched.source,
                    internalDate:
                      date !== undefined && Number.isFinite(date.getTime()) ? date : null,
                  });
                }
              }
              const nextUid =
                candidates.length > messages.length ? (messages.at(-1)?.uid ?? lastUid) : end;
              return { cursor: { uidValidity, lastUid: nextUid }, messages };
            } finally {
              lock.release();
            }
          },
          timeoutMs,
          () => client?.close(),
        );
      } catch (failure) {
        // A later slow or unavailable UID must not discard a valid prefix on every
        // retry. The next read starts after its last proven UID, before the failed one.
        if (completed !== undefined) return completed;
        if (failure instanceof MailboxDeliveryError) throw failure;
        throw new MailboxDeliveryError(failureCode(failure));
      } finally {
        client?.close();
      }
    },
    async probe(settings) {
      if (
        settings.email.length > 320 ||
        !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(settings.email)
      )
        throw new MailboxProbeError('invalid_address');
      const controller = new AbortController();
      let client: ImapFlow | undefined;
      try {
        return await mailboxDeadline(
          async () => {
            const [smtpAddress, imapAddress] = await Promise.all([
              mailboxAddress(settings.smtp.host, options),
              mailboxAddress(settings.imap.host, options),
            ]);
            if (controller.signal.aborted) throw new MailboxProbeError('timeout');
            client = imapClient(settings.imap, imapAddress, false);
            await client.connect();
            if (!client.secureConnection) throw new MailboxProbeError('tls_required');
            await client.mailboxOpen('INBOX', { readOnly: true });
            const messageId = `<crm-check.${randomUUID()}@crm.invalid>`;
            await smtp(
              settings.smtp,
              smtpAddress,
              {
                from: { address: settings.email, name: 'Mailbox setup check' },
                messageId,
                message: {
                  to: settings.email,
                  subject: 'Mailbox setup check',
                  text: 'This message checks your connected mailbox. No reply is needed.',
                },
              },
              controller.signal,
            );
            const source = await readProbeCopy(client, messageId, controller.signal);
            return { source, messageId, smtpTls: true as const, imapTls: true as const };
          },
          timeoutMs,
          () => {
            controller.abort();
            client?.close();
          },
        );
      } catch (failure) {
        if (failure instanceof MailboxProbeError) throw failure;
        throw new MailboxProbeError(failureCode(failure));
      } finally {
        controller.abort();
        client?.close();
      }
    },
    async send(login, from, message) {
      try {
        await smtp(login, await mailboxAddress(login.host, options), { from, message });
      } catch (failure) {
        throw new MailboxDeliveryError(failureCode(failure));
      }
    },
    async verify(settings) {
      const [smtpResult, imapResult] = await Promise.all([
        check('smtp', settings.smtp),
        check('imap', settings.imap),
      ]);
      return { smtp: smtpResult, imap: imapResult };
    },
  };
}
