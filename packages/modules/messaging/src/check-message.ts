import type { MailboxProbe, MailServerLogin } from '@repo/mail';
import { checkMessage, type MessageCheckResult, type Resolve } from '@repo/mail-checks';

/** Worker-only composition: the raw self-copy never leaves this call or enters a job. */
export async function checkSelfMessage(
  probe: MailboxProbe,
  settings: {
    readonly email: string;
    readonly smtp: MailServerLogin;
    readonly imap: MailServerLogin;
  },
  resolve?: Resolve,
): Promise<readonly MessageCheckResult[]> {
  const copy = await probe.probe(settings);
  return checkMessage(
    {
      source: copy.source,
      expectedFrom: settings.email,
      expectedMessageId: copy.messageId,
      smtpTls: copy.smtpTls,
      imapTls: copy.imapTls,
      campaign: false,
    },
    resolve,
  );
}
