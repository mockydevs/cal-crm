# Benchmarks and load tests

Three measurements of the server as an install runs it: the production start (`start()`,
role `app`), a real Postgres in Docker (Testcontainers), real HTTP, and a crowd in a
thread of its own.

| Command                                          | Measures                                                                                                                                                           | Takes             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| `pnpm --filter @repo/server run bench:pages`     | The server's own time for a published 20-section page: rendered, kept, and already held (304). p50, p95, p99 and requests a second                                 | about a minute    |
| `pnpm --filter @repo/server run bench:reports`   | Every report and widget of the reporting module at a large business (250,000 contacts, 100,000 opportunities, 50,000 appointments over three years), five ranges each: p50 and p95 against the budget, a report's first page at once, and the plans of whatever is over budget | about four minutes |
| `pnpm --filter @repo/server run load:intake`     | Form submissions a second, step by step, to the ceiling; then a flood on one business with the limits an install has, beside a quiet business and a published page | about two minutes |
| `pnpm --filter @repo/server run load:neighbours` | A flood of bookings on one business, then a flood of chats, each beside a quiet business, with the limits an install has                                           | about a minute    |

A fourth is no measurement but lives here because it needs the same server:
`pnpm --filter @repo/server run browser:arrival` drives Chromium (the one apps/dashboard's
Playwright installed) through a published two-step funnel from an ad's address to a sent form,
and reads the lead's touch. About a minute.

All need Docker. Run one at a time, with nothing else heavy on the machine, and never with
the test suites: what they measure is the machine. They are not part of `pnpm run check`.
A ceiling loose enough for a two-core CI runner is kept by the ordinary integration suite
instead (`src/sites-http.int.test.ts`, "answers a visit … within its ceiling").

Each run prints its numbers and writes them to `apps/server/reports/` (not committed):
`bench-pages.json`, `load-intake-capacity.json`, `load-intake-isolation.json`,
`load-booking-isolation.json`, `load-chat-isolation.json`, `bench-reports.json` (with
`bench-reports-plans.txt`).

## What is in here

- `client.mjs`: the load generator. Plain `node:http` over kept-alive connections, in a
  worker thread, so the clock that times an answer is not the server's own event loop. No
  dependency. Every request names an address of its own in `X-Forwarded-For` (the server
  under test trusts the loopback proxy), as a crowd of different visitors would have.
- `harness.ts`: the server, a business with its forms and a published page, percentiles.
- `pages.bench.ts`, `intake.load.ts`, `neighbours.load.ts`: the measurements, and what
  each fails on.
- `reports.bench.ts` and `reports-seed.ts`: the reporting benchmark and its large business,
  written straight into the tables as the owner role and vacuumed. It runs the reporting
  module's routes in the process, not over HTTP, so the per-person query limit is left out.
  It fails only if a report is refused (a timeout or a limit); what is over its budget is listed in the JSON.

## What each one fails on

A measurement that only prints can go wrong unnoticed, so both also assert:

- **Pages:** every answer is the one expected (200, 304, 404: a refusal by the limiter in
  the middle of a run would make the numbers a refusal's), a 304 carries no bytes, and the
  Brotli page is under a fifth of the page.
- **Intake, capacity:** every visitor told "received" is one stored submission, one event
  and one contact; up to 40 visitors a second all are received with a 95th percentile under
  a second; past the ceiling the server answers 429 or 503 and nothing else.
- **Intake, a flood:** the flooded business's visitors are told "received" or "wait" (429
  with `Retry-After`) and nothing else; the quiet business's are all received, with a 95th
  percentile under 1.5 s; the page answers throughout, from what the server kept, with a
  95th percentile under 250 ms.

- **Booking and chat beside a neighbour:** the flooded business gets what it asked for
  or "wait" (429 with `Retry-After`) and nothing else; every booking and message answered
  "done" is stored once, with its event; the quiet business gets everything it asked for,
  with a 95th percentile under 1.5 s.

## The limiter while measuring

The shared limiter's ceilings are a minute long and far below what the server can do (120
reads an address, 1,200 a business, 6,000 the install). To measure the server and not the
limiter, the page benchmark and the capacity phase empty the limiter's counters every
40 ms, as the turn of a minute does. Every request still pays for the limiter's statement.
The flood phase leaves the limiter exactly as an install has it: that phase is about the
limits.
