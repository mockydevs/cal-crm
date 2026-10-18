# Contributing

Thanks for your interest in Cal CRM.

Bug reports, feature requests, questions and pull requests are welcome. For a large
change, open an issue first, so nothing you build is wasted.

Cal CRM is licensed under the [GNU Affero General Public License v3.0](LICENSE). By
opening a pull request you agree that your contribution is licensed under it too.

Every change reaches `main` through a pull request. It merges only when the `ci` check
passes and a maintainer has approved it.

To report a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Setting up

Needs Node.js 24, pnpm and Docker. From a fresh clone:

```bash
pnpm install   # installs the dependencies and the git hooks
pnpm dev       # Postgres and Mailpit in Docker, a seeded database, then the app
```

The dashboard's browser tests need Playwright's Chromium, installed once with
`pnpm --filter @repo/dashboard exec playwright install chromium`.

## The bar for a change

The same for people and AI agents:

1. **Tests first.** Write a failing test from what the change must do, make it pass, then
   tidy up.
2. **Check external APIs at the source.** Before writing code against a provider, SDK or
   library, read its official documentation or source. Don't guess field names or
   behaviour.
3. **Run the checks** before calling a change done:

   ```bash
   pnpm run check        # format, build, lint, module boundaries, types, all tests (needs Docker)
   pnpm run db:validate  # when the change touches the database (needs Docker)
   ```

   After changing text in the dashboard, update the translation catalogs with
   `pnpm --filter @repo/dashboard run i18n:extract`; `check` fails while they're out of date.
4. **Review your own diff** before asking for review. Changes that touch input,
   authentication, secrets, files or providers also get a security review.

CI runs the same gates on every push and pull request.

## Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat: …`, `fix: …`, `docs: …`, `chore: …`), each small enough to review. The git
  hooks format and lint what you stage and check the message.
- **Database changes:** a new migration in `packages/db/migrations`, never an edit to one
  that has been released. The checklist is in [packages/db/README.md](packages/db/README.md).
- **Module boundaries:** business logic lives in `packages/modules`, each module owns its
  own tables, and `pnpm deps:check` enforces who may import what.
- **Words in the UI:** plain words that name what people control, the same words
  everywhere. Where GoHighLevel users expect a name (a "workflow", an "opportunity"),
  use theirs.
