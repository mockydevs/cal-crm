# CRM authoring MCP

An MCP-compatible AI client can use this stdio server to discover the CRM's catalog,
author drafts, create fields and email templates, validate documents, and dry-run
them. Tools call the existing `@repo/sdk` against the canonical CRM API. The API
enforces the key's business, permissions, optimistic draft revisions and audit actor.
The bridge has no database credentials and does not implement an alternative engine.
Requests have a 30-second transport timeout and refuse redirects.

Build with the repository's normal build, then configure the AI client's MCP server
command as `node` with the absolute path to `packages/mcp/dist/main.js` as its argument.
For example:

```text
/path/to/cal-crm/packages/mcp/dist/main.js
```

Only `CRM_API_URL` and `CRM_API_KEY` are required. No `CRM_BUSINESS_ID` is needed.
Supply these variables through the client's protected process environment:

| Variable                | Purpose                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `CRM_API_URL`           | API base URL ending in `/api/v1`; HTTPS, or loopback HTTP for development.                       |
| `CRM_API_KEY`           | A CRM subaccount or agency API key, created in Settings. Never a GHL or n8n key.                  |
| `CRM_BUSINESS_ID`       | Optional legacy business public ID override; retained for compatibility and checked by the API. |
| `CRM_MCP_ALLOW_PUBLISH` | Defaults to false. Explicit true exposes publishing (a workflow, a form), which still requires the key's own permission. |

Do not put a real key in a checked-in client configuration, tool argument, prompt or
log. This program does not read `.env`. The client supplies the environment.
For draft authoring use `automations.manage`; add `fields.manage` and
`templates.manage` only when creating those assets is required.

Tool names use `crm_` followed by the canonical API operation ID, for example
`crm_getAutomationCatalog`, `crm_createAutomation`, `crm_validateAutomation`,
`crm_createAutomationTestRun` and `crm_getAutomationTestRun`. Inputs contain the
API's `params`, `query` and `body` objects; tool discovery returns their actual schemas.
For example, `crm_createAutomation` takes `{ "body": { "document": { ... } } }`.

A subaccount key defaults to its own account. An agency key defaults to agency scope.
Use the read-only `crm_listBusinesses` tool to discover accessible accounts by name
and slug, then give any tool an optional top-level `business` slug:

```json
{
  "name": "crm_listTags",
  "arguments": { "business": "harbor-lights" }
}
```

Slugs follow native business creation: 1–63 lower-case letters, digits and hyphens,
starting and ending with a letter or digit. The MCP bridge removes `business` from
the API input and sends `Business-Slug` for this call only. Concurrent calls remain
independent; preserved form reads and updates use the same target. The API checks
that an agency key may access the active subaccount in its own agency. A subaccount
key cannot use a selector to enter another account. A per-call slug replaces the
legacy ID override; the next call without a slug uses the key's default scope (or
the configured legacy override). No operator-entered account ID is required.

`crm_copyWorkflowEmailTemplate` makes the server's own revision-checked copy of a template
into a workflow's email step (it takes the draft version and the template's revision; a
stale one is a 409). `crm_getPipelines`, `crm_listTags` and `crm_listCalendars` read what a
document refers to, so no id is guessed; nothing here changes them. `crm_createTag` makes
a tag a document's steps name; `crm_getRecordFields` and `crm_setRecordField` read and set a
field's value on a record (the write takes the revision the read gave).

Email inspection uses `crm_getEmailReport`, `crm_listTemplateWorkflowActions` and
`crm_getWorkflowEmailStepStatistics`. These call the existing permission-filtered APIs;
SMTP acceptance is not proof of delivery, and unavailable tracking metrics stay null.
`crm_renderEmailPreview` previews saved or unsaved content through the canonical renderer.
It takes a `body` and is read-only even though the API uses POST. A preview sends nothing.
Shared-template sync edits are not offered by these tools: editing a linked library asset
can affect live workflows and requires separate effect and confirmation semantics.
Unknown or unavailable nodes must be reported, not replaced with fictional nodes.

The server also offers the in-app assistant's tools, from the same registry the app reads
(`packages/contracts/src/assistant-tools.ts`). For forms: `crm_listForms`,
`crm_getForm`, `crm_getAssistantContext` (what is missing on a page, worked out by the
server with no model), `crm_getFormPreview`, `crm_getFormAnalytics`, `crm_getFields`,
`crm_listTags`, `crm_listAutomations`, `crm_createForm`, `crm_updateForm`, `crm_createField`
and `crm_createTag`. `crm_updateForm` does not take the websites that may show a form: it
reads the form first and saves it with the websites it already has. `crm_publishForm` is
offered only with `CRM_MCP_ALLOW_PUBLISH=true`, and still needs `forms.manage`.

Give the AI the client guideline and ask it to read the catalog and schema, resolve
the business's fields/templates/forms, save a draft, validate it, fix reported errors,
and compare dry-run traces with the required dates and branches. Validation errors
are returned in structured output with their JSON Pointers. HTTP errors such as
403 and revision-conflict 409 remain structured MCP errors. No send or delete tool
is exposed. Draft creation is not proof that a workflow can be published or delivered.

This stage supports clients that launch stdio servers. A hosted Streamable HTTP MCP
endpoint and connection UI are not implemented. Protocol acceptance runs the built
stdio process against a real local API and migrated Postgres using a generated scoped
test key; it creates and tests the wedding education draft and verifies publishing is
refused without permission. No browser authoring or external provider calls are used.
