# apps/server

The CRM's server, on Fastify. One
image runs it in three roles:

| `ROLE`   | Runs                                                           | Answers                                                 |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| `app`    | The API and the dashboard                                      | `/api/v1/*`, the dashboard's pages, `/health`, `/ready` |
| `worker` | Background work: the jobs commands add, run by Graphile Worker | `/health`, `/ready`                                     |
| `all`    | Both, in one process: development and tiny installs            | Everything                                              |

**An install** runs the image as `app` and `worker`, and once per deploy as `migrate`, whose
command is `node dist/install.js`. That applies the migrations as `crm_owner`
(`DATABASE_OWNER_URL`), then on a new install creates the agency (`AGENCY_NAME`) and its
built-in roles; it changes nothing more on later deploys. While nobody runs the agency, `app`
logs a one-time setup link for the first admin (`setupLink`) each time it starts. The
Compose file is [compose.yml](../../compose.yml); the database is an external PostgreSQL 18
with pgvector, which `DATABASE_ADMIN_URL` lets the first start set up.

**The vault's keys** come from
`node dist/vault.js new-key <version>`, which prints `SECRETS_KEYS` for the worker and
`SECRETS_PUBLIC_KEY` for the app. Back `SECRETS_KEYS` up apart from the database: without
it, no stored secret can be opened. The server builds its vault at start, so a key that
can't be used stops it. To rotate to a new key, in two deploys, so the worker can always
open what the app seals:
1. Make one with the next version. Add it to the worker's `SECRETS_KEYS` after the current
   one, and deploy.
2. Move it first, give the app its `SECRETS_PUBLIC_KEY`, and deploy.
3. Run `node dist/vault.js rotate` in the worker's container. It re-seals every secret under
   the new key, a batch at a time (`--batch-size`, 100 by default), while everything keeps
   working. It exits 1 if any secret couldn't be opened (naming them), or if an app still
   on the old public key sealed some meanwhile. It refuses to start if `SECRETS_KEYS`
   lists an older key before a newer one in use.
4. Once it reports every secret under the new key, remove the older keys.

In development, `pnpm dev` at the root runs it with the settings in `.env` and restarts it
when its code, or a package it uses, changes (see the [README](../../README.md#run-it-locally)).

```bash
pnpm --filter @repo/server build
pnpm --filter @repo/server test              # unit tests, with coverage
pnpm --filter @repo/server test:integration  # the built server as a process; the API and the worker against Postgres
pnpm --filter @repo/server test:container    # the images, in Docker, and a fresh Compose stack's first start (builds them unless SERVER_IMAGE and POSTGRES_IMAGE are set)
```

## Configuration

### Mailbox setup checks

Owners and admins can open a connected mailbox in Settings → Email to read its setup
score and exact available fixes, then select Check again. Checks also start after
connection and run daily while the worker is available. The app needs the public vault
key, and the worker needs the matching private key. Requests queue identifiers only.

The worker polls due mailboxes every five minutes and recovers pending jobs after ten
minutes. A self-check sends a diagnostic message to the same mailbox and reads it over
IMAP without marking it read. A crash can cause a duplicate diagnostic on retry.
Unobserved public delivery evidence and unconfigured blocklists earn no points; this
score measures verified setup, not guaranteed inbox placement.

A previously passing check that fails appears on Today and links to Email settings.
A verified recovery clears it; an inconclusive re-check preserves the alert. Connection
failures expose safe reasons, so investigate worker health and the mailbox/provider
settings without logging raw messages or credentials. GET /api/v1/mailboxes/{id}/setup,
POST /api/v1/mailboxes/{id}/checks and GET /api/v1/mailbox-setup-alerts all require a
business context and mailboxes.manage. The POST takes no request body.

### Use a connected mailbox for install mail

Keep `SMTP_URL` and `MAIL_FROM` configured for initial setup. Once an owner or admin has
connected a mailbox in Settings → Email, obtain its `mbx_…` ID from `GET /api/v1/mailboxes`
in that business. Set `SYSTEM_MAILBOX` to that ID in the app's trusted environment and
restart the app. The app needs `SECRETS_PUBLIC_KEY`; a running worker needs matching
`SECRETS_KEYS`. The selected mailbox's email address and display name become the sender.

The app seals sign-in links, password resets and invitations before queuing them. Only the
worker opens their bodies and mailbox credentials. Delivery failures retry; queued bodies
expire after ten minutes, and maintenance removes abandoned bodies every five minutes.
An inactive mailbox or suspended business cannot send. SMTP acceptance followed by a worker
crash can result in a duplicate delivery on retry.

Selecting a mailbox disables bootstrap delivery for these messages. To recover from an
unavailable sender, remove `SYSTEM_MAILBOX`, restore `SMTP_URL` and `MAIL_FROM`, and restart
the app. Do this before asking for a fresh sign-in link. Never copy mailbox passwords or
worker private keys into the app's environment.

Environment variables, all checked at start. What an install sets, and how, is in [docs/HOSTING.md](../../docs/HOSTING.md#5-every-setting); a test (`src/hosting-guide.test.ts`) fails when a setting is missing there, here or in `install.env.example`. An invalid setting stops the server with a
list of every problem, never with a value (they may hold passwords).

| Variable                                                                                                          | Default                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_APP_URL`                                                                                                | (required)                                  | `crm_app`'s connection string, `postgres://…`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `DATABASE_WORKER_URL`                                                                                             | (required for `worker` and `all`)           | `crm_worker`'s connection string, for the job queue                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DATABASE_AUTH_URL`                                                                                               | (required for `app` and `all`)              | `crm_auth`'s connection string, for signing in                                                                                                                                                                                                                                                                                                                                                                               |
| `AUTH_SECRET`                                                                                                     | (required for `app` and `all`)              | Signs session cookies: 32 characters or more                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SMTP_URL`                                                                                                        | (required for `app` and `all`)              | The mail server for the install's own mail (magic links, password resets): `smtp://user:password@host:587` (STARTTLS) or `smtps://…:465` (TLS). A Settings page comes later                                                                                                                                                                                                                                                                                                          |
| `MAIL_FROM`                                                                                                       | (required for `app` and `all`)              | Who that mail is from, such as `Bluebird Digital <crm@bluebird.example>`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PUBLIC_URL`                                                                                                      | (required)                                  | The address people use, such as `https://crm.example.com`, with no path; `https://` in production. Session cookies, the origin the API accepts changes from, and links in emails follow it                                                                                                                                                                                                                                                                                           |
| `VOICE_WORKER_ORIGIN` | (none) | Fixed worker origin for the app-only voice callback relay, such as `http://worker:3000` on the private Compose network. HTTPS is required outside the allowed local worker hosts; no credentials, path or query. Relays signed callbacks to the opening-vault worker. This setting alone does not enable calling; provider setup and call control remain required. |
| `MIGRATE_ON_START` | false | `true` in the worker only: before it starts, it migrates the database as the migrate container does (`DATABASE_OWNER_URL` and `AGENCY_NAME` then required), for installs where the worker deploys on its own. Refused in the app role. The app always waits, at start, until the database has every migration of its release. |
| `TRUST_PROXY`                                                                                                     | (none)                                      | The proxies in front, whose `X-Forwarded-For` gives the client's IP: addresses, CIDR ranges, `loopback`, `linklocal`, `uniquelocal`, and `cloudflare` (Cloudflare's published ranges, where the client is `CF-Connecting-IP`), separated by commas. A range wider than /8 (IPv4) or /16 (IPv6) is refused. Name the Docker network the reverse proxy reaches the app on, then `cloudflare` once Cloudflare's proxy is on; [HOSTING.md](../../docs/HOSTING.md#134-the-visitors-address-trust_proxy) says how to find them. Left empty in production, the server warns at start that every visitor will share one rate limit. Use `uniquelocal` only when every client has a public address: on a LAN or VPN, a client with a private address would count as a proxy and could pick its own rate-limit bucket. A hop count isn't accepted: it can't tell a proxy from a client |
| `AI_LOCAL_SERVERS`                                                                                                | (none)                                      | The install's own model servers, as `host:port` pairs separated by commas, such as `ollama:11434,192.168.1.20:8080`. They are the only private or plain-`http` addresses an AI provider's key may be sent to; every other address must be `https` on port 443 and resolve to public addresses only. The name and port must match the address saved in Settings exactly. Nothing in Settings can add to the list   |
| `FILES_STORAGE`                                                                                                   | `local`                                     | Where uploaded files' bytes go: `local`, a folder, or `s3`, any S3-compatible service                                                                                                                                                                                                                                                                                                                                     |
| `FILES_DIR`                                                                                                       | (required for `app` and `all` with `local`) | The folder, on a volume that's backed up                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `FILES_S3_ENDPOINT`, `FILES_S3_REGION`, `FILES_S3_BUCKET`, `FILES_S3_ACCESS_KEY_ID`, `FILES_S3_SECRET_ACCESS_KEY` | (required for `app` and `all` with `s3`)    | The service's address, such as `https://s3.eu-central-003.backblazeb2.com`, the bucket's region and name, and an access key for the bucket                                                                                                                                                                                                                                                                                                                                           |
| `FILES_S3_PATH_STYLE`                                                                                             | `false`                                     | `true` for `https://endpoint/bucket/key` addresses, which Garage, MinIO and most self-hosted services want                                                                                                                                                                                                                                                                                                                                                                           |
| `FILES_MAX_BYTES`                                                                                                 | `26214400` (25 MiB)                         | The largest upload taken, up to 1 GiB                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `FILES_LINK_SECRET`                                                                                               | (required for `app` and `all`)              | Signs file links, and nothing else: 32 characters or more                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `FILES_BUSINESS_QUOTA_BYTES` | (none: no limit) | The most one business's live files may add up to, in bytes |
| `PUBLIC_INTAKE_SECRET` | (none: no public page is served) | Keys the shared limiter of the public pages and signs preview links and the proof of when a form was shown: 32 bytes or more. Without it forms, booking pages, web chat, site pages and document links are not mounted |
| `SITES_SHARED_CACHE_SECONDS` | (none: a CDN asks every time) | Only with a CDN set to keep site pages: how long it may answer for a published page without asking, 0 to 300 seconds. Also how long it can go on showing an unpublished page ([HOSTING.md](../../docs/HOSTING.md#13-putting-a-cdn-in-front)) |
| `SITES_PAGE_CACHE_PAGES` | `500` | Rendered site pages each process keeps in memory, 0 to 10,000, and never more than 64 MiB; `0` renders every visit |
| `CAMPAIGN_AGENCY_DAILY_LIMIT` | (none: no limit) | The most campaign emails one agency's businesses release in 24 hours, together |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | (none: Google is hidden) | The install's Google OAuth client ("Web application", redirect URI `<PUBLIC_URL>/api/v1/integrations/google/callback`) for team members' Google Calendars. Both or neither, in the app and the worker |
| `SECRETS_KEYS`                                                                                                    | (required for `worker` and `all`)           | The vault's private keys, which open stored secrets, so `app` refuses them: `version:private-key`, separated by commas, the current one first. `node dist/vault.js new-key 1` makes one                                                                                                                                                                                                                                       |
| `SECRETS_PUBLIC_KEY`                                                                                              | (required for `app`)                        | The current key's public key, `version:public-key`. The app seals secrets with it, and can't open them                                                                                                                                                                                                                                                                                                                                                                               |
| `ROLE`                                                                                                            | `all`                                       | `app`, `worker` or `all`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `HOST`, `PORT`                                                                                                    | `0.0.0.0`, `3000`                           | Where it listens                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `LOG_LEVEL`                                                                                                       | `info`                                      | `fatal` to `trace`, or `silent`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `DATABASE_POOL_SIZE`                                                                                              | `10`                                        | Connections per process                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SHUTDOWN_TIMEOUT_MS`                                                                                             | `8000`                                      | How long shutdown waits for work in flight; under Docker's 10 seconds                                                                                                                                                                                                                                                                                                                                                                                                                |
| `DASHBOARD_DIR`                                                                                                   | (none; `/app/dashboard` in the image)       | The built dashboard to serve                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `NODE_ENV`                                                                                                        | `development`                               | `production` in the image                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `DEV_TENANT_CONTEXT`                                                                                              | (none)                                      | Development only: a request without a session acts as this user, `{"agencyId": …, "businessId": …, "userId": …}`. Refused when `NODE_ENV=production`. Without it, such a request gets 401                                                                                                                                                                                                                                                                                            |
| `DEV_SIGN_IN_LIMIT`                                                                                               | on                                          | Development only: `off` stops counting sign-in attempts (10 per 15 minutes per address otherwise), for local work where scripts sign in repeatedly. Refused when `NODE_ENV=production`. |

**Telemetry** is off unless OpenTelemetry's standard variables configure an exporter, such
as `OTEL_EXPORTER_OTLP_ENDPOINT`. Then it traces HTTP requests, Fastify, Postgres queries
and log lines (`trace_id` on each), and `OTEL_SERVICE_NAME` names the service (`crm` by
default).

## Behavior worth knowing

- **Logs** are JSON lines on stdout. Passwords, tokens, API keys, cookies,
  `Authorization` headers and connection strings are replaced with `[redacted]`.
- **Errors** are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details
  (`application/problem+json`).
  - Errors a caller can fix (422, 404, 409, 403) say what's wrong.
  - Anything else is a 500 that says nothing more; the details are in the logs.
- **Every response** carries an `x-request-id`, which is also the correlation id of the
  events the request causes.
- **Signing in** happens at
  `/api/auth/*`, Better Auth's endpoints, served from `@repo/module-auth`.
  - An API request is signed in by its session cookie, and acts for that person in their
    agency.
  - A signed-in person with no membership gets 403.
  - So does someone whose agency requires two-factor sign-in until they've set it up.
    Better Auth's endpoints, which set it up, still answer them.
  - **A request names the business it works in** with a `Business-Id` header, holding a
    `biz_` id:
    - agency staff may name any business of their agency, and work at the agency when
      they name none;
    - a business user may name only their own businesses, and works in their only one
      when they name none. Otherwise they get 403, "Choose a business first.", because
      acting for no business sees every business in the agency;
    - a business outside the person's agency, or a header that isn't a business id, gets
      404. A business the person doesn't work in gets 403. So does a suspended or archived
      business, for anyone but agency staff.
  - **`GET /api/v1/me`** says who is signed in, their agency, the businesses they may
    enter, and the business the request works in. The development stand-in
    (`DEV_TENANT_CONTEXT`) has no one to describe, so it gets 401.
  - Changes (any method but GET, HEAD and OPTIONS) must come from `PUBLIC_URL`, by their
    `Origin` header, or get 403.
  - Without a session, the API uses `DEV_TENANT_CONTEXT` in development, and otherwise
    answers 401.
- **Files**:
  - `POST /api/v1/files?filename=…` takes the file as the raw request body, in its own
    type. The bytes stream to a temporary file, never into memory. A `Content-Length` over
    `FILES_MAX_BYTES` gets 413 before anything is read, and so does a body that runs past
    it. A refused upload's connection is closed, so the rest isn't received.
  - `POST /api/v1/files/{id}/links` answers with a signed link, under `PUBLIC_URL`.
  - `GET /api/v1/files/{id}/content?…` is where links lead. It needs no session, since the
    link is the permission. An altered or expired link gets 403, and a missing file 404.
    The file is sent with:
    - `X-Content-Type-Options: nosniff`;
    - `Content-Security-Policy: default-src 'none'; sandbox`;
    - `Referrer-Policy: no-referrer`;
    - `Cache-Control: private, no-store`;
    - `Content-Disposition: attachment`, or `inline` for raster images.
- **`/health`** answers while the process runs; the image's health check uses it.
- **`/unsubscribe/{token}`** is public in app/all roles, outside the authenticated API.
  GET/HEAD only confirm. POST accepts exactly `List-Unsubscribe=One-Click` using
  URL-encoded or multipart form with a4096-byte limit; it needs no session, cookie,
  authorization or business header and never redirects. The capability fixes the
  original email marketing recipient and business. Repeated consumption is idempotent.
  The page carries no recipient address, scripts or remote assets. Invalid links are
  refused safely; storage failure offers a retry without claiming success. Request
  logs redact capability paths/queries; malformed/oversized router errors never echo
  paths, including under debug telemetry.
  **`/ready`** also checks the database and answers 503 while it's down or while the
  server is shutting down.
- **On SIGTERM** (from Docker, through tini) the server:
  1. stops taking requests and jobs;
  2. lets those in flight finish, closing each connection after its response;
  3. at `SHUTDOWN_TIMEOUT_MS`, closes whatever is left, and fails the jobs still running
     so that they run again soon.
- **The worker** works Graphile
  Worker's queue as `crm_worker`. It runs each job's task as `crm_app`, in the business
  that added the job, acting as the system.
  - A job that fails is retried with exponential backoff, up to 25 attempts.
  - A job can run more than once, so tasks must be safe to repeat.
  - The task `partitions.maintain` runs daily at 03:00 UTC. It creates the monthly
    partitions three months ahead.
  - The task `ai.maintain` runs every hour. It clears AI request logs past the days their
    business keeps them; a call's tokens and cost stay.
  - `src/worker/ai.ts` builds the AI gateway for the worker's jobs: the AI module's
    gateway with the worker's vault and `AI_LOCAL_SERVERS`. The task `ai.test_connection` uses
    it for "Test" in Settings → AI models.
  - **Adding a model server of your own** (Ollama, llama.cpp, vLLM, LM Studio) takes two
    steps. List its host and port in `AI_LOCAL_SERVERS`, for every role, and restart. Then
    add it in Settings → AI models with the same host and port in its address, such as
    `http://ollama:11434/v1`. An address that is neither listed nor public `https` on port
    443 is refused when it is saved, and Settings says which host and port to list. Under a
    spending limit that pauses AI, also give the model a price in the agency's Settings →
    AI models; it can be zero.
  - **CSV imports need the worker to reach the stored files**. The task `imports.run` reads the
    uploaded file and writes the file of rows it did not apply, so give the `worker` role
    the same `FILES_*` settings as the app, and the same volume when storage is `local`
    (`compose.yml` does). A worker without them starts as before, and ends every import it
    takes up as failed, saying so. The task `imports.recover` runs every minute: it queues
    again an import that has made no progress for five minutes, and closes one started more
    than a day ago.
  - A worker role doesn't start when it can't reach a migrated queue.
  - The process exits with code 1 when its worker stops by itself (after a fatal error, or
    when a newer release migrates the queue), so that Docker restarts it.
  - Modules export their tasks, and `src/worker-tasks.ts` lists them.
- **The dashboard:** files under `/assets` are cached for a year (their names change with
  their content), and the page itself is never cached.
