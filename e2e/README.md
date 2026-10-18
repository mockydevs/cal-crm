# e2e

End-to-end tests of the whole product, as an install runs it: the built server serving the
built dashboard, against a migrated Postgres in Docker. The dashboard's own Playwright suite
(apps/dashboard/e2e) covers its screens with the API stood in for; this one covers the
paths that cross every layer.

`global-setup.ts` starts Postgres and Mailpit once (`@repo/testing`), makes the agency, two
businesses and our owner, then starts the built server twice:
- **app** serves the dashboard and signs people in for real. Tests sign in with the links
  it emails, read from Mailpit (`signing-in.ts`).
- **other-business** acts for a second business in the same agency, to show what it can't
  see. It has no dashboard, and a request without a session acts for that business
  (`DEV_TENANT_CONTEXT`).

Better Auth limits sign-in attempts per client, such as five sign-in links a minute. The
app server trusts the browser as its proxy (`TRUST_PROXY`), so each test file names its
own client with `asClient` (`servers.ts`), and files don't use up each other's limits.

The app server is reached as `http://localhost:PORT`. A passkey belongs to a site's host
name, and WebAuthn refuses an IP address for one. The passkey test uses Chromium's virtual
authenticator, and the two-factor tests compute codes from the key Settings shows, as an
authenticator app does.

The app server has a `PUBLIC_INTAKE_SECRET`, so it serves what the public reaches without
signing in. `webchat-inbox.spec.ts` uses it for web chat on the whole product: a widget
made in Settings, a visitor on a website the test serves on another origin, the Inbox and
the reply. A visitor's browser context sets no `X-Forwarded-For`: a header added to the
widget's cross-origin requests would need a preflight to allow it, which real visitors
never send. `webchat.spec.ts` runs the widget against two small sites of its own
(`apps/server/test/webchat-sites.ts`), where a test can make the limiter refuse or the
team reply at a chosen moment; it uses none of this suite's servers.

Each server's log is in `test-results/servers/`.

The servers serve the dashboard from a copy of its build, taken when the run starts
(`test-results/dashboard/`), so a build made while the tests run changes nothing under
them. A missing or half-written build stops the run at once, with the reason. The server's
own build is used where it is: Node has read it by the time a server is ready.

Checkpoint 1A gets a third server and its own database, with no fixture users or businesses.
Global setup runs `node dist/install.js` to create its agency and built-in roles, then
reads the app's printed first-admin link. `checkpoint-1a.spec.ts` uses that link once,
creates a business, invites agency staff and business users, and verifies their distinct
access and two-factor sign-in. Postgres and Mailpit are shared with the suite; cleanup
stops the app before dropping its database. Setup tokens remain in ignored test output.

Checkpoint 1C, "Inbox day" (`checkpoint-1c.spec.ts`), gets an install of its own as well:
a fourth server, its own database, and the two things the day needs from the world outside.
- **A mail server:** GreenMail (`@repo/testing`), with SMTP and IMAP over TLS. The mailbox is
  connected to it in Settings, as "localhost". Mail from a contact arrives over its plain
  SMTP port (`sendMailFromOutside` in `inbox-day.ts`), and what the install delivered is
  read from GreenMail's own HTTP API.
- **Twilio:** a local stand-in (`apps/server/test/fake-twilio.ts`) that answers the three
  REST requests the SMS module may make with the recorded fixtures, and lets a test post
  signed webhooks. No test ever reaches Twilio.

An install refuses private mail servers and has Twilio's host fixed in its code, and no
setting changes either. So this server is not `dist/main.js` but `inbox-day-server.ts`: the
same configuration, routes and worker tasks, started by the same `start()`, which is told
where the two stand-ins are (`OutsideWorld` in `apps/server/src/start.ts`). Node runs the
file as it is.

Text messages need a public https address: Twilio reports to it and signs for it. So the
server stands behind `https-front.ts`, a small TLS proxy with the mail fixture's certificate
for "localhost", as an install stands behind Coolify's proxy. `PUBLIC_URL` is the front's
address, the test's browser reaches it there with `ignoreHTTPSErrors`, and the stand-in
posts webhooks to the server directly, signed for the public address.

The day happens once: the mailbox and the number stay connected, so the spec isn't written
to be repeated against the same servers (`--repeat-each`).

Settings → AI models, "Model day" (`ai-models.spec.ts`), has an install of its own as
well (`modelDay` in `servers.ts`, helpers in `model-day.ts`), started by
`inbox-day-server.ts`. Its worker is told in code where Claude is: a local stand-in
(`apps/server/test/fake-claude.ts`), through `OutsideWorld.aiBaseUrls`. Its operator has
listed two model servers in `AI_LOCAL_SERVERS`, as an operator would: that stand-in, which
the transport would otherwise refuse as a private address, and a stand-in for a model server
of the install's own (`packages/modules/ai/test/fake-openai.ts`). The spec connects both in
Settings, sees each test call with its cost, and never reaches a real provider. Its
providers stay connected, so it isn't written to be repeated against the same servers.

The assistant's reply drafts, "Draft day" (`reply-drafts.spec.ts`), have an install of
their own too (`draftDay` in `servers.ts`, helpers in `draft-day.ts`): `inbox-day-server.ts`
with both of the worlds above, the mail server and a stand-in for Claude of its own. A
test tells that stand-in what to answer over its `/__script` path, and names the request an
answer is for by a phrase of the message being answered: the mail server's one mailbox is
shared with "Inbox day", so mail another spec sent can reach this install as well, and must
not take the answer. The spec connects the mailbox and the key in Settings, a contact
writes in, the worker drafts through the gateway, and nothing leaves until a person
approves. Its mailbox and key stay connected, so it isn't written to be repeated against
the same servers.

Email verification, "Verify day" (`email-verification.spec.ts`), has an install of its own
too (`verifyDay` in `servers.ts`, helpers in `verify-day.ts`): `inbox-day-server.ts` told where
Emailable is (`E2E_EMAILABLE_URL`). The adapter asks Emailable's own address, a constant, with
the global fetch, so that server sends the requests for that address to a local stand-in
(`apps/server/test/fake-emailable.ts`) and every other request as before. The stand-in finds
an address undeliverable when its local part starts with "nobody". The DNS of an address check
is answered the same way as a mailbox check's. The spec connects the key in Settings, checks
an address on the contact page, blocks and unblocks it, and shows that a reply to a contact
whose address was found invalid is not sent. The key and the mailbox stay connected, so it
isn't written to be repeated against the same servers.

Checkpoint 1D, "Booking day" (`checkpoint-1d.spec.ts`), gets an install of its own too:
a booking sends its confirmation from a connected mailbox, and only a server told where the
mail stand-in is can connect one. It is `inbox-day-server.ts` again, with its own database
and business (`bookingDay` in `servers.ts`, helpers in `booking-day.ts`), reached at its own
http address: nothing in it needs https. The spec connects the mailbox to GreenMail in
Settings, turns quiet hours off (the lead is on Pacific time, and at night there a
confirmation rightly waits), and reads the confirmation from GreenMail. A test never writes a mailbox, or any
other row the product could not have made, into a business other specs use.

The business's website is a small server the spec starts on a port of its own
(`form-test-page.html`), so the form embed runs on another origin, under a strict
Content-Security-Policy. The visitor's browser context there is made with no extra
headers: the suite's `X-Forwarded-For` on a cross-origin request would force a preflight
no real visitor's browser sends, and the public API rightly refuses it. Its mailbox stays
connected, so this spec isn't written to be repeated against the same servers either.

**It runs after the dashboard's suite** (`dependsOn` in `turbo.json`). Starting Postgres in
Docker adds network interfaces. Chromium then aborts page loads that are in flight, with
`net::ERR_NETWORK_CHANGED`, so the two suites can't share the machine at the same time.

```bash
pnpm turbo run test:e2e --filter=@repo/e2e   # builds the server and the dashboard, and runs the dashboard's suite, first (needs Docker)
```
