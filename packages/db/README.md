# packages/db

The database: install bootstrap, migrations, the migration runner, typed access for the
application, and the SQL test suite.

```
bootstrap/   runs once per install as a superuser: roles, database, extensions
migrations/  forward-only SQL migrations, applied in file-name order as crm_owner
src/         access for the application (access.ts, database.gen.ts), and the
             migration runner (migrate.ts) with its command (cli.ts, bin.ts)
tests/       SQL test suite, run after the migrations against the same database
test/        the integration run's global setup: one Postgres 18 for every test file
scripts/     validate.sh: builds a throwaway Postgres 18 in Docker and runs everything
```

## Query the database

The API and the worker use Kysely,
typed from the schema itself:

```ts
import { connectDatabase, withTenant } from '@repo/db';

const db = connectDatabase({
  connectionString: appDatabaseUrl, // crm_app
  onConnectionError: (error) => log.error({ err: error }, 'database connection failed'),
});

const tags = await withTenant(db, context, (trx) =>
  trx.selectFrom('crm.tags').select(['id', 'name']).orderBy('name').execute(),
);
```

- **Every query on business data runs inside `withTenant`.** It sets the tenant context
  before anything else, for that transaction only, so a pooled connection never carries
  one request's context into the next. Outside it, every protected table reads as empty.
- **A connection that fails is reported, not fatal.** When Postgres restarts, its open
  connections fail. `onConnectionError` hears about each one once, so it can be logged.
  The pool opens new connections as needed, and a query that was using a failed one fails
  with it. Without a listener, Node would treat the error as uncaught and stop the process.
- **Two pools:** one for `crm_app` (the API and the worker) and one for `crm_auth` (sign-in,
  which has to find users before any context exists).
- **The types are in `src/database.gen.ts`,** written by kysely-codegen from a migrated
  database. Columns that Postgres computes, such as `display_name`, are read-only there.

## The job queue

Background jobs live in Postgres, in Graphile Worker's `graphile_worker` schema:

- **Commands add jobs** with `enqueue` (`@repo/commands`), which calls
  `private.enqueue_job(task, data)` inside the command's transaction. The function stamps
  the job with the transaction's agency, business and correlation id. It's `crm_app`'s
  only way to the queue.
- **The worker works the queue as `crm_worker`,** a role that reaches only
  `graphile_worker`, and runs each job's work as `crm_app` in the job's context.
- **Graphile Worker owns its schema's contents.** Its own migrations install and upgrade
  them, after ours. Its tables aren't a public interface: read the queue through its
  functions and its `jobs` view.

## Apply the migrations

The runner applies every migration the database doesn't have yet, in order, as
`crm_owner`, then Graphile Worker's migrations for the job queue. The `migrate` container
runs it on each deploy.

```bash
pnpm --filter @repo/db build
DATABASE_OWNER_URL=postgres://crm_owner:<password>@localhost:5432/crm \
  pnpm --filter @repo/db migrate             # or: node packages/db/dist/bin.js
pnpm --filter @repo/db migrate --dry-run     # lists what it would apply; changes nothing
```

A dry run lists only this package's migrations: Graphile Worker can't say what it would
apply. Its warnings, such as a queue migrated by a newer release, go to stderr.

`--locked-only` (`lockedOnly` in code) applies only the migrations listed in
`migrations.lock` and skips drafts that aren't in it yet, printing a line for each. A
locked migration whose file no longer matches its hash in the lock stops the run.
`pnpm dev` and `pnpm dev:setup` use it, so a development database never takes on a draft
that may still be renumbered or changed. Deploys and CI apply every migration.

The connection string comes only from `DATABASE_OWNER_URL`, never from the command line,
so the password doesn't show up in process lists. The exit code is 0 when the database
is up to date, 1 when migrating failed and 2 when the command was used wrongly.

**What it guarantees:**

- **Each file runs in its own transaction,** together with its row in
  `util.applied_migrations` (file name and SHA-256). A file that fails leaves nothing
  behind, and the error names the file and, where Postgres reports one, the line.
- **Applied migrations never change.** The runner refuses to go on when:
  - an applied file was edited (its SHA-256 differs);
  - an applied file is missing, which means the database is newer than the code;
  - a new file sorts before one that's already applied;
  - a `.sql` file isn't named like `0013_jobs.sql`, or two files share a number.
- **One run at a time.** A run holds an advisory lock, so a second run waits for it, then
  finds nothing left to apply. It waits up to 10 minutes (`runLockWaitMs`, whole
  milliseconds from 1 to 2147483647, the range of `lock_timeout`), then stops, saying another
  run holds the lock. `crm_owner`'s `lock_timeout` (5 seconds) still bounds
  each migration's statements, so none queues behind live traffic for long; it no longer
  bounds the wait for another run, which a full run outlasts on a slow machine.

## Check everything

```bash
pnpm test:integration                       # the runner and the test harness against Postgres 18 (needs Docker)
bash packages/db/scripts/validate.sh        # needs Docker; exits non-zero on any failure
KEEP=1 bash packages/db/scripts/validate.sh # leaves the container (crm-db-validate) running
```

The runner's integration tests also run the SQL suites against a database it migrated,
so both ways of applying the migrations (the runner, and psql in `validate.sh`) are
checked in CI. Integration tests anywhere in the repository get their database from
[packages/testing](../testing/README.md).

## Writing a migration

Name it with the next free number, such as `0014_reminders.sql`. The runner applies the
whole file in one transaction, so a migration:

- never controls the transaction itself (`begin`, `commit`, `rollback`): a `commit`
  would end the runner's transaction early, so a later failure would leave half the
  file applied and unrecorded;
- can't use statements that refuse to run in a transaction block, such as
  `create index concurrently`.

Never edit a migration once it's on `main`: put the change in a new one. The first
migration creates the `util` schema, where the runner keeps its record.

After a migration that changes the schema, regenerate the application's types and review
their diff with the migration (a test fails until they match):

```bash
pnpm --filter @repo/db types
```

The catalog tests in `tests/01_catalog.sql` enforce the rules marked ✓, so a migration
that breaks one fails validation.

Migration 0021 indexes the contact list's orders. Migration 0023 adds `crm.contacts.sort_name`
and `private.search_contacts`, because row-level security keeps `crm_app` from using the
trigram and full-text indexes;
the isolation suite checks it never returns another business's contact.

Migration 0022 adds bounded `crm.deals.won_note`, allowed only for won deals. Deal
commands store lost explanations in `lost_note` and clear both when reopening.
Outcome constraints are exercised in `tests/03_integrity.sql`.

- [ ] Business-owned tables have `business_id`, primary key `(business_id, id)` ✓, and
      reference other business-owned tables through `(business_id, …)`.
- [ ] Every foreign key has an index that starts with its columns ✓.
- [ ] Row-level security through `call util.enable_tenant_rls(...)`,
      `util.enable_scoped_rls(...)` or `util.enable_agency_rls(...)` ✓.
- [ ] `updated_at` columns get `call util.add_updated_at_trigger(...)` ✓.
- [ ] `timestamptz`, `text`, `numeric` for money, `jsonb` only for documents ✓.
- [ ] Constraints are named `<table>_<purpose>`, so the API can map each one to a clear error.
- [ ] Grants for `crm_app` go next to the new tables, with only the verbs the table needs.
      Partitions get no grants ✓. Functions aren't executable by PUBLIC ✓.
- [ ] Cross-tenant work goes in a `SECURITY DEFINER` function in `private`, with
      `set search_path = ''` ✓.
- [ ] Add tests for every new invariant to `tests/03_integrity.sql`. Add a row for every
      new table to the fixture in `tests/02_tenant_isolation.sql`, whose coverage check
      fails if a table with `business_id` has no fixture data.

## The request context

Each transaction from the API or a worker starts with the following, which `withTenant`
does for you (from `@repo/kernel`'s `TenantContext`):

```sql
select set_config('app.agency_id',      $1, true),
       set_config('app.business_id',    $2, true),  -- '' for agency staff with no business selected
       set_config('app.user_id',        $3, true),
       set_config('app.actor_kind',     $4, true),  -- user, ai_agent, automation, api_key, system, …
       set_config('app.actor_id',       $5, true),
       set_config('app.correlation_id', $6, true);
```

Without it, every protected table reads as empty.
