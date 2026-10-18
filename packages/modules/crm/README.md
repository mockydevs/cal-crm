# packages/modules/crm

The CRM module: contacts, companies, deals, fields, tags, notes and tasks, in the `crm`
schema. It owns those
tables; other modules use only what `src/index.ts` exports, or its events.

## Contacts

Each contact is one registry row (`crm.records`), its `crm.contacts` row and its email
addresses and phone numbers (`crm.contact_identities`), written in one transaction. Changes need
`contacts.manage`, which owners, admins and members have; viewers read.
- `GET /contacts`: the contacts not in the trash, 50 a page, newest first (`sort=newest`) or
  by name (`sort=name`, ignoring case, unnamed contacts last). The next page starts `after`
  the previous page's `next`, a contact id; its place is read in SQL (keyset paging over
  the indexes in migrations 0021 and 0023). `q` searches names by word prefix (full text,
  `simple`) or any part (trigram), email addresses by any part, and, when it looks like a
  phone number, phone numbers by their digits, without a national trunk prefix's leading
  zeros ("0712 345" finds +254712345678). A search under three characters matches word
  starts only. `%` and `_` match themselves. `createdFrom` and `createdBefore` keep
  contacts added in a period.

  Row-level security keeps Postgres from using an index for ILIKE, LIKE, `@@` or `lower()`,
  so the search's lookups run in `private.search_contacts`, bound to the request's business,
  and the by-name order compares `sort_name`.
  A narrow search (under 1,000 matches) reads its contacts by id; a broad one walks the
  list's order and tests each contact. At 100,000 contacts a page takes 3.8–4.9 ms at p95,
  and a search 9.6–41.1 ms. That budget runs alone: `pnpm --filter @repo/module-crm
  test:budget` (needs Docker), at checkpoints and after changing the list's queries.
- `POST /contacts` (`contact.create`): a name, an email address or a phone number, at least.
- `GET /contacts/{id}`: one contact, including one in the trash (`trashedAt`).
- `PATCH /contacts/{id}` (`contact.update`): changes only the fields sent. `emails` or
  `phones` replace that list; the first is the primary, and the rest keep the order they
  were added in.
- `DELETE /contacts/{id}` (`contact.trash`) and `POST /contacts/{id}/restore`
  (`contact.restore`): into the trash and back. A contact in the trash keeps its email
  addresses and phone numbers, and can't be changed until it's restored.
- A contact also shows `timeZone`, `doNotContact` and `preferencesRevision`. `PATCH
  /contacts/{id}` changes the first two: `timeZone` takes an IANA name in any letter
  case and stores it as PostgreSQL's `pg_timezone_names` spells it (null clears it; a
  place PostgreSQL has under another name is stored under that one; a name it has no
  zone for is a 422 `time_zone_unknown`), and `doNotContact` needs
  a `doNotContactReason` of 10 to 1000 characters, both ways. Either needs the
  `preferencesRevision` the change is based on; a stale one is a 409 and changes
  nothing. The reason is kept in the command's audit row, and in no event.
- `GET /time-zones`: the names a time zone can be on this server, PostgreSQL's own
  (`pg_timezone_names`, read at most once an hour). The contact page's picker shows these.
- A first booking gives the contact the booking page's zone the same way; a zone the server
  doesn't have is left unset, and the booking goes through.

Email addresses are trimmed and lowercased. Phone numbers are stored in E.164, parsed with
libphonenumber-js in international form, or in national form for the country in the
business's address. A number is accepted when its length is possible for its country
(`isPossible`), not checked digit by digit, so newly issued numbers aren't refused by an
install that hasn't been updated. Extensions are refused. The API shows each number in
E.164 and as people write it: national form in the business's country, international
otherwise.

Each email address and phone number belongs to one contact in the business, even one in
the trash. A duplicate is refused with a 422 issue on its field (code `taken`), whose
`existing` names the contact holding it, and whether it's in the trash so it can be
restored instead. Two people adding the same address at once can't both get it.

Events: `contact.created`, `contact.updated` (with the names of the fields that changed,
not their values), `contact.trashed`, `contact.restored`, `contact.do_not_contact_set`
and `contact.do_not_contact_cleared`, each on the contact's timeline. No event carries
personal data, since the event log can't be erased.

## Companies and contact links

Companies use `com` registry IDs. `GET /companies` lists live records50 per page, with
`after` and literal name/domain `q`; `POST /companies` and `GET/PATCH/DELETE /companies/{id}`
create, read, update and trash. `POST /companies/{id}/restore` restores when its domain
is available. Writes need `companies.manage`; phone numbers use the existing normalizer.
Domains are normalized plain hostnames, unique per business among live companies.

`GET /contacts/{id}/companies` pages saved links, retaining trashed companies. PUT on
`/contacts/{id}/companies/{companyId}` links an existing company; optional `primary`
changes its primary state. Omit it to preserve a saved link's state. DELETE removes the
association and returns204. Both writes require `contacts.manage`, lock the live contact
and emit only actual changes. Primary moves are atomic and also appear on both affected
company timelines. Removing a retained trashed company is allowed; writing a trashed
contact is refused.

## Field definitions

`GET /fields` lists the business's definitions and object types. Owners/admins holding
`fields.manage` create definitions with `POST /fields` and edit them with
`PUT /fields/{fieldId}`. Descriptions are required. Field keys, object and type are
permanent; choice keys survive label changes and cannot be removed. Archive fields and
choices to retire them. Updates require the returned revision to prevent lost edits.
AI sources and overwrite policy are stored configuration for future fill commands.

## Tags

`GET /tags` and `POST /tags` keep the original list/create interface. Names that differ
only in case, spaces, hyphens or underscores are duplicates. Creation requires
`tags.manage` plus the saved creation policy: `admins` defaults to owners/admins holding
`tags.configure`; `everyone` permits other callers with `tags.manage`. AI and automation
actors cannot create or edit definitions under either policy.

`GET /tag-configuration` combines definitions, groups, rules and caller capabilities.
`GET /tag-groups` also lists groups separately. Configuration writes require
`tags.configure`: `POST /tag-groups`, `PUT /tag-groups/{groupId}`, `PUT /tags/{id}` and
`PUT /tag-rules`. Updates send the last returned content revision; a changed version
gets409. Group references must belong to the selected business. No new migration is needed.

`GET /records/{id}/tags` reads a contact's, company's or deal's assignments, with the trusted actor
kind, assignment time, source event and whether the actor is the reader. Assign with
`PUT /records/{id}/tags/{tagId}` and an empty object; remove with `DELETE` on the same
resource. Both need `tags.manage`. Repeating an assignment preserves its source and
produces no extra event; repeating removal also produces no extra event. Assignment
and removal lock both registry and object rows, coordinating with existing trash commands.
Trashed records retain readable tags but cannot be changed until restored.

In **Settings → Fields and tags → Tags**, owners/admins describe and group tags, edit
creation rules and enable similar-name suggestions. Suggestions cover normalized names,
prefixes and single-character mistakes, including swapped adjacent letters. Choosing
an existing name leaves its definition unchanged. Record pages select existing tags
and show their sources with **Why?** explanations. Editors retain unsaved drafts across
background updates; a conflict offers **Reload saved version** to replace the draft
deliberately.

`seedBusinessDefaults` seeds what a new business starts with in the CRM, run by
`business.create`:
- contacts, companies and deals;
- link types with a primary: a deal's contacts and company, and a contact's company;
- a "Sales" pipeline, from New lead to Negotiating. Each stage has a win probability and
  a description the assistant reads;
- the CRM's settings.

Each record keeps a timeline (`crm.timeline_entries`), written with every event that
names the record in `records`. `activityRoutes` reads it:
- `GET /records/{id}/activity`: a contact's or deal's changes, newest first, 50 a page. The
  next page starts `after` the previous page's `next`, an entry's event id;
- `GET /events/{id}/why`: the chain of events that led to one, oldest first, followed
  through jobs for at most 50 steps. `reachesOrigin` is false when an earlier cause can't
  be read.

Each entry names who or what acted, as far as the reader may see them. The names come from
the modules that own them, through the `actorNames` lookups the server passes in (people
from `@repo/module-auth`). A kind of actor with no lookup shows no name.

`crmRoutes` lists the module's other API routes for the server.

Deals use `POST /deals`, `GET /deals/{id}`, `PUT /deals/{id}` and `GET /deals`.
Writes require `deals.manage` (members and above). PUT sends all editable values plus
the returned revision; a stale edit gets 409. Amounts are decimal strings and close
dates are `YYYY-MM-DD`. Lost outcomes require `outcomeReason`; won outcomes allow one.
Status never comes from a stage name. Closing keeps the stage, and reopening clears
close details. Stage changes alone append exact, contiguous history in the command's
transaction. Lists filter by pipeline/status, exclude trash and return a bounded page
with a deal ID cursor.

Pipelines and stages use `GET /pipelines` and `PUT /pipelines` (`pipelines.save`,
permission `pipelines.manage`, owners/admins). The bounded configuration includes archived
entries, IDs, descriptions and an opaque content revision. Array order becomes position.
Save locks the selected business before comparing the revision; a concurrent stale save
gets 409 and cannot overwrite the winner. Reads share that lock for a consistent aggregate.
Existing IDs cannot be omitted or moved between pipelines: archive instead of deleting,
preserving deal and stage-history references. Live names remain unique, even on restore.

In a business, open **Settings → Deal stages**. Owners/admins can add a pipeline,
name and describe its stages, then use **Move up** and **Move down** to order them.
Choose **Save changes** to persist the configuration. Members and viewers can read it.
**Archive** retains the pipeline/stage and its deals; **Restore** makes it active again
after checking its name is available. There is no delete action.

If someone saves while your page is open, your next save is refused rather than
overwriting their changes. Your draft stays on screen. **Reload saved version**
explicitly replaces that draft with the latest saved configuration, so keep any text
you want before reloading. Pipeline and stage names are limited to 80 characters,
descriptions to 2,000; each business can configure up to 100 pipelines with 100 stages
per pipeline, including archived entries.

## Contact context reads

GET /records/{id}/fields lists object-scoped live definitions and retained archived values,
with trusted sources, update/confirmation times and confidence. Merged definitions are omitted.
Numbers use exact decimal strings; date-only values use SQL text; false remains a boolean.
GET /records/{id}/activity remains the50-entry newest-first timeline with exact cursors.
The contact screen displays these beside identities/tags and the AI module's saved memory.
The public requireRecord reader provides a tenant-visible registry/entity reference to AI;
its locking variant preserves tag writes' coordination with contact/deal trash.
No field-value write, summary generation or provider call is added in this task.

## Record field values

On a contact/company page, or an existing deal's editor, choose **Edit value** in
Fields, enter a value and **Save value**. **Clear value** unsets it. Errors stay
beside the field and preserve the draft. A conflict means someone changed the
value or its definition; cancel, review the saved version and edit again.
**Confirm** marks an AI-filled value as checked by you while retaining its source.
The source badge names the person or kind of actor, with a **Why** event link.
Archived fields and trashed records remain readable.

Open **Field filters and order** on Contacts, Companies or Deals. Choose a field,
match and value, optionally a sort field/direction, then **Apply field filters**.
Set/unset needs no value. Choice matching selects a permanent option; numeric and
money filters use exact decimal strings. Unset values sort last. **Clear field
filters** restores the normal list; contact/company URLs retain applied options.

The API provides PUT `/records/{id}/fields/{fieldId}` with `{value, revision}` and
POST to its `/confirm` suffix with `{revision}`. These require `fields.values`;
confirmation additionally requires the signed-in human actor. The last GET
supplies the value revision. `createCrmRoutes(actorNames)` accepts owning-module
lookups for tenant-visible source names; `crmRoutes` remains available without
lookups.

## The trash

Open **Contacts** and choose **Trash** to see the contacts, companies and deals in the
trash, most recently trashed first, each with the day it's deleted for good. **Show**
narrows it to one kind. **Restore** brings the record back as it was, with its tags,
fields, links and timeline; it needs the kind's own permission (`contacts.manage`,
`companies.manage`, `deals.manage`). **Delete forever**, for owners and admins
(`trash.purge`), asks first, then deletes the record and everything attached to it.

The API lists the trash at `GET /trash` (`kind`, `after` cursor, 50 a page) and purges one
record at `DELETE /trash/{id}`; deals are trashed with `DELETE /deals/{id}` and restored
with `POST /deals/{id}/restore`. The worker purges records past the business's retention
days (`crm.settings.trash_retention_days`, 30 by default) daily at 03:30 UTC, with
`purgeExpiredTrash`.

## The command bar

Press ⌘K or Ctrl+K anywhere, or choose **Search** in the sidebar. Type to find the
business's contacts (name, email address, phone digits), companies (name, domain) and deals
(name), its pages, and the businesses you may enter; use the arrow keys and Enter to go
there, and Escape to close. A deal opens in its editor on the Deals page.

The API is `GET /search?q=`: contacts, then companies, then deals, at most five of each,
outside the trash, names starting with the search first. Reading needs no permission; row-level
security keeps each search in the request's business. Companies and deals are found through
`private.search_companies` and `private.search_deals` (migration 0025).

## Record notes

Contacts, companies and existing deals have a Notes panel. Add or edit simple rich text,
search its words, and load older notes. The editor loads when needed. Notes retain their
original author and separately show who last edited them. Failed saves and refreshes keep
the draft. When a newer saved version appears, review it and choose **Keep my draft** before
saving over it. Deletion requires confirmation. Trashed records keep readable notes.

`GET /records/{id}/notes` accepts `q` and an `after` cursor, at most 50 notes per page,
newest written first, with IDs breaking timestamp ties. POST adds a bounded Tiptap JSON
document; PUT and DELETE at `/records/{id}/notes/{noteId}` require its revision in the
request body. Writes need `notes.manage`. The server derives searchable text and author/
editor identities. Audits and activity keep identifiers, without note text. Migration0026
adds editor provenance and the paging index.

## Task API

`POST /tasks` creates a workspace task or links one permanently to a contact, company or
deal through `recordId`. `GET /tasks` reads 50 at a time, newest written first with ID
ties and a `nextCursor` for `after`. Optional filters are `recordId`, `scope` (`all`,
`mine`, `unassigned`), `status` (`open`, `completed`, `all`) and `due` (`any`, `overdue`).
Defaults are all assignments, open, any due date. Overdue compares the explicit due
instant with database time. Mine requires a human user. A cursor must belong to the
business and, when selected, the record. Completing or reassigning the cursor task keeps
the next page usable; imported timestamp precision stays in PostgreSQL.

The Tasks page's list (`tasks/list.ts`)
adds, all optional: `limit` (1 to 100, else 50) and a `total` of the tasks the filters
match on every page; `due` `today` (the business's current calendar day in
`tenancy.businesses.timezone`) and `upcoming` (after that day ends); `dueFrom` and
`dueBefore` (from, up to); `assignee` (one membership id, with `scope` left at `all`);
`q` (any part of the title, either case); and `sort` `created`, `due` or `title` with
`direction`. By due date, undated tasks come last both ways. The cursor is still the last
task's id: its place in the chosen order is read in SQL, so send `after` with the same
`sort` and `direction`.

Workspace lists exclude tasks linked to trashed records. Reading a particular record
keeps its task history with `canManage: false`; restore the record before changing its
tasks. All writes require `tasks.manage`. PUT `/tasks/{id}`, POST to its `/completion`
suffix with `completed`, and DELETE require the task's current `revision`. PUT sends
every editable value, including explicit description, due date and assignee; omitted
fields are refused instead of silently clearing them. Concurrent
changes return409. Repeating completion with the current revision keeps the original
completion actor/time and adds no duplicate event; reopening clears them.

Assignments accept `me`, an eligible public membership ID or null. GET `/tasks/assignees`
pages eligible people, with names and whether each is the human reader. The separate
`taskRoutes` factory receives tenancy's resolve/read/membership functions and auth's
actor-name lookups from the server. Membership removal is serialized with assignment;
removed assignees retain history but have a null membership ID and cannot be selected.
The API never accepts or exposes raw user IDs. Completion actors come from the invocation,
and activity/audit records keep identifiers and completion state without private task text.
