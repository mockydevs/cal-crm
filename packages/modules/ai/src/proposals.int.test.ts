// Proposals, approvals and undo against real Postgres under row-level security, through the
// routes the app registers. The two commands proposed here stand in for the Inbox's own
// (test/assistant-world.ts); the Inbox's own are proven in the messaging module and,
// composed with this one, in apps/server.
import { randomUUID } from 'node:crypto';

import { ApprovalRequiredError } from '@repo/commands';
import {
  applyProposal,
  dismissProposal,
  getConversationAssistant,
  getProposal,
  undoProposal,
  type Proposal,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { startAssistantWorld, type AssistantWorld } from '../test/assistant-world.js';
import type { Person } from '../test/settings-world.js';
import { expireAiProposals } from './maintenance.js';
import { storeProposal, type ProposalDraft } from './proposals.js';

let world: AssistantWorld;
beforeAll(async () => {
  world = await startAssistantWorld(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});
beforeEach(() => {
  world.clock.now = new Date('2026-10-10T09:00:00.000Z');
});

const asOwner = <Row extends object>(text: string, values: unknown[] = []) =>
  world.database.as('crm_owner', (sql) => sql.query<Row>(text, values));

/** A person, a conversation in their business, and what the inbox agent proposes for it. */
async function setUp() {
  const dana = await world.admin();
  const talk = await world.conversation(dana);
  const propose = (draft: Partial<ProposalDraft> & Pick<ProposalDraft, 'kind' | 'input'>) =>
    withTenant(world.db, world.assistant(dana).context, (trx) =>
      storeProposal(trx, world.assistant(dana), world.proposables, {
        agent: 'inbox',
        summary: 'Reply to Maya',
        autonomy: 'ask',
        ...draft,
      }),
    ).then(({ id }) => toPublicId('proposal', id));
  const reply = (text = 'Hi Maya, June 13 is open.', more: Partial<ProposalDraft> = {}) =>
    propose({ kind: 'reply', input: talk.reply(text), ...more });
  const audits = () =>
    asOwner<{
      command: string;
      outcome: string;
      error_code: string | null;
      proposal: string | null;
    }>(
      `select command, outcome, error_code, proposal_id as proposal from audit.commands
       where business_id = $1 order by recorded_at, id`,
      [dana.context.businessId],
    );
  const events = () =>
    asOwner<{ type: string; actor_kind: string; actor_id: string | null; proposal: string | null }>(
      `select type, actor_kind, actor_id, proposal_id as proposal from events.events
       where business_id = $1 order by recorded_at, id`,
      [dana.context.businessId],
    );
  return { dana, talk, propose, reply, audits, events };
}

const read = (person: Pick<Person, 'invocation'>, id: string): Promise<Proposal> =>
  world.ask(getProposal, person, { params: { id } });
const apply = (
  person: Pick<Person, 'invocation'>,
  id: string,
  body: unknown = {},
): Promise<Proposal> => world.ask(applyProposal, person, { params: { id }, body });
const dismiss = (person: Pick<Person, 'invocation'>, id: string): Promise<Proposal> =>
  world.ask(dismissProposal, person, { params: { id } });
const undo = (person: Pick<Person, 'invocation'>, id: string): Promise<Proposal> =>
  world.ask(undoProposal, person, { params: { id } });
const uuidOf = (id: string): string => parsePublicId('proposal', id) ?? '';

/** Someone else on the same team, with every permission or only those given. */
async function colleague(of: Person): Promise<Person> {
  const other = await world.admin(of.context.agencyId);
  const { businessId } = of.context;
  if (businessId === undefined) throw new Error('No business.');
  const context = { ...other.context, businessId };
  return { ...other, context, invocation: { ...other.invocation, context } };
}

describe('storing a proposal', () => {
  it('keeps the command and what it would do, and runs nothing', async () => {
    const { dana, talk, reply, audits, events } = await setUp();
    const id = await reply('Hi Maya, June 13 is open.', {
      basis: { messages: 3, facts: 1, summary: false, knowledge: ['Business profile'] },
      expiresAt: new Date('2026-10-17T09:00:00.000Z'),
    });
    expect(await read(dana, id)).toMatchObject({
      id,
      agent: 'inbox',
      kind: 'reply',
      status: 'pending',
      autonomy: 'ask',
      summary: 'Reply to Maya',
      conversationId: talk.publicId,
      change: { kind: 'reply', text: 'Hi Maya, June 13 is open.' },
      basis: { messages: 3, facts: 1, summary: false, knowledge: ['Business profile'] },
      stale: false,
      edited: false,
      canDecide: true,
      result: null,
      undo: null,
      expiresAt: '2026-10-17T09:00:00.000Z',
      decidedAt: null,
      decidedBy: null,
      undoneAt: null,
      undoneBy: null,
    });
    // Proposing sent nothing, changed nothing, and is no command: nothing is audited.
    expect(await talk.sent()).toEqual([]);
    expect(await events()).toEqual([]);
    expect(await audits()).toEqual([]);
    const [row] = await asOwner<{ command: unknown; revision: string }>(
      'select command, revision from ai.proposals where id = $1',
      [uuidOf(id)],
    );
    expect(row).toMatchObject({
      command: {
        name: 'test.send',
        input: { id: talk.publicId, reply: { text: 'Hi Maya, June 13 is open.' } },
      },
      revision: 'thread:0',
    });
  });

  it('keeps nothing whose command would refuse its input', async () => {
    const { talk, propose } = await setUp();
    await expect(
      propose({ kind: 'reply', input: { id: talk.publicId, reply: talk.changes('   ') } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      propose({ kind: 'reply', input: { ...talk.reply('x'), to: 'everyone' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      propose({
        kind: 'reply',
        input: {
          ...talk.reply('x'),
          id: toPublicId('conversation', randomUUID().replace(/^(.{14})./, '$17')),
        },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(
      await asOwner('select 1 from ai.proposals where conversation_id = $1', [talk.id]),
    ).toEqual([]);
  });

  it('takes a kind only from an assistant that may propose it', async () => {
    const { talk, propose } = await setUp();
    await expect(
      propose({ agent: 'copilot', kind: 'reply', input: talk.reply('From the copilot') }),
    ).rejects.toThrow('The copilot assistant may not propose a reply.');
  });

  it('replaces the waiting proposal of the same kind for the conversation, and no other', async () => {
    const { dana, talk, reply, propose } = await setUp();
    const first = await reply('First draft');
    const status = await propose({
      kind: 'conversation_status',
      input: await talk.statusChange('closed'),
    });
    const other = await world.conversation(dana);
    const elsewhere = await withTenant(world.db, world.assistant(dana).context, (trx) =>
      storeProposal(trx, world.assistant(dana), world.proposables, {
        agent: 'inbox',
        kind: 'reply',
        input: other.reply('For another conversation'),
        summary: 'Reply',
        autonomy: 'ask',
      }),
    );
    const second = await reply('Second draft');
    expect(await read(dana, first)).toMatchObject({
      status: 'expired',
      decidedBy: { kind: 'system', name: null, you: false },
    });
    expect((await read(dana, second)).status).toBe('pending');
    expect((await read(dana, status)).status).toBe('pending');
    expect((await read(dana, toPublicId('proposal', elsewhere.id))).status).toBe('pending');
    // The Inbox shows what waits: the new draft and the status change, not the old draft.
    const shown = await world.ask(getConversationAssistant, dana, {
      params: { id: talk.publicId },
    });
    expect(shown.proposals.map((each) => each.id).sort()).toEqual([second, status].sort());
  });
});

describe('Apply', () => {
  it('runs the proposal’s command once, as the person, through the command layer', async () => {
    const { dana, talk, reply, audits, events } = await setUp();
    const id = await reply();
    const applied = await apply(dana, id);
    expect(applied).toMatchObject({
      id,
      status: 'applied',
      edited: false,
      stale: false,
      undo: {
        available: false,
        reason: 'message_sent',
        message: 'A message that was sent can’t be unsent.',
      },
      decidedBy: { kind: 'user', name: dana.name, you: true },
    });
    expect(applied.result?.messageId).toMatch(/^msg_/);
    expect(applied.decidedAt).not.toBeNull();
    expect(await talk.sent()).toEqual(['Hi Maya, June 13 is open.']);
    // Attributed to the person who approved, and marked with the proposal in both logs.
    expect(await audits()).toEqual([
      { command: 'test.send', outcome: 'ok', error_code: null, proposal: uuidOf(id) },
    ]);
    expect(await events()).toEqual([
      {
        type: 'message.submitted',
        actor_kind: 'user',
        actor_id: dana.userId,
        proposal: uuidOf(id),
      },
    ]);
    const [row] = await asOwner<{ applied_event_id: string | null; decided_by_id: string | null }>(
      'select applied_event_id, decided_by_id from ai.proposals where id = $1',
      [uuidOf(id)],
    );
    expect(row?.decided_by_id).toBe(dana.userId);
    // The first event the command wrote: where "Why?" starts from.
    const [event] = await asOwner<{ id: string }>(
      'select id from events.events where proposal_id = $1',
      [uuidOf(id)],
    );
    expect(row?.applied_event_id).toBe(event?.id);
  });

  it('runs what the person changed it to, says it was edited, and keeps its own retry key', async () => {
    const { dana, talk, reply } = await setUp();
    const id = await reply('The draft');
    const applied = await apply(dana, id, {
      changes: {
        ...talk.changes('My own words.'),
        idempotencyKey: 'another-key-000000000000000000',
      },
    });
    expect(applied).toMatchObject({
      status: 'applied',
      edited: true,
      change: { kind: 'reply', text: 'My own words.' },
    });
    expect(await talk.sent()).toEqual(['My own words.']);
    const [row] = await asOwner<{ command: { input: { reply: { idempotencyKey: string } } } }>(
      'select command from ai.proposals where id = $1',
      [uuidOf(id)],
    );
    expect(row?.command.input.reply.idempotencyKey).toMatch(/^proposal-[0-9a-f]{32}$/);
  });

  it('checks a change as it checks any input, and leaves the proposal waiting when it does not fit', async () => {
    const { dana, talk, reply, propose, audits } = await setUp();
    const id = await reply('The draft');
    await expect(apply(dana, id, { changes: talk.changes('  ') })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      apply(dana, id, { changes: { ...talk.changes('Fine'), bcc: 'Not a field' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(apply(dana, id, { changes: 'Send this' })).rejects.toBeInstanceOf(ValidationError);
    expect(await talk.sent()).toEqual([]);
    expect((await read(dana, id)).status).toBe('pending');
    expect(await audits()).toMatchObject([
      { command: 'test.send', outcome: 'invalid', proposal: uuidOf(id) },
      { command: 'test.send', outcome: 'invalid', proposal: uuidOf(id) },
    ]);
    // A kind that allows no change takes none.
    const status = await propose({
      kind: 'conversation_status',
      input: await talk.statusChange('closed'),
    });
    const attempt = apply(dana, status, { changes: { status: 'open' } });
    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toMatchObject({
      issues: [{ path: '/changes', code: 'not_changeable' }],
    });
    expect(await talk.status()).toBe('open');
    // The proposal is still there to apply as it was proposed.
    expect((await apply(dana, id)).status).toBe('applied');
    expect(await talk.sent()).toEqual(['The draft']);
  });

  it('applies once on a double click: the second answers with the first one’s outcome', async () => {
    const { dana, talk, reply, audits } = await setUp();
    const id = await reply();
    const first = await apply(dana, id);
    const again = await apply(dana, id);
    // Not even a change sent with the second click runs anything.
    const withChange = await apply(dana, id, { changes: talk.changes('Something else') });
    expect(again).toEqual(first);
    expect(withChange).toEqual(first);
    expect(await talk.sent()).toEqual(['Hi Maya, June 13 is open.']);
    expect(await audits()).toHaveLength(1);
  });

  it('applies once when two people approve at the same moment', async () => {
    const { dana, talk, reply, audits, events } = await setUp();
    const sam = await colleague(dana);
    const id = await reply();
    // Dana's apply is stopped inside its transaction, with the proposal's row held.
    const hold = world.holdNext();
    const first = apply(dana, id);
    await hold.reached;
    // Sam's apply reaches the same row and waits on Dana's lock.
    const second = apply(sam, id);
    await world.waitingOnLock(1);
    expect(await talk.sent()).toEqual([]);
    hold.release();
    const [danas, sams] = await Promise.all([first, second]);
    expect(danas.status).toBe('applied');
    expect(danas.decidedBy).toMatchObject({ kind: 'user', name: dana.name, you: true });
    // Sam is answered with Dana's outcome: the same message, decided by Dana.
    expect(sams).toMatchObject({
      status: 'applied',
      result: danas.result,
      decidedAt: danas.decidedAt,
      decidedBy: { kind: 'user', you: false },
    });
    expect(await talk.sent()).toEqual(['Hi Maya, June 13 is open.']);
    expect(await audits()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it('refuses a proposal once what it was made on has changed, and says so', async () => {
    const { dana, talk, reply, audits } = await setUp();
    const id = await reply();
    await talk.newMessage();
    expect(await read(dana, id)).toMatchObject({ status: 'pending', stale: true });
    const attempt = apply(dana, id);
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toThrow(
      'Things have changed since this was suggested, so it was not applied. Ask for a new suggestion, or dismiss this one.',
    );
    // Changing the words does not make it fresh: the thread still moved on.
    await expect(apply(dana, id, { changes: talk.changes('Edited') })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await talk.sent()).toEqual([]);
    expect((await read(dana, id)).status).toBe('pending');
    expect(await audits()).toMatchObject([
      { command: 'test.send', outcome: 'failed', error_code: 'conflict', proposal: uuidOf(id) },
      { command: 'test.send', outcome: 'failed', error_code: 'conflict', proposal: uuidOf(id) },
    ]);
  });

  it('refuses a proposal from the moment its time is up, swept or not', async () => {
    const { dana, talk, reply } = await setUp();
    const id = await reply('In time', { expiresAt: new Date('2026-10-10T10:00:00.000Z') });
    world.clock.now = new Date('2026-10-10T10:00:00.000Z');
    expect((await read(dana, id)).status).toBe('expired');
    const attempt = apply(dana, id);
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toThrow('This suggestion has expired. Ask for a new one.');
    await expect(dismiss(dana, id)).rejects.toThrow('This suggestion has already expired.');
    expect(await talk.sent()).toEqual([]);
    const shown = await world.ask(getConversationAssistant, dana, {
      params: { id: talk.publicId },
    });
    expect(shown.proposals).toEqual([]);
    // A minute earlier it applies.
    const other = await reply('Just in time', { expiresAt: new Date('2026-10-10T10:00:00.001Z') });
    expect((await apply(dana, other)).status).toBe('applied');
  });

  it('refuses a dismissed proposal and an undone one', async () => {
    const { dana, talk, reply, propose } = await setUp();
    const dismissed = await reply('Dismissed');
    await dismiss(dana, dismissed);
    await expect(apply(dana, dismissed)).rejects.toThrow(
      'This suggestion was dismissed, so it can no longer be applied.',
    );
    const status = await propose({
      kind: 'conversation_status',
      input: await talk.statusChange('closed'),
    });
    await apply(dana, status);
    await undo(dana, status);
    await expect(apply(dana, status)).rejects.toThrow(
      'This suggestion was applied and then undone. Ask for a new one.',
    );
    expect(await talk.sent()).toEqual([]);
    expect(await talk.status()).toBe('open');
  });

  it('is refused as the command would refuse the person, and stays waiting', async () => {
    const { dana, talk, reply, audits } = await setUp();
    const id = await reply('REFUSED BY POLICY');
    const attempt = apply(dana, id);
    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toMatchObject({ issues: [{ code: 'refused' }] });
    expect(await talk.sent()).toEqual([]);
    expect((await read(dana, id)).status).toBe('pending');
    expect(await audits()).toMatchObject([
      { command: 'test.send', outcome: 'invalid', proposal: uuidOf(id) },
    ]);
    // Changed into something the command takes, it applies.
    expect(
      (await apply(dana, id, { changes: talk.changes('A reply the pipeline takes') })).status,
    ).toBe('applied');
  });

  it('needs the permission the proposal’s command needs, and nothing less', async () => {
    const { dana, talk, reply, propose, audits } = await setUp();
    const id = await reply();
    const status = await propose({
      kind: 'conversation_status',
      input: await talk.statusChange('closed'),
    });
    const viewer = world.limited(dana, []);
    const manager = world.limited(dana, ['conversations.manage', 'ai.manage']);
    const replier = world.limited(dana, ['conversations.reply']);

    for (const person of [viewer, manager]) {
      const attempt = apply(person, id);
      await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
      await expect(attempt).rejects.toMatchObject({ permission: 'conversations.reply' });
      await expect(dismiss(person, id)).rejects.toMatchObject({
        permission: 'conversations.reply',
      });
    }
    for (const person of [viewer, replier]) {
      await expect(apply(person, status)).rejects.toMatchObject({
        permission: 'conversations.manage',
      });
      await expect(dismiss(person, status)).rejects.toMatchObject({
        permission: 'conversations.manage',
      });
    }
    expect(await talk.sent()).toEqual([]);
    expect(await talk.status()).toBe('open');
    // Each sees the proposal, and is told whether deciding it is theirs.
    expect(await read(viewer, id)).toMatchObject({ status: 'pending', canDecide: false });
    expect((await read(replier, id)).canDecide).toBe(true);
    expect((await read(replier, status)).canDecide).toBe(false);
    expect((await read(manager, status)).canDecide).toBe(true);
    // Every refusal is on record; a refused Apply names the proposal it was about.
    const refusals = await audits();
    expect(refusals).toHaveLength(8);
    expect(refusals.every((row) => row.outcome === 'denied')).toBe(true);
    expect(
      refusals.filter((row) => row.command !== 'proposal.dismiss').map((row) => row.proposal),
    ).toEqual([uuidOf(id), uuidOf(id), uuidOf(status), uuidOf(status)]);
    // With the right permission and no other, each applies.
    expect((await apply(replier, id)).status).toBe('applied');
    expect((await apply(manager, status)).status).toBe('applied');
  });

  it('holds an assistant that applies a proposal to its autonomy rule', async () => {
    const { dana, talk, reply, audits } = await setUp();
    const id = await reply();
    const agent = { invocation: world.assistant(dana) };
    await expect(apply(agent, id)).rejects.toBeInstanceOf(ApprovalRequiredError);
    for (const level of ['suggest', 'ask'] as const) {
      await world.setRule(dana, 'send_message', level);
      await expect(apply(agent, id)).rejects.toBeInstanceOf(ApprovalRequiredError);
    }
    // A rule that lets it change conversations says nothing about sending.
    await world.setRule(dana, 'update_conversation', 'act');
    await expect(apply(agent, id)).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(await talk.sent()).toEqual([]);
    expect((await read(dana, id)).status).toBe('pending');
    expect((await audits()).map((row) => row.error_code)).toEqual([
      'approval_required',
      'approval_required',
      'approval_required',
      'approval_required',
    ]);

    await world.setRule(dana, 'send_message', 'act');
    expect(await apply(agent, id)).toMatchObject({
      status: 'applied',
      decidedBy: { kind: 'ai_agent', name: null, you: false },
    });
    expect(await talk.sent()).toEqual(['Hi Maya, June 13 is open.']);
  });

  it('does not show or decide a row of a kind this version has no command for', async () => {
    const { dana, talk } = await setUp();
    const [row] = await world.database.withTenant(dana.context, (sql) =>
      sql.query<{ id: string }>(
        `insert into ai.proposals (business_id, agent, kind, conversation_id, summary, command, after, autonomy, revision)
         values (app.business_id(), 'cleanup', 'merge_tags', $1, 'Merge two tags',
                 '{"name": "tags.merge", "input": {}}', '{"kind": "merge_tags"}', 'ask', 'tags:1')
         returning id`,
        [talk.id],
      ),
    );
    const id = toPublicId('proposal', row?.id ?? '');
    for (const call of [read, apply, dismiss, undo])
      await expect(call(dana, id)).rejects.toBeInstanceOf(NotFoundError);
    const shown = await world.ask(getConversationAssistant, dana, {
      params: { id: talk.publicId },
    });
    expect(shown.proposals).toEqual([]);
    const [after] = await asOwner<{ status: string }>(
      'select status from ai.proposals where id = $1',
      [row?.id],
    );
    expect(after?.status).toBe('pending');
  });
});

describe('Dismiss', () => {
  it('closes a waiting proposal and runs nothing', async () => {
    const { dana, talk, reply, audits, events } = await setUp();
    const id = await reply();
    expect(await dismiss(dana, id)).toMatchObject({
      status: 'dismissed',
      result: null,
      undo: null,
      decidedBy: { kind: 'user', name: dana.name, you: true },
    });
    expect(await talk.sent()).toEqual([]);
    expect(await audits()).toEqual([
      { command: 'proposal.dismiss', outcome: 'ok', error_code: null, proposal: null },
    ]);
    expect(await events()).toMatchObject([{ type: 'proposal.dismissed', actor_kind: 'user' }]);
    const shown = await world.ask(getConversationAssistant, dana, {
      params: { id: talk.publicId },
    });
    expect(shown.proposals).toEqual([]);
  });

  it('dismisses once: again is the same proposal, with nothing more recorded', async () => {
    const { dana, reply, events } = await setUp();
    const id = await reply();
    const first = await dismiss(dana, id);
    expect(await dismiss(dana, id)).toEqual(first);
    expect(await events()).toHaveLength(1);
  });

  it('dismisses a stale proposal, and refuses one that was applied', async () => {
    const { dana, talk, reply } = await setUp();
    const stale = await reply('Stale');
    await talk.newMessage();
    expect((await dismiss(dana, stale)).status).toBe('dismissed');
    const applied = await reply('Applied');
    await apply(dana, applied);
    await expect(dismiss(dana, applied)).rejects.toThrow(
      'This suggestion was already applied, so it can’t be dismissed.',
    );
    expect((await read(dana, applied)).status).toBe('applied');
  });
});

describe('Undo', () => {
  it('reverses an applied change with the command worked out when it was applied', async () => {
    const { dana, talk, propose, audits } = await setUp();
    const id = await propose({
      kind: 'conversation_status',
      input: await talk.statusChange('closed'),
    });
    const applied = await apply(dana, id);
    expect(applied).toMatchObject({
      status: 'applied',
      change: { kind: 'conversation_status', from: 'open', to: 'closed' },
      undo: { available: true, reason: null, message: null },
    });
    expect(await talk.status()).toBe('closed');

    const undone = await undo(dana, id);
    expect(undone).toMatchObject({
      status: 'undone',
      undo: null,
      decidedAt: applied.decidedAt,
      undoneBy: { kind: 'user', name: dana.name, you: true },
    });
    expect(undone.undoneAt).not.toBeNull();
    expect(await talk.status()).toBe('open');
    // Both runs are the command's own, each marked with the proposal.
    expect(await audits()).toEqual([
      { command: 'test.set_status', outcome: 'ok', error_code: null, proposal: uuidOf(id) },
      { command: 'test.set_status', outcome: 'ok', error_code: null, proposal: uuidOf(id) },
    ]);
  });

  it('undoes once: again is the same proposal, and nothing runs a second time', async () => {
    const { dana, talk, propose, audits } = await setUp();
    const id = await propose({
      kind: 'conversation_status',
      input: await talk.statusChange('closed'),
    });
    await apply(dana, id);
    const first = await undo(dana, id);
    expect(await undo(dana, id)).toEqual(first);
    expect(await talk.status()).toBe('open');
    expect(await audits()).toHaveLength(2);
  });

  it('undoes once when two people undo at the same moment', async () => {
    const { dana, talk, propose, audits } = await setUp();
    const sam = await colleague(dana);
    const id = await propose({
      kind: 'conversation_status',
      input: await talk.statusChange('closed'),
    });
    await apply(dana, id);
    const hold = world.holdNext();
    const first = undo(dana, id);
    await hold.reached;
    const second = undo(sam, id);
    await world.waitingOnLock(1);
    hold.release();
    const [danas, sams] = await Promise.all([first, second]);
    expect(danas.status).toBe('undone');
    expect(sams).toMatchObject({ status: 'undone', undoneAt: danas.undoneAt });
    expect(await talk.status()).toBe('open');
    expect(await audits()).toHaveLength(2);
  });

  it('says plainly that a sent message cannot be unsent, and changes nothing', async () => {
    const { dana, talk, reply, audits } = await setUp();
    const id = await reply();
    await apply(dana, id);
    const attempt = undo(dana, id);
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toThrow('A message that was sent can’t be unsent.');
    expect(await read(dana, id)).toMatchObject({
      status: 'applied',
      undo: { available: false, reason: 'message_sent' },
    });
    expect(await talk.sent()).toEqual(['Hi Maya, June 13 is open.']);
    expect(await audits()).toHaveLength(1);
  });

  it('says only that it cannot be undone when the reason is one it has no words for', async () => {
    const { dana, reply } = await setUp();
    const id = await reply('UNKNOWN REASON');
    expect((await apply(dana, id)).undo).toEqual({
      available: false,
      reason: null,
      message: 'This can’t be undone from here.',
    });
    await expect(undo(dana, id)).rejects.toThrow('This can’t be undone from here.');
  });

  it('refuses where the record was changed again after the proposal was applied', async () => {
    const { dana, talk, propose } = await setUp();
    const id = await propose({
      kind: 'conversation_status',
      input: await talk.statusChange('closed'),
    });
    await apply(dana, id);
    // Someone reopens it by hand: the way back was worked out for a closed conversation.
    await world.database.withTenant(dana.context, (sql) =>
      sql.query(`update messaging.conversations set status = 'open' where id = $1`, [talk.id]),
    );
    const attempt = undo(dana, id);
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toThrow(
      'This was changed again after the suggestion was applied, so undoing it would overwrite newer work. Nothing was changed.',
    );
    expect(await read(dana, id)).toMatchObject({ status: 'applied', undo: { available: true } });
    expect(await talk.status()).toBe('open');
  });

  it('undoes only what was applied', async () => {
    const { dana, talk, reply, propose } = await setUp();
    const waiting = await propose({
      kind: 'conversation_status',
      input: await talk.statusChange('closed'),
    });
    await expect(undo(dana, waiting)).rejects.toThrow(
      'Only a suggestion that was applied can be undone.',
    );
    const dismissed = await reply('Dismissed');
    await dismiss(dana, dismissed);
    await expect(undo(dana, dismissed)).rejects.toThrow(
      'Only a suggestion that was applied can be undone.',
    );
    expect(await talk.status()).toBe('open');
  });

  it('needs the permission the proposal’s command needs, whether or not it can be undone', async () => {
    const { dana, talk, reply, propose } = await setUp();
    const status = await propose({
      kind: 'conversation_status',
      input: await talk.statusChange('closed'),
    });
    await apply(dana, status);
    const sent = await reply();
    await apply(dana, sent);
    const viewer = world.limited(dana, []);
    await expect(undo(viewer, status)).rejects.toMatchObject({
      permission: 'conversations.manage',
    });
    await expect(undo(world.limited(dana, ['conversations.reply']), status)).rejects.toMatchObject({
      permission: 'conversations.manage',
    });
    // A viewer is told they may not, not why it could not be undone anyway.
    await expect(undo(viewer, sent)).rejects.toMatchObject({ permission: 'conversations.reply' });
    expect(await talk.status()).toBe('closed');
    expect((await undo(world.limited(dana, ['conversations.manage']), status)).status).toBe(
      'undone',
    );
  });

  it('holds an assistant that undoes to its autonomy rule', async () => {
    const { dana, talk, propose } = await setUp();
    const id = await propose({
      kind: 'conversation_status',
      input: await talk.statusChange('closed'),
    });
    await apply(dana, id);
    const agent = { invocation: world.assistant(dana) };
    await expect(undo(agent, id)).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(await talk.status()).toBe('closed');
    await world.setRule(dana, 'update_conversation', 'act');
    expect(await undo(agent, id)).toMatchObject({
      status: 'undone',
      undoneBy: { kind: 'ai_agent', name: null, you: false },
    });
  });
});

describe('another business', () => {
  let ours: Awaited<ReturnType<typeof setUp>>;
  let reply: string;
  let status: string;
  let theirs: Person;
  let sibling: Person;
  beforeAll(async () => {
    ours = await setUp();
    reply = await ours.reply('Ours alone');
    status = await ours.propose({
      kind: 'conversation_status',
      input: await ours.talk.statusChange('closed'),
    });
    await apply(ours.dana, status);
    theirs = await world.admin();
    sibling = await world.admin(ours.dana.context.agencyId);
  });

  it('cannot read, apply, dismiss or undo our proposals: to it they do not exist', async () => {
    for (const person of [theirs, sibling]) {
      for (const id of [reply, status]) {
        await expect(read(person, id)).rejects.toBeInstanceOf(NotFoundError);
        await expect(apply(person, id)).rejects.toBeInstanceOf(NotFoundError);
        await expect(dismiss(person, id)).rejects.toBeInstanceOf(NotFoundError);
        await expect(undo(person, id)).rejects.toBeInstanceOf(NotFoundError);
      }
      await expect(
        world.ask(getConversationAssistant, person, { params: { id: ours.talk.publicId } }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(await ours.talk.sent()).toEqual([]);
    expect(await ours.talk.status()).toBe('closed');
    expect((await read(ours.dana, reply)).status).toBe('pending');
  });

  it('cannot propose about our conversation, or see our rows under row-level security', async () => {
    await expect(
      withTenant(world.db, world.assistant(theirs).context, (trx) =>
        storeProposal(trx, world.assistant(theirs), world.proposables, {
          agent: 'inbox',
          kind: 'reply',
          input: ours.talk.reply('Reached from another business'),
          summary: 'Reply',
          autonomy: 'ask',
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    for (const person of [theirs, sibling])
      expect(
        await world.database.withTenant(person.context, (sql) =>
          sql.query('select id from ai.proposals'),
        ),
      ).toEqual([]);
  });

  it('is refused a malformed id as it is refused a missing one, at every door', async () => {
    const missing = toPublicId('proposal', '01890a5d-ac96-774b-bcce-b302099a8057');
    await expect(read(ours.dana, missing)).rejects.toBeInstanceOf(NotFoundError);
    await expect(apply(ours.dana, missing)).rejects.toBeInstanceOf(NotFoundError);
    await expect(dismiss(ours.dana, missing)).rejects.toBeInstanceOf(NotFoundError);
    await expect(undo(ours.dana, missing)).rejects.toBeInstanceOf(NotFoundError);
    for (const call of [read, apply, dismiss, undo])
      await expect(call(ours.dana, 'prop_wrong')).rejects.toBeInstanceOf(ValidationError);
    // At the agency, outside any business, there are no proposals to decide.
    const { businessId: _none, ...atTheAgency } = ours.dana.context;
    const staff = { invocation: { ...ours.dana.invocation, context: atTheAgency } };
    for (const call of [read, apply, dismiss, undo])
      await expect(call(staff, reply)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('the hourly sweep', () => {
  it('closes waiting proposals whose time is up, so they are no longer listed as waiting', async () => {
    const { dana, reply } = await setUp();
    const due = await reply('Due', { expiresAt: new Date('2020-01-01T00:00:00.000Z') });
    expect(await expireAiProposals(world.services)).toBeGreaterThanOrEqual(1);
    const [row] = await asOwner<{ status: string; decided_by_kind: string }>(
      'select status, decided_by_kind from ai.proposals where id = $1',
      [uuidOf(due)],
    );
    expect(row).toEqual({ status: 'expired', decided_by_kind: 'system' });
    expect((await read(dana, due)).decidedBy).toEqual({ kind: 'system', name: null, you: false });
  });
});
