# Hosting guide

How to run the CRM on your own server: what an install is, how to put it on Coolify or on
plain Docker Compose, every setting, files, mail, backups, upgrades, a CDN in front of the
live pages, and a checklist before you let people in.

**How to read it.** A statement about another product (Coolify, Docker, Cloudflare, R2,
Caddy, nginx, Traefik, Let's Encrypt, GitHub) was read in that product's own
documentation on 2026-10-13, and its address is beside it. Where the documentation does
not say, the line starts with **Check**, says what to look at on your own install, and
gives a fallback. A statement about the CRM was read in this repository, and names the
file. Nothing here was run on a Coolify server or a Cloudflare zone: the first install is
the test, and the **Check** lines are where to look first.

Nothing in this guide asks you to paste a password, a key or a token into a chat, an
issue or a log. Secrets go into `install.env` or Coolify's environment variables and
nowhere else.

## Contents

1. [What an install is](#1-what-an-install-is)
2. [Before you start](#2-before-you-start)
3. [Install on Coolify](#3-install-on-coolify)
4. [Install with plain Docker Compose](#4-install-with-plain-docker-compose)
5. [Every setting](#5-every-setting)
6. [Files in S3-compatible storage](#6-files-in-s3-compatible-storage)
7. [Public pages](#7-public-pages)
8. [Mail](#8-mail)
9. [AI providers](#9-ai-providers)
10. [Backups](#10-backups)
11. [Upgrades and rollback](#11-upgrades-and-rollback)
12. [Health and logs](#12-health-and-logs)
13. [Putting a CDN in front](#13-putting-a-cdn-in-front)
14. [Scaling notes](#14-scaling-notes)
15. [Go-live checklist](#15-go-live-checklist)

## 1. What an install is

One Docker Compose file, [compose.yml](../compose.yml), two images that CI builds and pushes
to the GitHub container registry, and two things outside it that you provide: an external
PostgreSQL 18 with the pgvector extension, and S3-compatible storage for uploaded files.
Nothing the install keeps lives on its server, so the server can be replaced or
redeployed at any time.

| Container  | Image          | What it does                                                                                                                                                                                                         | Runs               |
| ---------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `migrate`  | `crm`          | `node dist/install.js`: with `DATABASE_ADMIN_URL`, first creates the four roles (`crm_owner`, `crm_app`, `crm_auth`, `crm_worker`), the `crm` database and its extensions on an empty server; then applies the migrations as `crm_owner` and, on a new install, creates the agency (`AGENCY_NAME`) and its built-in roles. Then it exits. |
| `app`      | `crm`          | The API, the dashboard, the public pages and realtime (Socket.IO), on port 3000, plain HTTP. It holds the vault's public key only: it can seal a secret and cannot open one.                                         | always             |
| `worker`   | `crm`          | Background jobs (Graphile Worker): sending, imports, automations, scheduled tasks. It holds the vault's private keys.                                                                                                | always             |
| `backup`   | `crm-backup`   | Optional. A `pg_dump` of the database to S3-compatible storage once a day ([BACKUPS.md](BACKUPS.md)).                                                                                                                | with the `backup` profile |

No container publishes a port. A reverse proxy that you run (Coolify's, or your own) ends
HTTPS and passes requests to `app` on port 3000.

**The images** are built on GitHub's `ubuntu-latest` runner with no list of platforms
([ci.yml](../.github/workflows/ci.yml), job `image`), so they are for x86-64 (amd64)
servers. An ARM server cannot run them today.

**No volumes.** The database is on the Postgres server you give it (`DATABASE_HOST`), and
uploaded files are in your S3-compatible bucket (`FILES_S3_*`).

**What you must keep safe, and where it is:**

| What                                                                          | Where it lives                                           | Lose it and                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| The database                                                                  | your Postgres server                                     | everything is gone. Its own backups (on Coolify, the database's scheduled backups), or the `backup` container, protect it (section 10). |
| Uploaded files                                                                | your files bucket                                        | attachments, logos, media and imports are gone. **No database backup holds them** (section 6).     |
| `SECRETS_KEYS`, the vault's private keys                                      | `install.env`, or Coolify's environment variables        | no stored mailbox password, provider token or AI key can be opened again: people re-enter them all. |
| `AUTH_SECRET`                                                                 | the same                                                 | everyone is signed out.                                                                             |
| `FILES_LINK_SECRET`                                                           | the same                                                 | file links sent earlier stop working.                                                               |
| `PUBLIC_INTAKE_SECRET`                                                        | the same                                                 | preview links stop working, and forms and bot checks shown before the change are refused once.      |
| The database roles' passwords                                                 | the same                                                 | nothing is lost, but a restored install must be given the same ones (BACKUPS.md, "Restore").        |

Keep a copy of `install.env` (or of Coolify's environment variables) somewhere that is
neither the server nor the backups bucket: whoever holds a database dump and
`SECRETS_KEYS` together can read every stored credential.

**Sizes to start with.** There is no measured number for a small server yet: the baseline
on 2 vCPU / 4 GB has not been run. What
is known:

- Coolify itself "needs 2 CPU cores, 2 GB RAM, and 10 GB disk space to run"
  (<https://coolify.io/docs/start-with-self-hosted>).
- Beside it the install runs two Node processes, and Postgres when you run it on the same
  server (as a database Coolify manages is), plus the backup container when it is on,
  which writes one compressed dump to disk before uploading it.

So 2 vCPU / 4 GB is the least worth trying for one small agency, and it is unmeasured. For
a shared install that several agencies pay for, start larger (our judgement, not a
measurement: 4 vCPU, 8 GB, 80 GB of disk), watch memory and the database's size for the
first weeks, and resize from what you see.

**One shared install, or one per agency.**

- _One install per agency_ is what the code does today: the first start creates one
  agency, and nothing creates a second (`packages/modules/tenancy/src/agency/install.ts`).
  Each agency has its own server, database, backups and upgrade moment. This is the path
  that works now.
- _One shared install for many agencies_ is what the database is designed for: every
  row carries its agency, and row-level security keeps agencies apart. Sign-in, creating
  a second agency and per-agency branding are not built yet. Until
  they are, a shared install cannot take a second agency. What changes for the operator
  when it can: one deploy and one migration for everybody, one database to back up and
  one restore that rolls everybody back, and limits that must keep one agency from
  slowing the rest (the public-page limits in section 14 are already per business).

## 2. Before you start

- **A domain, and its DNS.** One address for the install, such as `crm.example.com`, as an
  A record (and AAAA, if the server has IPv6) pointing at the server. `PUBLIC_URL` is this
  address with `https://` and no path. It is the only address the install answers on:
  the dashboard, the API, the public pages, the links in emails and the session cookie
  all use it, and the API refuses changes that come from any other origin.
- **A server.** Linux, x86-64, with ports 80 and 443 open to the internet. For clients in
  the United States, choose a United States region: every dashboard click and every
  visit to a live page is a round trip to this server, and the server in turn calls the
  mail, SMS and AI providers the businesses connect, most of which answer from the
  United States. A server on another continent adds that distance to each of those.
  Pick the coast nearer to most of the clients' own customers.
- **A PostgreSQL 18 server with the pgvector extension**, reachable from the install on a
  private network. On Coolify, add a PostgreSQL database to the same project and choose
  the `pgvector/pgvector:pg18` image; anywhere else, any server where you hold a superuser
  for the first start. The install creates its own roles and database on it
  (`DATABASE_ADMIN_URL`, section 5); it never shares them with other applications.
- **A bucket for files** in S3-compatible storage, private, with an access key that may
  read, write and delete objects in that bucket only (section 6). The install does not
  start without it: uploaded files are never kept on the server.
- **A second bucket for backups**, with a key of its own (section 10). Not the files
  bucket.
- **A mailbox for the install's own mail:** sign-in links, password resets and
  invitations. Any SMTP server and an address to send from (section 8). The install does
  not start without it.
- **A way to keep `install.env` safe** off the server: a password manager entry is enough.

## 3. Install on Coolify

Coolify is the supported path. Install it
first, on the server, as its own guide says (<https://coolify.io/docs/start-with-self-hosted>).

On Coolify an install is three resources in one project, so that a deploy never takes the
running install down:

| Resource     | Kind                                    | What it runs                                                                          |
| ------------ | --------------------------------------- | ------------------------------------------------------------------------------------- |
| the database | PostgreSQL database, managed by Coolify | PostgreSQL 18 with pgvector, private, with scheduled backups to S3-compatible storage |
| `crm-app`    | application, Dockerfile build           | the `app` role: the API, the dashboard and the public pages, on your domain           |
| `crm-worker` | application, Dockerfile build           | the `worker` role: background work; it also applies the migrations when it starts     |

Coolify deploys an application one container at a time: it starts the new container,
waits for its health check, and only then removes the old one. When the new container is
not healthy, it logs "New container is not healthy, rolling back to the old container" and
the old one goes on serving (Coolify v4.4.6, `ApplicationDeploymentJob::rolling_update`).
A Docker Compose resource gets no such thing: Coolify stops all its containers before it
starts the new ones, so a failed deploy leaves nothing running. That is why `app` and
`worker` are applications here and not the services of `compose.yml`, which section 4 uses.

### 3.1 The database

In the project, select **+ New**, then **PostgreSQL**, and set its image to
`pgvector/pgvector:pg18`. Leave **Make it publicly available** off: only the install
reaches it, over Coolify's network. Start it.

- Its host name, for `DATABASE_HOST` and the connection strings below, is the name Coolify
  gives the database's container (its uuid); the port is `5432`. Its superuser is
  `postgres`, with the password Coolify shows: `DATABASE_ADMIN_URL`'s user, for the first
  start only (section 3.3).
- Under **Backups**, add a scheduled backup of the `crm` database, saved to S3-compatible
  storage you add under **S3 Storages** (not the files bucket), and run one now to check
  it. Section 10 says what a backup holds and how to restore.

### 3.2 The app and the worker

Add each as an application from the Git repository (**+ New**, the repository through a
Git App or a deploy key), with the build pack **Dockerfile**, the Dockerfile at the root,
and these settings. They are the same for both but for the name, the domain and the
environment variables:

- **Docker build target:** `runtime`. **Ports exposes:** `3000`. No port mappings, and
  **Consistent container names** off: either one turns the one-at-a-time deploy off.
- **Health check:** on, path `/health`, port `3000`, and host `127.0.0.1`. Not `localhost`:
  in this image `localhost` is the IPv6 address `::1`, where the server does not listen,
  so every check would fail and every deploy would roll back. Start period 10 seconds,
  interval 10 seconds, 60 retries: a new app waits up to ten minutes for the worker to
  finish a release's migrations before it answers (section 11).
- **Domain:** `crm-app` only, `https://` and your hostname. `crm-worker` has none.

Coolify builds the image on the server for each deploy. Auto-deploy on a push is fine once
pushes reach `main` only after CI (section 3.4).

### 3.3 Fill in the settings

Each application has its own **Environment Variables**. Section 5 says what each setting
does; on Coolify the connection strings are written out in full, since no Compose file
builds them. Make every password and secret with `openssl rand -hex 32` (letters and digits
only: they go into connection strings as they are), mark each variable **literal** so
Coolify leaves a `$` in it alone, and keep them out of the build (runtime only).

- **Both:** `PUBLIC_URL`, `LOG_LEVEL`, `DATABASE_POOL_SIZE`, `PUBLIC_INTAKE_SECRET`,
  `FILES_LINK_SECRET`, `FILES_MAX_BYTES`, `AI_LOCAL_SERVERS`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `FILES_STORAGE=s3` and the `FILES_S3_*` settings, and
  `DATABASE_APP_URL=postgres://crm_app:<password>@<host>:5432/crm`.
- **`crm-app`:** `ROLE=app`, `DATABASE_AUTH_URL` (`crm_auth`'s), `AUTH_SECRET`, `SMTP_URL`,
  `MAIL_FROM`, `SYSTEM_MAILBOX`, `TRUST_PROXY`, `VOICE_WORKER_ORIGIN`,
  `SECRETS_PUBLIC_KEY`, `SITES_SHARED_CACHE_SECONDS`, `SITES_PAGE_CACHE_PAGES`,
  `FILES_BUSINESS_QUOTA_BYTES`, `CAMPAIGN_AGENCY_DAILY_LIMIT`.
- **`crm-worker`:** `ROLE=worker`, `DATABASE_WORKER_URL` (`crm_worker`'s),
  `DATABASE_OWNER_URL` (`crm_owner`'s), `AGENCY_NAME`, `MIGRATE_ON_START=true`,
  `SECRETS_KEYS`.
- **The first start only, on `crm-worker`:** `DATABASE_ADMIN_URL`
  (`postgres://postgres:<superuser password>@<host>:5432/postgres`) and `DATABASE_AUTH_URL`.
  The worker then creates the four roles, the `crm` database and its extensions before it
  migrates. Remove both once it has started.

**The vault's keys** are a pair and cannot be random text. Make them on your own machine:

```sh
docker run --rm ghcr.io/mockydevs/crm:main node dist/vault.js new-key 1
```

It prints `SECRETS_KEYS=…` for the worker and `SECRETS_PUBLIC_KEY=…` for the app. Paste
each into Coolify and into your copy of the settings, and clear your terminal. Never run it
in a deployment log or a CI job: the output is the key.

### 3.4 Deploy

Deploy `crm-worker` first, then `crm-app`. On the first start the worker's log says
`Created the roles and the database on the Postgres server.`, then `Applied …` for each
migration, then `Created the agency …`.

- **The first admin.** While nobody runs the agency, `crm-app` prints a one-time setup link
  each time it starts. Read it in its logs, open it, and create the first admin. The link
  works once, within 24 hours; treat it as a password until it is used.
- **`TRUST_PROXY`.** `crm-app` warns at start, `TRUST_PROXY is empty…`, until you set it
  (section 13.4). On Coolify's network it starts with that network's range, such as
  `172.18.0.0/16` (`docker network inspect coolify` on the server).
- **Every later deploy** keeps the old container serving until the new one is healthy. A
  release whose container doesn't start (a wrong setting, a crash) fails its deploy, and
  the old version goes on as before. A release with new migrations: the new worker applies
  them before it starts, and the new app waits until they are in before it answers, while
  the old app goes on serving on the newer schema (migrations are written so the previous
  release still works on them, section 11).
- **Changing an application's settings** (its health check, domain, build target) changes
  what Coolify builds from, so its next deploy builds the image again from scratch, which
  takes several minutes. The old container serves meanwhile.
- **Deploy only after CI.** Pushes to `main` deploy when auto-deploy is on, so push only a
  revision whose checks have passed. Coolify's deploy webhook does the same on request
  (<https://coolify.io/docs/core/automation/deploy-webhooks>), with a token that has the
  `deploy` permission alone (<https://coolify.io/docs/api/permissions>).

`compose.yml` also runs on Coolify as one Docker Compose resource (section 4's file, from
the repository with the build strategy **Compose**), if you accept that each deploy stops
the install for as long as the new containers take to start.

## 4. Install with plain Docker Compose

The same file runs anywhere Docker Compose does, behind a reverse proxy you run.

```sh
docker login ghcr.io                     # a token with read:packages, as in 3.1
cp install.env.example install.env       # then fill it in (section 5)
chmod 600 install.env
docker run --rm ghcr.io/mockydevs/crm:main node dist/vault.js new-key 1   # the vault's keys, for install.env
docker compose --env-file install.env up -d
docker compose --env-file install.env logs app     # the setup link for the first admin
```

`--env-file` replaces Compose's default `.env`
(<https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/>),
so pass it on every command.

**What the proxy must do.** The app listens on port 3000 inside the Compose network and
publishes nothing. Put the proxy on that network (a service added in an override file, or
a container joined to the network `crm_default`) and have it:

| The proxy must                                                             | Why                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| serve HTTPS for your domain and pass requests to `app:3000` over plain HTTP | `PUBLIC_URL` must be `https://` in production; the session cookie is sent on HTTPS only.                                                                                                             |
| pass the `Host` header as the browser sent it                              | The public pages and links are built for that host.                                                                                                                                                 |
| send the client's address in `X-Forwarded-For`, and be named in `TRUST_PROXY` | The app reads the visitor's address from that header, through the proxies it trusts only. Rate limits, the sign-in limit and the audit log use it (section 13.4).                                    |
| pass WebSocket upgrades on `/socket.io/`                                   | Realtime (new messages, notifications) is Socket.IO on the same port.                                                                                                                               |
| allow a request body as large as `FILES_MAX_BYTES` (25 MiB unless you change it) | An upload is one request with the file as its body. A proxy with a smaller limit refuses it first, with its own 413.                                                                                |
| not time out a slow upload                                                 | The whole body must arrive inside the proxy's read timeout.                                                                                                                                         |

How three proxies stand on each, from their own documentation:

- **Caddy** (<https://caddyserver.com/docs/caddyfile/directives/reverse_proxy>,
  <https://caddyserver.com/docs/automatic-https>): `crm.example.com { reverse_proxy app:3000 }`
  is the whole configuration. It gets and renews the certificate when the domain's
  records "point to your server" and "ports `80` and `443` are open externally". It
  "passes through incoming headers—including `Host`—to the backend without
  modifications", and sets `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`.
  "The proxy also supports WebSocket connections". A body limit exists only if you add
  `request_body { max_size … }`. **Check:** the page states no default limit; upload a
  file near 25 MiB once to be sure.
- **nginx** (<https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size>,
  <https://nginx.org/en/docs/http/websocket.html>,
  <https://nginx.org/en/docs/http/ngx_http_proxy_module.html>): the body limit defaults
  to `1m`, and past it "the 413 (Request Entity Too Large) error is returned", so set
  `client_max_body_size 25m;` or more. Pass the host and the address with
  `proxy_set_header Host $host;` and
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`. WebSockets need
  `proxy_set_header Upgrade $http_upgrade;` and `proxy_set_header Connection "upgrade";`,
  and before nginx 1.29.7 also `proxy_http_version 1.1;`. An idle connection "will be
  closed if the proxied server does not transmit any data within 60 seconds"
  (`proxy_read_timeout`); the realtime server pings each connection every 25 seconds
  (the default `pingInterval` of the Socket.IO server package the image carries), which
  is inside it.
- **Traefik** (<https://doc.traefik.io/traefik/getting-started/faq/>,
  <https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/>,
  <https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/buffering/>):
  it adds `X-Forwarded-For` and the other forwarded headers by default, "supports
  WebSocket (WS) and WebSocket Secure (WSS) connections out of the box", and limits a
  body only through the `buffering` middleware, whose `maxRequestBodyBytes` is `0`
  ("unlimited") unless set. Its entry point's `readTimeout` defaults to 60 seconds for
  "reading the entire request, including the body": raise it if people upload large
  files over slow lines.

Let's Encrypt's HTTP challenge "can only be done on port 80"
(<https://letsencrypt.org/docs/challenge-types/>). Its certificates are valid for 90 days
today and are scheduled to shorten (64 days from February 2027, 45 from February 2028:
<https://letsencrypt.org/2025/12/02/from-90-to-45>); a proxy that renews by itself, as all
three above do, needs nothing from you.

## 5. Every setting

Each one is checked when a container starts. A wrong setting stops the server with a list
of every problem, naming the variables and never their values
([config.ts](../apps/server/src/config.ts)). A test fails when a setting exists in
`config.ts` or `compose.yml` and is missing from this section or from
[install.env.example](../install.env.example)
([hosting-guide.test.ts](../apps/server/src/hosting-guide.test.ts)).

"Refused in production" means the image, which sets `NODE_ENV=production`, does not start
with that value.

### 5.1 What you set

These are the names in `install.env`, or in Coolify's environment variables.

**The install**

| Setting              | Required | Default                              | What it does                                                                                                                                                                                                                              |
| -------------------- | -------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENCY_NAME`        | yes      |                                      | Your agency's name. The first start creates the agency with it; later starts ignore it.                                                                                                                                                   |
| `PUBLIC_URL`         | yes      |                                      | The address people use, such as `https://crm.example.com`, with no path. Session cookies, the origin the API accepts changes from, links in emails and public pages follow it. **Refused in production unless it is `https://`.**           |
| `VOICE_WORKER_ORIGIN` | no | none | Fixed target for the app-only voice callback relay: `http://worker:3000` on the private Compose network, or an HTTPS origin. No path, query or credentials. Relays signed callbacks to the opening-vault worker. This setting alone does not enable calling; provider setup and call control remain required. |
| `TRUST_PROXY`        | no       | empty                                | The proxies in front, whose `X-Forwarded-For` gives the visitor's address: addresses, CIDR ranges, `loopback`, `linklocal`, `uniquelocal`, and `cloudflare` when Cloudflare's proxy is on, separated by commas. Empty in production is a mistake, and the app warns (section 13.4).    |
| `CRM_IMAGE`          | no       | `ghcr.io/mockydevs/crm:main`         | The server's image. Use the same tag for the server and the backup image (section 11). |
| `LOG_LEVEL`          | no       | `info`                               | How much the app and the worker log: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.                                                                                                                                      |
| `DATABASE_POOL_SIZE` | no       | `10`                                 | Connections each of the app and the worker keeps to Postgres, 1 to 100 (section 14).                                                                                                                                                      |

**The database** (section 2): an external PostgreSQL 18 with the pgvector extension available.

| Setting              | Required          | Default | What it does |
| -------------------- | ----------------- | ------- | ------------ |
| `DATABASE_HOST`      | yes               |         | The Postgres server's host name, as `migrate`, `app`, `worker` and `backup` reach it. On Coolify, the name of the PostgreSQL database resource. |
| `DATABASE_PORT`      | no                | `5432`  | Its port. |
| `DATABASE_ADMIN_URL` | first start only  | empty   | A superuser's connection string, such as `postgres://postgres:<password>@<host>:5432/postgres`. With it, `migrate` creates the four roles (with the passwords below), the `crm` database and its extensions when the server has none of them, and does nothing when it has all of them. Remove it once the install has started. |

**Passwords and secrets.** Each is yours alone; make them with `openssl rand -hex 32`.

| Setting                | Required            | What it does                                                                                                                                                                                                                                  |
| ---------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CRM_OWNER_PASSWORD`   | yes                 | `crm_owner`, which owns the schema: `migrate` and `backup` use it; `app` and `worker` never receive it. |
| `CRM_APP_PASSWORD`     | yes                 | `crm_app`, under row-level security: what the app and the worker's jobs read and write as.                                                                                                                                                    |
| `CRM_AUTH_PASSWORD`    | yes                 | `crm_auth`, for sign-in.                                                                                                                                                                                                                      |
| `CRM_WORKER_PASSWORD`  | yes                 | `crm_worker`, for the job queue.                                                                                                                                                                                                              |
| `AUTH_SECRET`          | yes                 | Signs session cookies and tokens. 32 characters or more. **Refused in production if it is `.env.example`'s** (it contains `dev-only`).                                                                                                         |
| `FILES_LINK_SECRET`    | yes                 | Signs file download links and nothing else. 32 characters or more. **Refused in production if it is `.env.example`'s.**                                                                                                                         |
| `PUBLIC_INTAKE_SECRET` | no, but see section 7 | Signs and keys the public pages. 32 bytes or more. Empty: no public page is served. **Refused in production if it is `.env.example`'s.**                                                                                                     |
| `SECRETS_KEYS`         | yes                 | The vault's private keys, `version:private-key`, the current one first, separated by commas. The worker gets it; the app refuses it. **Refused in production if it is `.env.example`'s.** Back it up apart from the database.                  |
| `SECRETS_PUBLIC_KEY`   | yes                 | The current key's public half, `version:public-key`. The app seals secrets with it. **Refused in production if it is `.env.example`'s.**                                                                                                       |

The database passwords change only before the first start: the bootstrap sets them once.
Rotating the vault's keys is two deploys and one command
([apps/server/README.md](../apps/server/README.md), "The vault's keys").

**Mail** (section 8)

| Setting          | Required | What it does                                                                                                                                                          |
| ---------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SMTP_URL`       | yes      | The mail server for the install's own mail: `smtp://user:password@host:587` (STARTTLS) or `smtps://user:password@host:465` (TLS).                                     |
| `MAIL_FROM`      | yes      | Who that mail is from, such as `Bluebird Digital <crm@example.com>`.                                                                                                  |
| `SYSTEM_MAILBOX` | no       | The `mbx_…` id of a mailbox connected in Settings, to send the install's mail through it instead. Needs the worker. Keep the two settings above for recovery.          |

**Files** (section 6)

| Setting                      | Required          | Default    | What it does                                                                                                                               |
| ---------------------------- | ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `FILES_S3_ENDPOINT` | yes | | The storage's address, `https://…`. Uploaded files are never kept on the server. |
| `FILES_S3_REGION` | no | `auto` | The bucket's region (`auto` on Cloudflare R2). |
| `FILES_S3_BUCKET` | yes | | The bucket. It must exist. |
| `FILES_S3_ACCESS_KEY_ID` | yes | | The access key's id: one that may read, write and delete the bucket's objects, and nothing else. |
| `FILES_S3_SECRET_ACCESS_KEY` | yes | | The access key's secret. |
| `FILES_S3_PATH_STYLE`        | no                | `false`    | `true` for `https://endpoint/bucket/key` addresses, which MinIO, Garage and most self-hosted storage want.                                  |
| `FILES_MAX_BYTES`            | no                | `26214400` | The largest upload taken, in bytes (25 MiB), up to 1 GiB. The proxy and any CDN in front must allow as much.                                |
| `FILES_BUSINESS_QUOTA_BYTES` | no                | no limit   | The most one business's files may add up to, in bytes.                                                                                     |

**Public pages and limits** (sections 7 and 13)

| Setting                       | Required | Default       | What it does                                                                                                                                                                                 |
| ----------------------------- | -------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SITES_SHARED_CACHE_SECONDS`  | no       | off           | Only with a CDN set to keep site pages: how many seconds it may answer for a page without asking the server, 0 to 300. Also how long it can go on showing an unpublished page (section 13.3). |
| `SITES_PAGE_CACHE_PAGES`      | no       | `500`         | Rendered site pages each app process keeps in memory, 0 to 10,000, and never more than 64 MiB. `0` renders every visit.                                                                      |
| `CAMPAIGN_AGENCY_DAILY_LIMIT` | no       | no limit      | The most campaign emails one agency's businesses send in 24 hours, together.                                                                                                                 |
| `AI_LOCAL_SERVERS`            | no       | none          | Your own model servers, as `host:port` separated by commas: the only private or plain-`http` addresses an AI key may be sent to (section 9).                                                 |
| `GOOGLE_CLIENT_ID`            | no       | none          | Google Calendar for team members: the ID of a Google Cloud OAuth client of the type "Web application", whose redirect URI is `<PUBLIC_URL>/api/v1/integrations/google/callback`. Set it in the app and the worker, with the secret. Empty hides Google. |
| `GOOGLE_CLIENT_SECRET`        | no       | none          | That client's secret. Both or neither: one alone stops the start. Never logged or shown.                                                                                                    |

**Backups** (section 10; read by the `backup` container, not by the server)

| Setting                       | Required        | Default                              | What it does                                                                                              |
| ----------------------------- | --------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `COMPOSE_PROFILES`            | for backups     | empty                                | `backup` starts the backup container. Read by Docker Compose itself.                                      |
| `CRM_BACKUP_IMAGE`            | no              | `ghcr.io/mockydevs/crm-backup:main`  | The backup image.                                                                                         |
| `BACKUP_S3_ENDPOINT`          | for backups     |                                      | The storage's address.                                                                                    |
| `BACKUP_S3_REGION`            | no              | `auto`                               | The bucket's region.                                                                                      |
| `BACKUP_S3_BUCKET`            | for backups     |                                      | The bucket. Empty with the profile on: the container stays up and logs `backups are OFF`.                 |
| `BACKUP_S3_ACCESS_KEY_ID`     | for backups     |                                      | The access key's id.                                                                                      |
| `BACKUP_S3_SECRET_ACCESS_KEY` | for backups     |                                      | The access key's secret.                                                                                  |
| `BACKUP_S3_PREFIX`            | no              | `database`                           | The folder in the bucket.                                                                                 |
| `BACKUP_INSTALL_NAME`         | no              | `PUBLIC_URL`'s host                  | The install's folder under the prefix, so several installs can share a bucket.                            |
| `BACKUP_AT`                   | no              | `02:15`                              | When, in UTC, as `HH:MM`.                                                                                 |
| `BACKUP_RETENTION_DAYS`       | no              | `7`                                  | How many days of backups to keep.                                                                         |
| `BACKUP_ENCRYPT_TO`           | no              | none                                 | An age public key: dumps are encrypted before they leave the server. Keep the private key off the server. |

### 5.2 What the Compose file and the image set for you

You do not set these on an install. They are here so that a line in a log or in
`config.ts` can be looked up.

| Setting               | Set to                                                | What it does                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`            | `production` (the image)                              | Turns on every production refusal in this section.                                                                                                                                  |
| `ROLE`                | `app` or `worker` (compose.yml)                       | Which half of the server a container runs. `all` is both in one process, for development.                                                                                           |
| `HOST`, `PORT`        | `0.0.0.0`, `3000` (the image)                         | Where the server listens inside its container.                                                                                                                                      |
| `DASHBOARD_DIR`       | `/app/dashboard` (the image)                          | The built dashboard the app serves.                                                                                                                                                 |
| `DATABASE_APP_URL`    | built from `CRM_APP_PASSWORD` and `DATABASE_HOST` (compose.yml) | `crm_app`'s connection string. |
| `DATABASE_AUTH_URL`   | built from `CRM_AUTH_PASSWORD` (compose.yml, app)     | `crm_auth`'s connection string.                                                                                                                                                     |
| `DATABASE_WORKER_URL` | built from `CRM_WORKER_PASSWORD` (compose.yml, worker) | `crm_worker`'s connection string.                                                                                                                                                   |
| `FILES_STORAGE`       | `s3` (compose.yml)                                    | Where uploaded files go. An install always uses S3-compatible storage; `local`, a folder, is for development. |
| `FILES_DIR`           | not set (compose.yml)                                 | The folder files go in when `FILES_STORAGE` is `local`, as in development. An install never stores files on its server. |
| `SHUTDOWN_TIMEOUT_MS` | `8000` (the default)                                  | How long a stopping server waits for work in flight. It is under the ten seconds Docker gives a container to stop; compose.yml does not pass another value.                         |
| `MIGRATE_ON_START` | `false`; `true` only on a worker deployed on its own | The worker migrates the database before it starts, as `migrate` does; it then needs `DATABASE_OWNER_URL` and `AGENCY_NAME`. compose.yml has its `migrate` service instead and does not pass it. Refused in the app role. |

### 5.3 Development only

| Setting              | What it does                                                                                                         | In production                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `DEV_TENANT_CONTEXT` | A request without a session acts as one fixed user.                                                                  | **Refused**: it would sign every request in as one user.   |
| `DEV_SIGN_IN_LIMIT`  | `off` stops counting sign-in attempts (ten in fifteen minutes from one address otherwise), for scripts that sign in over and over. | **Refused** when `off`: passwords could be guessed freely. |

Neither is in `install.env.example`, and `compose.yml` passes neither.

**Telemetry** is off unless OpenTelemetry's standard variables name an exporter, such as
`OTEL_EXPORTER_OTLP_ENDPOINT` ([apps/server/README.md](../apps/server/README.md)).
`compose.yml` does not pass them; add them to both services in an override file if you
run a collector.

## 6. Files in S3-compatible storage

Uploaded files are kept in S3-compatible storage, never on the server: an install does
not start without the `FILES_S3_*` settings. (`FILES_STORAGE=local`, a folder, is for
development only.)

The bucket must be **private**. The CRM never hands out the bucket's own address: a
download goes through the app, by a signed link that expires
(`GET /api/v1/files/{id}/content`), and public media through `/m/…`. A public bucket
would let anyone who guessed an object's name read it.

**Cloudflare R2**, from its documentation:

| Setting               | Value                                                                                                                                                                                            | Source                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `FILES_S3_ENDPOINT`   | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. A bucket made with a jurisdiction has its own: `https://<ACCOUNT_ID>.us.r2.cloudflarestorage.com` for United States, `.eu.` for the European Union. | <https://developers.cloudflare.com/r2/api/s3/api/>                  |
| `FILES_S3_REGION`     | `auto` ("an empty value and `us-east-1` will alias to the `auto` region"; the CRM needs a value, so write `auto`).                                                                                | same page                                                           |
| `FILES_S3_PATH_STYLE` | `true`. R2's first addresses were path-based (`<ACCOUNT_ID>.r2.cloudflarestorage.com/<BUCKET>`), and it later added "support for S3 virtual-hosted style paths".                                  | <https://developers.cloudflare.com/r2/platform/release-notes/> (2022-05-16) |
| the access key        | An API token with **Object Read & Write**, applied to this bucket only. "You will not be able to access your **Secret Access Key** again after this step."                                        | <https://developers.cloudflare.com/r2/api/tokens/>                  |

- **Check: path style.** Only that release note speaks of the two styles, and no current
  reference page does. `true` uses the form R2 has had from the start. If uploads fail
  with a signature or host error, try `false`.
- R2 buckets are private unless you make them public: "By default, buckets are never
  publicly accessible and will always require explicit user permission to enable"
  (<https://developers.cloudflare.com/r2/buckets/public-buckets/>). Do not add a public
  `r2.dev` address or a custom domain to the files bucket.
- For United States clients, give the bucket a location hint when you create it: `enam`
  (Eastern North America) or `wnam` (Western North America). Hints "are a best effort
  and not a guarantee", and are "only honored the first time a bucket with a given name
  is created" (<https://developers.cloudflare.com/r2/reference/data-location/>).
- R2 does not charge for egress
  (<https://developers.cloudflare.com/r2/pricing/>).

**Against deleting or overwriting by mistake** ([BACKUPS.md](BACKUPS.md), "The files
bucket"): R2 has no object versioning (its S3 page lists `PutBucketVersioning` as not
implemented); it has bucket locks, which "prevent the deletion and overwriting of objects
in an R2 bucket for a specified period"
(<https://developers.cloudflare.com/r2/buckets/bucket-locks/>). On storage that has
versioning (Amazon S3, MinIO, Backblaze B2), turn it on. A lock on the files bucket also
stops the CRM from removing a file someone deleted until the lock's days have passed;
that is the point of it.

**The worker needs the same storage.** `compose.yml` gives both services the same
`FILES_*` settings; an import fails, saying so, on a worker without them.

Moving from `local` to `s3` later does not move the files already uploaded: copy the
volume's contents into the bucket under the same names before switching.

## 7. Public pages

`PUBLIC_INTAKE_SECRET` turns on everything a person who is not signed in can reach. It
keys the shared rate limiter and signs preview links and the proof of when a form was
shown ([start.ts](../apps/server/src/start.ts)). **Left empty, none of these is served:**

| What                                       | Address                                                          |
| ------------------------------------------ | ---------------------------------------------------------------- |
| Published site and funnel pages            | `/s/<key>/<path>`, and previews of drafts at `/s/_preview/<token>` |
| Forms                                      | `/f/<key>`, `/forms/embed.js`, `/api/v1/public/forms/…`          |
| Booking pages                              | `/book/<agency>/<business>/<calendar>`, `/api/v1/public/book/…`  |
| Managing a booked appointment              | `/appointments/manage/<token>`, `/api/v1/public/appointments/…`  |
| Web chat                                   | `/webchat/widget.js`, `/api/v1/public/webchat/…`                 |
| Quotes and invoices sent to a customer     | `/d/<token>`                                                     |

Unsubscribe links (`/unsubscribe/…`) and trigger links (`/l/…`) work without it.

Set it once, the same on every app container and on the worker, and do not change it
casually: preview links made before a change stop working, and so do the reschedule or
cancel links in appointment reminders already sent (the next reminder carries a new one).
The worker uses it only as the key of those reminder links; it serves no public page.
`compose.yml` passes it to both.

Every one of these is behind the shared limiter (section 14), which counts by the
visitor's address. That address is only right when `TRUST_PROXY` is (section 13.4).

**Bot protection needs no setting of its own.** A form or a calendar can ask visitors'
browsers for ALTCHA's proof of work (Settings: "Bot protection: Proof of work (ALTCHA)"). It runs on
this server, and nothing is sent to ALTCHA or anyone else.
- Its two signing keys are derived from `PUBLIC_INTAKE_SECRET`, so changing that secret
  voids the challenges that are open, as it voids previews.
- The visitor's browser solves the challenge with WebCrypto, which works only on secure
  pages. Embed a protected form on `https` pages only.
## 8. Mail

Two different things send mail.

- **The install's own mail**: sign-in links, password resets, invitations. It needs
  `SMTP_URL` and `MAIL_FROM`, and the app does not start without them. Any SMTP service
  will do; use an address on a domain you control, with SPF and DKIM set up at that
  service, or sign-in links land in spam.
- **Each business's mail**: conversations, campaigns, confirmations. A business connects
  its own mailbox in Settings → Email, and its password is sealed in the vault. The
  install's SMTP server is never used for it. Settings → Email checks the
  mailbox's setup and explains each problem with its fix.

Once a mailbox is connected, `SYSTEM_MAILBOX` can send the install's own mail through it
([apps/server/README.md](../apps/server/README.md), "Use a connected mailbox for install
mail"). Keep `SMTP_URL` and `MAIL_FROM` set: they are how you get back in if that mailbox
breaks.

On a shared install, do not send customers' mail from the server's own address: one
agency's bad sending would hurt everyone's delivery.

## 9. AI providers

Nothing is configured on the install. Each agency adds its providers and keys in Settings
→ AI models; a key is sealed with the vault's public key the moment it is saved, and only
the worker can open it.

A provider's address must be public `https` on port 443. The one exception is your own
model servers (Ollama, llama.cpp, vLLM, LM Studio): list each as `host:port` in
`AI_LOCAL_SERVERS`, redeploy, then add it in Settings with the same host and port. Nothing in Settings can add to
that list.

## 10. Backups

[BACKUPS.md](BACKUPS.md) is the guide: what happens each night, what a backup holds and
does not, turning it on, encryption, and restoring. The three commands to know:

```sh
docker compose --env-file install.env run --rm backup now      # one backup, now
docker compose --env-file install.env run --rm backup status   # the newest, its size, how many are kept
docker compose --env-file install.env run --rm \
  -e BACKUP_RESTORE_USER=postgres -e BACKUP_RESTORE_PASSWORD="$POSTGRES_SUPERUSER_PASSWORD" \
  backup restore latest                                        # into an empty database
```

On Coolify, open **Terminal** on the running `backup` container and run the same script
without the Compose part: `crm-backup now`, `crm-backup status`. A restore needs the
superuser's password for that one command: BACKUPS.md, "Restore", has the variables.

Three things a backup is not:

- It is the database only. Files are in the files bucket; secrets are in your copy of the
  settings.
- It is once a day. Up to a day's work can be lost.
- It is not tested until you have restored one. BACKUPS.md, "Test a restore", restores
  into a scratch database beside the live one. Do it before go-live and monthly.

## 11. Upgrades and rollback

**How images are named.** When every check on `main` has passed, CI pushes each of the
two images (the server and the backups) under two tags: `:main`, which moves, and `:<commit SHA>`, which never does
([ci.yml](../.github/workflows/ci.yml), job `publish`). There are no version numbers or
release channels yet.

- With the default `:main` tags, an upgrade is a pull and a restart:

  ```sh
  docker compose --env-file install.env pull
  docker compose --env-file install.env up -d
  ```

  `up` recreates a container whose "configuration or image was changed … (preserving
  mounted volumes)" (<https://docs.docker.com/reference/cli/docker/compose/up/>). On
  Coolify, **Deploy** does both.
- For an install people pay for, pin both images to one commit: set `CRM_IMAGE` and
  `CRM_BACKUP_IMAGE` to the same `:<commit SHA>`, and upgrade by changing the two together. You then know exactly what is running, and what to go
  back to.

**What `migrate` does.** On every deploy it applies the migrations the database does not
have yet, in order, as `crm_owner`, and exits. On a new install it then creates the
agency. It never removes data and never goes backwards. `app` and `worker` start after
it; on Coolify the worker does this itself when it starts (section 3.4).

**Before an upgrade:** take a backup (`backup now`), and read what changed.

**Rolling back.** Migrations are written expand-then-contract: a
release adds what it needs and leaves what the previous release used, and removes it a
release later. So going back one release is setting the images to the previous commit
and deploying: the older code runs on the newer schema. There is no downgrade of the
schema. If a release has to be undone further than that, or its migration damaged data,
the way back is the backup taken before it (BACKUPS.md, "Over the database of a running
install"), and everything written since is lost.

**During a deploy** on Coolify the old container serves until the new one is healthy, and
stays when the new one fails (section 3.4). With plain Docker Compose the old containers
stop and the new ones start. The server finishes requests in flight for up to eight seconds
when it is told to stop, and jobs that were running are run again by the new worker.

## 12. Health and logs

**Two addresses, on every role, inside the container** (port 3000):

- `/health` answers while the process runs. The image's own health check calls it every
  30 seconds.
- `/ready` also checks the database (and realtime, in the app), and answers 503 while
  either is down or the server is stopping. Point an uptime monitor at
  `https://<your address>/ready`.

**What to watch:**

| What                                   | Where                                                                                           | Means                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `/ready` is not 200                    | your monitor                                                                                    | The database is unreachable, or a deploy is in progress.                                                |
| The `backup` container is unhealthy    | `docker ps`, Coolify                                                                            | The last good backup is over 26 hours old. Its log has a line starting `FAILED:`.                       |
| `TRUST_PROXY is empty`                 | `app`'s log, at start                                                                           | Every visitor shares one rate limit (section 13.4).                                                     |
| `Public intake refused`, with a reason | `app`'s log                                                                                     | The limiter refused a request: `client_quota`, `scope_quota` (one business), `global_ceiling`, `storage_full`. A steady stream of `global_ceiling` or `storage_full` is a flood, or a missing `TRUST_PROXY`. |
| `… limiter unavailable`, status 503    | `app`'s log                                                                                     | The limiter could not reach the database in time. The server has run out of connections (section 14).   |
| Disk                                   | the server                                                                                      | Postgres, the `files` volume and one dump while a backup runs all share it.                             |
| The worker restarting                  | `docker ps`, Coolify                                                                            | It exits when its queue is migrated under it or after a fatal error, so that Docker starts it again; once per deploy is normal. |

**Logs** are JSON lines on standard output: `docker compose logs app`, or Coolify's
**Runtime Logs**. What is kept out of them ([logger.ts](../apps/server/src/logger.ts),
[sensitive-paths.ts](../apps/server/src/sensitive-paths.ts)):

- Fields named as a password, token, API key, secret, cookie, `Authorization` header or
  connection string are replaced with `[redacted]`.
- Addresses that are themselves the permission are logged without the part that grants
  it: `/unsubscribe/…`, `/api/v1/public/…`, `/book/…`, `/l/…`, `/f/preview/…`,
  `/s/_preview/…`, `/d/…` and `/webhooks/twilio/…`.
- A configuration error names the variable, never its value.

What **is** in them: each request's method, path, and the visitor's address
(`remoteAddress`). That is personal data in most privacy laws; decide how long your log
store keeps it.

Every response carries an `x-request-id`; the same id is on the log lines and the events
that request caused. Ask a person who reports a problem for it.

## 13. Putting a CDN in front

Nothing in the design needs one: a visit to a live page that has not changed costs the
server about two milliseconds. A CDN earns its place
when a campaign sends a crowd to one page, when visitors are far from the server, or to
keep an attack away from it. This section is written for Cloudflare, checked against its
documentation; 13.8 says what to carry over to another CDN.

The headers below are what the app sends today. They are built so that a CDN which
**respects the origin's headers** is safe with no further thought, and one told to ignore
them is not.

### 13.1 What a CDN may keep

| Address                                    | The app sends                                                                                           | A CDN may                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/s/<key>/<path>`, a published page        | `Cache-Control: public, max-age=0, must-revalidate, no-transform`, a strong `ETag`, `Vary: Accept-Encoding`           | store it, and must ask the server before every use; the server answers `304` with no body (about 2 ms).                |
| the same, with `SITES_SHARED_CACHE_SECONDS=N` | `Cache-Control: public, max-age=0, s-maxage=N, must-revalidate, no-transform`                                      | answer by itself for N seconds, then ask again (13.3).                                                                 |
| `/m/…`, public media                       | `Cache-Control: public, max-age=31536000, immutable`, an `ETag`                                         | keep it for a year. A media file's address names its content: a changed picture has a new address.                     |
| `/assets/…`, the dashboard's built files   | `Cache-Control: public, max-age=31536000, immutable`                                                    | keep it for a year. Every file name there carries a hash of its content.                                               |
| `/s/_js/<name>.<digest>.js`, a page's small scripts | `Cache-Control: public, max-age=31536000, immutable`, an `ETag` | keep it for a year. The address holds the digest of the file: a release that changes a script changes its address, and with it every page that names it. |
| `/forms/embed.js`, `/webchat/widget.js`    | `Cache-Control: public, max-age=300`, an `ETag`                                                         | keep it for five minutes. The same bytes for everyone; they change with a release.                                     |
| `/f/<key>`, a form's own page              | `Cache-Control: public, max-age=300`                                                                    | keep it for five minutes. It is an empty shell, the same for every form; the form itself comes from the API.           |
| any other file sent with `immutable` (such as the small scripts of site pages) | `Cache-Control: public, max-age=31536000, immutable`                 | keep it. The rule is the header, not the address: what the app sends as `immutable` never changes under its name.     |

`s-maxage` is for shared caches only: "Browsers ignore `s-maxage`"
(<https://developers.cloudflare.com/cache/concepts/cache-control/>), so a visitor's own
browser still asks every time.

### 13.2 What must never be kept

Each of these is sent so that nothing keeps it. Do not write a rule that overrides that.

| Address                                                                          | Why                                                                           | The app sends                                  |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| `/api/…` (the signed-in API)                                                     | A person's own data, by their session cookie.                                 | no `Cache-Control`; keep it out of every rule  |
| `/api/auth/…` (signing in and out)                                               | It answers with `Set-Cookie`.                                                 | keep it out of every rule                      |
| `/api/v1/public/…`                                                               | The answers to forms, bookings and chat.                                      | `no-store`                                     |
| `/api/v1/files/{id}/content?…` (signed file links)                               | The link is the permission, and it expires.                                   | `private, no-store`                            |
| `/s/_preview/…`, `/f/preview/…`                                                  | A draft, opened by a link that is the only key to it.                         | `no-store`                                     |
| `/m/p/…` (a picture in the editor, before it is public)                          | One signed-in person's.                                                       | `private, max-age=3600`                        |
| any `404` under `/s/`                                                            | A page that is not published must show the moment it is.                      | `no-store`                                     |
| `/d/…`, `/l/…`, `/unsubscribe/…`                                                 | An address that is itself the permission.                                     | `no-store`                                     |
| `/socket.io/…`                                                                   | Realtime: a WebSocket, or long polling when one cannot be opened.             | it is not a cacheable exchange                 |
| the dashboard's page: `/`, `/inbox`, `/book/…`, `/appointments/manage/…`, and every other path that is not a file | One page for every address, replaced by each release.                         | `no-cache`                                     |
| anything with `Set-Cookie`                                                       | It is one person's.                                                           |                                                |

Cloudflare's defaults already do the right thing with all of these: it "does not cache
HTML or JSON by default", it does not cache when "the `Cache-Control` header is set to
`private`, `no-store`, `no-cache`, or `max-age=0`" or "the Set-Cookie header exists", and
with a rule that makes a response eligible it "preserves the `Set-Cookie` but does not
cache the asset" (<https://developers.cloudflare.com/cache/concepts/default-cache-behavior/>,
<https://developers.cloudflare.com/cache/concepts/cache-behavior/>).

**The two rules never to make:**

- A rule that makes _everything_ eligible for cache. It would put the dashboard's page
  and the API inside the cache's reach, with only their own headers to protect them.
- **Edge TTL: "Ignore cache-control header and use this TTL"**, on any path. It overrides
  `no-store` (<https://developers.cloudflare.com/cache/concepts/cache-responses/>), so
  previews, API answers and 404s would be kept; and with it "Cloudflare removes the
  `Set-Cookie` and the asset is cached" (cache-behavior page), which would break signing
  in and could hand one person's answer to another.

### 13.3 How stale a page can be

- **Without `SITES_SHARED_CACHE_SECONDS`** (the default): never. The CDN asks the server
  before every use; a publish or an unpublish shows on the next request. Cloudflare with
  origin cache control "does not serve stale" for `must-revalidate`
  (<https://developers.cloudflare.com/cache/concepts/cache-control/>). The CDN saves the
  bytes, not the request: the server still sees every visit, as a 304.
- **With `SITES_SHARED_CACHE_SECONDS=N`** (1 to 300): the CDN answers by itself for up to
  N seconds from when it last asked. For that long a visitor can see the page as it was
  before a publish, and **a page that was unpublished can still be shown**. After N
  seconds it must ask again and may not show what it could not ask about. The server
  then sees about one request a page every N seconds from each of the CDN's locations,
  whatever the crowd. `60` is a sensible first value; the setting refuses more than 300.
  To end the wait at once, purge the page (13.6).

### 13.4 The visitor's address (`TRUST_PROXY`)

The limiter, the sign-in limit, the audit log and the request log count by the visitor's
address. Behind a proxy every connection comes from the proxy, so the app works the
address out through the proxies you have named in `TRUST_PROXY`
([client-address.ts](../apps/server/src/client-address.ts)): it starts at the
connection's own address, walks `X-Forwarded-For` from the right, and takes the first
address that is not a proxy you named. Each proxy appends the address that connected to
it, so a header is believed only when every hop to its right was a trusted proxy. With
`cloudflare` in the list, the walk stops at Cloudflare's address and the visitor is
Cloudflare's `CF-Connecting-IP` (below).

`TRUST_PROXY` takes addresses, CIDR ranges, `loopback`, `linklocal`, `uniquelocal`
(proxy-addr's names: 127.0.0.1/8 and ::1; 169.254.0.0/16 and fe80::/10; 10.0.0.0/8,
172.16.0.0/12, 192.168.0.0/16 and fc00::/7) and `cloudflare`, separated by commas.

**If it is wrong, it fails closed: nobody can choose their address, and the install may
refuse its own visitors.**

- Malformed, or a range wider than /8 (IPv4) or /16 (IPv6), or an IPv4 range written as
  IPv6: the app refuses to start and names the entry. A range that wide would hold
  visitors' own addresses, and a visitor inside it could write their own
  `X-Forwarded-For` and pick a fresh allowance each time.
- Empty, or missing the proxy: everyone has the proxy's address, and shares one
  visitor's allowance: 120 page views and 10 submissions a minute, and ten sign-in
  attempts in fifteen minutes, for the whole install. The app says so at start:
  `TRUST_PROXY is empty. This server is reached through a reverse proxy…`, or
  `TRUST_PROXY names cloudflare and no reverse proxy…`
  ([proxy-trust.ts](../apps/server/src/proxy-trust.ts)).
- Missing `cloudflare` when Cloudflare's proxy is on: everyone who comes through the same
  Cloudflare location shares that location's address and its allowance.
- A `CF-Connecting-IP` that is missing, repeated or not an address: the visitor is the
  Cloudflare address it came from.

**Finding the reverse proxy's address.** Open any page of the install, then look at
`app`'s log for that request: `remoteAddress` is the address the app saw. With
`TRUST_PROXY` empty, that is the proxy's address on the Docker network it shares with
`app`. Set `TRUST_PROXY` to that network's range, not the single address, which changes
when the proxy restarts:

```sh
docker network ls                       # find the network the app and the proxy share
docker network inspect <network> --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

On Coolify, the proxy "joins the `coolify` network and the resource-specific networks
used by Docker Compose applications"
(<https://coolify.io/docs/core/networking-in-coolify>); it is the resource's own network
you want. **Check:** Coolify documents no fixed range for these networks, so read it as
above rather than copying one from elsewhere, and read it again if you delete and
re-create the resource.

After setting it, the test is the same log line: `remoteAddress` must be your own public
address.

**With Cloudflare in front: add `cloudflare` to `TRUST_PROXY`, after the reverse
proxy's range**, such as `172.18.0.0/16,cloudflare`. Do it once the record is proxied
(13.5), not before. Nothing changes on the reverse proxy.

- _What the name does._ It stands for Cloudflare's published ranges, as the image
  carries them ([cloudflare-ranges.ts](../apps/server/src/cloudflare-ranges.ts), with the
  day they were last compared). When the walk reaches one of those addresses, the visitor
  is `CF-Connecting-IP`, which "provides the client IP address connecting to Cloudflare
  to the origin web server", and nothing to the left of that address in
  `X-Forwarded-For` is read
  (<https://developers.cloudflare.com/fundamentals/reference/http-headers/>).
- _Why not list Cloudflare's ranges by hand, as plain proxies._ Cloudflare's addresses
  are not this install's alone. Its shared origin certificate "only proves a request came
  from the Cloudflare network — not from your account specifically"
  (<https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/>),
  and Cloudflare rates allowing its addresses as "Moderately secure" and "Vulnerable to IP
  spoofing" (<https://developers.cloudflare.com/fundamentals/security/protect-your-origin-server/>).
  Anyone's Cloudflare Worker can send requests to this install's domain, with any
  `X-Forwarded-For` it likes; Cloudflare appends to a header that is already there.
  Listed as plain proxies, Cloudflare's ranges make every entry to the left of a
  Cloudflare address believable, and what Cloudflare puts in `X-Forwarded-For` for a
  Worker's request is not documented. What is documented: for a Worker's request to
  another zone, Cloudflare sets `CF-Connecting-IP` to 2a06:98c0:3600::103 "for security
  reasons" (same headers page), one address for every Worker, inside the published range
  2a06:98c0::/29. So with `cloudflare`, a Worker can't choose its address. This is how
  Cloudflare's own origin recipes for Apache, HAProxy, Caddy, Envoy, Tomcat and Lighttpd
  read the visitor: `CF-Connecting-IP`, from Cloudflare's ranges
  (<https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/>).
- _The reverse proxy needs nothing._ The app finds Cloudflare's address in
  `X-Forwarded-For` whether or not the proxy trusts Cloudflare, and reads
  `CF-Connecting-IP`, which no proxy here changes. Traefik (Coolify's proxy, read in its
  v3.7 source): from a peer that is not in `forwardedHeaders.trustedIPs` it deletes
  `X-Forwarded-*` and `X-Real-Ip`
  ([forwarded_header.go](https://github.com/traefik/traefik/blob/v3.7/pkg/middlewares/forwardedheaders/forwarded_header.go)),
  then appends the peer to `X-Forwarded-For`
  ([proxy.go](https://github.com/traefik/traefik/blob/v3.7/pkg/proxy/httputil/proxy.go)),
  so the app sees `X-Forwarded-For: <Cloudflare's address>` and Cloudflare's
  `CF-Connecting-IP`. With Cloudflare in `trustedIPs` the header keeps Cloudflare's
  entries and the answer is the same. nginx's `$proxy_add_x_forwarded_for` and Caddy
  (which "passes through incoming headers") also append the peer and keep
  `CF-Connecting-IP`.
- _Someone going around Cloudflare_ reaches the reverse proxy from their own address. The
  proxy appends it, it is not a trusted proxy, and it is the visitor, whatever
  `CF-Connecting-IP` or `X-Forwarded-For` they sent.
- _Pseudo IPv4 stays Off_ (Cloudflare's default). "Overwrite Headers" replaces
  `CF-Connecting-IP` and `X-Forwarded-For` with a made-up IPv4 address
  (<https://developers.cloudflare.com/network/pseudo-ipv4/>), which the limiter would
  count instead of the visitor's IPv6 /64.

**Keeping the list current.** <https://www.cloudflare.com/ips/> "is intended to be the
definitive source", the ranges "do not change frequently", and new ones "are added to our
list of IP ranges before being put into production"
(<https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/>).
Cloudflare documents no notice by email. Once a month, run
`node scripts/cloudflare-ips.mjs`: it compares Cloudflare's two text lists with the copies
the image is tested against, and exits 1 when they differ. Then
`node scripts/cloudflare-ips.mjs --write` updates the copies,
[cloudflare-ranges.test.ts](../apps/server/src/cloudflare-ranges.test.ts) fails until
`cloudflare-ranges.ts` lists the same ranges, and the next release carries them. Until it
does, visitors arriving through a new range share that Cloudflare address's allowance;
nobody can choose their address.

**Let only Cloudflare reach the server.** Once the domain is proxied, close ports 80 and
443 on the server's firewall to every address but Cloudflare's ranges. Otherwise anyone
who learns the server's own address can go around the CDN, its cache and its protection.
(The app's own reading is safe either way: a direct visitor is not a trusted proxy.) The
firewall keeps out the internet, not other Cloudflare customers; the lock that does is
zone-level Authenticated Origin Pulls with your own certificate, where "the certificate is
exclusive to your account" (Free plan included,
<https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/>),
which also needs the reverse proxy to ask for the client certificate. Not set up here:
without it, the most anyone on Cloudflare's network gains is the allowance of the one
Worker address; the per-business and whole-install ceilings hold either way.

### 13.5 Setting Cloudflare up

In this order.

1. **DNS.** Add the domain's record and leave it **DNS only** until step 3 is done.
   Caching and rules apply only to a **Proxied** record: when DNS-only, Cloudflare "does
   not route HTTP/HTTPS traffic through its network"
   (<https://developers.cloudflare.com/dns/proxy-status/>).

2. **The certificate on the server.** Cloudflare must reach the server over HTTPS with a
   certificate it can check. Two ways:
   - Keep the Let's Encrypt certificate the proxy already has. A public certificate
     satisfies Full (strict). But its renewal is at risk once the record is proxied:
     "Let's Encrypt might fail to validate your domain due to the proxy interfering with
     the **HTTP** or **TLS-ALPN-01** challenge. In that case, you must either use a DNS
     challenge or stop proxying your domain"
     (<https://coolify.io/docs/troubleshoot/dns-and-domains/lets-encrypt-not-working>),
     and a certificate that is still valid hides the problem for weeks. Switch the proxy
     to the DNS challenge
     (<https://coolify.io/docs/core/networking/proxy/traefik/dns-challenge>).

     Or keep Traefik's HTTP challenge (Coolify's default) and keep its path clear.
     "If your visitor uses http, then Cloudflare connects to the origin using plaintext
     HTTP" (<https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full/>),
     so Let's Encrypt's request reaches Traefik's port 80, where Traefik's own ACME router
     comes before every other (`Priority: math.MaxInt`,
     [internal.go](https://github.com/traefik/traefik/blob/v3.7/pkg/provider/traefik/internal.go)).
     Two things at Cloudflare would stop it. **Always Use HTTPS** would send Let's Encrypt
     to `https://`, where Traefik answers no challenge, and Cloudflare's page on it does not
     say that challenge paths are left alone
     (<https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/>):
     leave it off, since Traefik already redirects every other `http://` request. And any
     challenge page (Bot Fight Mode, Under Attack mode, a WAF rule) on
     `/.well-known/acme-challenge/`. **Check:** watch the first renewal after turning the
     proxy on in the proxy's log, and move to the DNS challenge if it fails.
   - Or install a Cloudflare Origin CA certificate on the proxy. It is for an origin
     that "only receives traffic from proxied records": visitors "may see untrusted
     certificate errors if you pause Cloudflare or disable proxying"
     (<https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/>), and
     "Cloudflare does not currently send expiration notifications" for it. Coolify's
     steps: <https://coolify.io/docs/integrations/networking/cloudflare/tunnels/full-tls>.

3. **SSL/TLS encryption mode: Full (strict).** It is Full "with added validation of the
   origin server's certificate, which can be issued by a public CA like Let's Encrypt or
   by Cloudflare Origin CA"
   (<https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/>). Never
   **Flexible**: Cloudflare would talk to the server over plain HTTP, and the proxy's
   redirect to HTTPS "creates a redirect loop". Never plain **Full** either: it does not
   check the certificate at all.

4. **Turn the proxy on** for the record (orange cloud), then add `cloudflare` to
   `TRUST_PROXY` as in 13.4, and redeploy. Until the redeploy, visitors share their
   Cloudflare location's allowance; nobody can choose an address.

5. **WebSockets.** "Cloudflare supports proxied WebSocket connections without additional
   configuration", on all plans; the switch is **Network > WebSockets**
   (<https://developers.cloudflare.com/network/websockets/>). **Check** that it is on:
   the page does not say what a new zone starts with. Cloudflare closes a WebSocket
   "when no data is transmitted in either direction for a period of time", and asks for
   a keepalive; the realtime server sends one every 25 seconds (Socket.IO's
   `pingInterval`, 25000 in the engine.io 6.6 the image carries, answered by the browser
   within `pingTimeout`, 20000). It also closes them when it restarts its own servers;
   the dashboard reconnects by itself. Realtime is the app's only long-lived connection:
   it uses WebSockets alone (no long polling), and there is no server-sent event stream.
   The AI jobs (assistant turns, reply drafts, field extraction) run in the worker, and a
   provider's connection test gives up after 30 seconds, so no request waits near the
   125 seconds after which Cloudflare gives up on an answer (step 8).

6. **A cache rule for live pages.** Without one, site pages are HTML and are not kept at
   all (`CF-Cache-Status: DYNAMIC`). Under **Caching > Cache Rules**, create one rule
   (<https://developers.cloudflare.com/cache/how-to/cache-rules/settings/>):

   | Field                 | Value                                                                                                                       |
   | --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
   | When (expression)     | `starts_with(http.request.uri.path, "/s/") and not starts_with(http.request.uri.path, "/s/_preview/")`                        |
   | **Cache eligibility** | **Eligible for cache**                                                                                                      |
   | **Edge TTL**          | **Use cache control-header if present, bypass cache if not** (the label is spelled that way)                                 |
   | **Browser TTL**       | **Respect origin**                                                                                                          |

   That is the whole of it: the rule lets Cloudflare keep live pages, and the origin's
   headers say for how long. Previews and 404s answer `no-store` and are not kept even
   though the first half of the expression matches them (their status is `BYPASS`);
   leaving previews out of the expression as well costs nothing. The Free plan allows 10
   cache rules. "The last matching rule wins", so do not add a broader rule below it.

   The files need no rule. `/assets/…`, `/m/…` with a picture's file extension, and
   the two scripts are kept by Cloudflare's defaults, which go "based on file extension
   and not by MIME type" and follow the origin's `max-age`. **Check:** a media file
   whose address has no extension Cloudflare knows is not kept without a rule; if
   `CF-Cache-Status` on your pictures is `DYNAMIC`, add a rule with the same three
   settings and the expression `starts_with(http.request.uri.path, "/m/")`, above the
   bypass rule below.

   **A bypass rule for the API, last in the list.** The API already answers
   `private, no-store`, and Cloudflare does not cache a response whose `Cache-Control` is
   "`private`, `no-store`, `no-cache`, or `max-age=0`"
   (<https://developers.cloudflare.com/cache/concepts/default-cache-behavior/>). The rule
   is there so that a broader rule someone adds later can't change that: "For conflicting
   settings (for example, bypass cache versus eligible for cache), the last matching rule
   wins" (<https://developers.cloudflare.com/cache/how-to/cache-rules/order/>).

   | Field                 | Value                                                                                                   |
   | --------------------- | ------------------------------------------------------------------------------------------------------- |
   | When (expression)     | `starts_with(http.request.uri.path, "/api/") or starts_with(http.request.uri.path, "/socket.io/")`      |
   | **Cache eligibility** | **Bypass cache**                                                                                        |

   **The dashboard's HTML needs no rule.** "The Cloudflare CDN does not cache HTML or JSON
   by default" (same default-cache page), the dashboard's page is sent `no-cache`, and the
   only rule that makes HTML eligible is the one for `/s/`. Its paths are the dashboard's
   own routes, so a path rule could not list them anyway.

   **Browser Cache TTL: Respect Existing Headers** (**Caching > Configuration**). Any
   other value makes Cloudflare override the origin's `Cache-Control` "when the origin's
   `max-age` is lower" than it
   (<https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/set-browser-ttl/>),
   and a live page's `max-age` is 0. Never add a "Cache Everything" page rule or a cache
   rule whose Edge TTL ignores the origin's header (13.2).

7. **Turn off what rewrites pages.** A live page carries a content security policy that
   allows the page's own stylesheet by its hash and no script but the CRM's own
   ([site-render](../packages/site-render/src/server.ts)). A feature that edits the HTML
   or adds a script on the way through either breaks the page or is blocked by it, and
   several also weaken or remove the `ETag` that revalidation rests on
   (<https://developers.cloudflare.com/cache/reference/etag-headers/>).

   Since 2026-10-13 every live page and every draft preview is also sent with
   `no-transform` in its `Cache-Control`: "an intermediary (regardless of whether it
   implements a cache) MUST NOT transform the content" (RFC 9111, 5.2.2.6). Cloudflare's
   own page on the header says that with it Cloudflare "does not transform body" when
   Origin Cache Control is on, that "Polish is disabled" and "compression is disabled"
   by it, and that without Origin Cache Control it "may (un)Gzip, Polish, email filter,
   etc." (<https://developers.cloudflare.com/cache/concepts/cache-control/>). So the
   header helps, and is not a promise: that page does not name Email Address Obfuscation,
   Rocket Loader or Web Analytics among what it stops, and it depends on a zone setting.
   **Switching the features below off is still the instruction; the header is belt and
   braces** for the day one is switched back on. One thing follows from it: Cloudflare
   will not compress a page for the server. It does not need to: the server sends each
   page already compressed (Brotli or gzip) to a browser that takes it.

   What to switch off:

   | Feature                                 | What it does                                                                                                                                                               | State on a new zone                                    | Do                    |
   | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------- |
   | **Email Address Obfuscation**           | "replaces visible email addresses in your HTML" and "injects a small decode script". The page's policy blocks the script, so every address on a page would read `[email protected]`. | on: "enables … automatically when you sign up"          | **turn off**          |
   | **Rocket Loader**                       | defers "all of your JavaScript", and needs `script-src … ajax.cloudflare.com`, which the pages do not allow. Forms and chat would stop loading.                            | **Check:** not stated                                  | keep off              |
   | **Automatic HTTPS Rewrites**            | rewrites `http` links in the HTML; one of the features that make Cloudflare remove a weak `ETag`.                                                                          | **Check:** not stated                                  | turn off (every address the CRM writes is https already) |
   | **Web Analytics** (automatic setup)     | injects a beacon script, which the policy blocks.                                                                                                                          | "enabled by default" for proxied sites after setup     | turn off, or leave the blocked beacon |
   | **Bot Fight Mode**                      | turns on JavaScript Detections, which injects a script "in response to requests for HTML pages".                                                                           | **Check:** not stated                                  | keep off unless you test every kind of page with it on |
   | **Cloudflare Fonts**                    | "works by rewriting your webpage's HTML".                                                                                                                                  | **Check:** not stated                                  | keep off              |
   | Auto Minify, Mirage                     | removed by Cloudflare (August 2024, September 2025).                                                                                                                       |                                                        | nothing to do         |

   Sources: <https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/>,
   <https://developers.cloudflare.com/speed/optimization/content/rocket-loader/>,
   <https://developers.cloudflare.com/fundamentals/reference/policies-compliances/content-security-policies/>,
   <https://developers.cloudflare.com/web-analytics/get-started/>,
   <https://developers.cloudflare.com/bots/get-started/bot-fight-mode/>,
   <https://developers.cloudflare.com/speed/optimization/content/fonts/>,
   <https://developers.cloudflare.com/fundamentals/api/reference/deprecations/>.
   To keep one of them for another site on the same zone, switch it off for this host
   with a configuration rule instead
   (<https://developers.cloudflare.com/speed/optimization/content/compression/>).

8. **Uploads.** Cloudflare's own limit on a request body is 100 MB on Free and Pro and
   200 MB on Business
   (<https://developers.cloudflare.com/cache/concepts/default-cache-behavior/#upload-limits>;
   the page does not say which error answers a larger one). Every upload, the media
   library's included, is one request with the file as its body, and its limit is
   `FILES_MAX_BYTES`: 25 MiB unless you change it, well inside. The app accepts up to
   1 GiB there; behind Cloudflare keep it under 100,000,000 bytes (Free, Pro). A request
   the server has not answered within 125 seconds ends as a 524 ("Proxy Read Timeout",
   125 s, changeable on Enterprise only), and Cloudflare gives up writing to the origin
   after 30 seconds ("Proxy Write Timeout")
   (<https://developers.cloudflare.com/fundamentals/reference/connection-limits/>).

### 13.6 Purging on publish

- **Without `SITES_SHARED_CACHE_SECONDS`: never needed.** The CDN asks before every use.
- **With it:** a publish, and above all an unpublish, takes up to N seconds to show. The
  CRM does not purge for you. To end the wait, purge the page's address, and the site's
  own address if the page is its first:

  ```sh
  curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/purge_cache" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -d '{"files":["https://crm.example.com/s/<key>/<path>","https://crm.example.com/s/<key>"]}'
  ```

  The token needs the **Cache Purge** permission and nothing else. Purging by URL is on
  every plan; "wildcards are not supported on single file purge", and a 200 "indicates
  that Cloudflare received the request — it does not confirm that Cloudflare … evicted
  any content" (<https://developers.cloudflare.com/cache/how-to/purge-cache/>). In the
  dashboard it is **Caching > Configuration > Purge Cache > Custom Purge**, by **URL**.
  Read the token from the environment as above; never write it into a command you paste
  somewhere.

### 13.7 Checking that it works

Cloudflare says what it did with a request in the `CF-Cache-Status` response header
(<https://developers.cloudflare.com/cache/concepts/cache-responses/>).

**The script.** From any computer with Node, in a checkout of the repository:

```sh
node scripts/check-cdn.mjs https://crm.example.com /s/<key>/<path>
```

It asks for the dashboard's HTML, one of its `/assets/` files, `/api/v1/me` and the
published page (when given) twice each, with no cookie and no sign-in, prints
`Cache-Control`, `CF-Cache-Status`, `ETag` and `Age` for each, and says PASS, WARN, FAIL
or SKIP for each expectation: the HTML and the API never come from the cache, the file is
immutable and a `HIT` the second time, the page is `public, no-transform` with an `ETag`,
the CDN keeps it, and nothing Cloudflare injects (the markers Cloudflare's own pages name
for Email Address Obfuscation, JavaScript Detections, Web Analytics and Rocket Loader, and
any `/cdn-cgi/` address) is in it. Without a `CF-Ray` header the record is DNS-only, and
the CDN's expectations are skipped. It exits 1 on any FAIL. The same by hand:

```sh
# A published page. First request: MISS. Then, with no SITES_SHARED_CACHE_SECONDS:
# REVALIDATED (kept, and the server said "unchanged"). With it: HIT, with an Age, for N seconds.
curl -sI https://crm.example.com/s/<key>/<path> | grep -iE '^(HTTP|cf-cache-status|cache-control|etag|age)'

# The same page, as a browser that holds it: 304, no body.
curl -sI -H 'If-None-Match: <the etag from above>' https://crm.example.com/s/<key>/<path> | head -1

# These must never say HIT or REVALIDATED. Expect DYNAMIC, or BYPASS for a path the rule matches.
curl -sI https://crm.example.com/                       | grep -iE '^(cf-cache-status|cache-control)'
curl -sI https://crm.example.com/api/v1/me              | grep -iE '^(cf-cache-status|cache-control)'
curl -sI https://crm.example.com/s/<key>/no-such-page   | grep -iE '^(HTTP|cf-cache-status|cache-control)'

# A dashboard file: HIT after the first request, and immutable.
curl -sI https://crm.example.com/assets/<a file name from the page source> | grep -iE '^(cf-cache-status|cache-control)'
```

- **Check:** Cloudflare's pages disagree about `max-age=0` on the plans where origin
  cache control cannot be turned off. One says it does not cache such a response; the
  origin cache control page and the cache-responses page say it "caches and always
  revalidates". If a published page shows `MISS` or `EXPIRED` on every request and never
  `REVALIDATED`, your zone follows the first: the page is still correct and never stale,
  and Cloudflare is saving you nothing. Set `SITES_SHARED_CACHE_SECONDS` to get `HIT`.
- Unpublish a test page and request it again: `404` at once without the setting; within
  N seconds with it.
- Open a published page in a browser with the developer console open: no content
  security policy errors, and an email address on the page reads as written.
- Sign in, open the Inbox, and check the browser's network panel shows a WebSocket to
  `/socket.io/` with status 101.
- Submit a form twice from two networks and read `remoteAddress` in `app`'s log: two
  different public addresses, neither of them Cloudflare's.

### 13.8 Another CDN

The app's side does not change. Carry these over, in the other product's words:

1. It must **honour the origin's `Cache-Control`**, including `no-store`, `private`,
   `must-revalidate` and `s-maxage`, and must not cache a response with `Set-Cookie`.
   If it has a "cache everything" or "override origin" switch, leave it off.
2. It must **revalidate with `If-None-Match`** and keep the origin's `ETag`. A CDN that
   cannot revalidate will fetch the page in full every time; that is correct and saves
   nothing.
3. If it caches only some content types by default, make **`/s/` eligible** and nothing
   wider.
4. It must **key by `Accept-Encoding`** (the pages send `Vary: Accept-Encoding`), or
   compress and decompress by itself.
5. It must **pass WebSockets** and a body as large as `FILES_MAX_BYTES`.
6. It must append the visitor's address to **`X-Forwarded-For`**, and publish the ranges
   it connects from, for `TRUST_PROXY`, where they are plain proxies. The app reads no
   other CDN's own header: `CF-Connecting-IP` is read only from Cloudflare's ranges, under
   the `cloudflare` name. **Check** whether others (its customers' code, say) can send
   requests from the same ranges: if so, an address they write to the left of the CDN's
   is believed, and the CDN needs a name of its own as Cloudflare has.
7. It must **not rewrite HTML or inject scripts** into `/s/` pages.
8. It must have a **purge by URL**, if you set `SITES_SHARED_CACHE_SECONDS`.

## 14. Scaling notes

What is true today, and what has not been measured.

**Measured**, on one development machine (Intel Core i7-14700K, 28 logical processors,
31.7 GiB, Windows 11, Postgres 18 in Docker Desktop, the server, the database and the
load generator all on it; the scripts are in
`apps/server/bench`). They say what the code costs, not what your server will carry:

- A published page that has not changed: about 2 ms, around 3,300 a second with eight
  visitors at a time. A page rendered from nothing: about 9 ms alone.
- Form submissions: every one stored up to 160 a second, with the default pool of ten.
- A flood on one business's form, booking calendar or chat, beside a quiet business: the
  quiet business's visitors were all served.

**Not measured:** anything on a 2 vCPU / 4 GB server; the dashboard and the
signed-in API under load; a shared install with several agencies; the worker's
throughput. Do not read a capacity for your server out of the numbers above. Run the
scripts on your own server (`apps/server/bench/README.md`) before promising one.

**The limits a crowd meets first** are the limiter's, not the server's. Each is a
minute long, counted in the database, so every app process shares them
(migrations 0042 and 0089):

|                   | Reads a minute | Writes a minute |
| ----------------- | -------------- | --------------- |
| One address       | 120            | 10              |
| One business      | 1,200          | 100             |
| The whole install | 6,000          | 500             |

- "One business" covers its site pages, forms, booking pages and chat together, from the
  second request for each (the first tells the server which business an address belongs
  to). A flood on one business stops at that business's line and uses none of the
  install's.
- Past a limit the answer is 429 with `Retry-After`; the form, the chat widget and the
  booking page keep what was typed and say to try again.
- 6,000 reads a minute is a hundred page views a second for the whole install. A CDN
  that answers by itself (`SITES_SHARED_CACHE_SECONDS`) is what carries more than that.
- The limiter keeps at most 4,096 different addresses in one minute. More than that, and
  new visitors are refused until the minute ends.

**What is per process, not per install.** If you ever run two `app` containers:

- The page cache (`SITES_PAGE_CACHE_PAGES`): each process keeps its own, and each checks
  the database before using it, so they never disagree.
- The line in front of one form's submissions, and the line in front of one business's
  booking requests (one at a time, 32 waiting): each process has its own, so two
  processes let two through at once.
- Which business a public address belongs to: each process learns it from its own first
  request.
- The sign-in limit and the public limiter are in the database: shared.
- Realtime: each process listens to Postgres for changes and tells its own connected
  browsers ([realtime.ts](../apps/server/src/realtime.ts)). **Check:** nothing in this
  repository has been run with two app containers behind a load balancer; read
  Socket.IO's own page on running several servers before you do.

**Connections to Postgres.** The app and the worker each keep up to
`DATABASE_POOL_SIZE` (ten), and sign-in, realtime and the job queue keep connections of
their own beside that; Postgres allows 100 in all unless you change it. Ten is what the measurements above
used. A request holds a connection for as long as its transaction runs, so more
connections help only when requests are waiting for one (the `limiter unavailable` line
in section 12), and each costs Postgres memory. Raise it in steps, and leave room: two
processes at 30 is already 60.

**Growing an install**, in this order: tune Postgres,
move to a bigger server, put the database on its own server, add workers. One server is
one point of failure: a restore you have tested is what stands behind it.

## 15. Go-live checklist

- [ ] `https://<your address>/ready` answers 200, with a valid certificate.
- [ ] `PUBLIC_URL` is that address, and the dashboard opens on it and nowhere else.
- [ ] No secret is a development value: the app would have refused to start, so `app`
      and `worker` running is the proof. Each secret is in your copy of the settings,
      off the server.
- [ ] `SECRETS_KEYS` is stored in a second place, apart from the backups bucket.
- [ ] The first admin exists, signed in through the setup link, and turned on two-factor
      sign-in.
- [ ] The sign-in limit is on: `DEV_SIGN_IN_LIMIT` is not set anywhere. (Production
      refuses `off`.)
- [ ] `TRUST_PROXY` is set: no `TRUST_PROXY is empty` line in `app`'s log, and a request
      of yours shows your own address as `remoteAddress`. Behind Cloudflare's proxy it ends
      in `cloudflare`, and `node scripts/check-cdn.mjs <your address> <a page>` shows no
      FAIL (13.7).
- [ ] `FILES_STORAGE=s3`, the bucket is private, and a file uploaded in the dashboard
      opens again from its link.
- [ ] Backups are on: `backup status` shows a backup from today, the container is
      healthy, and **a restore into a scratch database has been done once** (BACKUPS.md,
      "Test a restore").
- [ ] The install's mail arrives: ask for a sign-in link and receive it, not in spam.
- [ ] `PUBLIC_INTAKE_SECRET` is set. A test page is published, opens at its `/s/…`
      address signed out, and shows the browser no console errors.
- [ ] A test form on that page is submitted and its submission appears in the
      dashboard, with a contact.
- [ ] A test booking is made and its confirmation is queued; a chat message from the
      widget reaches the Inbox.
- [ ] With a CDN: every check in 13.7 passes, the server's ports are closed to everyone
      but the CDN, and uploading a file near `FILES_MAX_BYTES` works.
- [ ] An uptime monitor watches `/ready`, and someone is told when the `backup`
      container is unhealthy.
- [ ] The images are pinned to one commit (section 11), and you know the previous one.
