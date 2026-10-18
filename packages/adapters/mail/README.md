# packages/adapters/mail

Mail the install sends itself: sign-in links, password resets and, later, invitations.
It's sent over SMTP with [nodemailer](https://nodemailer.com). For now the server is set by
`SMTP_URL` and `MAIL_FROM`; a Settings page comes later. Businesses' own mailboxes are a
separate matter.

```ts
const mailer = createMailer({
  url: 'smtps://crm@bluebird.example:password@smtp.bluebird.example:465',
  from: 'Bluebird Digital <crm@bluebird.example>',
});
await mailer.send({ to, subject, text, html });
mailer.close();
```

- **Fails fast.** Connecting and the server's greeting each time out after 10 seconds,
  and a silent connection after 30, rather than nodemailer's defaults of 2 and 10 minutes.
- **`smtp://` upgrades with STARTTLS when the server offers it; `smtps://` is TLS from the
  start.**

Why nodemailer: it's the established Node SMTP client, maintained, MIT-0, with no
dependencies and its own types. The alternatives were emailjs (MIT, smaller and less used)
and `smtp-client` (unchanged since 2022).

```bash
pnpm --filter @repo/mail test:integration   # against Mailpit in Docker (@repo/testing's startMailpit)
```
