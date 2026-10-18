// A smart list shared as GoHighLevel shares one: with chosen team members, each able to
// view it or also edit it, or with everyone in the business at one level. Who sees it,
// what each may do, and that no other business or team member reaches it or its shares.
import { allowEveryone, type Grants, type Invocation } from '@repo/commands';
import { savedView, viewList, type SavedView } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { detailOptions, team, type Member, type Team } from '../../test/contact-details.js';
import { createCrmRoutes } from '../index.js';

let database: TestDatabase;
let db: Database;
const options = detailOptions();
const routes = createCrmRoutes(options.actorNames, options);

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function call(
  operationId: string,
  invocation: Invocation,
  body?: unknown,
  params: Record<string, string> = {},
  query: Record<string, string> = {},
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, params, body, query }, { db, authorize: allowEveryone });
}
const views = async (invocation: Invocation): Promise<SavedView[]> =>
  viewList.parse(await call('listViews', invocation, undefined, {}, { object: 'contact' })).items;
const share = async (
  invocation: Invocation,
  view: SavedView,
  sharing: {
    everyone?: 'view' | 'edit' | null;
    people?: readonly { readonly membershipId: string; readonly access: string }[];
  },
): Promise<SavedView> =>
  savedView.parse(
    await call(
      'setViewSharing',
      invocation,
      { everyone: null, people: [], ...sharing, revision: view.revision },
      { id: view.id },
    ),
  );
const rename = async (invocation: Invocation, view: SavedView, name: string) =>
  savedView.parse(
    await call(
      'updateView',
      invocation,
      { name, state: view.state, columns: view.columns, revision: view.revision },
      { id: view.id },
    ),
  );

const saving: Grants = new Set(['views.save']);
const sharing: Grants = new Set(['views.save', 'views.share']);

interface Cast {
  readonly t: Team;
  readonly owner: Member;
  readonly viewer: Member;
  readonly editor: Member;
  readonly bystander: Member;
  readonly view: SavedView;
}
/** A business with an owner of a smart list, and three other team members. */
async function cast(): Promise<Cast> {
  const t = await team(database);
  const owner = await t.member('Dana Brooks');
  const viewer = await t.member('Jordan Lee');
  const editor = await t.member('Maya Patel');
  const bystander = await t.member('Sam Ortiz');
  const view = savedView.parse(
    await call('createView', owner.as(), {
      objectKey: 'contact',
      name: 'Garden venues',
      state: { q: 'garden' },
      columns: ['name', 'email'],
    }),
  );
  return { t, owner, viewer, editor, bystander, view };
}
/** Shares the cast's list with the viewer to view and the editor to edit. */
async function sharedByName(c: Cast): Promise<SavedView> {
  return share(c.owner.as(), c.view, {
    people: [
      { membershipId: c.viewer.membershipId, access: 'view' },
      { membershipId: c.editor.membershipId, access: 'edit' },
    ],
  });
}

it('shares with the people chosen, each at their own level, and with nobody else', async () => {
  const c = await cast();
  const shared = await sharedByName(c);
  expect(shared).toMatchObject({
    visibility: 'selected',
    access: 'owner',
    canChange: true,
    canDelete: true,
    canChangeSharing: true,
    sharing: {
      everyone: null,
      people: [
        { membershipId: c.viewer.membershipId, name: 'Jordan Lee', you: false, access: 'view' },
        { membershipId: c.editor.membershipId, name: 'Maya Patel', you: false, access: 'edit' },
      ],
    },
  });
  expect(shared.revision).not.toBe(c.view.revision);

  const [seen] = await views(c.viewer.as(saving));
  expect(seen).toMatchObject({
    id: shared.id,
    name: 'Garden venues',
    access: 'view',
    owner: { membershipId: c.owner.membershipId, name: 'Dana Brooks', you: false },
    canChange: false,
    canDelete: false,
    canChangeSharing: false,
    revision: shared.revision,
  });
  // A list shared by name to view is only viewed, even by someone who may share views.
  expect(await views(c.viewer.as(sharing))).toMatchObject([
    { access: 'view', canChange: false, canDelete: false, canChangeSharing: false },
  ]);
  expect(seen?.sharing.people.map((person) => person.you)).toEqual([true, false]);
  expect(await views(c.editor.as(saving))).toMatchObject([
    { id: shared.id, access: 'edit', canChange: true, canDelete: false, canChangeSharing: false },
  ]);
  // Who may share views manages the shared ones too, as before: they may also delete it.
  expect(await views(c.editor.as(sharing))).toMatchObject([
    { id: shared.id, access: 'edit', canChange: true, canDelete: true, canChangeSharing: true },
  ]);

  // Someone else on the team, the business's API key or system, another business: none.
  expect(await views(c.bystander.as())).toEqual([]);
  expect(await views(c.t.system())).toEqual([]);
  const elsewhere = await (await team(database)).member();
  expect(await views(elsewhere.as())).toEqual([]);
  await expect(
    call(
      'setViewSharing',
      elsewhere.as(),
      { everyone: 'view', people: [], revision: shared.revision },
      { id: shared.id },
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(rename(c.bystander.as(), shared, 'Mine now')).rejects.toBeInstanceOf(NotFoundError);
});

it('lets a viewer open and use the list, never change, share or delete it', async () => {
  const c = await cast();
  const shared = await sharedByName(c);
  const viewer = c.viewer.as(sharing);
  await expect(share(viewer, shared, { everyone: 'view' })).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    call('deleteView', c.viewer.as(saving), { revision: shared.revision }, { id: shared.id }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(rename(c.viewer.as(saving), shared, 'Renamed')).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  for (const refused of [
    () => rename(viewer, shared, 'Renamed'),
    () => call('deleteView', viewer, { revision: shared.revision }, { id: shared.id }),
  ])
    await expect(refused()).rejects.toBeInstanceOf(ForbiddenError);
  expect((await views(c.owner.as()))[0]).toMatchObject({
    name: 'Garden venues',
    revision: shared.revision,
  });
});

it('lets an editor change the list everyone sees and who it is shared with, but not take it from the owner', async () => {
  const c = await cast();
  const shared = await sharedByName(c);
  const editor = c.editor.as(sharing);

  // One list, not a copy: what the editor saves is what the owner and the viewer open.
  const renamed = await rename(editor, shared, 'Garden venues, spring');
  for (const reader of [c.owner.as(), c.viewer.as(saving)])
    expect((await views(reader))[0]).toMatchObject({
      name: 'Garden venues, spring',
      revision: renamed.revision,
    });

  const widened = await share(editor, renamed, {
    people: [
      { membershipId: c.viewer.membershipId, access: 'edit' },
      { membershipId: c.editor.membershipId, access: 'edit' },
      { membershipId: c.bystander.membershipId, access: 'view' },
    ],
  });
  expect(widened.sharing.people.map((person) => [person.name, person.access])).toEqual([
    ['Jordan Lee', 'edit'],
    ['Maya Patel', 'edit'],
    ['Sam Ortiz', 'view'],
  ]);
  expect(await views(c.bystander.as(saving))).toMatchObject([{ access: 'view' }]);

  // An editor may share with everyone, but never makes it private or drops their own
  // editing; without the permission to manage shared views, they don't delete it either.
  await expect(share(editor, widened, {})).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    share(editor, widened, { people: [{ membershipId: c.viewer.membershipId, access: 'edit' }] }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    share(editor, widened, {
      people: [
        { membershipId: c.viewer.membershipId, access: 'edit' },
        { membershipId: c.editor.membershipId, access: 'view' },
      ],
    }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    call('deleteView', c.editor.as(saving), { revision: widened.revision }, { id: widened.id }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  // Sharing needs the permission to share, whatever the access.
  await expect(share(c.editor.as(saving), widened, { everyone: 'view' })).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  // Everyone at view would take the editor's own editing away: refused as the rest is.
  const reduced = await share(editor, widened, { everyone: 'view' }).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(reduced instanceof ForbiddenError)) throw new Error('Everyone at view must be refused.');
  expect(reduced.message).toBe('Keep your own access to edit. Only the owner can take it away.');
  const everyone = await share(editor, widened, { everyone: 'edit' });
  expect(everyone).toMatchObject({
    visibility: 'shared',
    access: 'edit',
    canChange: true,
    canChangeSharing: true,
    sharing: { everyone: 'edit', people: [] },
  });
});

it('shares with everyone at one level: to edit, anyone who saves lists may change it', async () => {
  const c = await cast();
  const editable = await share(c.owner.as(), c.view, { everyone: 'edit' });
  expect(editable).toMatchObject({
    visibility: 'shared',
    sharing: { everyone: 'edit', people: [] },
  });
  expect(await views(c.bystander.as(saving))).toMatchObject([
    { access: 'edit', canChange: true, canDelete: false, canChangeSharing: false },
  ]);
  const renamed = await rename(c.bystander.as(saving), editable, 'Shared garden venues');
  // Back to viewing only: the same person can no longer change it.
  const viewOnly = await share(c.owner.as(), renamed, { everyone: 'view' });
  expect(viewOnly.revision).not.toBe(renamed.revision);
  await expect(rename(c.bystander.as(saving), viewOnly, 'Again')).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  // The API key and the system see a list shared with everyone, as before.
  expect(await views(c.t.system())).toMatchObject([{ id: viewOnly.id, access: 'view' }]);
});

it('refuses everyone and people together, someone off the team, the owner, or one person twice', async () => {
  const c = await cast();
  const outsider = await (await team(database)).member();
  for (const [sharingAsked, expected] of [
    [
      { everyone: 'view', people: [{ membershipId: c.viewer.membershipId, access: 'view' }] },
      '/people',
    ],
    [
      { people: [{ membershipId: outsider.membershipId, access: 'view' }] },
      '/people/0/membershipId',
    ],
    [
      {
        people: [
          { membershipId: c.viewer.membershipId, access: 'view' },
          { membershipId: c.owner.membershipId, access: 'edit' },
        ],
      },
      '/people/1/membershipId',
    ],
    [
      {
        people: [
          { membershipId: c.viewer.membershipId, access: 'view' },
          { membershipId: c.viewer.membershipId, access: 'edit' },
        ],
      },
      '/people',
    ],
  ] as const) {
    const refused = await share(c.owner.as(), c.view, sharingAsked).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(refused instanceof ValidationError)) throw new Error(`Expected ${expected} refused.`);
    expect(refused.issues[0].path).toBe(expected);
  }
  expect(await views(c.viewer.as())).toEqual([]);
  // A change made on a revision that is not the latest is refused.
  await sharedByName(c);
  await expect(share(c.owner.as(), c.view, { everyone: 'view' })).rejects.toBeInstanceOf(
    ConflictError,
  );
});

it('makes the list private again: the shares go, and so does everyone else’s sight of it', async () => {
  const c = await cast();
  const shared = await sharedByName(c);
  const privateAgain = savedView.parse(
    await call('unshareView', c.owner.as(), { revision: shared.revision }, { id: shared.id }),
  );
  expect(privateAgain).toMatchObject({
    visibility: 'private',
    sharing: { everyone: null, people: [] },
  });
  expect(await views(c.viewer.as())).toEqual([]);
  expect(await views(c.editor.as())).toEqual([]);
  const [left] = await database.as('crm_owner', (sql) =>
    sql.query<{ count: number }>(
      'select count(*)::int as count from crm.saved_view_shares where business_id = $1',
      [c.t.businessId],
    ),
  );
  expect(left).toEqual({ count: 0 });

  // Shared by name again, then with the team by the old way: nobody keeps a share by name.
  const again = await sharedByName({ ...c, view: privateAgain });
  const team = savedView.parse(
    await call('shareView', c.owner.as(), { revision: again.revision }, { id: again.id }),
  );
  expect(team).toMatchObject({ visibility: 'shared', sharing: { everyone: 'view', people: [] } });
});

it('keeps the shares of one business and of one list from anyone who cannot see the list', async () => {
  const c = await cast();
  const shared = await sharedByName(c);
  const elsewhere = await team(database);
  const count = (context: Invocation['context']) =>
    database.withTenant(context, (sql) =>
      sql.one<{ count: number }>('select count(*)::int as count from crm.saved_view_shares'),
    );
  expect(await count(c.viewer.as().context)).toEqual({ count: 2 });
  expect(await count(c.bystander.as().context)).toEqual({ count: 0 });
  expect(await count((await elsewhere.member()).as().context)).toEqual({ count: 0 });

  // Nobody can give themselves a share of a list they cannot see.
  await expect(
    database.withTenant(c.bystander.as().context, (sql) =>
      sql.query(
        `insert into crm.saved_view_shares (business_id, view_id, user_id, access)
         select app.business_id(), id, app.user_id(), 'edit' from crm.saved_views`,
      ),
    ),
  ).resolves.toEqual([]);
  await expect(
    database.withTenant(c.bystander.as().context, (sql) =>
      sql.query(
        `insert into crm.saved_view_shares (business_id, view_id, user_id, access)
         values (app.business_id(), $1, app.user_id(), 'edit')`,
        [parsePublicId('saved_view', shared.id)],
      ),
    ),
  ).rejects.toThrow(/row-level security/);
  expect(await views(c.bystander.as())).toEqual([]);
});

it('names who changed sharing in the audit by the list alone, and records the change once', async () => {
  const c = await cast();
  const shared = await sharedByName(c);
  const repeated = await share(c.owner.as(), shared, {
    people: [
      { membershipId: c.viewer.membershipId, access: 'view' },
      { membershipId: c.editor.membershipId, access: 'edit' },
    ],
  });
  expect(repeated.revision).toBe(shared.revision);
  const audits = await database.as('crm_owner', (sql) =>
    sql.query<{ command: string; input: unknown }>(
      `select command, input from audit.commands where business_id = $1 and command = 'view.set_sharing'`,
      [c.t.businessId],
    ),
  );
  expect(audits).toEqual([
    { command: 'view.set_sharing', input: { id: shared.id } },
    { command: 'view.set_sharing', input: { id: shared.id } },
  ]);
  const events = await database.as('crm_owner', (sql) =>
    sql.query<{ type: string; payload: unknown }>(
      `select type, payload from events.events where business_id = $1 and type = 'view.sharing_changed'`,
      [c.t.businessId],
    ),
  );
  expect(events).toEqual([{ type: 'view.sharing_changed', payload: {} }]);
});

/** Puts someone taken off the team back on it, through a new membership. */
async function invitedBack(c: Cast, member: Member): Promise<Member> {
  const row = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.memberships (agency_id, business_id, role_id, user_id)
       select agency_id, business_id, role_id, $2 from tenancy.memberships where user_id = $1
       returning id`,
      [c.owner.userId, member.userId],
    ),
  );
  return { ...member, membershipId: toPublicId('membership', row.id) };
}

it('takes the list from someone taken off the team at once, and does not give it back on their return', async () => {
  const c = await cast();
  const shared = await sharedByName(c);
  await c.t.remove(c.editor);
  expect(await views(c.editor.as())).toEqual([]);
  await expect(rename(c.editor.as(), shared, 'Still mine?')).rejects.toBeInstanceOf(NotFoundError);
  // The owner sees the share as someone no longer on the team: no membership, no name.
  const [left] = await views(c.owner.as());
  expect(left?.sharing.people.map((person) => [person.name, person.membershipId])).toEqual([
    ['Jordan Lee', c.viewer.membershipId],
    [null, null],
  ]);
  expect(left?.revision).toBe(shared.revision);

  // Invited back, the old share stays spent: only sharing with them again gives it back.
  const back = await invitedBack(c, c.editor);
  expect(await views(back.as())).toEqual([]);
  const [current] = await views(c.owner.as());
  if (current === undefined) throw new Error('The owner keeps the list.');
  expect(current.sharing.people[1]).toMatchObject({ name: 'Maya Patel', membershipId: null });
  const again = await share(c.owner.as(), current, {
    people: [
      { membershipId: c.viewer.membershipId, access: 'view' },
      { membershipId: back.membershipId, access: 'edit' },
    ],
  });
  expect(again.sharing.people.map((person) => person.membershipId)).toEqual([
    c.viewer.membershipId,
    back.membershipId,
  ]);
  expect(await views(back.as())).toMatchObject([{ id: shared.id, access: 'edit' }]);
});

it('lets the database refuse a change by someone the list is shared with only to view', async () => {
  const c = await cast();
  const shared = await sharedByName(c);
  const viewId = parsePublicId('saved_view', shared.id);
  const viewer = c.viewer.as().context;
  const changed = await database.withTenant(viewer, (sql) =>
    sql.query(`update crm.saved_views set name = 'Taken' where id = $1 returning id`, [viewId]),
  );
  expect(changed).toEqual([]);
  const deleted = await database.withTenant(viewer, (sql) =>
    sql.query('delete from crm.saved_views where id = $1 returning id', [viewId]),
  );
  expect(deleted).toEqual([]);
  const sharesGone = await database.withTenant(viewer, (sql) =>
    sql.query('delete from crm.saved_view_shares returning user_id'),
  );
  expect(sharesGone).toEqual([]);
  const promoted = await database.withTenant(viewer, (sql) =>
    sql.query(`update crm.saved_view_shares set access = 'edit' returning user_id`),
  );
  expect(promoted).toEqual([]);
  await expect(
    database.withTenant(viewer, (sql) =>
      sql.query(
        `insert into crm.saved_view_shares (business_id, view_id, user_id, access)
         values (app.business_id(), $1, $2, 'edit')`,
        [viewId, c.bystander.userId],
      ),
    ),
  ).rejects.toThrow(/row-level security/);
  // The editor may, as the owner may.
  const renamed = await database.withTenant(c.editor.as().context, (sql) =>
    sql.query(`update crm.saved_views set name = 'Edited' where id = $1 returning id`, [viewId]),
  );
  expect(renamed).toHaveLength(1);
  expect((await views(c.owner.as()))[0]).toMatchObject({ name: 'Edited' });
});

it('counts every list the team shares toward its limit, those the sharer cannot see too', async () => {
  const c = await cast();
  // A hundred lists of someone else's, each shared by name with someone else.
  await database.as('crm_owner', (sql) =>
    sql.query(
      `insert into crm.saved_views (business_id, object_type_id, owner_user_id, name, visibility, columns)
       select v.business_id, v.object_type_id, $2, 'Hidden ' || n, 'selected', '["name"]'
       from crm.saved_views v, generate_series(1, 100) n where v.id = $1`,
      [parsePublicId('saved_view', c.view.id), c.bystander.userId],
    ),
  );
  expect(await views(c.owner.as())).toHaveLength(1);
  for (const asked of [
    { everyone: 'view' as const },
    {
      people: [{ membershipId: c.viewer.membershipId, access: 'view' }],
    },
  ]) {
    const refused = await share(c.owner.as(), c.view, asked).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(refused instanceof ValidationError)) throw new Error('The limit must refuse it.');
    expect(refused.issues[0].code).toBe('shared_view_limit');
  }
});

it('lists all of the reader’s own views, however many others are shared with them', async () => {
  const c = await cast();
  await database.as('crm_owner', (sql) =>
    sql.query(
      `insert into crm.saved_views (business_id, object_type_id, owner_user_id, name, visibility, columns)
       select v.business_id, v.object_type_id, $2, 'Aaa shared ' || n, 'shared', '["name"]'
       from crm.saved_views v, generate_series(1, 250) n where v.id = $1`,
      [parsePublicId('saved_view', c.view.id), c.bystander.userId],
    ),
  );
  const listed = await views(c.owner.as());
  expect(listed.filter((view) => view.access === 'owner').map((view) => view.name)).toEqual([
    'Garden venues',
  ]);
  expect(listed.length).toBeLessThanOrEqual(200);
  // In name order still.
  expect(listed.at(-1)?.name).toBe('Garden venues');
});

it('answers the same revision and the same order of people from a change and from the list', async () => {
  const c = await cast();
  const first = await share(c.owner.as(), c.view, {
    people: [{ membershipId: c.editor.membershipId, access: 'edit' }],
  });
  const second = await share(c.owner.as(), first, {
    people: [
      { membershipId: c.viewer.membershipId, access: 'view' },
      { membershipId: c.editor.membershipId, access: 'view' },
    ],
  });
  // Maya was chosen first; changing her level keeps her place.
  expect(second.sharing.people.map((person) => person.name)).toEqual(['Maya Patel', 'Jordan Lee']);
  const [listed] = await views(c.owner.as());
  expect(listed?.sharing).toEqual(second.sharing);
  expect(listed?.revision).toBe(second.revision);
});
