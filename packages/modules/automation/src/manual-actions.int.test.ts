// Manual actions against real Postgres: a manual step leaves an action in the queue and its
// run waits there; completing or skipping the action lets the run go on, and a run that
// ends another way takes its action off the queue. Also the "Trigger link clicked" trigger,
// from a real click. Real events, through runCommand.
import { randomInt, randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import {
  automationDocument,
  manualAction,
  manualActionList,
  permissions,
  type AutomationDocumentInput,
  type ManualAction,
  type Permission,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { issueTriggerLinkAddresses, openTriggerLink } from '@repo/module-messaging';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  cancelRuns,
  contactValues,
  createManualActionCommands,
  createRunStepCommand,
  matchEvent,
  publishAutomationVersion,
  readManualAction,
  readManualActions,
  type ManualActionOptions,
} from './index.js';

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

const everythingBut = (...denied: Permission[]): readonly Permission[] =>
  permissions.filter((each) => !denied.includes(each));

const calling: AutomationDocumentInput = {
  name: 'Call new leads',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'call',
  steps: {
    call: {
      type: 'manual.call',
      config: { notes: 'Ask {{contact.firstName}} about the quote' },
      next: 'after',
    },
    after: { type: 'wait', config: { duration: 'PT1M' } },
  },
};

/**
 * A business with a team of two (Mia and Sam; `me` is whoever the invocation is), an
 * automation, and contacts that enrol in it when created.
 */
async function scene(document: AutomationDocumentInput = calling) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context: TenantContext = { ...business.context, correlationId: randomUUID() };
  const mia = await database.fixtures.user();
  const sam = await database.fixtures.user();
  // Tenancy's part, stood in for: a membership id is the user's id as a public id.
  const team = new Map([
    [mia.id, toPublicId('membership', mia.id)],
    [sam.id, toPublicId('membership', sam.id)],
  ]);
  const options: ManualActionOptions = {
    actorNames: {
      user: (_trx, ids) =>
        Promise.resolve(
          new Map(ids.map((id) => [id, id === mia.id ? 'Mia' : id === sam.id ? 'Sam' : 'Other'])),
        ),
    },
    assignees: {
      resolve: (_trx, invocationContext, selection) => {
        if (selection === null) return Promise.resolve(null);
        if (selection === 'me') return Promise.resolve(invocationContext.userId ?? null);
        const found = [...team].find(([, membership]) => membership === selection);
        if (found === undefined)
          throw new ValidationError([
            { path: '/assignee', code: 'invalid_assignee', message: 'Choose a team member.' },
          ]);
        return Promise.resolve(found[0]);
      },
      read: () => Promise.resolve({ items: [], nextCursor: null }),
      memberships: (_trx, _context, userIds) =>
        Promise.resolve(
          new Map(userIds.flatMap((id) => (team.has(id) ? [[id, team.get(id) ?? '']] : []))),
        ),
    },
  };
  const runStep = createRunStepCommand({ tasks: options, publicUrl: 'https://crm.example' });
  const as = (
    user: { id: string } = mia,
    granted: readonly Permission[] | 'all' = 'all',
  ): Invocation => ({
    context: {
      ...context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: granted === 'all' ? 'all' : new Set(granted),
  });
  const automationId = await withTenant(db, context, async (trx) => {
    const { id } = await trx
      .insertInto('automation.automations')
      .values({
        business_id: business.id,
        name: document.name,
        draft: JSON.stringify(document),
        created_by_kind: 'system',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await publishAutomationVersion(trx, context, id, automationDocument.parse(document), 'v1');
    return id;
  });
  const sql = <T extends object>(text: string, values: unknown[] = []) =>
    database.withTenant(context, (client) => client.query<T>(text, values));
  const enrolment = async (id: string) => {
    const [row] = await sql<{
      status: string;
      current_step: string | null;
      wake_at: Date | null;
      state: { sequence: number; manual?: unknown };
      exit_reason: string | null;
    }>(
      `select status, current_step, wake_at, state, exit_reason from automation.enrolments
       where id = $1`,
      [id],
    );
    if (row === undefined) throw new Error('No such run.');
    return row;
  };
  const step = async (enrolmentId: string, sequence?: number) =>
    runCommand(
      services,
      runStep,
      { enrolmentId, sequence: sequence ?? (await enrolment(enrolmentId)).state.sequence },
      { context, permissions: 'all' },
    );
  /** Creates a contact, which enrols it; `owner` makes that person the contact's owner. */
  const lead = async (
    as_: { firstName?: string; phone?: boolean; owner?: string; run?: boolean } = {},
  ) => {
    await runCommand(
      services,
      createContactCommand,
      {
        firstName: as_.firstName ?? 'Ada',
        emails: [`${randomUUID()}@example.test`],
        ...(as_.phone === false
          ? {}
          : {
              phones: [
                `+1202${String(randomInt(2, 10))}${String(randomInt(20, 100))}${String(randomInt(0, 10_000)).padStart(4, '0')}`,
              ],
            }),
      },
      { context, permissions: 'all' },
    );
    const event = await withTenant(db, context, (trx) =>
      trx
        .selectFrom('events.events')
        .select(['id', 'subject_id'])
        .where('type', '=', 'contact.created')
        .orderBy('recorded_at', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow(),
    );
    if (as_.owner !== undefined)
      await database.as('postgres', (client) =>
        client.query(`update crm.contacts set owner_user_id = $1 where id = $2`, [
          as_.owner,
          event.subject_id,
        ]),
      );
    const enrolmentId = await withTenant(db, context, async (trx) => {
      const [first] = (await matchEvent(trx, context, event.id, contactValues)).enrolled;
      return first?.enrolmentId ?? '';
    });
    if (as_.run !== false && enrolmentId !== '') await step(enrolmentId);
    return { contactId: event.subject_id, enrolmentId };
  };
  const commands = (permission: 'conversations.manage' | 'conversations.reply') =>
    createManualActionCommands(options, permission);
  const list = (query: Record<string, unknown> = {}, invocation = as()) =>
    withTenant(db, invocation.context, (trx) =>
      readManualActions(
        trx,
        invocation,
        { status: 'pending', assignee: 'anyone', limit: 20, ...query },
        options,
      ),
    );
  const only = async (): Promise<ManualAction> => {
    const { items } = await list({ status: 'all' });
    if (items.length !== 1 || items[0] === undefined)
      throw new Error(`Expected one action, found ${String(items.length)}.`);
    return items[0];
  };
  const close =
    (which: 'complete' | 'skip') =>
    (action: Pick<ManualAction, 'id' | 'revision'>, invocation = as()) =>
      runCommand(
        services,
        commands('conversations.manage')[which],
        { actionId: action.id, revision: action.revision },
        invocation,
      );
  return {
    business,
    context,
    automationId,
    mia,
    sam,
    team,
    as,
    sql,
    enrolment,
    step,
    lead,
    list,
    only,
    read: (actionId: string, invocation = as()) =>
      withTenant(db, invocation.context, (trx) =>
        readManualAction(trx, invocation, actionId, options),
      ),
    complete: close('complete'),
    skip: close('skip'),
    assign: (
      action: Pick<ManualAction, 'id' | 'revision'>,
      assignee: string | null,
      invocation = as(),
      permission: 'conversations.manage' | 'conversations.reply' = 'conversations.manage',
    ) =>
      runCommand(
        services,
        commands(permission).assign,
        { actionId: action.id, revision: action.revision, assignee },
        invocation,
      ),
    stepRuns: (enrolmentId: string) =>
      sql<{ step_key: string; status: string; output: Record<string, unknown>; resumes: boolean }>(
        `select step_key, status, output, resumes from automation.step_runs
         where enrolment_id = $1 order by started_at, id`,
        [enrolmentId],
      ),
    events: (type: string) =>
      sql<{ subject_kind: string; payload: Record<string, unknown> }>(
        `select subject_kind, payload from events.events where type = $1 order by recorded_at, id`,
        [type],
      ),
    /** The sequence the run's one queued step job carries: the visit it would run. */
    queuedVisit: async (enrolmentId: string) =>
      (
        await database.as('crm_owner', (client) =>
          client.query<{ sequence: number }>(
            `select (payload -> 'data' ->> 'sequence')::int as sequence
             from graphile_worker._private_jobs where key = 'automation-enrolment:' || $1::text`,
            [enrolmentId],
          ),
        )
      ).map((job) => job.sequence),
  };
}

describe('a manual step', () => {
  it('puts a call in the queue, filled in for the contact, and leaves the run waiting with no timeout', async () => {
    const s = await scene();
    const { contactId, enrolmentId } = await s.lead();
    const action = manualAction.parse(await s.only());
    expect(action).toMatchObject({
      type: 'call',
      status: 'pending',
      body: 'Ask Ada about the quote',
      contact: { id: toPublicId('contact', contactId), name: 'Ada', trashed: false },
      automation: { id: toPublicId('automation', s.automationId), name: 'Call new leads' },
      runId: toPublicId('automation_enrolment', enrolmentId),
      assignee: null,
      closedAt: null,
      closedBy: null,
    });
    expect(action.contact.phone).toMatch(/^\+1202\d{7}$/);
    expect(await s.enrolment(enrolmentId)).toMatchObject({
      status: 'waiting',
      current_step: 'call',
      wake_at: null,
      state: { sequence: 1, manual: { step: 'call' } },
    });
    expect(await s.stepRuns(enrolmentId)).toEqual([
      {
        step_key: 'call',
        status: 'waiting',
        output: { manualActionId: action.id },
        resumes: false,
      },
    ]);
    expect(await s.events('manual_action.created')).toEqual([
      {
        subject_kind: 'manual_action',
        payload: { type: 'call', automationId: toPublicId('automation', s.automationId) },
      },
    ]);
  });

  it('does nothing when its job runs again while the action is still open', async () => {
    const s = await scene();
    const { enrolmentId } = await s.lead();
    const before = await s.enrolment(enrolmentId);
    expect(await s.step(enrolmentId)).toBe('skipped');
    // A job of the visit that queued the action is older than the wait, and is skipped too.
    expect(await s.step(enrolmentId, 0)).toBe('skipped');
    expect(await s.enrolment(enrolmentId)).toEqual(before);
    expect((await s.list()).total).toBe(1);
  });

  it('goes to the contact’s owner when they are on the team, or to whoever the step names', async () => {
    const s = await scene();
    await s.lead({ owner: s.sam.id });
    expect((await s.only()).assignee).toEqual({
      membershipId: s.team.get(s.sam.id),
      name: 'Sam',
      you: false,
    });
    // An owner who has left the team gets nothing: the action is for anyone.
    const gone = await database.fixtures.user();
    const left = await scene();
    await left.lead({ owner: gone.id });
    expect((await left.only()).assignee).toBeNull();
    // The step's own choice comes before the owner; someone it names who left falls back.
    const named = await scene({
      ...calling,
      steps: {
        ...calling.steps,
        call: { type: 'manual.call', config: { user: 'placeholder' }, next: 'after' },
      },
    });
    const withUser = (user: string) =>
      database.as('postgres', (client) =>
        client.query(
          `update automation.versions
           set document = jsonb_set(document, '{steps,call,config,user}', to_jsonb($1::text))
           where automation_id = $2`,
          [user, named.automationId],
        ),
      );
    await withUser(named.team.get(named.mia.id) ?? '');
    await named.lead({ owner: named.sam.id, firstName: 'One' });
    await withUser(toPublicId('membership', gone.id));
    await named.lead({ owner: named.sam.id, firstName: 'Two' });
    const { items } = await named.list();
    expect(items.map((item) => [item.contact.name, item.assignee?.name, item.body])).toEqual([
      ['One', 'Mia', ''],
      ['Two', 'Sam', ''],
    ]);
    expect(items[0]?.assignee?.you).toBe(true);
  });

  it('fails, leaving nothing in the queue, for a contact it cannot be done for', async () => {
    const s = await scene();
    const noPhone = await s.lead({ phone: false });
    expect(await s.enrolment(noPhone.enrolmentId)).toMatchObject({
      status: 'failed',
      exit_reason: 'no_phone_number',
    });
    const unnamed = await scene({
      ...calling,
      steps: {
        call: { type: 'manual.sms', config: { message: 'Hi {{contact.lastName}}' } },
      },
    });
    const { enrolmentId } = await unnamed.lead();
    expect(await unnamed.enrolment(enrolmentId)).toMatchObject({
      status: 'failed',
      exit_reason: 'missing_values',
    });
    expect((await s.list({ status: 'all' })).total).toBe(0);
    expect((await unnamed.list({ status: 'all' })).total).toBe(0);
  });

  it('writes a text to send by hand, with the contact’s own address for a trigger link', async () => {
    const s = await scene({
      ...calling,
      steps: {
        call: {
          type: 'manual.sms',
          config: { message: 'Hi {{contact.firstName}}: {{trigger_link.offer}}' },
        },
      },
    });
    await s.sql(
      `insert into messaging.trigger_links (business_id, name, key, url, created_by_kind)
       values (app.business_id(), 'Offer', 'offer', 'https://harbor.example/offer', 'user')`,
    );
    await s.lead();
    const action = await s.only();
    expect(action.type).toBe('sms');
    expect(action.body).toMatch(/^Hi Ada: https:\/\/crm\.example\/l\/[A-Za-z0-9_-]{43}$/);
  });
});

describe('closing a manual action', () => {
  it('completes it, says who did, and lets the run go on to the next step', async () => {
    const s = await scene();
    const { enrolmentId } = await s.lead();
    // Until then nothing is queued for the wait: only the job of the visit that began it.
    expect(await s.queuedVisit(enrolmentId)).toEqual([0]);
    const done = await s.complete(await s.only());
    expect(done).toMatchObject({
      status: 'completed',
      closedBy: { name: 'Mia', you: true },
    });
    expect(done.closedAt).not.toBeNull();
    // The run's step was queued for the visit after the wait, and running it takes the outcome.
    expect(await s.queuedVisit(enrolmentId)).toEqual([1]);
    expect(await s.step(enrolmentId)).toBe('ran');
    const after = await s.enrolment(enrolmentId);
    expect(after).toMatchObject({ status: 'running', current_step: 'after' });
    expect(after.state.manual).toBeUndefined();
    // The waiting row closed as the visit went on, and the row that continues it says how.
    expect(await s.stepRuns(enrolmentId)).toEqual([
      {
        step_key: 'call',
        status: 'succeeded',
        output: { manualActionId: done.id },
        resumes: false,
      },
      { step_key: 'call', status: 'succeeded', output: { outcome: 'completed' }, resumes: true },
    ]);
    expect(await s.events('manual_action.completed')).toHaveLength(1);
  });

  it('skips it, and the run goes on just the same, saying it was skipped', async () => {
    const s = await scene();
    const { enrolmentId } = await s.lead();
    expect(await s.skip(await s.only())).toMatchObject({ status: 'skipped' });
    expect(await s.step(enrolmentId)).toBe('ran');
    expect((await s.stepRuns(enrolmentId)).at(-1)?.output).toEqual({ outcome: 'skipped' });
    expect(await s.enrolment(enrolmentId)).toMatchObject({ current_step: 'after' });
    expect(await s.events('manual_action.skipped')).toHaveLength(1);
  });

  it('is done once: a stale revision, a second close and a close at the same moment are refused', async () => {
    const s = await scene();
    const { enrolmentId } = await s.lead();
    const action = await s.only();
    await expect(s.complete({ id: action.id, revision: 'f'.repeat(64) })).rejects.toBeInstanceOf(
      ConflictError,
    );
    const results = await Promise.allSettled([s.complete(action), s.skip(action)]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find((result) => result.status === 'rejected')?.reason).toBeInstanceOf(
      ConflictError,
    );
    const closed = await s.only();
    await expect(s.skip(closed)).rejects.toThrow(/already/);
    await expect(s.assign(closed, 'me')).rejects.toBeInstanceOf(ConflictError);
    expect(await s.queuedVisit(enrolmentId)).toEqual([1]);
    expect(await s.step(enrolmentId)).toBe('ran');
    expect((await s.stepRuns(enrolmentId)).map((run) => run.output)).toEqual([
      { manualActionId: closed.id },
      { outcome: closed.status },
    ]);
  });

  it('leaves the queue when its run ends some other way, and can then not be completed', async () => {
    const s = await scene();
    const { enrolmentId } = await s.lead();
    const action = await s.only();
    await withTenant(db, s.context, (trx) => cancelRuns(trx, { enrolmentId }));
    const cancelled = await s.only();
    expect(cancelled).toMatchObject({ status: 'cancelled', closedBy: null });
    expect(cancelled.closedAt).not.toBeNull();
    await expect(s.complete(action)).rejects.toBeInstanceOf(ConflictError);
    await expect(s.complete(cancelled)).rejects.toBeInstanceOf(ConflictError);
    expect((await s.list()).total).toBe(0);
    expect(await s.enrolment(enrolmentId)).toMatchObject({ status: 'cancelled' });
  });

  it('is for whoever works conversations, and never reaches another business', async () => {
    const s = await scene();
    const other = await scene();
    await s.lead();
    const action = await s.only();
    const viewer = s.as(s.mia, everythingBut('conversations.manage', 'conversations.reply'));
    await expect(s.complete(action, viewer)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.skip(action, viewer)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.assign(action, 'me', viewer)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(other.read(action.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(other.complete(action)).rejects.toBeInstanceOf(NotFoundError);
    await expect(other.skip(action)).rejects.toBeInstanceOf(NotFoundError);
    await expect(other.assign(action, null)).rejects.toBeInstanceOf(NotFoundError);
    expect(await other.list({ status: 'all' })).toMatchObject({ items: [], total: 0 });
    expect(await s.only()).toMatchObject({ status: 'pending' });
  });
});

describe('assigning a manual action', () => {
  it('gives it to a team member, to the reader or to nobody, from its revision', async () => {
    const s = await scene();
    await s.lead();
    const action = await s.only();
    const sams = await s.assign(action, s.team.get(s.sam.id) ?? '');
    expect(sams.assignee).toMatchObject({ name: 'Sam', you: false });
    await expect(s.assign(action, 'me')).rejects.toBeInstanceOf(ConflictError);
    const mine = await s.assign(sams, 'me');
    expect(mine.assignee).toMatchObject({ name: 'Mia', you: true });
    expect((await s.assign(mine, null)).assignee).toBeNull();
    await expect(
      s.assign(await s.only(), toPublicId('membership', randomUUID7())),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await s.events('manual_action.assigned')).map((event) => event.payload)).toEqual([
      expect.objectContaining({ assignedUserId: s.sam.id }),
      expect.objectContaining({ assignedUserId: s.mia.id }),
    ]);
    expect(await s.events('manual_action.unassigned')).toHaveLength(1);
  });

  it('lets someone who only replies take one or put their own back, and no more', async () => {
    const s = await scene();
    await s.lead();
    const replier = s.as(s.sam, everythingBut('conversations.manage'));
    const reply = 'conversations.reply' as const;
    const action = await s.only();
    await expect(
      s.assign(action, s.team.get(s.mia.id) ?? '', replier, reply),
    ).rejects.toMatchObject({ issues: [{ path: '/assignee', code: 'not_allowed' }] });
    const taken = await s.assign(action, 'me', replier, reply);
    expect(taken.assignee).toMatchObject({ name: 'Sam' });
    const back = await s.assign(taken, null, replier, reply);
    expect(back.assignee).toBeNull();
    // One that is someone else's is not theirs to put back.
    const mias = await s.assign(back, s.team.get(s.mia.id) ?? '');
    await expect(s.assign(mias, null, replier, reply)).rejects.toMatchObject({
      issues: [{ path: '/assignee', code: 'not_allowed' }],
    });
    // The permission the route did not pick refuses them.
    await expect(s.assign(mias, 'me', replier)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('the manual actions queue', () => {
  it('lists oldest first, a page at a time, by status, type, workflow and assignee', async () => {
    const s = await scene();
    await s.lead({ firstName: 'One', owner: s.mia.id });
    await s.lead({ firstName: 'Two', owner: s.sam.id });
    await s.lead({ firstName: 'Three' });
    const names = async (query: Record<string, unknown> = {}, invocation = s.as()) =>
      (await s.list(query, invocation)).items.map((item) => item.contact.name);
    const first = manualActionList.parse(await s.list({ limit: 2 }));
    expect(first.items.map((item) => item.contact.name)).toEqual(['One', 'Two']);
    expect(first).toMatchObject({ total: 3, canWork: true, canAssign: true });
    expect(await names({ limit: 2, after: first.next })).toEqual(['Three']);
    expect(await names({ assignee: 'me' })).toEqual(['One']);
    expect(await names({ assignee: 'me' }, s.as(s.sam))).toEqual(['Two']);
    expect(await names({ assignee: 'unassigned' })).toEqual(['Three']);
    expect(await names({ assignee: s.team.get(s.sam.id) })).toEqual(['Two']);
    expect(await names({ type: 'sms' })).toEqual([]);
    expect(await names({ type: 'call' })).toHaveLength(3);
    expect(await names({ automationId: toPublicId('automation', s.automationId) })).toHaveLength(3);
    expect(await names({ automationId: toPublicId('automation', randomUUID7()) })).toEqual([]);
    const [one] = first.items;
    if (one !== undefined) await s.complete(one);
    expect(await names()).toEqual(['Two', 'Three']);
    expect(await names({ status: 'completed' })).toEqual(['One']);
    expect(await names({ status: 'all' })).toEqual(['One', 'Two', 'Three']);
    await expect(s.list({ after: 'nope' })).rejects.toBeInstanceOf(ValidationError);
    // An id that is not one names nothing, as an id nothing has does.
    expect(await names({ automationId: 'not-an-id' })).toEqual([]);
    await expect(s.read('not-an-id')).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      s.list({ assignee: toPublicId('membership', randomUUID7()) }),
    ).rejects.toBeInstanceOf(ValidationError);
    const replier = s.as(s.sam, everythingBut('conversations.manage'));
    expect(await s.list({}, replier)).toMatchObject({ canWork: true, canAssign: false });
  });
});

describe('the “Trigger link clicked” trigger', () => {
  it('enrols the contact who opened the link it names, and nobody for another link', async () => {
    const s = await scene();
    const links = await s.sql<{ id: string; key: string }>(
      `insert into messaging.trigger_links (business_id, name, key, url, created_by_kind)
       values (app.business_id(), 'Offer', 'offer', 'https://harbor.example/offer', 'user'),
              (app.business_id(), 'Other', 'other', 'https://harbor.example/other', 'user')
       returning id, key`,
    );
    const offer = links.find((link) => link.key === 'offer');
    const clicked: AutomationDocumentInput = {
      name: 'Clicked the offer',
      triggers: [
        {
          id: 'clicked',
          type: 'trigger_link.clicked',
          config: { link: toPublicId('trigger_link', offer?.id ?? '') },
        },
      ],
      start: 'after',
      steps: { after: { type: 'wait', config: { duration: 'PT1M' } } },
    };
    const automationId = await withTenant(db, s.context, async (trx) => {
      const { id } = await trx
        .insertInto('automation.automations')
        .values({
          business_id: s.business.id,
          name: clicked.name,
          draft: JSON.stringify(clicked),
          created_by_kind: 'system',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await publishAutomationVersion(trx, s.context, id, automationDocument.parse(clicked), 'v1');
      return id;
    });
    const { contactId } = await s.lead();
    const addresses = await withTenant(db, s.context, (trx) =>
      issueTriggerLinkAddresses(trx, s.context, {
        contactId,
        keys: ['offer', 'other'],
        publicUrl: 'https://crm.example',
      }),
    );
    const open = async (key: string) => {
      const token = addresses[`trigger_link.${key}`]?.split('/').at(-1) ?? '';
      expect(await openTriggerLink(db, token, randomUUID())).toBe(`https://harbor.example/${key}`);
      const [event] = await s.sql<{ id: string }>(
        `select id from events.events where type = 'trigger_link.clicked'
         order by recorded_at desc, id desc limit 1`,
      );
      return withTenant(db, s.context, (trx) =>
        matchEvent(trx, s.context, event?.id ?? '', contactValues),
      );
    };
    expect((await open('other')).enrolled).toEqual([]);
    const matched = await open('offer');
    expect(matched.enrolled).toHaveLength(1);
    const [run] = await s.sql<{ automation_id: string; record_id: string }>(
      `select automation_id, record_id from automation.enrolments where id = $1`,
      [matched.enrolled[0]?.enrolmentId],
    );
    expect(run).toEqual({ automation_id: automationId, record_id: contactId });
  });
});

/** A UUIDv7 nothing has: the version and variant bits set on a random UUID. */
function randomUUID7(): string {
  const raw = randomUUID().replaceAll('-', '');
  const hex = `${raw.slice(0, 12)}7${raw.slice(13, 16)}8${raw.slice(17)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
