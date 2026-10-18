# packages/modules/tenancy

The tenancy module: the agency and its businesses, and who works where, in the `tenancy`
schema. Other modules use only what
`src/index.ts` exports, or its events.

So far it has the agency's sign-in rule:
- `agency.require_two_factor` (`PUT /agency/two-factor-requirement`): requires the agency's
  staff to sign in with two factors, or stops requiring it. It records an
  `agency.two_factor_requirement_changed` event.
- `GET /agency/two-factor-requirement`: whether it's required.

Both work for the whole agency, so they're refused inside a business (`requireAgency`).
Sign-in reads the rule itself, through `crm_auth` (`@repo/module-auth`).

And businesses:
- `business.create` (`POST /businesses`): agency staff, at the agency, add a business.
  - The slug comes from the name when none is given, with -2, -3… after a taken one. A
    taken slug that was asked for is refused. Creates in one agency take turns choosing
    (an advisory lock), so two made at once with one name get slug and slug-2.
  - It records a `business.created` event.
  - In the same transaction it runs each module's seeder (`BusinessSeeder`), acting in
    the new business, then goes back to the agency. The server passes the seeders to
    `businessRoutes({ seeders })`, so this module never imports the modules it seeds.

`tenancyRoutes` and `businessRoutes` list the module's API routes for the server.

## Business profile

`businessProfileRoutes(checkBusinessLogo)` reads and updates the selected business through
`GET/PUT /business-profile`. Owners/admins may change it through `business.profile`;
members/viewers can read it. The update records `business.profile_updated` and the normal
command audit entry. It does not change the slug or business status.

The existing address JSON holds `line1`, `line2`, `city`, `region`, `postalCode`, and
`country` (uppercase two-letter code, or empty). An absent address is null. The server passes the
files module's `checkBusinessLogo`, which validates a live raster image in the exact
business within the update transaction. The dashboard uses the existing files upload and
signed-link endpoints; removing a logo leaves the uploaded file intact.

## Team and invitations

`teamRoutes({ people, sendInvitation })` lists members, available roles and invitation
history in the exact workspace. The server supplies auth's identity reader and mail
delivery; tenancy owns memberships and invitations. Explicit workspace filters exclude
agency-wide rows that scoped RLS would otherwise show inside a business.

`team.invite`, `team.resend_invitation`, `team.revoke_invitation` and `team.remove_member`
require `team.manage`: built-in owners/admins have it; members/viewers do not. Custom
roles use their stored grants. Invitations cannot assign ownership; removal protects
owners and the caller's own membership. Missing or foreign-workspace ids reveal no row.

Invitations last seven days. Only a SHA-256 token hash is stored; resend rotates it and
invalidates the previous link. Mail is sent after commit. A delivery failure returns
`deliveryFailed: true`, leaving the pending invitation available for resend. Tokens never
appear in API responses, events or audit entries. Acceptance belongs to auth's `crm_auth`
transaction so it can create an identity and membership atomically without tenant context.
An existing membership keeps its role when another invitation is accepted.

## API keys

`apiKeyRoutes({ people })` lists, makes and revokes a business's API keys. The server passes the auth module's
`readUserNames`, to say who made each key.

- `api_key.create` and `api_key.revoke` need `apps.manage`, which owners and admins have.
- A key is `crm_live_` and 64 hex digits. The create response shows it once; only its
  SHA-256 and its first 21 characters are kept. It never appears in events, the audit log
  or a list.
- A key's scopes are the business's permissions apart from `apps.manage`, so a key can't
  make keys. Its maker can give it only permissions they have.
- The list is the business's own working keys, newest first. Row-level security also shows
  agency-wide rows in a business, so it filters on the business exactly.
- `readApiKeyNames` names keys, revoked ones too, for a record's activity.

## Task assignment support

`readTaskAssignees(trx, context, after?)` pages eligible business and agency members,
one entry per person, preferring a business membership when both exist. The returned
membership ID is public; its user ID is an internal seam for CRM, never an API input.
The caller supplies the matching tenant transaction and resolves names through auth.

`resolveTaskAssignee(trx, context, selection)` accepts an eligible membership ID, `me`
for an actual signed-in person, or null. It refuses sibling businesses, other agencies,
arbitrary user IDs and machine self-assignment. Its shared row lock holds the selected
membership against removal until the caller's task transaction finishes. CRM task routes
are the next implementation slice.

`readTaskAssigneeMemberships(trx, context, userIds)` maps stored assignee user IDs to the
public membership ID each would be assigned through now, preferring the business
membership over the agency one, so a task can show its assignee as the list does. A person
removed since, or only in a sibling business or another agency, has no entry. Repeated IDs
count once; no IDs gives an empty map, and it still needs a business. It's one read and
holds no lock.
