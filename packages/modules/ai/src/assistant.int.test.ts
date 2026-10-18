// The in-app assistant against real Postgres under row-level security, with the real
// gateway and a local stand-in for Claude that each test scripts. No test calls a real
// provider. The tools here are the CRM's own tag routes and a stand-in for publishing a
// form (test/copilot-world.ts); the real form tools are proven with it in apps/server.
import {
  applyProposal,
  ASSISTANT_LIMITS,
  cancelAssistantTurn,
  createAssistantThread,
  deleteAssistantThread,
  dismissProposal,
  getAssistantContext,
  getAssistantThread,
  getAssistantTurn,
  getAutonomy,
  listAssistantMessages,
  listAssistantThreads,
  postAssistantTurn,
  type AssistantMessage,
  type AssistantTurnStarted,
} from '@repo/contracts';
import { randomUUID } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError, parsePublicId } from '@repo/kernel';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  MISSING_FORM,
  STAND_IN_FORM,
  STAND_IN_REVISION,
  startCopilotWorld,
  type CopilotWorld,
} from '../test/copilot-world.js';
import {
  anthropicError,
  anthropicText,
  anthropicToolCalls,
  toolResultsOf,
} from '../test/fake-anthropic.js';
import type { Person } from '../test/settings-world.js';
import { GENERAL_CHIPS } from './assistant-chat-routes.js';
import { ASSISTANT_SYSTEM } from './assistant-loop.js';
import { titleOf } from './assistant-threads.js';
import { alternating } from './assistant-turn.js';
import type { AiGateway } from './gateway.js';
import { expireAssistantThreads } from './maintenance.js';

let world: CopilotWorld;
beforeAll(async () => {
  world = await startCopilotWorld(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});
beforeEach(async () => {
  world.clock.now = new Date('2026-10-12T09:00:00.000Z');
  world.claude.requests.length = 0;
  world.turnEvents.length = 0;
  world.faults.length = 0;
  world.grants.clear();
  await world.database.runJobs(['ai.assistant_turn', 'ai.test_connection']);
});

const FORMS = { route: '/forms' };
const ON_FORM = {
  route: `/forms/${STAND_IN_FORM}`,
  record: { kind: 'form', id: STAND_IN_FORM },
};

const say = (
  person: Pick<Person, 'invocation'>,
  message: string,
  page: object = FORMS,
): Promise<AssistantTurnStarted> =>
  world.ask(createAssistantThread, person, { body: { message, page } });
const sayIn = (
  person: Pick<Person, 'invocation'>,
  threadId: string,
  message: string,
  page: object = FORMS,
): Promise<AssistantTurnStarted> =>
  world.ask(postAssistantTurn, person, { params: { id: threadId }, body: { message, page } });
const messagesOf = async (
  person: Pick<Person, 'invocation'>,
  threadId: string,
): Promise<AssistantMessage[]> =>
  (await world.ask(listAssistantMessages, person, { params: { id: threadId } })).items;
/** Native effects and cards, excluding the additional execution-status receipts. */
const effectMessagesOf = async (person: Pick<Person, 'invocation'>, threadId: string) =>
  (await messagesOf(person, threadId)).filter(
    (message) =>
      message.activity?.state !== 'started' &&
      !(message.activity?.effect === 'confirm' && message.activity.state !== undefined),
  );
const turnOf = (person: Pick<Person, 'invocation'>, turnId: string) =>
  world.ask(getAssistantTurn, person, { params: { id: turnId } });
/** The requests the stand-in was sent for a model's answer, oldest first. */
const asked = () => world.claude.requests.filter((each) => each.path === '/v1/messages');
/** One of those requests, by its place. */
const request = (index: number) => {
  const found = asked()[index];
  if (found === undefined)
    throw new Error(`The stand-in was not asked ${String(index + 1)} times.`);
  return found;
};
const bodyOf = (index: number) =>
  asked()[index]?.json as {
    system: unknown;
    tools: { name: string }[];
    messages: { role: string; content: unknown }[];
  };

describe('what is missing on a page', () => {
  it('answers with the page’s checks and no box to type in where no provider is connected', async () => {
    const dana = await world.admin();
    const context = await world.ask(getAssistantContext, dana, { body: ON_FORM });
    expect(context).toMatchObject({
      ai: 'not_connected',
      canUse: true,
      message: 'No AI provider is connected yet. Connect one in Settings → AI models.',
      connect: { kind: 'ai_settings', id: null, section: null, path: null },
      subject: { kind: 'form', id: STAND_IN_FORM, name: 'Wedding enquiry' },
      chips: [{ code: 'form.whats_missing' }],
    });
    // What stops the form working comes first, whatever order the page's module gave.
    expect(context.checks.map((check) => [check.severity, check.code])).toEqual([
      ['blocker', 'no_identity'],
      ['suggestion', 'no_consent_box'],
    ]);

    // And a message is refused in the same words, before anything is stored or queued.
    const refused = say(dana, 'Build a form');
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(refused).rejects.toThrow(
      'No AI provider is connected yet. Connect one in Settings → AI models.',
    );
    expect((await world.ask(listAssistantThreads, dana)).items).toEqual([]);
    expect(await world.runTurns()).toBe(0);
  });

  it('says ready with a provider, off when AI is turned off, and offers the general chips elsewhere', async () => {
    const dana = await world.connected();
    expect(await world.ask(getAssistantContext, dana, { body: { route: '/contacts' } })).toEqual({
      ai: 'ready',
      canUse: true,
      message: null,
      connect: null,
      subject: null,
      checks: [],
      chips: [...GENERAL_CHIPS],
    });
    // A record that is not there is a page with nothing to say, not an error.
    expect(
      await world.ask(getAssistantContext, dana, {
        body: { route: '/forms/x', record: { kind: 'form', id: MISSING_FORM } },
      }),
    ).toMatchObject({ subject: null, checks: [], chips: [...GENERAL_CHIPS] });

    await world.database.withTenant(dana.context, (sql) =>
      sql.query(`update ai.settings set enabled = false`),
    );
    const off = await world.ask(getAssistantContext, dana, { body: FORMS });
    expect(off).toMatchObject({ ai: 'off', connect: null });
    expect(off.message).toContain('AI is turned off for this business');
    await expect(say(dana, 'Build a form')).rejects.toThrow('AI is turned off');
  });

  it('tells someone whose role lacks the assistant so, and refuses their message naming the permission', async () => {
    const dana = await world.connected();
    const without = world.limited(dana, ['forms.manage']);
    expect(await world.ask(getAssistantContext, without, { body: FORMS })).toMatchObject({
      ai: 'ready',
      canUse: false,
      message: 'Your role doesn’t include the assistant. Ask someone who manages the team.',
    });
    const refused = say(without, 'Build a form');
    await expect(refused).rejects.toBeInstanceOf(ForbiddenError);
    await expect(refused).rejects.toMatchObject({ permission: 'assistant.use' });
  });
});

describe('a conversation', () => {
  it('starts with its first message: a titled thread, a queued turn and one job', async () => {
    const dana = await world.connected();
    const written = 'Build a wedding   enquiry form\nwith a hidden campaign field';
    const started = await say(dana, `  ${written} `);
    expect(started.thread).toMatchObject({
      title: 'Build a wedding enquiry form with a hidden campaign field',
      createdAt: '2026-10-12T09:00:00.000Z',
      lastActivityAt: '2026-10-12T09:00:00.000Z',
      expiresAt: '2026-11-11T09:00:00.000Z',
    });
    expect(started.turn).toMatchObject({
      status: 'queued',
      outcome: null,
      message: null,
      cancelRequested: false,
      steps: 0,
      costEstimate: null,
      startedAt: null,
      finishedAt: null,
    });
    expect(started.message).toMatchObject({
      seq: 1,
      kind: 'user',
      text: written,
      turnId: started.turn.id,
    });
    expect(started.thread.turn).toEqual(started.turn);

    const listed = await world.ask(listAssistantThreads, dana);
    expect(listed).toEqual({ items: [started.thread], nextCursor: null });
    const opened = await world.ask(getAssistantThread, dana, { params: { id: started.thread.id } });
    expect(opened).toEqual({
      thread: started.thread,
      messages: { items: [started.message], cursor: 1, more: false, turn: started.turn },
    });
    expect(await turnOf(dana, started.turn.id)).toEqual(started.turn);

    // What the audit log keeps of it is where it was asked from, never the words.
    const [audit] = await world.database.as('crm_owner', (sql) =>
      sql.query<{ command: string; input: unknown; outcome: string }>(
        `select command, input, outcome from audit.commands
         where correlation_id = $1 and command = 'assistant.start_turn'`,
        [dana.context.correlationId],
      ),
    );
    expect(audit).toEqual({
      command: 'assistant.start_turn',
      outcome: 'ok',
      input: { threadId: null, route: '/forms', record: null, selected: 0, length: written.length },
    });

    world.claude.next(anthropicText('Tell me what the form is for.'));
    expect(await world.runTurns()).toBe(1);
  });

  it('takes one message at a time, and goes on in the same thread once the turn has finished', async () => {
    const dana = await world.connected();
    const first = await say(dana, 'Build a form');
    const busy = sayIn(dana, first.thread.id, 'And a tag');
    await expect(busy).rejects.toBeInstanceOf(ConflictError);
    await expect(busy).rejects.toThrow('The assistant is still working on your last message.');

    world.claude.next(anthropicText('What is it for?'));
    await world.runTurns();
    world.clock.now = new Date('2026-10-12T09:05:00.000Z');
    const second = await sayIn(dana, first.thread.id, 'Weddings');
    expect(second.thread.id).toBe(first.thread.id);
    expect(second.thread.title).toBe('Build a form');
    expect(second.thread.lastActivityAt).toBe('2026-10-12T09:05:00.000Z');
    expect(second.message).toMatchObject({ seq: 3, kind: 'user', text: 'Weddings' });

    world.claude.next(anthropicText('I’ll draft it.'));
    await world.runTurns();
    expect(
      (await effectMessagesOf(dana, first.thread.id)).map((each) => [
        each.seq,
        each.kind,
        each.text,
      ]),
    ).toEqual([
      [1, 'user', 'Build a form'],
      [2, 'assistant', 'What is it for?'],
      [3, 'user', 'Weddings'],
      [4, 'assistant', 'I’ll draft it.'],
    ]);
    // The second turn was given what was said before, as the two sides said it.
    const sent = bodyOf(1).messages;
    expect(sent.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(sent[0])).toContain('Build a form');
    expect(JSON.stringify(sent[1])).toContain('What is it for?');
    expect(JSON.stringify(sent[2])).toContain('Weddings');
  });

  it('is read after a cursor, a page at a time', async () => {
    const dana = await world.connected();
    const { thread } = await say(dana, 'Build a form');
    world.claude.next(anthropicToolCalls([{ name: 'crm_listTags', input: {} }], 'Looking.'));
    world.claude.next(anthropicText('No tags yet.'));
    await world.runTurns();
    const read = (query: object) =>
      world.ask(listAssistantMessages, dana, { params: { id: thread.id }, query });
    const first = await read({ limit: 2 });
    expect(first.items.map((item) => item.seq)).toEqual([1, 2]);
    expect(first).toMatchObject({ cursor: 2, more: true });
    const rest = await read({ after: first.cursor });
    expect(rest.items.map((item) => item.seq)).toEqual([3, 4, 5]);
    expect(rest.items.map((item) => item.activity?.state)).toEqual([
      'started',
      'completed',
      undefined,
    ]);
    expect(rest).toMatchObject({ cursor: 5, more: false, turn: { status: 'finished' } });
    // Nothing new: the cursor comes back as it was sent.
    expect(await read({ after: 5 })).toMatchObject({ items: [], cursor: 5, more: false });
  });

  it('lists a person’s threads newest activity first, a page at a time', async () => {
    const dana = await world.connected();
    const titles: string[] = [];
    for (const [index, title] of ['First', 'Second', 'Third'].entries()) {
      world.clock.now = new Date(Date.UTC(2026, 9, 12, 9, index));
      const started = await say(dana, title);
      titles.push(started.thread.id);
      world.claude.next(anthropicText('Yes.'));
      await world.runTurns();
    }
    const page = (query: object) => world.ask(listAssistantThreads, dana, { query });
    const first = await page({ limit: 2 });
    expect(first.items.map((item) => item.title)).toEqual(['Third', 'Second']);
    expect(first.nextCursor).not.toBeNull();
    const second = await page({ limit: 2, after: first.nextCursor });
    expect(second.items.map((item) => item.title)).toEqual(['First']);
    expect(second.nextCursor).toBeNull();
    expect(first.items[0]?.turn).toMatchObject({ status: 'finished', outcome: 'answered' });
    // A cursor that is none of ours ends the list rather than starting it again.
    for (const after of [
      'nonsense',
      '12.nonsense',
      `x.${titles[0] ?? ''}`,
      `1.${titles[0] ?? ''}.2`,
    ])
      expect(await page({ after })).toEqual({ items: [], nextCursor: null });
  });

  it('is its person’s alone: nobody else in the business, no other business and no machine reads it', async () => {
    const dana = await world.connected();
    const { thread, turn } = await say(dana, 'Build a private form');
    const sam = await world.colleague(dana);
    const elsewhere = await world.connected();
    for (const other of [sam, elsewhere]) {
      expect(await world.ask(listAssistantThreads, other)).toEqual({ items: [], nextCursor: null });
      for (const attempt of [
        () => world.ask(getAssistantThread, other, { params: { id: thread.id } }),
        () => world.ask(listAssistantMessages, other, { params: { id: thread.id } }),
        () => world.ask(getAssistantTurn, other, { params: { id: turn.id } }),
        () => world.ask(cancelAssistantTurn, other, { params: { id: turn.id } }),
        () => world.ask(deleteAssistantThread, other, { params: { id: thread.id } }),
        () => sayIn(other, thread.id, 'Let me in'),
      ])
        await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
    }
    // An API key, a job and an assistant carrying her id are not her acting herself.
    for (const actorKind of ['api_key', 'system', 'ai_agent'] as const) {
      const machine = {
        invocation: {
          ...dana.invocation,
          context: { ...dana.context, actorKind },
        },
      };
      for (const attempt of [
        () => world.ask(listAssistantThreads, machine),
        () => world.ask(getAssistantThread, machine, { params: { id: thread.id } }),
        () => world.ask(listAssistantMessages, machine, { params: { id: thread.id } }),
        () => world.ask(getAssistantTurn, machine, { params: { id: turn.id } }),
      ])
        await expect(attempt()).rejects.toThrow('Only a signed-in person talks to the assistant.');
      // Starting, stopping and deleting are refused too: by the same rule, or, for an
      // assistant, already by the command layer, which lets it run no command of these.
      for (const attempt of [
        () => say(machine, 'As a machine'),
        () => world.ask(cancelAssistantTurn, machine, { params: { id: turn.id } }),
        () => world.ask(deleteAssistantThread, machine, { params: { id: thread.id } }),
      ])
        await expect(attempt()).rejects.toBeInstanceOf(ForbiddenError);
    }
    // It is still there, untouched, for her.
    expect((await world.ask(listAssistantThreads, dana)).items.map((item) => item.id)).toEqual([
      thread.id,
    ]);
    expect(await turnOf(dana, turn.id)).toMatchObject({ status: 'queued', cancelRequested: false });
    await expect(
      world.ask(getAssistantThread, dana, { params: { id: turn.id } }),
    ).rejects.toThrow();
  });

  it('holds one person to thirty turns an hour, and lets them go on when the hour has passed', async () => {
    const dana = await world.connected();
    const { thread } = await say(dana, 'First of many');
    world.claude.next(anthropicText('Yes.'));
    await world.runTurns();
    await world.database.as('crm_owner', (sql) =>
      sql.query(
        `insert into ai.assistant_turns (business_id, thread_id, user_id, status, outcome, page,
           correlation_id, created_at, finished_at)
         select $1, $2, $3, 'finished', 'answered', '{"route": "/forms"}', uuidv7(),
           $4::timestamptz - interval '10 minutes', $4::timestamptz
         from generate_series(1, $5)`,
        [
          dana.context.businessId,
          parsePublicId('assistant_thread', thread.id),
          dana.userId,
          world.clock.now.toISOString(),
          ASSISTANT_LIMITS.turnsPerHour - 1,
        ],
      ),
    );
    const refused = sayIn(dana, thread.id, 'One too many');
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(refused).rejects.toThrow('30 messages in the last hour');
    // A colleague's own count is their own.
    const sam = await world.colleague(dana);
    await say(sam, 'Mine');
    world.clock.now = new Date('2026-10-12T10:00:01.000Z');
    expect((await sayIn(dana, thread.id, 'An hour later')).turn.status).toBe('queued');
  });

  it('is deleted with its messages once no turn of it runs, and what the assistant made stays', async () => {
    const dana = await world.connected();
    const { thread } = await say(dana, 'Make a tag');
    await expect(
      world.ask(deleteAssistantThread, dana, { params: { id: thread.id } }),
    ).rejects.toThrow('Stop it before deleting it.');
    world.claude.next(
      anthropicToolCalls([
        { name: 'crm_createTag', input: { body: { name: 'Kept after deletion' } } },
        {
          name: 'crm_publishForm',
          input: { params: { id: STAND_IN_FORM }, body: { revision: STAND_IN_REVISION } },
        },
      ]),
    );
    world.claude.next(anthropicText('Done.'));
    await world.runTurns();
    await world.ask(deleteAssistantThread, dana, { params: { id: thread.id } });
    await expect(
      world.ask(getAssistantThread, dana, { params: { id: thread.id } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const left = await world.database.as('crm_owner', (sql) =>
      sql.one<{ turns: string; messages: string; proposals: string }>(
        `select (select count(*) from ai.assistant_turns where business_id = $1)::text as turns,
                (select count(*) from ai.assistant_messages where business_id = $1)::text as messages,
                (select count(*) from ai.proposals where business_id = $1)::text as proposals`,
        [dana.context.businessId],
      ),
    );
    expect(left).toEqual({ turns: '0', messages: '0', proposals: '1' });
    expect(await world.tags(dana)).toEqual(['Kept after deletion']);
  });

  it('is removed with its turns and messages when its time is up', async () => {
    const dana = await world.connected();
    const kept = await say(dana, 'Kept');
    world.claude.next(anthropicText('Yes.'));
    await world.runTurns();
    const old = await say(dana, 'Old');
    world.claude.next(anthropicText('Yes.'));
    await world.runTurns();
    await world.database.as('crm_owner', (sql) =>
      sql.query(
        `update ai.assistant_threads set expires_at = now() - interval '1 minute' where id = $1`,
        [parsePublicId('assistant_thread', old.thread.id)],
      ),
    );
    expect(await expireAssistantThreads(world.services)).toBe(1);
    expect((await world.ask(listAssistantThreads, dana)).items.map((item) => item.id)).toEqual([
      kept.thread.id,
    ]);
    expect(await expireAssistantThreads(world.services)).toBe(0);
  });

  it('is kept as long as the business keeps what was said to a model, a day at least and a month at most', async () => {
    const dana = await world.connected();
    const expiry = async (days: number) => {
      await world.database.withTenant(dana.context, (sql) =>
        sql.query(`update ai.settings set request_log_days = $1`, [days]),
      );
      const { thread } = await say(dana, `Kept ${String(days)} days`);
      world.claude.next(anthropicText('Yes.'));
      await world.runTurns();
      return (await world.ask(getAssistantThread, dana, { params: { id: thread.id } })).thread
        .expiresAt;
    };
    expect(await expiry(0)).toBe('2026-10-13T09:00:00.000Z');
    expect(await expiry(7)).toBe('2026-10-19T09:00:00.000Z');
    expect(await expiry(365)).toBe('2026-11-11T09:00:00.000Z');
  });

  it('titles a thread by its first message on one line, cut to what the list shows', () => {
    expect(titleOf('  Build\n\ta   form ')).toBe('Build a form');
    const long = titleOf(`${'word '.repeat(40)}end`);
    expect(Array.from(long)).toHaveLength(ASSISTANT_LIMITS.titleLength);
    expect(long.endsWith('word…')).toBe(true);
    // Cut at a space, the ellipsis follows the last word and not the space.
    expect(titleOf(`${'a'.repeat(78)} bcd`)).toBe(`${'a'.repeat(78)}…`);
    expect(Array.from(titleOf('é'.repeat(200)))).toHaveLength(ASSISTANT_LIMITS.titleLength);
  });
});

describe('a turn', () => {
  it('runs the tools the model asks for as the API’s own operations, and writes a message for each step', async () => {
    const dana = await world.connected();
    const { thread, turn } = await say(dana, 'Make a tag for wedding leads', ON_FORM);
    world.claude.next(
      anthropicToolCalls(
        [{ name: 'crm_createTag', input: { body: { name: 'Wedding lead' } } }],
        'I’ll add it.',
      ),
    );
    world.claude.next(anthropicText('The tag “Wedding lead” is ready.'));
    expect(await world.runTurns()).toBe(1);

    const raw = await messagesOf(dana, thread.id);
    const receipts = raw.filter((message) => message.kind === 'activity');
    expect(receipts.map((message) => message.activity?.state)).toEqual(['started', 'completed']);
    expect(receipts[0]?.activity?.callId).toBe(receipts[1]?.activity?.callId);
    expect(receipts[0]?.activity?.callId).toBeTruthy();
    const messages = await effectMessagesOf(dana, thread.id);
    expect(messages.map((each) => [each.kind, each.text])).toEqual([
      ['user', 'Make a tag for wedding leads'],
      ['assistant', 'I’ll add it.'],
      ['activity', 'Created the tag “Wedding lead”'],
      ['assistant', 'The tag “Wedding lead” is ready.'],
    ]);
    expect(messages[2]?.activity).toMatchObject({
      operationId: 'createTag',
      effect: 'draft',
      ok: true,
      target: { kind: 'tag', section: null, path: null },
    });
    expect(messages[2]?.activity?.target?.id).toMatch(/^tag_/);
    expect(await world.tags(dana)).toEqual(['Wedding lead']);

    const done = await turnOf(dana, turn.id);
    expect(done).toMatchObject({
      status: 'finished',
      outcome: 'answered',
      message: null,
      steps: 2,
      startedAt: '2026-10-12T09:00:00.000Z',
      finishedAt: '2026-10-12T09:00:00.000Z',
    });
    // Two priced calls of the stand-in's model: a cost, in dollars with six places.
    expect(done.costEstimate).toMatch(/^\d+\.\d{6}$/);
    expect(Number(done.costEstimate)).toBeGreaterThan(0);
    expect(world.turnEvents).toEqual([
      {
        businessId: dana.context.businessId,
        turnId: parsePublicId('assistant_turn', turn.id),
        outcome: 'answered',
        reason: null,
        steps: 2,
      },
    ]);

    // The model was given the instructions, the tools by name, and the page as data.
    const first = bodyOf(0);
    expect(JSON.stringify(first.system)).toContain(ASSISTANT_SYSTEM.slice(0, 80));
    expect(first.tools.map((tool) => tool.name).sort()).toEqual([
      'crm_createTag',
      'crm_getAssistantContext',
      'crm_listTags',
      'crm_publishForm',
    ]);
    const said = JSON.stringify(first.messages[0]);
    expect(said).toContain('<data>');
    expect(said).toContain('no_identity');
    expect(said).toContain('Wedding enquiry');
    expect(said).toContain('Make a tag for wedding leads');
    // And then what its tool answered.
    const [result] = toolResultsOf(request(1));
    expect(result).toMatchObject({ isError: false });
    expect(JSON.parse(result?.content ?? '{}')).toMatchObject({ name: 'Wedding lead' });

    // Each call is the assistant's, on the model chosen for building, under this prompt.
    const calls = await world.database.withTenant(dana.context, (sql) =>
      sql.query<{ job: string; prompt_version: string; actor_kind: string; status: string }>(
        `select job, prompt_version, actor_kind, status from ai.requests
         where prompt_version like 'assistant/%' order by started_at, id`,
      ),
    );
    expect(calls).toEqual([
      {
        job: 'automation_builder',
        prompt_version: 'assistant/2',
        actor_kind: 'ai_agent',
        status: 'ok',
      },
      {
        job: 'automation_builder',
        prompt_version: 'assistant/2',
        actor_kind: 'ai_agent',
        status: 'ok',
      },
    ]);
    // The tag was made by the assistant, audited under the request that asked for it.
    const audits = await world.database.as('crm_owner', (sql) =>
      sql.query<{ command: string; actor_kind: string; actor_id: string | null; outcome: string }>(
        `select command, actor_kind, actor_id, outcome from audit.commands
         where correlation_id = $1 and command in ('assistant.start_turn', 'tag.create')
         order by recorded_at, id`,
        [dana.context.correlationId],
      ),
    );
    expect(audits).toEqual([
      { command: 'assistant.start_turn', actor_kind: 'user', actor_id: dana.userId, outcome: 'ok' },
      { command: 'tag.create', actor_kind: 'ai_agent', actor_id: null, outcome: 'ok' },
    ]);
  });

  it('never runs a tool that makes something live: a card waits, and the person applies it as themselves', async () => {
    const dana = await world.connected();
    const { thread } = await say(dana, 'Publish it', ON_FORM);
    world.claude.next(
      anthropicToolCalls([
        {
          name: 'crm_publishForm',
          input: { params: { id: STAND_IN_FORM }, body: { revision: STAND_IN_REVISION } },
        },
      ]),
    );
    world.claude.next(anthropicText('A card is waiting for you to confirm.'));
    await world.runTurns();

    const messages = await effectMessagesOf(dana, thread.id);
    expect(messages.map((each) => each.kind)).toEqual(['user', 'proposal', 'assistant']);
    const card = messages[1];
    expect(card).toMatchObject({
      text: 'Publish the form “Wedding enquiry”',
      proposal: {
        agent: 'copilot',
        kind: 'form_publish',
        status: 'pending',
        autonomy: 'ask',
        summary: 'Publish the form “Wedding enquiry”',
        canDecide: true,
        stale: false,
        change: { kind: 'form_publish', name: 'Wedding enquiry', questions: 3 },
        expiresAt: '2026-10-19T09:00:00.000Z',
      },
    });
    // Nothing was published, and the model was told so.
    expect(await world.tags(dana)).toEqual([]);
    const [told] = toolResultsOf(request(1));
    expect(told?.isError).toBe(false);
    expect(told?.content).toContain('Nothing was published');

    // A colleague without the form's permission sees the card and cannot press it.
    const proposalId = card?.proposal?.id ?? '';
    await expect(
      world.ask(applyProposal, world.limited(dana, ['assistant.use']), {
        params: { id: proposalId },
        body: {},
      }),
    ).rejects.toMatchObject({ permission: 'forms.manage' });
    expect(await world.tags(dana)).toEqual([]);

    const applied = await world.ask(applyProposal, dana, { params: { id: proposalId }, body: {} });
    expect(applied).toMatchObject({ status: 'applied', decidedBy: { kind: 'user', you: true } });
    expect(await world.tags(dana)).toEqual([`published ${STAND_IN_FORM}`]);
    // The thread shows the card as it now stands.
    expect((await effectMessagesOf(dana, thread.id))[1]?.proposal).toMatchObject({
      status: 'applied',
      result: { formId: STAND_IN_FORM },
      undo: { available: false, reason: 'published_before' },
    });
    // The publish is the person's: the assistant only proposed it.
    const [audit] = await world.database.as('crm_owner', (sql) =>
      sql.query<{ actor_kind: string; proposal_id: string | null }>(
        `select actor_kind, proposal_id from audit.commands where command = 'test.publish_form'
           and business_id = $1`,
        [dana.context.businessId],
      ),
    );
    expect(audit).toEqual({
      actor_kind: 'user',
      proposal_id: parsePublicId('proposal', proposalId),
    });
  });

  it('lets the person say not now: the card is dismissed and nothing is published', async () => {
    const dana = await world.connected();
    const { thread } = await say(dana, 'Publish it');
    world.claude.next(
      anthropicToolCalls([
        {
          name: 'crm_publishForm',
          input: { params: { id: STAND_IN_FORM }, body: { revision: STAND_IN_REVISION } },
        },
      ]),
    );
    world.claude.next(anthropicText('Waiting.'));
    await world.runTurns();
    const [, card] = await effectMessagesOf(dana, thread.id);
    const dismissed = await world.ask(dismissProposal, dana, {
      params: { id: card?.proposal?.id ?? '' },
    });
    expect(dismissed.status).toBe('dismissed');
    expect(await world.tags(dana)).toEqual([]);
    expect((await effectMessagesOf(dana, thread.id))[1]?.proposal?.status).toBe('dismissed');
  });

  it('is held to the person’s own role, read when it runs: no permission, no change and no card', async () => {
    const dana = await world.connected();
    const { thread } = await say(dana, 'Make a tag and publish the form');
    // Her role was changed after she wrote: the turn runs with what she has now.
    world.grants.set(dana.userId, new Set(['assistant.use']));
    world.claude.next(
      anthropicToolCalls([
        { name: 'crm_createTag', input: { body: { name: 'Not hers to make' } } },
        {
          name: 'crm_publishForm',
          input: { params: { id: STAND_IN_FORM }, body: { revision: STAND_IN_REVISION } },
        },
      ]),
    );
    world.claude.next(anthropicText('Your role doesn’t allow either.'));
    await world.runTurns();

    expect(await world.tags(dana)).toEqual([]);
    const messages = await effectMessagesOf(dana, thread.id);
    expect(messages.map((each) => [each.kind, each.text, each.activity?.ok ?? null])).toEqual([
      ['user', 'Make a tag and publish the form', null],
      ['activity', 'Was not allowed to: create a tag', false],
      [
        'activity',
        'Could not propose: publish the draft, so websites show it and it accepts submissions',
        false,
      ],
      ['assistant', 'Your role doesn’t allow either.', null],
    ]);
    const proposals = await world.database.as('crm_owner', (sql) =>
      sql.query(`select 1 from ai.proposals where business_id = $1`, [dana.context.businessId]),
    );
    expect(proposals).toEqual([]);
    // The model read both refusals, each naming what the person lacks.
    const told = toolResultsOf(request(1));
    expect(told.map((each) => each.isError)).toEqual([true, true]);
    expect(JSON.parse(told[0]?.content ?? '{}')).toMatchObject({
      error: 'forbidden',
      needs: 'tags.manage',
    });
    expect(JSON.parse(told[1]?.content ?? '{}')).toMatchObject({
      error: 'forbidden',
      needs: 'forms.manage',
    });
    // The refusal is in the audit log, as the assistant's.
    const [audit] = await world.database.as('crm_owner', (sql) =>
      sql.query<{ actor_kind: string; outcome: string; error_code: string }>(
        `select actor_kind, outcome, error_code from audit.commands
         where command = 'tag.create' and business_id = $1`,
        [dana.context.businessId],
      ),
    );
    expect(audit).toEqual({ actor_kind: 'ai_agent', outcome: 'denied', error_code: 'forbidden' });
  });

  it('ends without calling a model when the person no longer works there or may not use the assistant', async () => {
    const dana = await world.connected();
    for (const grant of [undefined, new Set(['forms.manage'] as const)]) {
      const { thread, turn } = await say(dana, 'Build a form');
      world.grants.set(dana.userId, grant);
      await world.runTurns();
      world.grants.delete(dana.userId);
      expect(await turnOf(dana, turn.id)).toMatchObject({
        status: 'finished',
        outcome: 'no_access',
        steps: 0,
      });
      expect((await effectMessagesOf(dana, thread.id)).at(-1)).toMatchObject({
        kind: 'error',
        code: 'no_access',
        text: 'You no longer have access to the assistant in this business.',
      });
    }
    expect(asked()).toEqual([]);
  });

  it('is held to the business’s rule for building drafts, like any assistant', async () => {
    const dana = await world.connected();
    // Where the in-app assistant starts: drafts without asking, publishing asks.
    const levels = async () =>
      (await world.ask(getAutonomy, dana)).items
        .filter((item) => item.agent === 'copilot')
        .map((item) => [item.action, item.level, item.source]);
    expect(await levels()).toEqual([
      ['build_draft', 'act', 'default'],
      ['publish', 'ask', 'default'],
    ]);
    await world.database.withTenant(dana.context, (sql) =>
      sql.query(
        `insert into ai.autonomy_rules (business_id, agent, action, level)
         values (app.business_id(), 'copilot', 'build_draft', 'ask')`,
      ),
    );
    const { thread } = await say(dana, 'Make a tag');
    world.claude.next(
      anthropicToolCalls([{ name: 'crm_createTag', input: { body: { name: 'Held' } } }]),
    );
    world.claude.next(anthropicText('This business asks me not to.'));
    await world.runTurns();
    expect(await world.tags(dana)).toEqual([]);
    expect((await effectMessagesOf(dana, thread.id))[1]).toMatchObject({
      kind: 'activity',
      activity: { ok: false },
    });
    expect(toolResultsOf(request(1))[0]?.content).toContain('The assistant may only propose this');
  });

  it('gives the model a tool that does not exist, and an input that does not fit, as errors it reads', async () => {
    const dana = await world.connected();
    const { thread, turn } = await say(dana, 'Do something odd');
    world.claude.next(
      anthropicToolCalls([
        { name: 'crm_deleteEverything', input: {} },
        { name: 'crm_createTag', input: { body: { name: '' }, extra: true } },
        { name: 'crm_publishForm', input: { params: { id: 'not-a-form' }, body: {} } },
        {
          name: 'crm_publishForm',
          input: { params: { id: MISSING_FORM }, body: { revision: STAND_IN_REVISION } },
        },
      ]),
    );
    world.claude.next(anthropicText('None of that worked.'));
    await world.runTurns();

    const told = toolResultsOf(request(1));
    expect(told.map((each) => each.isError)).toEqual([true, true, true, true]);
    expect(told[0]?.content).toContain('There is no tool named "crm_deleteEverything"');
    expect(JSON.parse(told[1]?.content ?? '{}')).toMatchObject({ error: 'invalid_input' });
    expect(JSON.parse(told[2]?.content ?? '{}')).toMatchObject({ error: 'invalid_input' });
    expect(JSON.parse(told[3]?.content ?? '{}')).toMatchObject({ error: 'not_found' });
    expect(await world.tags(dana)).toEqual([]);
    expect(
      (await effectMessagesOf(dana, thread.id)).map((each) => [
        each.kind,
        each.activity?.ok ?? null,
      ]),
    ).toEqual([
      ['user', null],
      ['activity', false],
      ['activity', false],
      ['activity', false],
      ['assistant', null],
    ]);
    expect(await turnOf(dana, turn.id)).toMatchObject({ outcome: 'answered', steps: 2 });
    expect(world.faults).toEqual([]);
  });

  it('checks the page again as a tool, for the person, with no model', async () => {
    const dana = await world.connected();
    await say(dana, 'What is missing?', ON_FORM);
    world.claude.next(
      anthropicToolCalls([{ name: 'crm_getAssistantContext', input: { body: ON_FORM } }]),
    );
    world.claude.next(anthropicText('A consent box and an email question.'));
    await world.runTurns();
    const [result] = toolResultsOf(request(1));
    expect(JSON.parse(result?.content ?? '{}')).toMatchObject({
      ai: 'ready',
      subject: { name: 'Wedding enquiry' },
      checks: [{ code: 'no_identity' }, { code: 'no_consent_box' }],
    });
  });

  it('stops at its number of steps and says so, keeping what it had done', async () => {
    const dana = await world.connected();
    const { thread, turn } = await say(dana, 'Keep going');
    // The model would go on: each answer asks for another tool.
    for (const name of ['One', 'Two'])
      world.claude.next(anthropicToolCalls([{ name: 'crm_createTag', input: { body: { name } } }]));
    await world.runTurns({ limits: { steps: 2 } });
    const stopped = await turnOf(dana, turn.id);
    expect(stopped).toMatchObject({ status: 'finished', outcome: 'step_limit', steps: 2 });
    expect(stopped.message).toContain('I stopped after 12 steps');
    expect(await world.tags(dana)).toEqual(['One', 'Two']);
    expect((await effectMessagesOf(dana, thread.id)).at(-1)).toMatchObject({
      kind: 'error',
      code: 'step_limit',
    });
    expect(asked()).toHaveLength(2);
  });

  it('stops when its time is up', async () => {
    const dana = await world.connected();
    const { turn } = await say(dana, 'Take your time');
    await world.runTurns({ limits: { durationMs: 50 } });
    expect(await turnOf(dana, turn.id)).toMatchObject({ outcome: 'time_limit', steps: 0 });
    expect(asked()).toEqual([]);
  });

  it('is cancelled at once before a worker takes it, and the job then does nothing', async () => {
    const dana = await world.connected();
    const { thread, turn } = await say(dana, 'Never mind');
    const cancelled = await world.ask(cancelAssistantTurn, dana, { params: { id: turn.id } });
    expect(cancelled).toMatchObject({
      status: 'finished',
      outcome: 'cancelled',
      message: 'Stopped. What was already done stays done.',
    });
    // Cancelling again changes nothing.
    expect(await world.ask(cancelAssistantTurn, dana, { params: { id: turn.id } })).toEqual(
      cancelled,
    );
    expect(await world.runTurns()).toBe(1);
    expect(asked()).toEqual([]);
    expect((await effectMessagesOf(dana, thread.id)).map((each) => [each.kind, each.code])).toEqual(
      [
        ['user', null],
        ['error', 'cancelled'],
      ],
    );
    // And the thread takes the next message.
    expect((await sayIn(dana, thread.id, 'Something else')).turn.status).toBe('queued');
  });

  it('stops before its next step when it is cancelled while it runs', async () => {
    const dana = await world.connected();
    const { thread, turn } = await say(dana, 'Make three tags');
    let calls = 0;
    /** The real gateway, with the person pressing Stop while the first answer is on its way. */
    const gateway: Pick<AiGateway, 'generate'> = {
      async generate(context, request, options) {
        calls += 1;
        const answer = await world.gateway.generate(context, request, options);
        if (calls === 1) {
          const asking = await world.ask(cancelAssistantTurn, dana, { params: { id: turn.id } });
          expect(asking).toMatchObject({ status: 'running', cancelRequested: true });
          // Pressing it twice is pressing it once.
          await world.ask(cancelAssistantTurn, dana, { params: { id: turn.id } });
        }
        return answer;
      },
    };
    world.claude.next(
      anthropicToolCalls([{ name: 'crm_createTag', input: { body: { name: 'Never made' } } }]),
    );
    await world.runTurns({ gateway });
    expect(calls).toBe(1);
    expect(await world.tags(dana)).toEqual([]);
    expect(await turnOf(dana, turn.id)).toMatchObject({
      status: 'finished',
      outcome: 'cancelled',
      cancelRequested: true,
      steps: 1,
    });
    expect((await effectMessagesOf(dana, thread.id)).at(-1)).toMatchObject({ code: 'cancelled' });
  });

  it('stops at the business’s spending limit and says so', async () => {
    const dana = await world.connected();
    const { thread, turn } = await say(dana, 'Build a form');
    await world.database.withTenant(dana.context, (sql) =>
      sql.query(`update ai.settings set monthly_limit = 0, at_limit = 'pause'`),
    );
    await world.runTurns();
    expect(asked()).toEqual([]);
    expect(await turnOf(dana, turn.id)).toMatchObject({
      status: 'finished',
      outcome: 'paused',
      steps: 0,
      costEstimate: null,
      message:
        'The business has reached its monthly AI spending limit, so I stopped. Someone who manages AI can raise it in Settings → AI models.',
    });
    expect((await effectMessagesOf(dana, thread.id)).at(-1)).toMatchObject({
      kind: 'error',
      code: 'paused',
    });
    expect(world.turnEvents.at(-1)).toMatchObject({ outcome: 'paused', reason: 'limit_reached' });
  });

  it('ends saying the provider failed, and keeps nothing a failed call said', async () => {
    const dana = await world.connected();
    const { thread, turn } = await say(dana, 'Build a form');
    world.claude.next(anthropicError(401, 'authentication_error'));
    await world.runTurns();
    const failed = await turnOf(dana, turn.id);
    expect(failed).toMatchObject({ outcome: 'failed', steps: 1 });
    expect(failed.message).toContain('The AI provider could not be reached');
    expect((await effectMessagesOf(dana, thread.id)).map((each) => each.kind)).toEqual([
      'user',
      'error',
    ]);
    expect(world.turnEvents.at(-1)).toMatchObject({ outcome: 'failed', reason: 'authentication' });
  });

  it('ends as failed, without running again, when the server itself faults', async () => {
    const dana = await world.connected();
    const { turn } = await say(dana, 'Build a form');
    const fault = new Error('the pool is gone');
    await world.runTurns({ gateway: { generate: () => Promise.reject(fault) } });
    expect(world.faults).toEqual([fault]);
    expect(await turnOf(dana, turn.id)).toMatchObject({ status: 'finished', outcome: 'failed' });
    // A second delivery of the job finds it finished.
    await world.runTurn(dana, turn.id);
    expect(asked()).toEqual([]);
  });

  it('is never run twice: a turn found running was interrupted, and one that is gone is left alone', async () => {
    const dana = await world.connected();
    const { thread, turn } = await say(dana, 'Build a form');
    await world.database.runJobs(['ai.assistant_turn']);
    await world.database.as('crm_owner', (sql) =>
      sql.query(
        `update ai.assistant_turns set status = 'running', started_at = now() where id = $1`,
        [parsePublicId('assistant_turn', turn.id)],
      ),
    );
    await world.runTurn(dana, turn.id);
    expect(asked()).toEqual([]);
    const interrupted = await turnOf(dana, turn.id);
    expect(interrupted).toMatchObject({ status: 'finished', outcome: 'interrupted' });
    expect(interrupted.message).toContain('The server restarted while I was working');
    expect((await effectMessagesOf(dana, thread.id)).at(-1)).toMatchObject({ code: 'interrupted' });
    await world.runTurn(dana, turn.id);
    // A turn deleted with its thread, and an id that names none.
    await world.ask(deleteAssistantThread, dana, { params: { id: thread.id } });
    await world.runTurn(dana, turn.id);
    expect(world.turnEvents.map((event) => event.outcome)).toEqual(['interrupted']);
  });

  for (const proof of ['committed', 'refused', 'missing', 'retired-read'] as const)
    it(`recovers ${proof} execution evidence without calling the model or replaying a write`, async () => {
      const dana = await world.connected();
      const { thread, turn } = await say(dana, 'Create exactly one tag');
      await world.database.runJobs(['ai.assistant_turn']);
      const businessId = dana.context.businessId;
      const threadId = parsePublicId('assistant_thread', thread.id);
      const turnId = parsePublicId('assistant_turn', turn.id);
      if (businessId === undefined || threadId === undefined || turnId === undefined)
        throw new Error('Invalid recovery fixture identity.');
      const callId = `${randomUUID()}:recovery`;
      const tool = world.toolbox.tools.find((entry) => entry.operationId === 'createTag');
      if (tool?.commandName === undefined) throw new Error('Missing native audited tag tool.');
      const agent: Person['invocation'] = {
        permissions: 'all',
        agent: 'copilot',
        assistantToolCallId: callId,
        context: {
          agencyId: dana.context.agencyId,
          businessId,
          userId: dana.userId,
          actorKind: 'ai_agent',
          correlationId: randomUUID(),
        },
      };
      const input = { body: { name: 'Created before crash' } };
      if (proof === 'refused')
        expect(
          (
            await world.toolbox.run(tool, input, {
              ...agent,
              assistantToolCallId: `${callId}:first`,
            })
          ).ok,
        ).toBe(true);
      if (proof === 'committed' || proof === 'refused')
        expect((await world.toolbox.run(tool, input, agent)).ok).toBe(proof === 'committed');
      const worker: Person['context'] = {
        agencyId: dana.context.agencyId,
        businessId,
        actorKind: 'system',
        correlationId: randomUUID(),
      };
      await world.database.withTenant(worker, async (sql) => {
        await sql.query(
          "update ai.assistant_turns set status = 'running', started_at = now() where id = $1",
          [turnId],
        );
        await sql.query(
          `insert into ai.assistant_tool_calls
          (business_id, thread_id, turn_id, user_id, call_id, operation_id, command_name, effect)
          values (app.business_id(), $1, $2, $3, $4, $5, $6, $7)`,
          [
            threadId,
            turnId,
            dana.userId,
            callId,
            proof === 'retired-read' ? 'removedReadTool' : 'createTag',
            proof === 'retired-read' ? null : tool.commandName,
            proof === 'retired-read' ? 'read' : 'draft',
          ],
        );
      });
      await Promise.all([world.runTurn(dana, turn.id), world.runTurn(dana, turn.id)]);
      const state =
        proof === 'committed' ? 'completed' : proof === 'refused' ? 'failed' : 'uncertain';
      expect(
        await world.database.withTenant(worker, (sql) =>
          sql.query('select state from ai.assistant_tool_calls where turn_id = $1', [turnId]),
        ),
      ).toEqual([{ state }]);
      expect(await turnOf(dana, turn.id)).toMatchObject({ outcome: 'interrupted' });
      expect(
        (await messagesOf(dana, thread.id)).find((message) => message.activity?.callId === callId),
      ).toMatchObject({ activity: { state, ok: state === 'completed', target: null } });
      expect(
        (await messagesOf(dana, thread.id)).filter(
          (message) => message.activity?.callId === callId,
        ),
      ).toHaveLength(1);
      await world.runTurn(dana, turn.id);
      expect(await world.tags(dana)).toEqual(
        proof === 'committed' || proof === 'refused' ? ['Created before crash'] : [],
      );
      expect(asked()).toEqual([]);
      expect(world.faults).toEqual([]);
    });

  it('preserves the original requirements after native conversation history is bounded', async () => {
    const dana = await world.connected();
    const original = 'Keep the form private, ask before publishing, and never send email or SMS.';
    const { thread } = await say(dana, original);
    world.claude.next(anthropicText('I will keep those requirements.'));
    await world.runTurns();
    for (let index = 0; index < 17; index++) {
      await sayIn(dana, thread.id, `Review field ${String(index + 1)} without publishing.`);
      world.claude.next(anthropicText('The field was reviewed.'));
      await world.runTurns();
    }
    const last = bodyOf(17);
    expect(JSON.stringify(last.messages.slice(0, -1))).not.toContain(original);
    expect(JSON.stringify(last.messages.at(-1)?.content)).toContain(original);
    const threadId = parsePublicId('assistant_thread', thread.id);
    const saved = await world.database.as('crm_owner', (sql) =>
      sql.query<{ checkpoint: { omitted: number; requirements: { text: string }[] } }>(
        'select checkpoint from ai.assistant_threads where id = $1',
        [threadId],
      ),
    );
    expect(saved[0]?.checkpoint.requirements[0]?.text).toBe(original);
    expect(saved[0]?.checkpoint.omitted).toBeGreaterThan(0);
    expect(world.faults).toEqual([]);
  });

  it('gives a turn what was said before in order, joining what a provider would refuse', () => {
    expect(
      alternating([
        { role: 'assistant', parts: [{ type: 'text', text: 'Left out: nobody asked yet.' }] },
        { role: 'user', text: 'First' },
        { role: 'user', text: 'Second' },
        { role: 'assistant', parts: [{ type: 'text', text: 'One' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'Two' }] },
        { role: 'user', text: 'Third' },
      ]),
    ).toEqual([
      { role: 'user', text: 'First\n\nSecond' },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'One' },
          { type: 'text', text: 'Two' },
        ],
      },
      { role: 'user', text: 'Third' },
    ]);
  });
});
