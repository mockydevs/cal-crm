import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import * as publicContracts from './index.js';
import {
  applyProposalInput,
  assistantEndpoints,
  autonomyLevels,
  conversationAssistant,
  DEFAULT_AUTONOMY,
  draftReplyJob,
  draftRequest,
  proposal,
  setAutonomyInput,
} from './ai-proposals.js';
import { parseInput } from './validation.js';
import { proposalChange } from './ai-proposals.js';

it('shows live CRM changes as explicit confirmation cards, with server-computed details', () => {
  const change = {
    kind: 'crm_change',
    operationId: 'savePipelines',
    name: 'Pipelines',
    details: { pipelineCount: 2 },
  };
  expect(proposalChange.parse(change)).toEqual(change);
});

const UUID = '01890a5d-ac96-774b-bcce-b302099a8057';
const at = '2026-10-10T09:00:00.000Z';
const proposalId = toPublicId('proposal', UUID);
const conversationId = toPublicId('conversation', UUID);

const reply = {
  id: proposalId,
  agent: 'inbox',
  kind: 'reply',
  status: 'pending',
  autonomy: 'ask',
  summary: 'Reply to Maya about June 13',
  conversationId,
  change: {
    kind: 'reply',
    channel: 'email',
    accountId: toPublicId('channel_account', UUID),
    to: toPublicId('contact_identity', UUID),
    subject: 'Re: June 13',
    text: 'Hi Maya, June 13 is open.',
  },
  basis: { messages: 4, facts: 2, summary: true, knowledge: ['Business profile'] },
  stale: false,
  edited: false,
  canDecide: true,
  result: null,
  undo: null,
  createdAt: at,
  expiresAt: at,
  decidedAt: null,
  decidedBy: null,
  undoneAt: null,
  undoneBy: null,
};

it('exports every assistant endpoint through the canonical contract package', () => {
  expect(assistantEndpoints.map((endpoint) => endpoint.operationId)).toEqual([
    'getConversationAssistant',
    'requestReplyDraft',
    'getProposal',
    'applyProposal',
    'dismissProposal',
    'undoProposal',
    'listContactProposals',
    'getAutonomy',
    'setAutonomy',
  ]);
  for (const endpoint of assistantEndpoints) {
    expect(publicContracts).toHaveProperty(endpoint.operationId, endpoint);
    expect(publicContracts.endpoints).toContain(endpoint);
    expect(endpoint.group).toBe('Assistant');
  }
});

it('starts every assistant at asking first', () => {
  expect(DEFAULT_AUTONOMY).toBe('ask');
  expect(autonomyLevels).toEqual(['suggest', 'ask', 'act']);
});

describe('a proposal', () => {
  it('shows a drafted reply as text with where it would go', () => {
    expect(proposal.parse(reply)).toEqual(reply);
  });

  it('shows a change to a conversation as before and after', () => {
    const status = { kind: 'conversation_status', from: 'open', to: 'closed', until: null };
    expect(
      proposal.parse({ ...reply, kind: 'conversation_status', change: status }).change,
    ).toEqual(status);
  });

  it('says whether an applied one can be undone, and why not', () => {
    const applied = {
      ...reply,
      status: 'applied',
      result: { messageId: toPublicId('message', UUID) },
      undo: {
        available: false,
        reason: 'message_sent',
        message: 'A sent message can’t be unsent.',
      },
      decidedAt: at,
      decidedBy: { kind: 'user', name: 'Sam Rivers', you: true },
    };
    expect(proposal.parse(applied)).toEqual(applied);
    expect(() =>
      proposal.parse({ ...applied, undo: { available: false, reason: 'because', message: null } }),
    ).toThrow();
  });

  it('refuses a status, a kind, an agent or a change it does not know', () => {
    for (const wrong of [
      { status: 'sent' },
      { kind: 'contact_delete' },
      { agent: 'robot' },
      { autonomy: 'always' },
      {
        change: {
          kind: 'reply',
          channel: 'fax',
          accountId: 'x',
          to: null,
          subject: null,
          text: '',
        },
      },
      { change: { kind: 'conversation_status', from: 'open', to: 'gone', until: null } },
      { id: toPublicId('message', UUID) },
    ])
      expect(() => proposal.parse({ ...reply, ...wrong })).toThrow();
  });
});

describe('applying a proposal', () => {
  it('takes nothing, or what to run instead as an object', () => {
    expect(parseInput(applyProposalInput, {})).toEqual({});
    expect(parseInput(applyProposalInput, { changes: { text: 'Hello' } })).toEqual({
      changes: { text: 'Hello' },
    });
    for (const wrong of [{ changes: 'Hello' }, { changes: ['Hello'] }, { text: 'Hello' }])
      expect(() => parseInput(applyProposalInput, wrong)).toThrow();
  });
});

describe('a request for a draft', () => {
  const pending = {
    id: toPublicId('draft_request', UUID),
    status: 'pending',
    outcome: null,
    reason: null,
    message: null,
    origin: 'person',
    createdAt: at,
    finishedAt: null,
  };

  it('is pending, or finished with one of the ways it can end', () => {
    expect(draftRequest.parse(pending)).toEqual(pending);
    const paused = {
      ...pending,
      status: 'finished',
      outcome: 'paused',
      reason: 'limit_reached',
      message: 'This month’s AI spending limit is reached.',
      finishedAt: at,
    };
    expect(draftRequest.parse(paused)).toEqual(paused);
    expect(() => draftRequest.parse({ ...paused, outcome: 'sent' })).toThrow();
    expect(() => draftRequest.parse({ ...pending, origin: 'model' })).toThrow();
  });

  it('is carried to the worker as the conversation, and never as words to send', () => {
    expect(draftReplyJob.parse({ conversationId: UUID })).toEqual({ conversationId: UUID });
    expect(() => draftReplyJob.parse({ conversationId })).toThrow();
    expect(() => draftReplyJob.parse({ conversationId: UUID, text: 'Send this' })).toThrow();
  });
});

describe('autonomy', () => {
  it('is set for the business, or for one contact, or removed', () => {
    expect(
      parseInput(setAutonomyInput, { agent: 'inbox', action: 'send_message', level: 'act' }),
    ).toEqual({ agent: 'inbox', action: 'send_message', contactId: null, level: 'act' });
    const contactId = toPublicId('contact', UUID);
    expect(
      parseInput(setAutonomyInput, {
        agent: 'inbox',
        action: 'send_message',
        contactId,
        level: null,
      }),
    ).toEqual({ agent: 'inbox', action: 'send_message', contactId, level: null });
    for (const wrong of [
      { agent: 'inbox', action: 'send_message' },
      { agent: 'inbox', action: 'send_message', level: 'always' },
      { agent: 'robot', action: 'send_message', level: 'ask' },
      { agent: 'inbox', action: 'delete_everything', level: 'act' },
      { agent: 'inbox', action: 'send_message', level: 'ask', contactId: conversationId },
      { agent: 'inbox', action: 'send_message', level: 'ask', businessId: 'x' },
    ])
      expect(() => parseInput(setAutonomyInput, wrong)).toThrow();
  });

  it('is shown for a conversation with where the level comes from', () => {
    const assistant = {
      ai: 'ready',
      canDraft: true,
      autonomy: {
        agent: 'inbox',
        action: 'send_message',
        level: 'ask',
        source: 'default',
        businessLevel: 'ask',
        canChange: false,
      },
      draft: null,
      proposals: [reply],
    };
    expect(conversationAssistant.parse(assistant)).toEqual(assistant);
    expect(() => conversationAssistant.parse({ ...assistant, ai: 'maybe' })).toThrow();
  });
});
