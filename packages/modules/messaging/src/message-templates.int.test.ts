// Authoring message templates against real Postgres: the rules a save keeps, the
// two races the table and the row lock decide, and what the database refuses on its own.
import { createHash, randomUUID } from 'node:crypto';
import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import {
  messageTemplate,
  messageTemplateList,
  permissions,
  type MessageTemplate,
  type MessageTemplateUse,
  type Permission,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
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
import {
  createTemplateCommands,
  readTemplate,
  readTemplates,
  type ReadTemplateUses,
  type TemplateOptions,
} from './message-templates.js';

let database: TestDatabase;
let db: Database;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

const guide = {
  name: 'Pricing guide',
  subject: 'Your guide, {{contact.firstName}}',
  body: 'Hi {{ contact.firstName }},\nWe cover {{contact.custom.services}}.',
};
const everythingBut = (permission: Permission): readonly Permission[] =>
  permissions.filter((each) => each !== permission);

async function fixture(options: TemplateOptions = {}, agencyId?: string) {
  const agency = agencyId === undefined ? await database.fixtures.agency() : { id: agencyId };
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const as = (granted: readonly Permission[] | 'all' = ['templates.manage']): Invocation => ({
    context: {
      ...business.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: granted === 'all' ? 'all' : new Set(granted),
  });
  const commands = createTemplateCommands(options);
  const read = (id: string, invocation: Invocation = as()): Promise<MessageTemplate> =>
    withTenant(db, invocation.context, (trx) => readTemplate(trx, invocation, id, options));
  return {
    agency,
    business,
    user,
    as,
    commands,
    read,
    create: (input: unknown = guide, invocation: Invocation = as()) =>
      runCommand(services, commands.create, input, invocation),
    update: (
      template: Pick<MessageTemplate, 'id' | 'revision'>,
      patch: Record<string, unknown> = {},
      invocation: Invocation = as(),
    ) =>
      runCommand(
        services,
        commands.update,
        { ...guide, ...patch, id: template.id, revision: template.revision },
        invocation,
      ),
    archive: (template: Pick<MessageTemplate, 'id' | 'revision'>, invocation: Invocation = as()) =>
      runCommand(
        services,
        commands.archive,
        { id: template.id, revision: template.revision },
        invocation,
      ),
    restore: (template: Pick<MessageTemplate, 'id' | 'revision'>, invocation: Invocation = as()) =>
      runCommand(
        services,
        commands.restore,
        { id: template.id, revision: template.revision },
        invocation,
      ),
    list: (
      query: { archived?: 'exclude' | 'include' | 'only'; after?: string } = {},
      invocation: Invocation = as(),
    ) =>
      withTenant(db, invocation.context, (trx) =>
        readTemplates(trx, invocation, { archived: 'exclude', ...query }),
      ),
    stored: () =>
      database.withTenant(business.context, (sql) =>
        sql.query<{ name: string; subject: string; body: string; archived: boolean }>(
          `select name, subject, body, archived_at is not null as archived
           from messaging.templates order by created_at, id`,
        ),
      ),
    events: (type: string) =>
      database.withTenant(business.context, (sql) =>
        sql.query<{ subject_kind: string; subject_id: string; payload: unknown }>(
          `select subject_kind, subject_id, payload from events.events
           where type = $1 order by recorded_at, id`,
          [type],
        ),
      ),
    audits: (command: string) =>
      database.withTenant(business.context, (sql) =>
        sql.query<{ outcome: string; error_code: string | null; input: unknown }>(
          `select outcome, error_code, input from audit.commands
           where command = $1 order by recorded_at, id`,
          [command],
        ),
      ),
  };
}

const uuidOf = (template: Pick<MessageTemplate, 'id'>): string => {
  const uuid = parsePublicId('template', template.id);
  if (uuid === undefined) throw new Error(`Not a template id: ${template.id}`);
  return uuid;
};

// A reader of what sends a template that stops the first command to reach it, after that
// command's write and before its commit, until the test lets it go.
function gate(): {
  uses: ReadTemplateUses;
  reached: Promise<undefined>;
  release: () => void;
} {
  const reached = Promise.withResolvers<undefined>();
  const held = Promise.withResolvers<undefined>();
  let calls = 0;
  return {
    uses: async () => {
      calls += 1;
      if (calls === 1) {
        reached.resolve(undefined);
        await held.promise;
      }
      return [];
    },
    reached: reached.promise,
    release: () => {
      held.resolve(undefined);
    },
  };
}

// Another role's wait events are hidden from crm_app, so the superuser watches.
const lockWaits = (): Promise<number> =>
  database.as('postgres', async (sql) => {
    const row = await sql.one<{ waiting: number }>(
      `select count(*)::int as waiting from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`,
    );
    return row.waiting;
  });

const issuesOf = (error: unknown): readonly { path: string; code: string }[] => {
  if (!(error instanceof ValidationError))
    throw new Error(`Not a validation error: ${String(error)}`);
  return error.issues.map(({ path, code }) => ({ path, code }));
};
const rejection = async (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => {
      throw new Error('Expected a refusal.');
    },
    (error: unknown) => error,
  );

it('creates a template as plain text, with its revision, merge fields, event and a body-free audit row', async () => {
  const f = await fixture();
  const marker = `only-in-the-body-${randomUUID()}`;
  const saved = messageTemplate.parse(
    await f.create({
      name: '  Pricing guide ',
      subject: ` ${guide.subject} `,
      body: `${guide.body}${marker}`,
    }),
  );
  expect(saved).toMatchObject({
    name: 'Pricing guide',
    subject: guide.subject,
    body: `${guide.body}${marker}`,
    mergeFields: ['contact.firstName', 'contact.custom.services'],
    archivedAt: null,
    canManage: true,
    // No reader of automations was given, so the answer doesn't pretend to know.
    usedBy: null,
    unfillableFields: null,
  });
  expect(saved.revision).toMatch(/^[0-9a-f]{64}$/);
  expect(saved.createdAt).toBe(saved.updatedAt);
  expect(await f.read(saved.id)).toEqual(saved);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select id, channel, created_by_kind, created_by_id from messaging.templates'),
    ),
  ).toEqual([
    { id: uuidOf(saved), channel: 'email', created_by_kind: 'user', created_by_id: f.user.id },
  ]);
  expect(await f.events('template.created')).toEqual([
    {
      subject_kind: 'template',
      subject_id: uuidOf(saved),
      payload: { name: 'Pricing guide', channel: 'email' },
    },
  ]);
  const body = `${guide.body}${marker}`;
  expect(await f.audits('template.create')).toEqual([
    {
      outcome: 'ok',
      error_code: null,
      input: {
        name: 'Pricing guide',
        subject: guide.subject,
        bodyLength: body.length,
        bodySha256: createHash('sha256').update(body).digest('hex'),
      },
    },
  ]);
  // Neither the audit log nor the event log holds the text itself.
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        `select 'audit' as place from audit.commands c where to_jsonb(c)::text like '%' || $1 || '%'
         union all
         select 'event' from events.events e where to_jsonb(e)::text like '%' || $1 || '%'`,
        [marker],
      ),
    ),
  ).toEqual([]);
});

it('keeps live names unique in a business, ignoring case and outer spaces, as a clear error on the name', async () => {
  const f = await fixture();
  const first = await f.create();
  const error = await rejection(f.create({ ...guide, name: '  pricing GUIDE ' }));
  expect(error).toBeInstanceOf(ValidationError);
  expect(issuesOf(error)).toEqual([{ path: '/name', code: 'taken' }]);
  expect(String(error)).toContain('A template is already named "pricing GUIDE"');
  expect(await f.stored()).toEqual([{ ...guide, archived: false }]);
  expect((await f.audits('template.create')).map((row) => [row.outcome, row.error_code])).toEqual([
    ['ok', null],
    ['invalid', 'validation'],
  ]);
  // A rename runs into the same rule, and changes nothing.
  const other = await f.create({ ...guide, name: 'Welcome' });
  expect(issuesOf(await rejection(f.update(other, { name: 'PRICING guide' })))).toEqual([
    { path: '/name', code: 'taken' },
  ]);
  expect((await f.read(other.id)).revision).toBe(other.revision);
  // Changing only the case of its own name isn't a clash with itself.
  expect((await f.update(first, { name: 'PRICING GUIDE' })).name).toBe('PRICING GUIDE');
  // Another business has its own names.
  const elsewhere = await fixture({}, f.agency.id);
  expect((await elsewhere.create()).name).toBe('Pricing guide');
});

it('lets exactly one of two overlapping creates take a name', async () => {
  const gated = gate();
  const f = await fixture({ uses: gated.uses });
  const first = f.create();
  await gated.reached;
  // The first has inserted and not committed, so the second waits on the unique index.
  const second = f.create({ ...guide, name: ' PRICING GUIDE', body: 'The other one.' });
  try {
    await expect.poll(lockWaits, { timeout: 10_000, interval: 50 }).toBe(1);
  } finally {
    gated.release();
  }
  const [won, lost] = await Promise.allSettled([first, second]);
  expect(won).toMatchObject({ status: 'fulfilled', value: { name: 'Pricing guide' } });
  expect(lost.status).toBe('rejected');
  expect(issuesOf(lost.status === 'rejected' ? lost.reason : undefined)).toEqual([
    { path: '/name', code: 'taken' },
  ]);
  expect(await f.stored()).toEqual([{ ...guide, archived: false }]);
});

it('edits a template, moving its revision and saying what changed without copying the text', async () => {
  const f = await fixture();
  const saved = await f.create();
  const edited = messageTemplate.parse(
    await f.update(saved, { name: 'Price list', body: 'Hello {{contact.lastName}}' }),
  );
  expect(edited).toMatchObject({
    id: saved.id,
    name: 'Price list',
    subject: guide.subject,
    body: 'Hello {{contact.lastName}}',
    mergeFields: ['contact.firstName', 'contact.lastName'],
    createdAt: saved.createdAt,
  });
  expect(edited.revision).not.toBe(saved.revision);
  expect(Date.parse(edited.updatedAt)).toBeGreaterThanOrEqual(Date.parse(saved.updatedAt));
  // The table's trigger stamps each save.
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.one('select updated_at > created_at as moved from messaging.templates'),
    ),
  ).toEqual({ moved: true });
  expect(await f.events('template.updated')).toEqual([
    {
      subject_kind: 'template',
      subject_id: uuidOf(saved),
      payload: {
        name: 'Price list',
        previousName: 'Pricing guide',
        subjectChanged: false,
        bodyChanged: true,
      },
    },
  ]);
  expect(await f.audits('template.update')).toEqual([
    {
      outcome: 'ok',
      error_code: null,
      input: {
        id: saved.id,
        revision: saved.revision,
        name: 'Price list',
        subject: guide.subject,
        bodyLength: 'Hello {{contact.lastName}}'.length,
        bodySha256: createHash('sha256').update('Hello {{contact.lastName}}').digest('hex'),
      },
    },
  ]);
  // Saving what is already stored is no change: the same revision, and no second event.
  const again = await f.update(edited, { name: 'Price list', body: 'Hello {{contact.lastName}}' });
  expect(again).toEqual(edited);
  expect(await f.events('template.updated')).toHaveLength(1);
  // Each real save moves the revision, even back to text it held before.
  const back = await f.update(edited, { name: 'Price list', body: guide.body });
  const forth = await f.update(back, { name: 'Price list', body: 'Hello {{contact.lastName}}' });
  expect(new Set([saved.revision, edited.revision, back.revision, forth.revision]).size).toBe(4);
});

it('refuses a stale save with a conflict that changes nothing', async () => {
  const f = await fixture();
  const opened = await f.create();
  const theirs = await f.update(opened, { subject: 'Their subject' });
  const before = await f.stored();
  for (const attempt of [
    () => f.update(opened, { subject: 'My subject' }),
    () => f.archive(opened),
    () => f.restore(opened),
    () => f.update({ id: opened.id, revision: 'f'.repeat(64) }, { subject: 'My subject' }),
  ])
    expect(await rejection(attempt())).toBeInstanceOf(ConflictError);
  expect(await f.stored()).toEqual(before);
  expect(await f.read(opened.id)).toEqual(theirs);
  expect(await f.events('template.updated')).toHaveLength(1);
  expect(await f.events('template.archived')).toEqual([]);
  expect((await f.audits('template.update')).map((row) => [row.outcome, row.error_code])).toEqual([
    ['ok', null],
    ['failed', 'conflict'],
    ['failed', 'conflict'],
  ]);
  // With the revision it has now, the same edit goes through.
  expect((await f.update(theirs, { subject: 'My subject' })).subject).toBe('My subject');
});

it('applies exactly one of two overlapping saves made from the same revision', async () => {
  const setup = await fixture();
  const opened = await setup.create();
  const gated = gate();
  const commands = createTemplateCommands({ uses: gated.uses });
  const save = (subject: string) =>
    runCommand(
      services,
      commands.update,
      { ...guide, subject, id: opened.id, revision: opened.revision },
      setup.as(),
    );
  const first = save('First');
  await gated.reached;
  // The first has written and holds the row, so the second waits before it can compare.
  const second = save('Second');
  try {
    await expect.poll(lockWaits, { timeout: 10_000, interval: 50 }).toBe(1);
  } finally {
    gated.release();
  }
  const [won, lost] = await Promise.allSettled([first, second]);
  expect(won).toMatchObject({ status: 'fulfilled', value: { subject: 'First' } });
  expect(lost.status).toBe('rejected');
  expect(lost.status === 'rejected' && lost.reason).toBeInstanceOf(ConflictError);
  expect(await setup.stored()).toEqual([{ ...guide, subject: 'First', archived: false }]);
  expect(await setup.events('template.updated')).toHaveLength(1);
});

it('archives instead of deleting: no edits, out of the list, its name free, and restored only if the name still is', async () => {
  const f = await fixture();
  const saved = await f.create();
  const archived = messageTemplate.parse(await f.archive(saved));
  expect(archived.archivedAt).not.toBeNull();
  expect(archived.revision).not.toBe(saved.revision);
  expect(archived).toMatchObject({ id: saved.id, name: guide.name, body: guide.body });
  expect(await f.read(saved.id)).toEqual(archived);
  expect(await f.events('template.archived')).toEqual([
    {
      subject_kind: 'template',
      subject_id: uuidOf(saved),
      payload: { name: guide.name, automations: null },
    },
  ]);
  // Archiving what is archived, from its current revision, is no change.
  expect(await f.archive(archived)).toEqual(archived);
  expect(await f.events('template.archived')).toHaveLength(1);

  // It can't be edited while archived, even from its current revision.
  const edit = await rejection(f.update(archived, { subject: 'New subject' }));
  expect(edit).toBeInstanceOf(ConflictError);
  expect(String(edit)).toContain('archived');
  expect(await f.stored()).toEqual([{ ...guide, archived: true }]);

  // It's listed only when asked for.
  const ids = async (archivedFilter?: 'exclude' | 'include' | 'only') =>
    (await f.list(archivedFilter === undefined ? {} : { archived: archivedFilter })).items.map(
      (item) => item.id,
    );
  expect(await ids()).toEqual([]);
  expect(await ids('exclude')).toEqual([]);
  expect(await ids('only')).toEqual([saved.id]);
  expect(await ids('include')).toEqual([saved.id]);

  // Its name is free again, so a new template can take it.
  const replacement = await f.create({ ...guide, body: 'The new one.' });
  expect(await ids()).toEqual([replacement.id]);
  expect(await ids('only')).toEqual([saved.id]);
  expect((await ids('include')).sort()).toEqual([saved.id, replacement.id].sort());

  // Restoring would make two live templates with one name, so it's refused as a whole.
  const refused = await rejection(f.restore(archived));
  expect(refused).toBeInstanceOf(ValidationError);
  expect(issuesOf(refused)).toEqual([{ path: '', code: 'taken' }]);
  expect(String(refused)).toContain('Rename or archive that one');
  expect(await f.read(saved.id)).toEqual(archived);
  expect(await f.events('template.restored')).toEqual([]);

  // Once the name is free, it comes back, editable, under a new revision.
  await f.update(replacement, { name: 'Price list', body: 'The new one.' });
  const restored = messageTemplate.parse(await f.restore(archived));
  expect(restored).toMatchObject({ id: saved.id, name: guide.name, archivedAt: null });
  expect(new Set([saved.revision, archived.revision, restored.revision]).size).toBe(3);
  expect(await f.events('template.restored')).toEqual([
    {
      subject_kind: 'template',
      subject_id: uuidOf(saved),
      payload: { name: guide.name, from: 'archived' },
    },
  ]);
  expect(await f.restore(restored)).toEqual(restored);
  expect(await f.events('template.restored')).toHaveLength(1);
  expect((await f.update(restored, { subject: 'Edited again' })).subject).toBe('Edited again');
});

it('refuses a subject with a line break and text out of bounds, in the command and again in the database', async () => {
  const f = await fixture();
  const saved = await f.create();
  for (const [field, value] of [
    ['subject', 'Hello\r\nBcc: victim@example.test'],
    ['subject', 'Hello\nthere'],
    ['subject', 'Hello\rthere'],
    ['subject', 's'.repeat(256)],
    ['subject', '   '],
    ['body', ''],
    ['body', 'b'.repeat(100_001)],
    ['name', '  '],
    ['name', 'n'.repeat(121)],
  ] as const) {
    for (const attempt of [
      () => f.create({ ...guide, name: 'Another', [field]: value }),
      () => f.update(saved, { [field]: value }),
    ]) {
      const error = await rejection(attempt());
      expect(error, `${field}: ${value.slice(0, 20)}`).toBeInstanceOf(ValidationError);
      expect(issuesOf(error).map((issue) => issue.path)).toEqual([`/${field}`]);
    }
  }
  expect(
    await rejection(f.create({ ...guide, name: 'With HTML', bodyHtml: '<p>Hello</p>' })),
  ).toBeInstanceOf(ValidationError);
  expect(await f.stored()).toEqual([{ ...guide, archived: false }]);
  // The longest text the contract takes is text the database takes.
  const longest = await f.create({
    name: 'n'.repeat(120),
    subject: 's'.repeat(255),
    body: 'b'.repeat(100_000),
  });
  expect(longest.body).toHaveLength(100_000);

  // With the command bypassed, the table still refuses each one by its named constraint.
  const insert = (name: string, subject: string, body: string) =>
    database.withTenant(f.business.context, (sql) =>
      sql.query(
        `insert into messaging.templates (business_id, name, subject, body, created_by_kind)
         values (app.business_id(), $1, $2, $3, 'user')`,
        [name, subject, body],
      ),
    );
  const change = (column: 'name' | 'subject' | 'body', value: string) =>
    database.withTenant(f.business.context, (sql) =>
      sql.query(`update messaging.templates set ${column} = $1 where id = $2`, [
        value,
        uuidOf(saved),
      ]),
    );
  for (const [attempt, constraint] of [
    [
      () => insert('Direct', 'Hello\r\nBcc: victim@example.test', 'Body'),
      'templates_subject_valid',
    ],
    [() => insert('Direct', 'Hello\nthere', 'Body'), 'templates_subject_valid'],
    [() => insert('Direct', 's'.repeat(256), 'Body'), 'templates_subject_valid'],
    [() => insert('Direct', '', 'Body'), 'templates_subject_valid'],
    [() => insert('Direct', 'Subject', ''), 'templates_body_length'],
    [() => insert('Direct', 'Subject', 'b'.repeat(100_001)), 'templates_body_length'],
    [() => insert('   ', 'Subject', 'Body'), 'templates_name_length'],
    [() => change('subject', 'Hello\rthere'), 'templates_subject_valid'],
    [() => change('body', ''), 'templates_body_length'],
    [() => change('name', 'n'.repeat(121)), 'templates_name_length'],
  ] as const)
    await expect(attempt(), constraint).rejects.toMatchObject({ code: '23514', constraint });
  await expect(insert(' PRICING guide ', 'Subject', 'Body')).rejects.toMatchObject({
    code: '23505',
    constraint: 'templates_name_unique',
  });
  // And nothing the API runs as can delete one: archiving is the only way out.
  await expect(
    database.withTenant(f.business.context, (sql) =>
      sql.query('delete from messaging.templates where id = $1', [uuidOf(saved)]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  expect((await f.read(saved.id)).revision).toBe(saved.revision);
});

it("keeps another business out: it can't read, list, page from or change a template, and learns nothing", async () => {
  const ours = await fixture();
  const theirs = await fixture({}, ours.agency.id);
  const stranger = await fixture();
  const saved = await ours.create();
  const missing = toPublicId('template', '01900000-0000-7000-8000-000000000001');
  for (const other of [theirs, stranger]) {
    const invocation = other.as('all');
    const attempts = (id: string) => [
      other.read(id, invocation),
      other.update({ id, revision: saved.revision }, { subject: 'Taken over' }, invocation),
      other.archive({ id, revision: saved.revision }, invocation),
      other.restore({ id, revision: saved.revision }, invocation),
    ];
    const refusals = await Promise.all(attempts(saved.id).map(rejection));
    const unknown = await Promise.all(attempts(missing).map(rejection));
    for (const [at, error] of refusals.entries()) {
      expect(error).toBeInstanceOf(NotFoundError);
      // Exactly what a template that never existed answers, apart from the id asked for.
      expect(String(error).replaceAll(saved.id, missing)).toBe(String(unknown[at]));
      expect(String(error)).not.toContain(guide.name);
    }
    expect(await other.list({ archived: 'include' }, invocation)).toEqual({
      canManage: true,
      items: [],
      nextCursor: null,
      // Not even how many there are elsewhere.
      total: 0,
    });
    const paging = await rejection(other.list({ after: saved.id }, invocation));
    expect(issuesOf(paging)).toEqual([{ path: '/after', code: 'unknown_template' }]);
    expect(issuesOf(await rejection(other.list({ after: missing }, invocation)))).toEqual(
      issuesOf(paging),
    );
    // Its own template of the same name is a different one.
    expect((await other.create()).id).not.toBe(saved.id);
  }
  expect(await ours.read(saved.id)).toEqual(saved);
  expect(await ours.stored()).toEqual([{ ...guide, archived: false }]);
  expect(await ours.events('template.updated')).toEqual([]);
  expect(await ours.events('template.archived')).toEqual([]);
});

it('lets any member read, and only templates.manage change anything', async () => {
  const f = await fixture();
  const saved = await f.create();
  // Every permission but the one that counts.
  const viewer = f.as(everythingBut('templates.manage'));
  expect(await f.read(saved.id, viewer)).toEqual({ ...saved, canManage: false });
  expect(await f.read(saved.id, f.as([]))).toEqual({ ...saved, canManage: false });
  expect(await f.list({}, viewer)).toMatchObject({ canManage: false, items: [{ id: saved.id }] });
  expect(await f.list({}, f.as('all'))).toMatchObject({ canManage: true });
  for (const attempt of [
    () => f.create({ ...guide, name: 'Denied' }, viewer),
    () => f.update(saved, { subject: 'Denied' }, viewer),
    () => f.archive(saved, viewer),
    () => f.restore(saved, viewer),
  ]) {
    const error = await rejection(attempt());
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({ permission: 'templates.manage' });
  }
  expect(await f.stored()).toEqual([{ ...guide, archived: false }]);
  for (const command of ['template.update', 'template.archive', 'template.restore'])
    expect((await f.audits(command)).map((row) => [row.outcome, row.error_code])).toEqual([
      ['denied', 'forbidden'],
    ]);
  // The permission alone is enough.
  expect((await f.update(saved, { subject: 'Allowed' }, f.as(['templates.manage']))).subject).toBe(
    'Allowed',
  );
});

it('works only inside a business', async () => {
  const f = await fixture();
  const saved = await f.create();
  const { businessId: _businessId, ...agencyContext } = f.as().context;
  const agency: Invocation = { ...f.as('all'), context: agencyContext };
  for (const attempt of [
    () => f.create(guide, agency),
    () => f.update(saved, {}, agency),
    () => f.archive(saved, agency),
    () => f.restore(saved, agency),
    () => f.read(saved.id, agency),
    () => f.list({}, agency),
  ])
    expect(issuesOf(await rejection(attempt()))).toEqual([{ path: '', code: 'business_required' }]);
});

it('lists templates by name, a page at a time, without their bodies', async () => {
  const f = await fixture();
  const names = ['delta', 'Alpha', 'charlie', 'Bravo'];
  const saved = new Map<string, MessageTemplate>();
  for (const name of names) saved.set(name, await f.create({ ...guide, name }));
  const first = messageTemplateList.parse(await f.list());
  expect(first.items.map((item) => item.name)).toEqual(['Alpha', 'Bravo', 'charlie', 'delta']);
  expect(first).toMatchObject({ canManage: true, nextCursor: null, total: 4 });
  for (const item of first.items) {
    const full = saved.get(item.name);
    expect(item).not.toHaveProperty('body');
    expect(item).not.toHaveProperty('mergeFields');
    // The revision a list gives is the one a save of that template needs.
    expect(item).toEqual({
      id: full?.id,
      name: full?.name,
      subject: full?.subject,
      createdAt: full?.createdAt,
      updatedAt: full?.updatedAt,
      archivedAt: null,
      deletedAt: null,
      revision: full?.revision,
      // What a picker shows beside the name.
      format: 'text',
      preheader: null,
      folder: null,
      preview: full?.preview,
      // Nobody told this reader what workflows use: it says it cannot tell.
      workflowUses: null,
    });
  }
  // Fifty to a page; the cursor is the last template of the page before.
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      `insert into messaging.templates (business_id, name, subject, body, created_by_kind)
       select app.business_id(), 'Echo ' || lpad(n::text, 3, '0'), 'Subject', 'Body', 'user'
       from generate_series(1, 60) as n`,
    ),
  );
  const pageOne = await f.list();
  expect(pageOne.items).toHaveLength(50);
  expect(pageOne.items.slice(0, 4).map((item) => item.name)).toEqual([
    'Alpha',
    'Bravo',
    'charlie',
    'delta',
  ]);
  expect(pageOne.nextCursor).toBe(pageOne.items.at(-1)?.id);
  const pageTwo = await f.list({ after: pageOne.nextCursor ?? '' });
  expect(pageTwo.items.map((item) => item.name)).toEqual(
    Array.from({ length: 14 }, (_, at) => `Echo ${String(at + 47).padStart(3, '0')}`),
  );
  expect(pageTwo.nextCursor).toBeNull();
  // An archived template still marks a place, and archived ones may share a name.
  const cursor = pageOne.items.at(-1);
  if (cursor === undefined) throw new Error('Expected a first page.');
  await f.archive(cursor);
  expect((await f.list({ after: cursor.id })).items).toEqual(pageTwo.items);
  const twin = await f.create({ ...guide, name: cursor.name });
  await f.archive(twin);
  const archivedOnly = await f.list({ archived: 'only' });
  // Both are named alike, so the older id comes first.
  expect(archivedOnly.items.map((item) => item.id)).toEqual([cursor.id, twin.id]);
  expect(
    (await f.list({ archived: 'only', after: archivedOnly.items[0]?.id ?? '' })).items.map(
      (item) => item.id,
    ),
  ).toEqual([archivedOnly.items[1]?.id]);
});

it('refuses ids that are not template ids before it looks anything up', async () => {
  const f = await fixture();
  const invocation = f.as();
  await expect(f.read('con_01h455vb4pex5vsknk084sn02q')).rejects.toBeInstanceOf(NotFoundError);
  await expect(f.read('nonsense')).rejects.toBeInstanceOf(NotFoundError);
  expect(
    issuesOf(
      await rejection(
        withTenant(db, invocation.context, (trx) =>
          readTemplates(trx, invocation, { archived: 'exclude', after: 'nonsense' }),
        ),
      ),
    ),
  ).toEqual([{ path: '/after', code: 'unknown_template' }]);
});

it('says which automations send a template, and refuses to archive it while they do', async () => {
  const uses: MessageTemplateUse[] = [
    {
      id: toPublicId('automation', '01900000-0000-7000-8000-00000000000a'),
      name: 'Welcome',
      status: 'active',
    },
    {
      id: toPublicId('automation', '01900000-0000-7000-8000-00000000000b'),
      name: 'Win back',
      status: 'paused',
    },
  ];
  const asked: { template: string; businessId: string | undefined }[] = [];
  const f = await fixture({
    uses: (_trx, context, template) => {
      asked.push({ template, businessId: context.businessId });
      return Promise.resolve([...uses]);
    },
  });
  const saved = messageTemplate.parse(await f.create());
  expect(saved.usedBy).toEqual(uses);
  expect((await f.read(saved.id)).usedBy).toEqual(uses);
  expect((await f.update(saved, { subject: 'Edited' })).usedBy).toEqual(uses);
  const current = await f.read(saved.id);
  // Archived, every send of those workflows would fail: it stays live, and says why.
  const refused = await f.archive(current).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(ConflictError);
  expect(refused instanceof Error ? refused.message : '').toBe(
    '"Welcome" and "Win back" send this template. Take it out of their Send email step, then archive it.',
  );
  expect((await f.read(saved.id)).archivedAt).toBeNull();
  expect(await f.events('template.archived')).toEqual([]);
  // Once nothing sends it, it archives.
  uses.length = 0;
  const archived = messageTemplate.parse(await f.archive(current));
  expect(archived.archivedAt).not.toBeNull();
  expect(archived.usedBy).toEqual([]);
  expect(await f.events('template.archived')).toEqual([
    {
      subject_kind: 'template',
      subject_id: uuidOf(saved),
      payload: { name: guide.name, automations: [] },
    },
  ]);
  // The reader is asked in the caller's business, by the template's public id.
  expect(new Set(asked.map((each) => each.template))).toEqual(new Set([saved.id]));
  expect(new Set(asked.map((each) => each.businessId))).toEqual(new Set([f.business.id]));
  // A list asks nothing: it would be one question per row.
  const before = asked.length;
  await f.list({ archived: 'include' });
  expect(asked).toHaveLength(before);
});

it('is what automations read: listed for setup once created, sent as edited, gone once archived', async () => {
  const f = await fixture();
  // The two reads automations make (setup.ts and actions-email.ts), as SQL.
  const forSetup = () =>
    database.withTenant(f.business.context, (sql) =>
      sql.query<{ id: string; name: string }>(
        `select id, name from messaging.templates
         where channel = 'email' and archived_at is null order by name`,
      ),
    );
  const forSending = (id: string) =>
    database.withTenant(f.business.context, (sql) =>
      sql.query<{ subject: string; body: string }>(
        `select subject, body from messaging.templates
         where id = $1 and channel = 'email' and archived_at is null`,
        [id],
      ),
    );
  expect(await forSetup()).toEqual([]);
  const saved = await f.create();
  expect(await forSetup()).toEqual([{ id: uuidOf(saved), name: guide.name }]);
  const renamed = await f.update(saved, { name: 'Price list', body: 'New text' });
  // The id an automation holds survives the rename, and it sends the new text.
  expect(renamed.id).toBe(saved.id);
  expect(await forSetup()).toEqual([{ id: uuidOf(saved), name: 'Price list' }]);
  expect(await forSending(uuidOf(saved))).toEqual([{ subject: guide.subject, body: 'New text' }]);
  const archived = await f.archive(renamed);
  expect(await forSetup()).toEqual([]);
  expect(await forSending(uuidOf(saved))).toEqual([]);
  await f.restore(archived);
  expect(await forSending(uuidOf(saved))).toEqual([{ subject: guide.subject, body: 'New text' }]);
});

it('saves a template that uses fields no send can fill in, and names them in every answer', async () => {
  let asked = 0;
  const f = await fixture({
    fields: (_trx, context) => {
      asked += 1;
      expect(context.businessId).toBe(f.business.id);
      return Promise.resolve(['contact.firstName', 'contact.custom.services']);
    },
  });
  // Nothing is refused: the author is told, and so is every other client.
  const saved = messageTemplate.parse(
    await f.create({
      name: 'Reel',
      subject: 'For {{contact.firstName}} {{contact.firstname}}',
      body: '{{values.sample_reel_url}} {{contact.custom.services}} {{deal.name}} {{contact.firstname}}',
    }),
  );
  expect(saved.mergeFields).toEqual([
    'contact.firstName',
    'contact.firstname',
    'values.sample_reel_url',
    'contact.custom.services',
    'deal.name',
  ]);
  expect(saved.unfillableFields).toEqual([
    'contact.firstname',
    'values.sample_reel_url',
    'deal.name',
  ]);
  expect((await f.read(saved.id)).unfillableFields).toEqual(saved.unfillableFields);
  const fixed = await f.update(saved, {
    name: 'Reel',
    subject: 'For {{contact.firstName}}',
    body: 'We cover {{contact.custom.services}}.',
  });
  expect(fixed.unfillableFields).toEqual([]);
  expect((await f.archive(fixed)).unfillableFields).toEqual([]);
  // Text with no merge fields has nothing to check, so the reader isn't asked.
  const before = asked;
  const plain = await f.create({ name: 'Plain', subject: 'Hello', body: 'No fields here.' });
  expect(plain).toMatchObject({ mergeFields: [], unfillableFields: [] });
  expect(asked).toBe(before);
});
