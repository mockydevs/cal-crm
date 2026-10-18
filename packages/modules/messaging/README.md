# Messaging

Mailbox connection, setup checks and the tenant-scoped outbound foundation.

## Phone System

`phone-settings.ts` and `phone-routes.ts` implement business defaults, per-number
routing and eligible member pages, with phone.manage, tenant RLS and
optimistic revisions. SMS-only operators retain connection and number controls.
The SMS transport allowlist is unchanged.

Call history and requests use `call-records.ts`, `call-requests.ts`, `call-routes.ts`
and `call-ledger.ts`. `createPlaceCallTask` requires a worker provider port
and the canonical current-user grant reader. Never supply an always-allow reader in
production. The ledger reserves before asking the provider once, preserves unknown
outcomes, and orders progress under locks. A queued request cannot authorize a call
after access or consent changes.

`voice/` supplies bounded transports, callback authentication, canonical URLs,
TwiML, device token signing and routing calculation. Browser signing keys come from
the documented Standard-only v2010 Key resource; seal their one-time secrets in an
authorized worker setup attempt. No helper repeats uncertain creation or placement.
Number acquisition reports uncertainty and provider prices without inferring
purchase, compliance approval or verification success.

Synchronous callbacks are reserved for the opening-vault worker and narrow app
relay. Boundary tests do not establish that this runtime is wired. Availability
stays false until provider setup and runtime are ready. Local tests place no calls,
buy no numbers and submit no registrations.

## Outbound module interface

`queueOutboundMessage(trx, context, input)` runs inside an authorized command's
`withTenant` transaction. It returns the stored message UUID, including on an identical
idempotent retry. It validates a strict input containing stored identity/account UUIDs,
email or SMS channel, marketing or transactional purpose, reply/transactional/automation/
campaign lane, idempotency key, text and optional subject/HTML. Missing or foreign
identities/accounts throw `NotFoundError`; changed key reuse throws `ConflictError`.
Policy refusal instead persists a failed message with the recorded reason. Temporary
restrictions persist queued work with `scheduled_for` and a bounded recheck job.

`createDispatchOutboundTask(sender)` produces the `messaging.dispatch` worker task.
Its strict payload contains only `messageId`. The `OutboundSender.deliver(message,
context)` port receives the immutable body/destination/account and trusted tenant
context for worker-side provider configuration. It returns accepted plus a provider ID,
rejected, or unknown. An exception is treated as unknown without persisting its contents.
Register the task only with a concrete verified provider adapter. There is no outbound HTTP route at this stage.

A delivery reservation commits before the external call. Completed and concurrent
retries never call the provider again. A reservation without a definitive result is
unknown and needs operator reconciliation. Do not clear a reservation or mint a new
idempotency key automatically to bypass this protection. Changing a contact's identity
after queuing refuses the old destination rather than sending unreviewed content to it.

## Local verification

`pnpm --filter @repo/module-messaging test` measures pure score/policy coverage.
`pnpm --filter @repo/module-messaging test:integration` uses real Postgres and disposable
SMTP/IMAP peers. `pnpm --filter @repo/module-messaging test:mutation` mutates the public
outbound policy; the required minimum is 80%. The repository's full gates still apply.

## SMTP delivery and sending settings

`createSmtpDispatchTask(vault, submitter, db, publicUrl)` composes admission and dispatch. Worker
startup registers it when opening vault keys are available. Admission precedes the
reservation and runs under the same business lock as settings updates.

`readMailboxSendingSettings` and `updateMailboxSendingCommand` back the GET/PUT
`/mailboxes/{id}/sending` routes under `mailboxes.manage`. The five explicit settings
are daily cap, pacing, warmup, conversation use and campaign use. Credentials and raw
provider responses never appear. Saving cannot remove the isolated provider hold.

The mail adapter's `MailboxSubmitter` returns only accepted/header Message-ID,
rejected/temporary, or unknown. SMTP acceptance is not final delivery. Definitive
refusals stay failed; held unattempted messages resume after quota/pacing/provider
windows. Unknown attempts are never automatically resent. Install-owned mail remains
on its own separate sealed path. The real integration fixture uses authenticated
TLS Mailpit with a disposable trusted CA and exact pinned version options.

Marketing submissions add controlled RFC8058 headers and an opaque HTTPS capability.
An HTTP publicUrl refuses marketing before reservation as `unsubscribe_unavailable`.
Transactional/install-owned mail carry neither header. The owner's SMTP server must
DKIM-sign both fields; mailbox checks diagnose coverage, and SMTP receipt alone is not
proof of RFC8058 compliance.

`createUnsubscribeLink` is trusted tenant-scoped issuance; `unsubscribeFromLink` resolves
the capability alone and atomically withdraws email marketing consent. It binds the
original contact/identity/address, refuses unused moved/deleted identities and is
idempotent for repeated/concurrent consumption. It emits safe timeline/audit records
without raw capability/digest. No global address suppression is created.
 Public HTTP and
the confirmation/retry page are served outside authenticated API scope.

For tenant-scoped operational counts, run the following inside `withTenant`. It exposes
only states and safe categories, covering deferred quotas, provider refusals and unknown
delivery without recipient addresses, bodies or credentials. A growing unknown count
requires reconciliation, never an automatic resend.

```sql
select status, error_code, count(*) as messages
from messaging.messages
where direction = 'outbound' and channel = 'email'
  and status in ('queued', 'failed', 'unknown')
group by status, error_code;
```

## Inbound email

`createSyncMailboxTask(vault, reader)` is the `mailboxes.sync` worker task. Its payload
holds only `mailboxId`. `scheduleMailboxSyncs(services)` queues every due mailbox, one
waiting job per mailbox; the worker's cron runs it.

The task decrypts credentials in a short transaction. It reads INBOX read-only, so the
`\Seen` flag is never set, and parses outside any transaction. It then runs
`ingestInboundCommand`, which only the worker's system actor may run. The command:
- rechecks, under locks, the cursor, the credentials and the active mailbox, channel and
  business, and changes nothing if any of them moved;
- records one outcome per UID in `messaging.mailbox_inbound_uids`;
- moves the cursor, and queues the next read while it advances.

Unknown senders become contacts through the CRM's `createContactCommand`. Replies are
parented only to a stored message in the sender's own conversation. No consent is recorded.

Only mail that arrives after a mailbox is connected is read: verification saves the
inbox's baseline with the mailbox.
