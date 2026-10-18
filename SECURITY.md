# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub's private
vulnerability reporting on this repository (the **Security** tab, then **Report a
vulnerability**). Include the steps to reproduce and the impact you expect.

We'll acknowledge your report, keep you updated while we fix it, and agree a disclosure
date with you.

## Supported versions

None yet: Cal CRM is in development and has no releases.

## How the design limits damage

- **Tenant isolation is enforced by the database.** Row-level security is forced on every
  business-owned table and fails closed. Composite foreign keys stop rows from referencing
  another business's rows.
- **The application's database role has only the permissions it needs.** Logs are
  append-only, and cross-tenant work goes through a few narrow functions.
- **Provider secrets are sealed in a vault.** Mailbox passwords, API keys and other
  credentials are encrypted with keys kept outside the database. Only the background
  worker holds the keys that open them; the web-facing app refuses them.
