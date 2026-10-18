# Cal CRM

**The open-source GoHighLevel alternative, built AI-first.**

Cal CRM is an all-in-one CRM for agencies and the businesses they serve: contacts,
conversations, pipelines, calendars, workflows, forms, websites and email marketing, in
one app you host yourself. If you have used GoHighLevel, you already know your way around:
the layout, the menus and the workflow builder follow the same patterns.

What makes it different is that AI is part of the product. You don't bolt it on. Describe what you
want, and the assistant builds it. When something doesn't work, ask it why.

> **Status:** in active development, not yet released. Expect rough edges and breaking
> changes until the first release.

## Build it by asking

The built-in assistant works through the same API as the screens, with the same
permissions. It can build and change:

- **Workflows.** "When someone books a call, tag them, wait a day and send a follow-up
  email." The assistant writes the workflow, checks it with the validator and test-runs it
  against a real contact, without sending anything.
- **Calendars.** Booking calendars, their availability and the team members who take
  the appointments.
- **Forms.** Fields, tags and the workflow a submission starts.
- **Pipelines.** Stages for your deals, set up the way you sell.

It also reads your contacts, deals and reports to answer questions about the business.

**Nothing goes live without you.** The assistant can read anything and draft freely. A
change that goes live, such as publishing a workflow or a form or changing a calendar, comes
to you as a proposal, and you confirm it.

## Debug it by asking

Automation tools usually leave you with logs you have to read yourself. In Cal CRM you can ask:

- "Why didn't Sarah get the welcome email?" The assistant checks which triggers fired,
  whether she matched the filters, and where her run stopped, and says why in plain words.
- "What did this workflow do yesterday?" Every run and every step is recorded, with its
  outcome.
- "Why did this contact get that tag?" Every change on a record keeps the event that caused it.

The same answers are on screen: each workflow has its enrollment history and execution
logs, and each contact shows the automations it has been through.

## Any AI you choose

- **Bring your own model:** Anthropic, OpenAI, or any OpenAI-compatible server, including
  models you run yourself with Ollama, vLLM or LM Studio. Pick a model for each job, set
  spending limits, and see what each call cost.
- **Use your own AI tools:** Cal CRM ships an [MCP server](packages/mcp/README.md), so
  Claude, Cursor or any MCP client can build and debug workflows, forms and calendars in
  your CRM, with an API key that limits what it may touch.
- **An open automation format:** every workflow is one JSON document with a published
  schema and catalog, so any model or script can write workflows that actually run. See
  [docs/AUTOMATIONS.md](docs/AUTOMATIONS.md).
- **Your own apps in the marketplace:** list apps for your businesses to install. An app
  connects with OAuth, gets only what the business allowed, and hears of events by signed
  webhook. See
  [docs/APP-DEVELOPERS.md](docs/APP-DEVELOPERS.md).

## Everything else you expect from a CRM

| | |
|---|---|
| **Contacts and companies** | Custom fields, tags, smart lists, bulk actions, CSV import, notes, tasks and a full activity timeline |
| **Conversations** | One inbox for every mailbox you connect: your own mail server, Google, Microsoft or any provider. AI drafts replies for you to send |
| **Opportunities** | Pipelines, stages, a board view and stage history |
| **Calendars** | Booking pages, team availability, round-robin assignment, reminders and Google Calendar sync |
| **Workflows** | A drag-and-drop builder with triggers, conditions, waits, email, SMS, tasks and webhooks, plus ready-made recipes |
| **Sites and forms** | Websites and funnels with a page editor, forms with spam protection, and lead-source tracking |
| **Marketing** | Email campaigns, templates, snippets and trigger links |
| **Payments** | Quotes and invoices, with payments recorded against them |
| **Reporting** | Dashboards and reports for opportunities, appointments, email and attribution |
| **Agency tools** | Many client businesses in one install, roles and permissions, your own branding, audit logs, API keys and an app marketplace |

## Why self-hosted

- **Your data stays on your server.** Each business is isolated in the database itself:
  row-level security is enforced on every table, so one client never sees another's data.
- **No per-seat or per-account fees.** Run as many client businesses as your server holds.
- **Use the providers you already pay for:** your own mailboxes, SMS provider, file
  storage (any S3-compatible service) and AI models.
- **One Docker Compose file.** It runs on any VPS, with or without
  [Coolify](https://coolify.io), with daily backups built in.

## Install

The full guide is [docs/HOSTING.md](docs/HOSTING.md): Coolify or plain Docker Compose,
every setting, file storage, mail, backups, upgrades and a go-live checklist.

In short, behind any reverse proxy that serves HTTPS and passes requests to `app` on
port 3000:

```bash
cp install.env.example install.env   # fill it in: passwords, secrets, mail, your address
docker run --rm ghcr.io/mockydevs/crm:main node dist/vault.js new-key 1   # the vault's keys, for install.env
docker compose --env-file install.env up -d
docker compose --env-file install.env logs app   # the setup link for the first admin
```

On first start, `migrate` sets up the database and creates your agency, then `app` prints a
one-time setup link that creates the first admin. Upgrading is deploying the new
version: the migrations run on their own, and your data stays as it is.

Backups and restore are covered in [docs/BACKUPS.md](docs/BACKUPS.md).

## Run it locally

Needs Node.js 24, pnpm and Docker.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts Postgres and [Mailpit](https://mailpit.axllent.org) in Docker, sets up
the database with a sample agency and business, and runs the app.

| Address | What's there |
|---|---|
| http://localhost:5173 | The app |
| http://localhost:3000/api/v1 | The API; its OpenAPI document is at `/api/v1/openapi.json` |
| http://localhost:8025 | Mailpit, which catches the email the app sends |

Sign in as `dana@harborlights.example`: choose **Email me a sign-in link instead**, and
open the link in Mailpit.

## How it's built

TypeScript throughout: a [Fastify](https://fastify.dev) server, a React dashboard, and
Postgres 18 for the data, the job queue and search. One image runs the API, the
background worker and the dashboard.

| Path | What it holds |
|---|---|
| [apps/server](apps/server/) | The API and the background worker |
| [apps/dashboard](apps/dashboard/) | The React app |
| [packages/modules](packages/modules/) | The business logic: CRM, automation, AI, calendars, messaging, sites and more |
| [packages/db](packages/db/) | Migrations and the SQL test suite |
| [packages/contracts](packages/contracts/) | The API's contracts and its OpenAPI document |
| [packages/sdk](packages/sdk/) | A typed client for the API |
| [packages/mcp](packages/mcp/) | The MCP server for outside AI clients |
| [e2e](e2e/) | End-to-end tests against the built app and a real database |

## Contributing

Issues and ideas are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a
pull request, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

Cal CRM is free software under the [GNU Affero General Public License v3.0](LICENSE).
You may use, self-host, change and share it, including commercially. If you run a changed
version for others over a network, you must offer them its source under the same license.

Copyright (C) 2026 Mocky Digital.
