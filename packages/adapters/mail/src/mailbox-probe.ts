import { setTimeout as pause } from 'node:timers/promises';
import type { ImapFlow } from 'imapflow';

export class MailboxProbeError extends Error {
  override readonly name = 'MailboxProbeError';
  constructor(readonly code: string) {
    super(`Mailbox test is unavailable (${code}).`);
  }
}

/** Reads only the uniquely identified copy; IMAP EXAMINE and BODY.PEEK preserve flags. */
export async function readProbeCopy(
  client: ImapFlow,
  messageId: string,
  signal: AbortSignal,
): Promise<Buffer> {
  while (!signal.aborted) {
    const ids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
    if (ids === false || ids === undefined) throw new MailboxProbeError('read_failed');
    if (ids.length > 1) throw new MailboxProbeError('ambiguous_copy');
    const uid = ids[0];
    if (uid !== undefined) {
      // Fetch the complete BODY.PEEK literal. The client's literal/response limits
      // bound allocation; unlike a partial fetch this cannot silently truncate mail.
      const copy = await client.fetchOne(String(uid), { size: true, source: true }, { uid: true });
      if (copy === false || copy?.source === undefined || copy.size === undefined)
        throw new MailboxProbeError('read_failed');
      if (copy.size > 512 * 1024 || copy.source.length > 512 * 1024)
        throw new MailboxProbeError('too_large');
      return copy.source;
    }
    await pause(250, undefined, { signal });
  }
  throw new MailboxProbeError('timeout');
}
