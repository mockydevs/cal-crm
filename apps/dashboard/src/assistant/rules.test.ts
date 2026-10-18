import { i18n } from '@lingui/core';
import {
  assistantContext,
  assistantMessage,
  assistantThread,
  assistantTurn,
  assistantTurnOutcomes,
  proposal as proposalSchema,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  builtMessages,
  contextOf,
  formContext,
  formsListContext,
  messageOf,
  noPermission,
  notConnected,
  publishedProposalOf,
  publishProposalOf,
  runningTurn,
  threadOf,
  turnId,
  turnOf,
} from '../../e2e/assistant-panel-fixtures';
import { replyProposalOf } from '../../e2e/assistant-fixtures';
import {
  canAsk,
  cardStateOf,
  costOf,
  groupMessages,
  isGone,
  lastActivityWords,
  mergeMessages,
  outcomeWords,
  refusalWords,
  turnIsRunning,
  unavailableWords,
} from './rules';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const said = (words: ReturnType<typeof outcomeWords>): string | null =>
  words === null ? null : typeof words === 'string' ? words : i18n._(words);

describe('the fixtures', () => {
  it('are what the contract says the server sends', () => {
    for (const context of [
      contextOf(),
      formsListContext,
      formContext(),
      notConnected,
      noPermission,
    ])
      expect(assistantContext.safeParse(context).error).toBeUndefined();
    for (const turn of [turnOf(), runningTurn])
      expect(assistantTurn.safeParse(turn).error).toBeUndefined();
    expect(assistantThread.safeParse(threadOf()).error).toBeUndefined();
    for (const message of [...builtMessages(), ...builtMessages(publishedProposalOf())])
      expect(assistantMessage.safeParse(message).error).toBeUndefined();
    for (const proposal of [publishProposalOf(), publishedProposalOf()])
      expect(proposalSchema.safeParse(proposal).error).toBeUndefined();
  });
});

describe('mergeMessages', () => {
  it('keeps what is held when nothing was read', () => {
    const held = [messageOf(1)];
    expect(mergeMessages(held, [])).toBe(held);
  });

  it('adds what was read after what is held, oldest first', () => {
    const merged = mergeMessages([messageOf(1), messageOf(2)], [messageOf(4), messageOf(3)]);
    expect(merged.map((message) => message.seq)).toEqual([1, 2, 3, 4]);
  });

  it('takes the later reading of a message it already holds', () => {
    const merged = mergeMessages([messageOf(1, { text: 'old' })], [messageOf(1, { text: 'new' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe('new');
  });
});

describe('turnIsRunning', () => {
  it('is true until the turn has finished', () => {
    expect(turnIsRunning(runningTurn)).toBe(true);
    expect(turnIsRunning(turnOf({ status: 'queued', outcome: null }))).toBe(true);
    expect(turnIsRunning(turnOf())).toBe(false);
  });

  it('is false without a turn', () => {
    expect(turnIsRunning(null)).toBe(false);
    expect(turnIsRunning(undefined)).toBe(false);
  });
});

describe('groupMessages', () => {
  it('replaces a pending tool activity with its completion, while keeping unrelated steps', () => {
    const activity = {
      operationId: 'createForm',
      effect: 'draft' as const,
      ok: true,
      target: null,
      callId: 'request:call',
    };
    const start = messageOf(1, { kind: 'activity', activity: { ...activity, state: 'started' } });
    const done = messageOf(3, { kind: 'activity', activity: { ...activity, state: 'completed' } });
    const groups = groupMessages([start, messageOf(2, { kind: 'activity' }), done]);
    expect(
      groups.flatMap((group) =>
        group.kind === 'steps' ? group.steps.map((step) => step.seq) : [],
      ),
    ).toEqual([2, 3]);
  });
  it('draws the steps that follow one another as one list', () => {
    const groups = groupMessages(builtMessages());
    expect(groups.map((group) => group.kind)).toEqual(['message', 'steps', 'message', 'message']);
    const steps = groups[1];
    expect(steps?.kind === 'steps' ? steps.steps.map((step) => step.seq) : []).toEqual([2, 3]);
  });

  it('starts a new list for the steps of another turn', () => {
    const activity = { kind: 'activity' } as const;
    const groups = groupMessages([
      messageOf(1, activity),
      messageOf(2, { ...activity, turnId: turnId('2') }),
    ]);
    expect(groups.map((group) => group.kind)).toEqual(['steps', 'steps']);
  });

  it('is empty for an empty conversation', () => {
    expect(groupMessages([])).toEqual([]);
  });
});

describe('outcomeWords', () => {
  const stopped = turnOf({ outcome: 'step_limit', message: 'I stopped after 12 steps.' });

  it('says nothing while the turn runs, when it answered, and with no turn', () => {
    expect(outcomeWords(runningTurn, [])).toBeNull();
    expect(outcomeWords(turnOf(), [])).toBeNull();
    expect(outcomeWords(null, [])).toBeNull();
    expect(outcomeWords(turnOf({ outcome: null }), [])).toBeNull();
  });

  it('gives the sentence the server wrote for a turn that ended another way', () => {
    expect(outcomeWords(stopped, [messageOf(1, { kind: 'user' })])).toBe(
      'I stopped after 12 steps.',
    );
  });

  it('says nothing more when the conversation already ends with that sentence', () => {
    const byCode = messageOf(2, { kind: 'error', code: 'step_limit', text: 'Another wording.' });
    const byText = messageOf(2, { kind: 'error', text: 'I stopped after 12 steps.' });
    expect(outcomeWords(stopped, [byCode])).toBeNull();
    expect(outcomeWords(stopped, [byText])).toBeNull();
  });

  it('still says it when the error is another turn’s, or another kind of message', () => {
    const earlier = messageOf(2, { kind: 'error', code: 'step_limit', turnId: turnId('2') });
    const answer = messageOf(3, { kind: 'assistant', code: 'step_limit' });
    expect(outcomeWords(stopped, [earlier, answer])).toBe('I stopped after 12 steps.');
  });

  it('has words of its own for every way a turn can end without the server’s', () => {
    for (const outcome of assistantTurnOutcomes) {
      const words = said(outcomeWords(turnOf({ outcome, message: null }), []));
      if (outcome === 'answered') expect(words).toBeNull();
      else expect(words).toMatch(/\.$/);
    }
  });
});

describe('costOf', () => {
  it('is what the finished turn came to', () => {
    expect(costOf(turnOf({ costEstimate: '0.004200' }))).toBe(0.0042);
  });

  it('is unknown while it runs, with no turn, and with no cost that can be read', () => {
    expect(costOf(runningTurn)).toBeNull();
    expect(costOf(null)).toBeNull();
    expect(costOf(turnOf({ costEstimate: null }))).toBeNull();
    expect(costOf(turnOf({ costEstimate: '0.000000' }))).toBeNull();
    expect(costOf(turnOf({ costEstimate: 'free' }))).toBeNull();
  });
});

describe('canAsk and unavailableWords', () => {
  it('has a box to type in only where a model can be asked by this person', () => {
    expect(canAsk(contextOf())).toBe(true);
    expect(canAsk(notConnected)).toBe(false);
    expect(canAsk(noPermission)).toBe(false);
    expect(canAsk(undefined)).toBe(false);
  });

  it('says why in the server’s words', () => {
    expect(unavailableWords(notConnected)).toBe(notConnected.message);
  });

  it('has words of its own where the server sent none', () => {
    const none = { message: null, canUse: true } as const;
    expect(said(unavailableWords({ ...none, ai: 'off' }))).toContain('turned off');
    expect(said(unavailableWords({ ...none, ai: 'not_connected' }))).toContain('provider');
    expect(said(unavailableWords({ ...none, ai: 'ready', canUse: false }))).toContain('role');
  });
});

describe('cardStateOf', () => {
  const words = (proposal: Parameters<typeof cardStateOf>[0]): string | null => {
    const state = cardStateOf(proposal);
    return state.words === null ? null : i18n._(state.words);
  };

  it('offers Publish and "Not now" while it waits', () => {
    expect(cardStateOf(publishProposalOf())).toEqual({
      waiting: true,
      canConfirm: true,
      canDismiss: true,
      canUndo: false,
      undoRefusal: null,
      words: null,
    });
  });

  it('cannot be confirmed when the form changed since, and says so', () => {
    const stale = publishProposalOf({ stale: true });
    expect(cardStateOf(stale)).toMatchObject({ canConfirm: false, canDismiss: true });
    expect(words(stale)).toContain('form changed');
    expect(words(replyProposalOf({ stale: true }))).toContain('changed after the assistant');
  });

  it('cannot be decided by someone whose role does not allow it, and says so', () => {
    const denied = publishProposalOf({ canDecide: false });
    expect(cardStateOf(denied)).toMatchObject({ canConfirm: false, canDismiss: false });
    expect(words(denied)).toContain('publishing forms');
    expect(words(replyProposalOf({ canDecide: false }))).toContain('role');
  });

  it('offers Undo once applied, where the server says it can be undone', () => {
    expect(cardStateOf(publishedProposalOf())).toMatchObject({
      waiting: false,
      canUndo: true,
      undoRefusal: null,
    });
    expect(cardStateOf(publishedProposalOf({ canDecide: false })).canUndo).toBe(false);
  });

  it('says why an applied one cannot be undone', () => {
    const live = publishedProposalOf({
      undo: {
        available: false,
        reason: 'published_before',
        message: 'The form was live before, so there is no draft to go back to.',
      },
    });
    expect(cardStateOf(live)).toMatchObject({
      canUndo: false,
      undoRefusal: 'The form was live before, so there is no draft to go back to.',
    });
    expect(cardStateOf(publishedProposalOf({ undo: null }))).toMatchObject({
      canUndo: false,
      undoRefusal: null,
    });
  });

  it('says what became of one that was set aside, undone or left too long', () => {
    expect(words(publishProposalOf({ status: 'dismissed' }))).toContain('Nothing was published');
    expect(words(replyProposalOf({ status: 'dismissed' }))).toContain('Nothing was changed');
    expect(words(publishProposalOf({ status: 'undone' }))).toContain('draft again');
    expect(words(replyProposalOf({ status: 'undone' }))).toBe('Undone.');
    expect(words(publishProposalOf({ status: 'expired' }))).toContain('expired');
    expect(cardStateOf(publishProposalOf({ status: 'expired' })).waiting).toBe(false);
  });
});

describe('refusalWords and isGone', () => {
  const problem = (status: number, detail?: string): ApiError =>
    new ApiError({ type: 'about:blank', title: 'Refused', status, ...(detail && { detail }) });

  it('passes on the sentence of a refusal the server explains', () => {
    const busy = 'The assistant is still working on your last message.';
    expect(refusalWords(problem(409, busy))).toBe(busy);
    expect(refusalWords(problem(403, 'Your role doesn’t include this.'))).toContain('role');
  });

  it('has none for a fault of the server’s, or of the connection', () => {
    expect(refusalWords(problem(500, 'A stack trace.'))).toBeNull();
    expect(refusalWords(new TypeError('Failed to fetch'))).toBeNull();
  });

  it('knows a conversation that is gone', () => {
    expect(isGone(problem(404))).toBe(true);
    expect(isGone(problem(409))).toBe(false);
    expect(isGone(null)).toBe(false);
  });
});

describe('lastActivityWords', () => {
  const now = new Date(2026, 9, 12, 15, 0);

  it('is the time for today', () => {
    expect(lastActivityWords(new Date(2026, 9, 12, 9, 5).toISOString(), now, 'en')).toBe('9:05 AM');
  });

  it('is the day for any day before', () => {
    expect(lastActivityWords(new Date(2026, 9, 11, 9, 5).toISOString(), now, 'en')).toBe('Oct 11');
    expect(lastActivityWords(new Date(2025, 9, 12, 9, 5).toISOString(), now, 'en')).toBe('Oct 12');
    expect(lastActivityWords(new Date(2026, 8, 12, 9, 5).toISOString(), now, 'en')).toBe('Sep 12');
  });
});
