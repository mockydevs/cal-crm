import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation } from '@repo/commands';
import {
  contact,
  contactList,
  contactViewState,
  fieldDefinition,
  recordFields,
  savedView,
  viewList,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { createCrmRoutes } from '../index.js';

let database: TestDatabase;
let db: Database;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});

it('shares one configuration with members and viewers, then hides it again when its owner makes it private', async () => {
  const owner = await fixture();
  const member: Invocation = {
    ...(await anotherPerson(owner)),
    permissions: new Set(['views.save']),
  };
  const viewer: Invocation = { ...member, permissions: new Set() };
  const saved = savedView.parse(await call('createView', owner, contactInput));
  const shared = savedView.parse(
    await call('shareView', owner, { revision: saved.revision }, { id: saved.id }),
  );
  expect(shared).toMatchObject({
    ...contactInput,
    visibility: 'shared',
    owner: { you: true },
    canShare: false,
    canUnshare: true,
  });
  expect(shared.revision).not.toBe(saved.revision);
  for (const reader of [member, viewer]) {
    const listed = viewList.parse(
      await call('listViews', reader, undefined, {}, { object: 'contact' }),
    );
    expect(listed.canSave).toBe(reader === member);
    expect(listed.items).toEqual([
      {
        ...shared,
        owner: { membershipId: null, name: null, you: false },
        access: 'view',
        canChange: false,
        canShare: false,
        canUnshare: false,
        canDelete: false,
        canChangeSharing: false,
      },
    ]);
  }
  expect(
    viewList.parse(await call('listViews', await fixture(), undefined, {}, { object: 'contact' }))
      .items,
  ).toEqual([]);
  const privateAgain = savedView.parse(
    await call(
      'unshareView',
      {
        ...owner,
        permissions: new Set(['views.save']),
      },
      { revision: shared.revision },
      { id: shared.id },
    ),
  );
  expect(privateAgain).toMatchObject({
    visibility: 'private',
    canChange: true,
    canShare: false,
    canUnshare: false,
  });
  expect(
    viewList.parse(await call('listViews', member, undefined, {}, { object: 'contact' })).items,
  ).toEqual([]);
  expect(
    viewList.parse(await call('listViews', owner, undefined, {}, { object: 'contact' })).items[0]
      ?.state,
  ).toEqual(contactInput.state);
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function fixture(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user({ name: 'Dana Brooks' });
  return {
    context: {
      ...business.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
}
async function anotherPerson(invocation: Invocation): Promise<Invocation> {
  const person = await database.fixtures.user({ name: 'Jordan Lee' });
  return {
    ...invocation,
    context: { ...invocation.context, userId: person.id, actorId: person.id },
  };
}
async function call(
  operationId: string,
  invocation: Invocation,
  body?: unknown,
  params: Record<string, string> = {},
  query: Record<string, string> = {},
) {
  const route = createCrmRoutes().find((route) => route.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, params, body, query }, { db, authorize: allowEveryone });
}
const contactInput = {
  objectKey: 'contact',
  name: 'Recent gardens',
  state: { q: 'garden', sort: 'name', added: 'week' },
  columns: ['name', 'phone', 'email'],
};

it('replaces a view at its current revision, refuses stale or incompatible changes, and deletes only the version reviewed', async () => {
  const owner = await fixture();
  const saved = savedView.parse(await call('createView', owner, contactInput));
  const replacement = {
    name: 'Indoor venues',
    state: { q: 'indoor', added: 'month' },
    columns: ['email', 'name'],
    revision: saved.revision,
  };
  const edited = savedView.parse(await call('updateView', owner, replacement, { id: saved.id }));
  expect(edited).toMatchObject({
    name: replacement.name,
    state: replacement.state,
    columns: replacement.columns,
    id: saved.id,
    objectKey: 'contact',
  });
  expect(edited.revision).not.toBe(saved.revision);
  for (const operation of ['updateView', 'shareView', 'deleteView']) {
    await expect(
      call(
        operation,
        owner,
        operation === 'updateView' ? replacement : { revision: saved.revision },
        { id: saved.id },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  }
  for (const changes of [
    { name: 'Incomplete', revision: edited.revision },
    { ...replacement, objectKey: 'deal', revision: edited.revision },
    {
      ...replacement,
      state: { status: 'won', layout: 'table' },
      columns: ['name', 'amount'],
      revision: edited.revision,
    },
  ]) {
    await expect(call('updateView', owner, changes, { id: saved.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
  }
  expect(
    viewList.parse(await call('listViews', owner, undefined, {}, { object: 'contact' })).items,
  ).toEqual([edited]);
  await call('deleteView', owner, { revision: edited.revision }, { id: saved.id });
  expect(
    viewList.parse(await call('listViews', owner, undefined, {}, { object: 'contact' })).items,
  ).toEqual([]);
  await expect(
    call('updateView', owner, { malformed: true }, { id: saved.id }),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('reopens the saved contact configuration for its owner, without exposing it to another person or business', async () => {
  const owner = await fixture();
  const saved = await call('createView', owner, contactInput);
  expect(saved).toMatchObject({
    ...contactInput,
    visibility: 'private',
    owner: { name: null, you: true },
    canChange: true,
    canShare: true,
    canUnshare: false,
  });
  const parsed = savedView.parse(saved);
  expect(parsed.id).toMatch(/^view_/);
  expect(parsed.revision).toMatch(/^[0-9a-f]{64}$/);
  expect(await call('listViews', owner, undefined, {}, { object: 'contact' })).toEqual({
    canSave: true,
    items: [saved],
  });
  expect(await call('listViews', owner, undefined, {}, { object: 'deal' })).toEqual({
    canSave: true,
    items: [],
  });
  for (const reader of [await anotherPerson(owner), await fixture()]) {
    expect(await call('listViews', reader, undefined, {}, { object: 'contact' })).toEqual({
      canSave: true,
      items: [],
    });
  }
});

it.each([
  {
    objectKey: 'contact',
    state: {
      fieldId: toPublicId('field', '00000000-0000-7000-8000-000000000001'),
      fieldOperator: 'is_set',
    },
    path: '/state/fieldId',
    code: 'unknown_field',
  },
  {
    objectKey: 'deal',
    state: { sortField: toPublicId('field', '00000000-0000-7000-8000-000000000002') },
    path: '/state/sortField',
    code: 'unknown_field',
  },
  {
    objectKey: 'deal',
    state: { pipelineId: toPublicId('pipeline', '00000000-0000-7000-8000-000000000003') },
    path: '/state/pipelineId',
    code: 'unknown_pipeline',
  },
])(
  'rejects an inaccessible reference in $path when saving or replacing a view',
  async ({ objectKey, state, path, code }) => {
    const owner = await fixture();
    const input = { objectKey, name: 'Reference check', state, columns: ['name'] };
    await expect(call('createView', owner, input)).rejects.toMatchObject({
      issues: [{ path, code }],
    });
    const saved = savedView.parse(await call('createView', owner, { ...input, state: {} }));
    await expect(
      call(
        'updateView',
        owner,
        {
          name: input.name,
          state,
          columns: input.columns,
          revision: saved.revision,
        },
        { id: saved.id },
      ),
    ).rejects.toMatchObject({ issues: [{ path, code }] });
    expect(
      viewList.parse(await call('listViews', owner, undefined, {}, { object: objectKey })).items,
    ).toEqual([saved]);
  },
);

it('validates field ownership, object kind and typed values with the same rules as record lists', async () => {
  const owner = await fixture();
  const fieldInput = {
    objectKey: 'contact',
    key: 'guest_count',
    label: 'Guest count',
    description: 'Expected guests.',
    valueType: 'number',
    options: [],
    currency: null,
    aiFillSources: ['conversations'],
    aiOverwrite: 'ask',
    archived: false,
  };
  const field = fieldDefinition.parse(await call('createField', owner, fieldInput));
  const foreign = fieldDefinition.parse(await call('createField', await fixture(), fieldInput));
  for (const [objectKey, fieldId] of [
    ['contact', foreign.id],
    ['deal', field.id],
  ]) {
    await expect(
      call('createView', owner, {
        name: 'Wrong field',
        objectKey,
        state: { fieldId, fieldOperator: 'is_set' },
        columns: ['name'],
      }),
    ).rejects.toMatchObject({ issues: [{ path: '/state/fieldId', code: 'unknown_field' }] });
  }
  for (const state of [
    { fieldId: field.id, fieldOperator: 'gt', fieldValue: 'many' },
    { fieldId: field.id, fieldOperator: 'contains', fieldValue: '10' },
  ]) {
    await expect(call('createView', owner, { ...contactInput, state })).rejects.toBeInstanceOf(
      ValidationError,
    );
  }
  const state = {
    fieldId: field.id,
    fieldOperator: 'gte',
    fieldValue: '10',
    sortField: field.id,
    fieldOrder: 'desc',
  };
  const saved = savedView.parse(await call('createView', owner, { ...contactInput, state }));
  expect(saved.state).toEqual(state);
  expect(
    viewList.parse(await call('listViews', owner, undefined, {}, { object: 'contact' })).items,
  ).toEqual([saved]);
});

async function seedViews(owner: Invocation, count: number, visibility = 'private') {
  await database.as('crm_owner', (sql) =>
    sql.query(
      `insert into crm.saved_views(business_id,object_type_id,owner_user_id,name,visibility,columns)
     select o.business_id,o.id,$2,'Saved ' || n,$4,'["name"]'::jsonb
     from crm.object_types o cross join generate_series(1,$3::integer) n
     where o.business_id=$1 and o.kind='contact'`,
      [owner.context.businessId, owner.context.userId, count, visibility],
    ),
  );
}

it('allows only one of two concurrent saves at the personal limit, without counting other owners or objects', async () => {
  const owner = await fixture();
  const other = await anotherPerson(owner);
  await seedViews(owner, 99);
  await seedViews(other, 99);
  const results = await Promise.allSettled([
    call('createView', owner, contactInput),
    call('createView', owner, { ...contactInput, name: 'Second concurrent save' }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { issues: [{ path: '', code: 'view_limit' }] },
  });
  const views = viewList.parse(
    await call('listViews', owner, undefined, {}, { object: 'contact' }),
  );
  expect(views.items).toHaveLength(100);
  expect(views.items.every((view) => view.owner.you)).toBe(true);
  await call('createView', other, contactInput);
  await call('createView', owner, {
    objectKey: 'deal',
    name: 'Deals',
    state: {},
    columns: ['name'],
  });
  const first = views.items[0];
  if (first === undefined) throw new Error('The first view must exist.');
  await call('deleteView', owner, { revision: first.revision }, { id: first.id });
  await call('createView', owner, contactInput);
});

it('bounds shared views across owners under concurrent shares and frees capacity when a view becomes private', async () => {
  const owner = await fixture();
  const other = await anotherPerson(owner);
  await seedViews(other, 99, 'shared');
  const a = savedView.parse(await call('createView', owner, contactInput));
  const b = savedView.parse(await call('createView', other, contactInput));
  const results = await Promise.allSettled([
    call('shareView', owner, { revision: a.revision }, { id: a.id }),
    call('shareView', other, { revision: b.revision }, { id: b.id }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { issues: [{ path: '', code: 'shared_view_limit' }] },
  });
  const reader = await anotherPerson(owner);
  const shared = viewList.parse(
    await call('listViews', reader, undefined, {}, { object: 'contact' }),
  );
  expect(shared.items).toHaveLength(100);
  const first = shared.items[0];
  if (first === undefined) throw new Error('A shared view must exist.');
  const firstOwner = first.id === a.id ? owner : other;
  await call('unshareView', firstOwner, { revision: first.revision }, { id: first.id });
  const winner = results.find((result) => result.status === 'fulfilled');
  if (winner?.status !== 'fulfilled') throw new Error('One share must succeed.');
  const winning = savedView.parse(winner.value);
  const loser = winning.id === a.id ? b : a;
  const loserOwner = loser.id === a.id ? owner : other;
  await call('shareView', loserOwner, { revision: loser.revision }, { id: loser.id });
  expect(
    viewList.parse(await call('listViews', reader, undefined, {}, { object: 'contact' })).items,
  ).toHaveLength(100);
});

it('keeps every private-view mutation invisible to other people and businesses before parsing their bodies', async () => {
  const owner = await fixture();
  const saved = savedView.parse(await call('createView', owner, contactInput));
  for (const reader of [await anotherPerson(owner), await fixture()]) {
    for (const operation of ['updateView', 'deleteView', 'shareView', 'unshareView']) {
      await expect(
        call(operation, reader, { malformed: true }, { id: saved.id }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
  }
  for (const injected of [
    { owner_user_id: owner.context.userId },
    { visibility: 'shared' },
    { revision: saved.revision },
  ]) {
    await expect(
      call('createView', owner, { ...contactInput, ...injected }),
    ).rejects.toBeInstanceOf(ValidationError);
  }
  expect(
    viewList.parse(await call('listViews', owner, undefined, {}, { object: 'contact' })).items,
  ).toEqual([saved]);
});

it('allows members to maintain their views and admins to maintain shared views, while only the owner controls visibility', async () => {
  const owner = await fixture();
  const member: Invocation = {
    ...(await anotherPerson(owner)),
    permissions: new Set(['views.save']),
  };
  const admin = await anotherPerson(owner);
  const viewer: Invocation = { ...member, permissions: new Set() };
  const saved = savedView.parse(await call('createView', owner, contactInput));
  await expect(call('createView', viewer, contactInput)).rejects.toBeInstanceOf(ForbiddenError);
  const own = savedView.parse(await call('createView', member, contactInput));
  await expect(
    call('shareView', member, { revision: own.revision }, { id: own.id }),
  ).rejects.toMatchObject({ permission: 'views.share' });
  const shared = savedView.parse(
    await call('shareView', owner, { revision: saved.revision }, { id: saved.id }),
  );
  const changes = { name: 'Team gardens', state: {}, columns: ['name'], revision: shared.revision };
  await expect(call('updateView', member, changes, { id: shared.id })).rejects.toMatchObject({
    permission: 'views.share',
  });
  await expect(
    call('deleteView', member, { revision: shared.revision }, { id: shared.id }),
  ).rejects.toMatchObject({ permission: 'views.share' });
  await expect(call('updateView', viewer, changes, { id: shared.id })).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  const edited = savedView.parse(await call('updateView', admin, changes, { id: shared.id }));
  expect(edited).toMatchObject({
    name: changes.name,
    owner: { you: false },
    canChange: true,
    canShare: false,
    canUnshare: false,
  });
  for (const operation of ['shareView', 'unshareView']) {
    await expect(
      call(operation, admin, { revision: edited.revision }, { id: edited.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  }
  const ownerWithoutSharing: Invocation = { ...owner, permissions: new Set(['views.save']) };
  const privateAgain = savedView.parse(
    await call(
      'unshareView',
      ownerWithoutSharing,
      { revision: edited.revision },
      { id: edited.id },
    ),
  );
  expect(privateAgain.visibility).toBe('private');
  const sharedAgain = savedView.parse(
    await call('shareView', owner, { revision: privateAgain.revision }, { id: privateAgain.id }),
  );
  await call('deleteView', admin, { revision: sharedAgain.revision }, { id: sharedAgain.id });
  const editedOwn = savedView.parse(
    await call('updateView', member, { ...changes, revision: own.revision }, { id: own.id }),
  );
  await call('deleteView', member, { revision: editedOwn.revision }, { id: editedOwn.id });
});

it('lets non-human and delegated actors read shared views but never save or change them', async () => {
  const owner = await fixture();
  const saved = savedView.parse(await call('createView', owner, contactInput));
  const shared = savedView.parse(
    await call('shareView', owner, { revision: saved.revision }, { id: saved.id }),
  );
  const personal = savedView.parse(await call('createView', owner, contactInput));
  const contexts = [
    { ...owner.context, actorKind: 'system' as const },
    { ...owner.context, actorKind: 'api_key' as const },
    { ...owner.context, actorId: randomUUID() },
  ];
  for (const context of contexts) {
    const actor: Invocation = { ...owner, context };
    const listed = viewList.parse(
      await call('listViews', actor, undefined, {}, { object: 'contact' }),
    );
    expect(listed).toMatchObject({
      canSave: false,
      items: [
        {
          id: shared.id,
          owner: { you: false },
          canChange: false,
          canShare: false,
          canUnshare: false,
        },
      ],
    });
    await expect(call('createView', actor, contactInput)).rejects.toBeInstanceOf(ForbiddenError);
    for (const operation of ['updateView', 'deleteView', 'shareView', 'unshareView']) {
      const body =
        operation === 'updateView'
          ? { name: 'Changed', state: {}, columns: ['name'], revision: shared.revision }
          : { revision: shared.revision };
      await expect(call(operation, actor, body, { id: shared.id })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(call(operation, actor, body, { id: personal.id })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }
  }
});

it('rejects the losing concurrent edit and keeps view content out of audits and events', async () => {
  const owner = await fixture();
  const saved = savedView.parse(await call('createView', owner, contactInput));
  const results = await Promise.allSettled(
    ['First edit', 'Second edit'].map((name) =>
      call(
        'updateView',
        owner,
        {
          name,
          state: contactInput.state,
          columns: contactInput.columns,
          revision: saved.revision,
        },
        { id: saved.id },
      ),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected?.status !== 'rejected') throw new Error('The stale edit must fail.');
  const rejection: unknown = rejected.reason;
  expect(rejection).toBeInstanceOf(ConflictError);
  const winner = results.find((result) => result.status === 'fulfilled');
  if (winner?.status !== 'fulfilled') throw new Error('One edit must succeed.');
  const current = savedView.parse(winner.value);
  const shared = savedView.parse(
    await call('shareView', owner, { revision: current.revision }, { id: current.id }),
  );
  const repeated = savedView.parse(
    await call('shareView', owner, { revision: shared.revision }, { id: shared.id }),
  );
  expect(repeated).toEqual(shared);
  const privateAgain = savedView.parse(
    await call('unshareView', owner, { revision: shared.revision }, { id: shared.id }),
  );
  await call('deleteView', owner, { revision: privateAgain.revision }, { id: privateAgain.id });
  const audits = await database.as('crm_owner', (sql) =>
    sql.query<{ input: unknown; outcome: string }>(
      'select input,outcome from audit.commands where business_id=$1 order by id',
      [owner.context.businessId],
    ),
  );
  expect(audits).toHaveLength(7);
  expect(audits.filter((audit) => audit.outcome === 'failed')).toHaveLength(1);
  for (const audit of audits)
    expect(audit.input).toEqual(
      audit.input !== null && typeof audit.input === 'object' && 'objectKey' in audit.input
        ? { objectKey: 'contact' }
        : { id: saved.id },
    );
  const events = await database.as('crm_owner', (sql) =>
    sql.query<{ type: string; subject_kind: string; payload: unknown }>(
      'select type,subject_kind,payload from events.events where business_id=$1 order by id',
      [owner.context.businessId],
    ),
  );
  expect(events.map((event) => event.type)).toEqual([
    'view.created',
    'view.updated',
    'view.shared',
    'view.unshared',
    'view.deleted',
  ]);
  for (const event of events)
    expect(event).toMatchObject({ subject_kind: 'saved_view', payload: {} });
});

it('reopens a shared typed filter and ordering against actual record-list results for another person', async () => {
  const owner = await fixture();
  const reader = await anotherPerson(owner);
  const field = fieldDefinition.parse(
    await call('createField', owner, {
      objectKey: 'contact',
      key: 'capacity',
      label: 'Capacity',
      description: 'Number of guests.',
      valueType: 'number',
      options: [],
      currency: null,
      aiFillSources: [],
      aiOverwrite: 'ask',
      archived: false,
    }),
  );
  const records: string[] = [];
  for (const [name, value] of [
    ['Maya', '10'],
    ['Dana', '20'],
    ['Jordan', '5'],
  ]) {
    const record = contact.parse(await call('createContact', owner, { firstName: name }));
    records.push(record.id);
    const fields = recordFields.parse(
      await call('getRecordFields', owner, undefined, { id: record.id }),
    );
    await call(
      'setRecordField',
      owner,
      { value, revision: fields.items[0]?.revision },
      { id: record.id, fieldId: field.id },
    );
  }
  const state = {
    fieldId: field.id,
    fieldOperator: 'gte',
    fieldValue: '10',
    sortField: field.id,
    fieldOrder: 'desc',
  };
  const created = savedView.parse(
    await call('createView', owner, { ...contactInput, state, columns: ['phone', 'name'] }),
  );
  await call('shareView', owner, { revision: created.revision }, { id: created.id });
  const shared = viewList.parse(
    await call('listViews', reader, undefined, {}, { object: 'contact' }),
  ).items[0];
  if (shared === undefined) throw new Error('The shared view must exist.');
  expect(shared).toMatchObject({ state, columns: ['phone', 'name'] });
  const query = Object.fromEntries(
    Object.entries(contactViewState.parse(shared.state)).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const matching = contactList.parse(await call('listContacts', reader, undefined, {}, query));
  expect(matching.items.map((item) => item.id)).toEqual([records[1], records[0]]);
  expect(matching.next).toBeNull();
});

it.each(['createView', 'shareView', 'unshareView'])(
  '%s keeps capacity writes serialized without blocking a concurrent contact insert',
  async (operation) => {
    const owner = await fixture();
    const initial = savedView.parse(await call('createView', owner, contactInput));
    const current =
      operation === 'unshareView'
        ? savedView.parse(
            await call('shareView', owner, { revision: initial.revision }, { id: initial.id }),
          )
        : initial;
    const held = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const route = createCrmRoutes({
      user: async () => {
        held.resolve(undefined);
        await release.promise;
        return new Map();
      },
    }).find((item) => item.endpoint.operationId === operation);
    if (route === undefined) throw new Error(`Missing ${operation} route.`);
    const changing = route.run(
      {
        invocation: owner,
        query: {},
        params: { id: current.id },
        body: operation === 'createView' ? contactInput : { revision: current.revision },
      },
      { db, authorize: allowEveryone },
    );
    void changing.catch(held.reject);
    try {
      await held.promise;
      const inserted = await database.withTenant(owner.context, async (sql) => {
        await sql.query("set local lock_timeout = '200ms'");
        return sql.one<{ first_name: string }>(
          `with record as (
             insert into crm.records(business_id,kind,object_type_id)
             select app.business_id(),'contact',id from crm.object_types where kind='contact'
             returning id
           ) insert into crm.contacts(business_id,id,first_name,created_by_kind,created_by_id)
           select app.business_id(),id,'Maya',app.actor_kind(),app.actor_id() from record
           returning first_name`,
        );
      });
      expect(inserted.first_name).toBe('Maya');
    } finally {
      release.resolve(undefined);
      await changing;
    }
  },
);
