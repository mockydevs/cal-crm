import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation } from '@repo/commands';
import { note, recordNotes } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  parsePublicId,
  toPublicId,
  ValidationError,
  ConflictError,
  NotFoundError,
  ForbiddenError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { createCrmRoutes, crmRoutes, type NameLookup } from '../index.js';

let database: TestDatabase;
let db: Database;
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

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user({ name: 'Dana Brooks' });
  const invocation: Invocation = {
    context: {
      ...business.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
  const record = await database.fixtures.contact(invocation.context, {
    firstName: 'Maya',
  });
  return { invocation, id: toPublicId('contact', record.id) };
}
async function call(
  operationId: string,
  invocation: Invocation,
  params: Record<string, string>,
  body?: unknown,
  query: Record<string, string> = {},
  routes = crmRoutes,
) {
  const route = routes.find((route) => route.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, params, body, query }, { db, authorize: allowEveryone });
}
const body = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Call Maya', marks: [{ type: 'bold' }] },
        { type: 'hardBreak' },
        { type: 'text', text: 'Confirm the garden venue.' },
      ],
    },
  ],
};

it('saves a structured note with trusted authorship and finds its derived text on the record', async () => {
  const { invocation, id } = await fixture();
  const saved = note.parse(await call('createNote', invocation, { id }, { body }));
  expect(saved).toMatchObject({
    recordId: id,
    body,
    text: 'Call Maya\nConfirm the garden venue.',
    author: { kind: 'user', you: true },
  });
  expect(saved.id).toMatch(/^note_/);
  const matches = recordNotes.parse(
    await call('listRecordNotes', invocation, { id }, undefined, {
      q: 'garden',
    }),
  );
  expect(matches.items).toEqual([saved]);
  expect(matches.canManage).toBe(true);
  expect(
    recordNotes.parse(
      await call('listRecordNotes', invocation, { id }, undefined, {
        q: 'indoor',
      }),
    ).items,
  ).toEqual([]);
});

it('pages notes without repeats and refuses a cursor from another record or business', async () => {
  const { invocation, id } = await fixture();
  const created: string[] = [];
  for (let index = 0; index < 52; index++) {
    const saved = note.parse(await call('createNote', invocation, { id }, { body }));
    created.push(saved.id);
  }
  const first = recordNotes.parse(await call('listRecordNotes', invocation, { id }));
  expect(first.items).toHaveLength(50);
  if (first.nextCursor === null) throw new Error('Expected another page.');
  expect(first.nextCursor).toBe(first.items.at(-1)?.id);
  const second = recordNotes.parse(
    await call('listRecordNotes', invocation, { id }, undefined, { after: first.nextCursor }),
  );
  expect(second.items).toHaveLength(2);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
    new Set(created),
  );
  const foreign = await fixture();
  const foreignNote = note.parse(
    await call('createNote', foreign.invocation, { id: foreign.id }, { body }),
  );
  await expect(
    call('listRecordNotes', invocation, { id }, undefined, { after: foreignNote.id }),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('edits with a revision, keeps the original author and refuses stale edits and deletes', async () => {
  const { invocation, id } = await fixture();
  const saved = note.parse(await call('createNote', invocation, { id }, { body }));
  const otherUser = await database.fixtures.user({ name: 'Jordan Lee' });
  const editor: Invocation = {
    ...invocation,
    context: { ...invocation.context, actorId: otherUser.id, userId: otherUser.id },
  };
  const changed = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Confirm the indoor venue.' }] },
    ],
  };
  const edited = note.parse(
    await call(
      'updateNote',
      editor,
      { id, noteId: saved.id },
      {
        body: changed,
        revision: saved.revision,
      },
    ),
  );
  expect(saved).toMatchObject({ editedBy: null, editedAt: null });
  expect(edited.body).toEqual(changed);
  expect(edited.text).toBe('Confirm the indoor venue.');
  expect(edited.author).toMatchObject({ kind: 'user', you: false });
  expect(edited.editedBy).toMatchObject({ kind: 'user', you: true });
  expect(edited.editedAt).not.toBeNull();
  expect(edited.revision).not.toBe(saved.revision);
  await expect(
    call(
      'updateNote',
      invocation,
      { id, noteId: saved.id },
      {
        body,
        revision: saved.revision,
      },
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(
    call(
      'deleteNote',
      invocation,
      { id, noteId: saved.id },
      {
        revision: saved.revision,
      },
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(
    recordNotes.parse(await call('listRecordNotes', invocation, { id }, undefined, { q: 'garden' }))
      .items,
  ).toEqual([]);
  expect(
    recordNotes.parse(await call('listRecordNotes', invocation, { id }, undefined, { q: 'indoor' }))
      .items,
  ).toHaveLength(1);
  await call('deleteNote', invocation, { id, noteId: saved.id }, { revision: edited.revision });
  expect(recordNotes.parse(await call('listRecordNotes', invocation, { id })).items).toEqual([]);
});

it('hides foreign record and note IDs, refuses forged authors, and leaves trashed notes read-only', async () => {
  const { invocation, id } = await fixture();
  const foreign = await fixture();
  const saved = note.parse(await call('createNote', invocation, { id }, { body }));
  const theirs = note.parse(
    await call('createNote', foreign.invocation, { id: foreign.id }, { body }),
  );
  await expect(call('listRecordNotes', invocation, { id: foreign.id })).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(
    call('createNote', invocation, { id }, { body, author: { kind: 'system' } }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    call('updateNote', invocation, { id, noteId: theirs.id }, { body, revision: theirs.revision }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('deleteNote', invocation, { id, noteId: theirs.id }, { revision: theirs.revision }),
  ).rejects.toBeInstanceOf(NotFoundError);
  const viewer: Invocation = { ...invocation, permissions: new Set() };
  expect(recordNotes.parse(await call('listRecordNotes', viewer, { id })).canManage).toBe(false);
  await expect(call('createNote', viewer, { id }, { body })).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    call('updateNote', viewer, { id, noteId: saved.id }, { body, revision: saved.revision }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    call('deleteNote', viewer, { id, noteId: saved.id }, { revision: saved.revision }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await call('trashContact', invocation, { id });
  expect(recordNotes.parse(await call('listRecordNotes', invocation, { id }))).toMatchObject({
    canManage: false,
    items: [saved],
  });
  await expect(call('createNote', invocation, { id }, { body })).rejects.toBeInstanceOf(
    ConflictError,
  );
  await expect(
    call('updateNote', invocation, { id, noteId: saved.id }, { body, revision: saved.revision }),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(
    call('deleteNote', invocation, { id, noteId: saved.id }, { revision: saved.revision }),
  ).rejects.toBeInstanceOf(ConflictError);
});

/** The record's notes, a page at a time, as their ids. */
async function allPages(invocation: Invocation, id: string): Promise<string[][]> {
  const pages: string[][] = [];
  let after: string | undefined;
  for (;;) {
    const page = recordNotes.parse(
      await call(
        'listRecordNotes',
        invocation,
        { id },
        undefined,
        after === undefined ? {} : { after },
      ),
    );
    pages.push(page.items.map((item) => item.id));
    if (page.nextCursor === null) return pages;
    after = page.nextCursor;
  }
}

it('names who wrote a note and who last edited it, person or machine, one lookup a kind', async () => {
  const { invocation, id } = await fixture();
  const jordan = await database.fixtures.user({ name: 'Jordan Lee' });
  const key = randomUUID();
  const lookups: [string, string[]][] = [];
  const names =
    (kind: string, known: Record<string, string>): NameLookup =>
    (_trx, ids) => {
      lookups.push([kind, [...ids].sort()]);
      return Promise.resolve(
        new Map(ids.flatMap((each) => (known[each] === undefined ? [] : [[each, known[each]]]))),
      );
    };
  const dana = invocation.context.userId ?? '';
  const routes = createCrmRoutes({
    user: names('user', { [dana]: 'Dana Brooks', [jordan.id]: 'Jordan Lee' }),
    api_key: names('api_key', { [key]: 'Zapier' }),
  });
  const asJordan: Invocation = {
    ...invocation,
    context: { ...invocation.context, actorId: jordan.id, userId: jordan.id },
  };
  const { agencyId, businessId } = invocation.context;
  const asKey: Invocation = {
    context: {
      agencyId,
      ...(businessId === undefined ? {} : { businessId }),
      actorKind: 'api_key',
      actorId: key,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
  const first = note.parse(await call('createNote', invocation, { id }, { body }, {}, routes));
  const second = note.parse(await call('createNote', invocation, { id }, { body }, {}, routes));
  const byJordan = note.parse(
    await call(
      'updateNote',
      asJordan,
      { id, noteId: first.id },
      { body, revision: first.revision },
      {},
      routes,
    ),
  );
  const byKey = note.parse(
    await call(
      'updateNote',
      asKey,
      { id, noteId: second.id },
      { body, revision: second.revision },
      {},
      routes,
    ),
  );
  expect(byJordan.editedBy).toEqual({ kind: 'user', name: 'Jordan Lee', you: true });
  expect(byKey.editedBy).toEqual({ kind: 'api_key', name: 'Zapier', you: false });

  lookups.length = 0;
  const list = recordNotes.parse(
    await call('listRecordNotes', invocation, { id }, undefined, {}, routes),
  );
  expect(list.items.map((item) => [item.id, item.author, item.editedBy])).toEqual([
    [
      second.id,
      { kind: 'user', name: 'Dana Brooks', you: true },
      { kind: 'api_key', name: 'Zapier', you: false },
    ],
    [
      first.id,
      { kind: 'user', name: 'Dana Brooks', you: true },
      { kind: 'user', name: 'Jordan Lee', you: false },
    ],
  ]);
  // Authors and editors together: one lookup for each kind of actor on the page.
  expect(lookups).toEqual([
    ['user', [dana, jordan.id].sort()],
    ['api_key', [key]],
  ]);
});

it("refuses an editor named in the input, and another record's note or cursor", async () => {
  const { invocation, id } = await fixture();
  const saved = note.parse(await call('createNote', invocation, { id }, { body }));
  const forged = { kind: 'system', name: 'Anyone', you: false };
  await expect(
    call('createNote', invocation, { id }, { body, editedBy: forged }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    call(
      'updateNote',
      invocation,
      { id, noteId: saved.id },
      { body, revision: saved.revision, editedBy: forged },
    ),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    call(
      'updateNote',
      invocation,
      { id, noteId: saved.id },
      { body, revision: saved.revision, editedAt: '2020-01-01T00:00:00.000Z' },
    ),
  ).rejects.toBeInstanceOf(ValidationError);
  // A note on another contact in the same business is no note of this one.
  const other = toPublicId(
    'contact',
    (await database.fixtures.contact(invocation.context, { firstName: 'Priya' })).id,
  );
  const elsewhere = note.parse(await call('createNote', invocation, { id: other }, { body }));
  await expect(
    call(
      'updateNote',
      invocation,
      { id, noteId: elsewhere.id },
      { body, revision: elsewhere.revision },
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('deleteNote', invocation, { id, noteId: elsewhere.id }, { revision: elsewhere.revision }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('listRecordNotes', invocation, { id }, undefined, { after: elsewhere.id }),
  ).rejects.toBeInstanceOf(ValidationError);
  // Only the search and the cursor: anything else in the query is refused.
  await expect(
    call('listRecordNotes', invocation, { id }, undefined, { q: 'garden', sort: 'oldest' }),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('keeps only ids in the audit log, for done, refused and failed note commands', async () => {
  const { invocation, id } = await fixture();
  const saved = note.parse(await call('createNote', invocation, { id }, { body }));
  const edited = note.parse(
    await call(
      'updateNote',
      invocation,
      { id, noteId: saved.id },
      { body, revision: saved.revision },
    ),
  );
  const viewer: Invocation = { ...invocation, permissions: new Set() };
  await expect(call('createNote', viewer, { id }, { body })).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    call('updateNote', viewer, { id, noteId: saved.id }, { body, revision: edited.revision }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  // A stale revision fails inside the command.
  await expect(
    call('updateNote', invocation, { id, noteId: saved.id }, { body, revision: saved.revision }),
  ).rejects.toBeInstanceOf(ConflictError);
  await call('deleteNote', invocation, { id, noteId: saved.id }, { revision: edited.revision });

  const rows = await database.as('crm_owner', (sql) =>
    sql.query<{ command: string; outcome: string; input: Record<string, unknown> }>(
      `select command, outcome, input from audit.commands
       where business_id = $1 and command like 'note.%' order by recorded_at, id`,
      [invocation.context.businessId],
    ),
  );
  expect(rows.map((row) => [row.command, row.outcome, Object.keys(row.input).sort()])).toEqual([
    ['note.create', 'ok', ['id']],
    ['note.update', 'ok', ['id', 'noteId']],
    ['note.create', 'denied', ['id']],
    ['note.update', 'denied', ['id', 'noteId']],
    ['note.update', 'failed', ['id', 'noteId']],
    ['note.delete', 'ok', ['id', 'noteId']],
  ]);
  expect(JSON.stringify(rows)).not.toMatch(/garden|Call Maya|revision/);
});

it('pages newest written first, ties broken by id, imported history included', async () => {
  const { invocation, id } = await fixture();
  const latest = note.parse(await call('createNote', invocation, { id }, { body }));
  const record = parsePublicId('contact', id);
  const groups = await database.as('crm_owner', async (sql) => {
    const insert = (count: number, at: string) =>
      sql.query<{ id: string }>(
        `insert into crm.notes (business_id, record_id, body, body_text, author_kind, created_at)
         select $1, $2, $3::jsonb, 'Imported', 'import', $4 from generate_series(1, $5)
         returning id`,
        [invocation.context.businessId, record, JSON.stringify(body), at, count],
      );
    // Written at the same moment, then older history imported after them, so ids alone
    // would put the history first.
    const tied = await insert(55, '2026-01-01T00:00:00.000Z');
    const history = await insert(5, '2020-06-01T00:00:00.000Z');
    return { tied, history };
  });
  const newestFirst = (rows: { id: string }[]) =>
    rows
      .map((row) => row.id)
      .sort()
      .reverse()
      .map((each) => toPublicId('note', each));

  const pages = await allPages(invocation, id);

  expect(pages.map((page) => page.length)).toEqual([50, 11]);
  expect(pages.flat()).toEqual([
    latest.id,
    ...newestFirst(groups.tied),
    ...newestFirst(groups.history),
  ]);
});
