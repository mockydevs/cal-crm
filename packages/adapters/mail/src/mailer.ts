// Mail the install sends itself: sign-in links, password resets and invitations. It goes
// out over SMTP, configured by SMTP_URL and MAIL_FROM for now (a Settings page comes later),
// with nodemailer.
import nodemailer from 'nodemailer';

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface Mailer {
  /** Sends one message; rejects when the mail server refuses it or can't be reached. */
  send(message: MailMessage): Promise<void>;
  /** Closes the connection to the mail server. */
  close(): void;
}

export interface MailerOptions {
  /** smtp://user:password@host:587 (STARTTLS) or smtps://user:password@host:465 (TLS). */
  readonly url: string;
  /** Who the mail is from, such as "Bluebird Digital <crm@bluebird.example>". */
  readonly from: string;
}

export function createMailer(options: MailerOptions): Mailer {
  // nodemailer waits two minutes to connect and ten for a quiet server by default; a
  // sign-in link that hasn't gone in seconds isn't going.
  const transport = nodemailer.createTransport(
    { url: options.url, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 },
    { from: options.from },
  );
  return {
    async send(message) {
      await transport.sendMail({
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
      });
    },
    close() {
      transport.close();
    },
  };
}
