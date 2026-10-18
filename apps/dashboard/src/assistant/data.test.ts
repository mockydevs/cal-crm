import type { Client } from '@repo/sdk';
import { describe, expect, it } from 'vitest';
import {
  messageOf,
  publishedProposalOf,
  publishProposalOf,
  runningTurn,
  threadId,
  threadOf,
  turnOf,
} from '../../e2e/assistant-panel-fixtures';
import { assistantKeys, readConversation, withProposal, withTurnStarted } from './data';
import type { Conversation } from './rules';

interface Call {
  readonly operation: string;
  readonly after: number | undefined;
}

/** A client that answers each operation from a function, and keeps what was asked. */
function clientOf(answer: (call: Call) => unknown): { client: Client; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    request: (endpoint: { operationId: string }, input: { query?: { after?: number } }) => {
      const call = { operation: endpoint.operationId, after: input.query?.after };
      calls.push(call);
      return Promise.resolve(answer(call));
    },
  } as unknown as Client;
  return { client, calls };
}

const id = threadId('1');

describe('assistantKeys', () => {
  it('names the business in every key, so a realtime hint reads them again', () => {
    const page = { route: '/forms', selection: [] };
    for (const key of [
      assistantKeys.all('biz_1'),
      assistantKeys.context('biz_1', page),
      assistantKeys.context('biz_1', { ...page, record: { kind: 'form', id: 'form_1' } }),
      assistantKeys.threads('biz_1'),
      assistantKeys.thread('biz_1', id),
    ])
      expect(key).toContain('biz_1');
  });
});

describe('readConversation', () => {
  it('reads the thread with its newest messages', async () => {
    const { client, calls } = clientOf(() => ({
      thread: threadOf(),
      messages: { items: [messageOf(1), messageOf(2)], cursor: 2, more: false, turn: turnOf() },
    }));
    const read = await readConversation(client, id);
    expect(read.title).toBe(threadOf().title);
    expect(read.messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(read.cursor).toBe(2);
    expect(read.turn).toEqual(turnOf());
    expect(calls).toEqual([{ operation: 'getAssistantThread', after: undefined }]);
  });

  it('reads the earlier messages of a long thread too', async () => {
    const { client, calls } = clientOf((call) =>
      call.operation === 'getAssistantThread'
        ? {
            thread: threadOf(),
            messages: { items: [messageOf(5), messageOf(6)], cursor: 6, more: false, turn: null },
          }
        : call.after === 0
          ? { items: [messageOf(1), messageOf(2)], cursor: 2, more: true, turn: null }
          : { items: [messageOf(3), messageOf(4)], cursor: 4, more: true, turn: null },
    );
    const read = await readConversation(client, id);
    expect(read.messages.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(read.cursor).toBe(6);
    expect(calls.map((call) => call.after)).toEqual([undefined, 0, 2]);
  });

  it('stops asking for earlier messages when none come back', async () => {
    const { client, calls } = clientOf((call) =>
      call.operation === 'getAssistantThread'
        ? {
            thread: threadOf(),
            messages: { items: [messageOf(5)], cursor: 5, more: false, turn: null },
          }
        : { items: [], cursor: 0, more: false, turn: null },
    );
    const read = await readConversation(client, id);
    expect(read.messages.map((message) => message.seq)).toEqual([5]);
    expect(calls).toHaveLength(2);
  });

  it('reads an empty thread without asking for more', async () => {
    const { client, calls } = clientOf(() => ({
      thread: threadOf({ turn: null }),
      messages: { items: [], cursor: 0, more: false, turn: null },
    }));
    expect((await readConversation(client, id)).messages).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('reads only what came after the cursor while the turn runs, until there is no more', async () => {
    const held: Conversation = {
      title: 'Held',
      messages: [messageOf(1)],
      cursor: 1,
      turn: runningTurn,
    };
    const { client, calls } = clientOf((call) =>
      call.after === 1
        ? { items: [messageOf(2)], cursor: 2, more: true, turn: runningTurn }
        : { items: [messageOf(3)], cursor: 3, more: false, turn: turnOf() },
    );
    const read = await readConversation(client, id, held);
    expect(read).toEqual({
      title: 'Held',
      messages: [messageOf(1), messageOf(2), messageOf(3)],
      cursor: 3,
      turn: turnOf(),
    });
    expect(calls).toEqual([
      { operation: 'listAssistantMessages', after: 1 },
      { operation: 'listAssistantMessages', after: 2 },
    ]);
  });

  it('reads everything again once the held turn has finished', async () => {
    const held: Conversation = {
      title: 'Held',
      messages: [messageOf(1)],
      cursor: 1,
      turn: turnOf(),
    };
    const { client, calls } = clientOf(() => ({
      thread: threadOf({ title: 'Read again' }),
      messages: { items: [messageOf(1), messageOf(2)], cursor: 2, more: false, turn: turnOf() },
    }));
    expect((await readConversation(client, id, held)).title).toBe('Read again');
    expect(calls[0]?.operation).toBe('getAssistantThread');
  });
});

describe('withTurnStarted', () => {
  const started = {
    thread: threadOf({ title: 'A new one' }),
    turn: runningTurn,
    message: messageOf(1, { kind: 'user', text: 'Hello' }),
  };

  it('starts a conversation from its first message', () => {
    expect(withTurnStarted(undefined, started)).toEqual({
      title: 'A new one',
      messages: [started.message],
      cursor: 1,
      turn: runningTurn,
    });
  });

  it('adds the message to a conversation that is held, and never moves the cursor back', () => {
    const held: Conversation = {
      title: 'Held',
      messages: [messageOf(1), messageOf(2)],
      cursor: 2,
      turn: turnOf(),
    };
    const next = withTurnStarted(held, { ...started, message: messageOf(3, { kind: 'user' }) });
    expect(next.messages.map((message) => message.seq)).toEqual([1, 2, 3]);
    expect(next.cursor).toBe(3);
    expect(withTurnStarted({ ...held, cursor: 9 }, started).cursor).toBe(9);
  });
});

describe('withProposal', () => {
  it('puts the proposal as the server answered it on its card, and on no other message', () => {
    const held: Conversation = {
      title: 'Held',
      messages: [
        messageOf(1, { kind: 'user' }),
        messageOf(2, { kind: 'proposal', proposal: publishProposalOf() }),
      ],
      cursor: 2,
      turn: turnOf(),
    };
    const next = withProposal(held, publishedProposalOf());
    expect(next.messages[0]).toBe(held.messages[0]);
    expect(next.messages[1]?.proposal?.status).toBe('applied');
  });
});
