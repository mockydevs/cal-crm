import {
  autonomySetting,
  autonomySettings,
  conversationAssistant,
  conversationStatuses,
  draftOutcomes,
  draftRequest,
  proposal,
  replyRefusalCodes,
  type DraftOutcome,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { describe, expect, it } from 'vitest';
import {
  appliedStatusOf,
  assistantOf,
  autonomyOf,
  autonomySettingsOf,
  draftOf,
  endedDraftOf,
  noAssistant,
  replyProposalOf,
  sam,
  sentReplyOf,
  statusProposalOf,
  theAssistant,
  you,
} from '../e2e/assistant-fixtures';
import {
  accountId,
  bookings,
  composerOf,
  identityId,
  mayaEmail,
  openChat,
  siteChat,
} from '../e2e/inbox-fixtures';
import {
  assistantViewOf,
  basisOf,
  canWriteReply,
  draftFailureReasons,
  draftNoticeOf,
  firstNameOf,
  isQuiet,
  isReplyProposal,
  isStatusProposal,
  pollEveryOf,
  recentLineOf,
  replyActionsOf,
  replyRouteOf,
  staleReasonOf,
  statusSuggestionOf,
  statusWords,
  stillOffered,
} from './inbox-assistant-rules';
import { failureOf, serverRefusalWords } from './inbox-rules';

const problem = (status: number, detail: string, errors?: unknown[]): ApiError =>
  new ApiError({
    type: 'about:blank',
    title: 'Problem',
    status,
    detail,
    ...(errors === undefined ? {} : { errors }),
  } as ApiError['problem']);

describe('the fixtures', () => {
  it('are what the contract says the API sends', () => {
    for (const each of [
      replyProposalOf(),
      replyProposalOf({ stale: true, canDecide: false }),
      sentReplyOf(),
      sentReplyOf({ decidedBy: theAssistant, autonomy: 'act' }),
      sentReplyOf({ decidedBy: sam, edited: true }),
      statusProposalOf(),
      appliedStatusOf(),
      appliedStatusOf({ status: 'undone', undoneAt: '2026-10-09T08:20:00.000Z', undoneBy: you }),
    ]) {
      expect(proposal.parse(each)).toEqual(each);
    }
    for (const each of [draftOf(), endedDraftOf('failed', 'timeout'), endedDraftOf('refused')]) {
      expect(draftRequest.parse(each)).toEqual(each);
    }
    for (const each of [
      assistantOf(),
      noAssistant(),
      assistantOf({ draft: draftOf(), proposals: [replyProposalOf(), appliedStatusOf()] }),
      assistantOf({ autonomy: { level: 'act', source: 'contact', canChange: false } }),
    ]) {
      expect(conversationAssistant.parse(each)).toEqual(each);
    }
    expect(autonomySetting.parse(autonomyOf())).toEqual(autonomyOf());
    expect(
      autonomySettings.parse(autonomySettingsOf({ level: 'act', source: 'business' })),
    ).toEqual(autonomySettingsOf({ level: 'act', source: 'business' }));
  });
});

describe('what kind a proposal is', () => {
  it('tells a reply from a change of status by what it would do', () => {
    expect(isReplyProposal(replyProposalOf())).toBe(true);
    expect(isStatusProposal(replyProposalOf())).toBe(false);
    expect(isStatusProposal(statusProposalOf())).toBe(true);
    expect(isReplyProposal(statusProposalOf())).toBe(false);
  });
});

describe('draftNoticeOf', () => {
  it('says nothing while a draft is being written, or when there was no request', () => {
    expect(draftNoticeOf(null)).toBeUndefined();
    expect(draftNoticeOf(draftOf())).toBeUndefined();
    expect(draftNoticeOf(draftOf({ status: 'finished', outcome: null }))).toBeUndefined();
  });

  it('never shows a request that ended in a draft, or one overtaken by events', () => {
    expect(draftNoticeOf(endedDraftOf('drafted'))).toBeUndefined();
    expect(draftNoticeOf(endedDraftOf('superseded'))).toBeUndefined();
  });

  it('has words for every other outcome the contract defines, ending in what to do', () => {
    const silent: readonly DraftOutcome[] = ['drafted', 'superseded'];
    for (const outcome of draftOutcomes.filter((each) => !silent.includes(each))) {
      const notice = draftNoticeOf(endedDraftOf(outcome));
      expect(notice, outcome).toBeDefined();
      expect(notice?.words.message, outcome).toMatch(/\.$/);
    }
  });

  it('never repeats the API’s own words, which are English only', () => {
    const notice = draftNoticeOf(endedDraftOf('failed', 'timeout'));
    expect(notice?.words.message).not.toContain('No draft was written.');
  });

  it('has its own words for each reason a draft failed, and offers another try', () => {
    const reasons = [
      'timeout',
      'rate_limited',
      'unavailable',
      'authentication',
      'billing',
      'invalid_request',
      'invalid_response',
      'not_found',
      'blocked_address',
      'empty_answer',
      'cut_short',
      'too_long',
    ];
    expect([...draftFailureReasons].sort()).toEqual([...reasons].sort());
    const words = new Set<string | undefined>();
    for (const reason of reasons) {
      const notice = draftNoticeOf(endedDraftOf('failed', reason));
      expect(notice?.retry, reason).toBe('try_again');
      expect(notice?.words.message, reason).toMatch(/write your own reply\.$/);
      words.add(notice?.words.message);
    }
    expect(words.size).toBe(reasons.length);
  });

  it('falls back to plain words for a reason this version does not know, or none', () => {
    const unknown = draftNoticeOf(endedDraftOf('failed', 'something_new'));
    expect(unknown?.words.message).toBe(
      'The draft couldn’t be written. Try again, or write your own reply.',
    );
    expect(unknown).toEqual(draftNoticeOf(endedDraftOf('failed')));
    // A name every object has is not a reason.
    expect(draftNoticeOf(endedDraftOf('failed', 'toString'))).toEqual(unknown);
  });

  it('points to Settings where the fix is there, and nowhere else', () => {
    expect(draftNoticeOf(endedDraftOf('failed', 'authentication'))?.settings).toBe(true);
    expect(draftNoticeOf(endedDraftOf('failed', 'billing'))?.settings).toBe(true);
    expect(draftNoticeOf(endedDraftOf('failed', 'not_found'))?.settings).toBe(true);
    expect(draftNoticeOf(endedDraftOf('failed', 'blocked_address'))?.settings).toBe(true);
    expect(draftNoticeOf(endedDraftOf('paused', 'limit_reached'))?.settings).toBe(true);
    expect(draftNoticeOf(endedDraftOf('paused', 'price_unknown'))?.settings).toBe(true);
    expect(draftNoticeOf(endedDraftOf('ai_off'))?.settings).toBe(true);
    expect(draftNoticeOf(endedDraftOf('not_configured'))?.settings).toBe(true);
    expect(draftNoticeOf(endedDraftOf('failed', 'timeout'))?.settings).toBe(false);
    expect(draftNoticeOf(endedDraftOf('refused'))?.settings).toBe(false);
    expect(draftNoticeOf(endedDraftOf('expired'))?.settings).toBe(false);
    expect(draftNoticeOf(endedDraftOf('cannot_reply'))?.settings).toBe(false);
  });

  it('names the limit that paused it', () => {
    expect(draftNoticeOf(endedDraftOf('paused', 'limit_reached'))?.words.message).toContain(
      'spending limit has been reached',
    );
    expect(draftNoticeOf(endedDraftOf('paused', 'price_unknown'))?.words.message).toContain(
      'has no price',
    );
  });

  it('asks a refused draft to be drafted again, and offers nothing where a try would end the same', () => {
    expect(draftNoticeOf(endedDraftOf('refused'))?.retry).toBe('draft_again');
    expect(draftNoticeOf(endedDraftOf('expired'))?.retry).toBe('try_again');
    expect(draftNoticeOf(endedDraftOf('nothing_to_answer', 'answered'))?.retry).toBeNull();
    expect(draftNoticeOf(endedDraftOf('nothing_to_answer', 'automated'))?.retry).toBeNull();
    expect(draftNoticeOf(endedDraftOf('cannot_reply'))?.retry).toBeNull();
    expect(draftNoticeOf(endedDraftOf('nothing_to_answer', 'automated'))?.words.message).toContain(
      'came from a machine',
    );
    expect(draftNoticeOf(endedDraftOf('nothing_to_answer', 'answered'))?.words.message).toContain(
      'nothing new to answer',
    );
  });
});

describe('replyActionsOf', () => {
  const fresh = { stale: false, canDecide: true };

  it('offers Send it, Change it and Not now when the assistant asks first', () => {
    expect(
      replyActionsOf({ proposal: fresh, level: 'ask', canEdit: true, canDraft: true }),
    ).toEqual(['send', 'change', 'dismiss']);
    expect(
      replyActionsOf({ proposal: fresh, level: 'act', canEdit: true, canDraft: true }),
    ).toEqual(['send', 'change', 'dismiss']);
  });

  it('never offers Send it at "Suggest": the draft is for the person to send themselves', () => {
    expect(
      replyActionsOf({ proposal: fresh, level: 'suggest', canEdit: true, canDraft: true }),
    ).toEqual(['use', 'dismiss']);
  });

  it('offers no change where there is no reply box to change it in', () => {
    expect(
      replyActionsOf({ proposal: fresh, level: 'ask', canEdit: false, canDraft: true }),
    ).toEqual(['send', 'dismiss']);
    expect(
      replyActionsOf({ proposal: fresh, level: 'suggest', canEdit: false, canDraft: true }),
    ).toEqual(['dismiss']);
  });

  it('offers nothing to someone whose role cannot decide it', () => {
    expect(
      replyActionsOf({
        proposal: { stale: false, canDecide: false },
        level: 'ask',
        canEdit: true,
        canDraft: true,
      }),
    ).toEqual([]);
  });

  it('never sends a stale draft: it can be drafted again, or set aside', () => {
    const stale = { stale: true, canDecide: true };
    expect(
      replyActionsOf({ proposal: stale, level: 'ask', canEdit: true, canDraft: true }),
    ).toEqual(['redraft', 'dismiss']);
    expect(
      replyActionsOf({ proposal: stale, level: 'ask', canEdit: true, canDraft: false }),
    ).toEqual(['dismiss']);
    expect(
      replyActionsOf({
        proposal: { stale: true, canDecide: false },
        level: 'ask',
        canEdit: true,
        canDraft: false,
      }),
    ).toEqual([]);
  });
});

describe('a suggested change of status', () => {
  it('is closing, snoozing or reopening, by where it would leave the conversation', () => {
    expect(statusSuggestionOf({ to: 'closed' })).toBe('close');
    expect(statusSuggestionOf({ to: 'snoozed' })).toBe('snooze');
    expect(statusSuggestionOf({ to: 'open' })).toBe('reopen');
  });

  it('has a word for every status the contract defines', () => {
    expect(Object.keys(statusWords).sort()).toEqual([...conversationStatuses].sort());
  });
});

describe('recentLineOf', () => {
  it('says the assistant replied on its own when nobody approved it', () => {
    expect(recentLineOf(sentReplyOf({ decidedBy: theAssistant }))).toBe('assistant_replied');
  });

  it('says a person sent the draft, as it was or after changing it', () => {
    expect(recentLineOf(sentReplyOf())).toBe('reply_sent');
    expect(recentLineOf(sentReplyOf({ edited: true }))).toBe('reply_sent_changed');
    expect(recentLineOf(sentReplyOf({ decidedBy: null, undo: null }))).toBe('reply_sent');
  });

  it('says an approved draft was not sent when the pipeline refused it', () => {
    expect(
      recentLineOf(
        sentReplyOf({
          undo: {
            available: false,
            reason: 'not_sent',
            message: 'This reply was never sent, so there is nothing to undo.',
          },
        }),
      ),
    ).toBe('reply_not_sent');
  });

  it('says a change of status was applied, or undone', () => {
    expect(recentLineOf(appliedStatusOf())).toBe('status_applied');
    expect(recentLineOf(appliedStatusOf({ status: 'undone' }))).toBe('status_undone');
  });

  it('gives no line to what is waiting, dismissed or expired', () => {
    expect(recentLineOf(replyProposalOf())).toBeUndefined();
    expect(recentLineOf(replyProposalOf({ status: 'dismissed' }))).toBeUndefined();
    expect(recentLineOf(replyProposalOf({ status: 'undone' }))).toBeUndefined();
    expect(recentLineOf(statusProposalOf())).toBeUndefined();
    expect(recentLineOf(statusProposalOf({ status: 'expired' }))).toBeUndefined();
  });
});

describe('assistantViewOf', () => {
  it('shows nothing at all where there is no assistant: no nagging', () => {
    for (const ai of ['off', 'not_connected'] as const) {
      const view = assistantViewOf(assistantOf({ ai }));
      expect(view.offerDraft).toBe(false);
      expect(view.autonomy).toBe('hidden');
      expect(isQuiet(view)).toBe(true);
    }
    expect(isQuiet(assistantViewOf(noAssistant()))).toBe(true);
  });

  it('still shows what waits, and what was done, after AI was turned off', () => {
    const view = assistantViewOf(
      assistantOf({ ai: 'off', proposals: [replyProposalOf(), appliedStatusOf()] }),
    );
    expect(view.reply?.id).toBe(replyProposalOf().id);
    expect(view.recent).toHaveLength(1);
    expect(view.canDraft).toBe(false);
    expect(isQuiet(view)).toBe(false);
  });

  it('offers a quiet "Draft a reply" when nothing waits and the person may ask', () => {
    const view = assistantViewOf(assistantOf());
    expect(view.offerDraft).toBe(true);
    expect(view.canDraft).toBe(true);
    expect(view.writing).toBe(false);
    expect(view.reply).toBeUndefined();
    expect(isQuiet(view)).toBe(false);
  });

  it('offers no draft to someone who may not ask for one', () => {
    const view = assistantViewOf(assistantOf({ canDraft: false }));
    expect(view.offerDraft).toBe(false);
    expect(view.canDraft).toBe(false);
    // The level is still theirs to see.
    expect(isQuiet(view)).toBe(false);
  });

  it('says a draft is being written, and offers no second one meanwhile', () => {
    const view = assistantViewOf(assistantOf({ draft: draftOf() }));
    expect(view.writing).toBe(true);
    expect(view.offerDraft).toBe(false);
    expect(view.canDraft).toBe(false);
    expect(view.notice).toBeUndefined();
  });

  it('shows why there is no draft in place of the quiet button', () => {
    const view = assistantViewOf(assistantOf({ draft: endedDraftOf('failed', 'timeout') }));
    expect(view.notice?.retry).toBe('try_again');
    expect(view.offerDraft).toBe(false);
    expect(view.canDraft).toBe(true);
  });

  it('puts each proposal where it belongs: waiting reply, waiting changes, what was done', () => {
    const view = assistantViewOf(
      assistantOf({
        proposals: [
          replyProposalOf(),
          statusProposalOf(),
          sentReplyOf({ id: replyProposalOf().id.replace(/1$/, '3') }),
          appliedStatusOf({ id: replyProposalOf().id.replace(/1$/, '4') }),
          statusProposalOf({ id: replyProposalOf().id.replace(/1$/, '5'), status: 'dismissed' }),
        ],
      }),
    );
    expect(view.reply?.change.text).toContain('June 13 is open');
    expect(view.changes.map((each) => each.change.to)).toEqual(['closed']);
    expect(view.recent.map((each) => recentLineOf(each))).toEqual(['reply_sent', 'status_applied']);
    expect(view.offerDraft).toBe(false);
  });

  it('shows the level as a control to those who may change it, as a sentence to the rest', () => {
    expect(assistantViewOf(assistantOf()).autonomy).toBe('control');
    expect(assistantViewOf(assistantOf({ autonomy: { canChange: false } })).autonomy).toBe(
      'sentence',
    );
  });
});

describe('pollEveryOf', () => {
  it('asks again every three seconds only while a draft is being written', () => {
    expect(pollEveryOf(undefined)).toBe(false);
    expect(pollEveryOf(assistantOf())).toBe(false);
    expect(pollEveryOf(assistantOf({ draft: endedDraftOf('failed') }))).toBe(false);
    expect(pollEveryOf(assistantOf({ draft: draftOf() }))).toBe(3000);
  });
});

describe('basisOf', () => {
  it('lists what the product counted, in the order the card says it', () => {
    expect(
      basisOf({ messages: 4, facts: 2, summary: true, knowledge: ['Business profile'] }),
    ).toEqual({
      parts: [{ kind: 'messages', count: 4 }, { kind: 'facts', count: 2 }, { kind: 'summary' }],
      knowledge: ['Business profile'],
    });
  });

  it('leaves out what counts nothing, and knowledge with no name', () => {
    expect(basisOf({ messages: 1, facts: 0, summary: false, knowledge: [' ', ''] })).toEqual({
      parts: [{ kind: 'messages', count: 1 }],
      knowledge: [],
    });
    expect(basisOf({ messages: 0, facts: 3, summary: false, knowledge: [' Prices '] })).toEqual({
      parts: [{ kind: 'facts', count: 3 }],
      knowledge: ['Prices'],
    });
  });

  it('is empty when nothing was recorded', () => {
    expect(basisOf(null)).toEqual({ parts: [], knowledge: [] });
  });
});

describe('replyRouteOf', () => {
  it('names the account and the address a draft would go from and to', () => {
    expect(
      replyRouteOf(composerOf(), { channel: 'email', accountId: bookings.id, to: mayaEmail.id }),
    ).toEqual({ channel: 'email', from: 'Bookings · bookings@harbor.test', to: mayaEmail.address });
  });

  it('sends a chat reply to the visitor, from a widget that has no address', () => {
    expect(
      replyRouteOf(composerOf({ channels: [openChat] }), {
        channel: 'webchat',
        accountId: siteChat.id,
        to: null,
      }),
    ).toEqual({ channel: 'webchat', from: 'Harbor website', to: null });
  });

  it('says nothing when the account or the address is not among what the composer offers', () => {
    const composer = composerOf();
    expect(replyRouteOf(undefined, { channel: 'email', accountId: bookings.id, to: null })).toBe(
      undefined,
    );
    expect(
      replyRouteOf(composer, { channel: 'email', accountId: accountId('9'), to: mayaEmail.id }),
    ).toBeUndefined();
    expect(
      replyRouteOf(composer, { channel: 'email', accountId: bookings.id, to: identityId('9') }),
    ).toBeUndefined();
    expect(
      replyRouteOf(composer, { channel: 'email', accountId: bookings.id, to: null }),
    ).toBeUndefined();
    // Text messages aren't set up in this business.
    expect(
      replyRouteOf(composer, { channel: 'sms', accountId: bookings.id, to: mayaEmail.id }),
    ).toBeUndefined();
  });
});

describe('canWriteReply', () => {
  it('is true only when the composer has a reply form', () => {
    expect(canWriteReply(composerOf())).toBe(true);
    expect(canWriteReply(undefined)).toBe(false);
    expect(canWriteReply(composerOf({ canReply: false }))).toBe(false);
    expect(canWriteReply(composerOf({ channels: [] }))).toBe(false);
  });
});

describe('firstNameOf', () => {
  it('is the first word of a name, and nothing for a contact with no name', () => {
    expect(firstNameOf('Maya Thompson')).toBe('Maya');
    expect(firstNameOf('  Maya   Thompson ')).toBe('Maya');
    expect(firstNameOf('maya@example.test')).toBe('maya@example.test');
    expect(firstNameOf('')).toBeUndefined();
    expect(firstNameOf('   ')).toBeUndefined();
  });
});

describe('failureOf', () => {
  it('passes on the server’s plain words when the proposal changed first', () => {
    expect(failureOf(problem(409, 'Maya wrote again after this was drafted.'))).toEqual({
      kind: 'conflict',
      detail: 'Maya wrote again after this was drafted.',
    });
  });

  it('uses the composer’s own words for every reply refusal the contract defines', () => {
    for (const code of replyRefusalCodes) {
      expect(
        failureOf(
          problem(422, 'Refused.', [{ path: '/reply/text', code, message: 'Server words.' }]),
        ),
      ).toEqual({ kind: 'refused', words: serverRefusalWords[code], message: 'Server words.' });
    }
  });

  it('falls back to the server’s message for a refusal it has no words for', () => {
    expect(
      failureOf(
        problem(422, 'Refused.', [
          {
            path: '/changes',
            code: 'not_changeable',
            message: 'This suggestion can’t be changed.',
          },
        ]),
      ),
    ).toEqual({ kind: 'refused', words: undefined, message: 'This suggestion can’t be changed.' });
    expect(failureOf(problem(422, 'The input was refused.'))).toEqual({
      kind: 'refused',
      words: undefined,
      message: 'The input was refused.',
    });
  });

  it('tells a role’s refusal, a lost connection and anything else apart', () => {
    expect(failureOf(problem(403, 'It needs conversations.reply.'))).toEqual({ kind: 'forbidden' });
    expect(failureOf(new TypeError('Failed to fetch'))).toEqual({ kind: 'network' });
    expect(failureOf(undefined)).toEqual({ kind: 'network' });
    expect(failureOf(problem(503, 'Unavailable.'))).toEqual({
      kind: 'other',
      message: 'Unavailable.',
    });
  });
});

describe('staleReasonOf', () => {
  const drafted = { createdAt: '2026-10-09T08:00:00.000Z' };

  it('is nothing for a draft that can still be sent', () => {
    expect(staleReasonOf({ ...drafted, stale: false }, '2026-10-09T09:00:00.000Z')).toBeUndefined();
  });

  it('says the contact wrote again when their newest message is newer than the draft', () => {
    expect(staleReasonOf({ ...drafted, stale: true }, '2026-10-09T08:00:01.000Z')).toBe(
      'contact_wrote',
    );
  });

  it('says only that the conversation changed when it cannot tell who changed it', () => {
    expect(staleReasonOf({ ...drafted, stale: true }, '2026-10-09T07:58:00.000Z')).toBe('changed');
    expect(staleReasonOf({ ...drafted, stale: true }, drafted.createdAt)).toBe('changed');
    expect(staleReasonOf({ ...drafted, stale: true }, undefined)).toBe('changed');
  });
});

describe('stillOffered', () => {
  const waiting = replyProposalOf();
  const other = statusProposalOf();

  it('takes a click on a draft that still waits', () => {
    const read = assistantOf({ proposals: [waiting, other] });
    expect(stillOffered(read, 'send', waiting.id)).toBe(true);
    expect(stillOffered(read, 'dismiss', waiting.id)).toBe(true);
    expect(stillOffered(read, 'apply', other.id)).toBe(true);
  });

  it('ignores a click on a draft that was just sent, set aside, or is gone', () => {
    for (const read of [
      assistantOf({ proposals: [sentReplyOf()] }),
      assistantOf({ proposals: [replyProposalOf({ status: 'dismissed' })] }),
      assistantOf({ proposals: [replyProposalOf({ status: 'expired' })] }),
      assistantOf(),
    ]) {
      expect(stillOffered(read, 'send', waiting.id)).toBe(false);
      expect(stillOffered(read, 'dismiss', waiting.id)).toBe(false);
    }
    expect(stillOffered(assistantOf({ proposals: [waiting] }), 'send')).toBe(false);
  });

  it('never sends or applies what is out of date, but still sets it aside', () => {
    const read = assistantOf({ proposals: [replyProposalOf({ stale: true })] });
    expect(stillOffered(read, 'send', waiting.id)).toBe(false);
    expect(stillOffered(read, 'apply', waiting.id)).toBe(false);
    expect(stillOffered(read, 'dismiss', waiting.id)).toBe(true);
  });

  it('undoes only what is applied and can be undone', () => {
    const applied = appliedStatusOf();
    expect(stillOffered(assistantOf({ proposals: [applied] }), 'undo', applied.id)).toBe(true);
    expect(
      stillOffered(
        assistantOf({ proposals: [appliedStatusOf({ status: 'undone', undo: null })] }),
        'undo',
        applied.id,
      ),
    ).toBe(false);
    expect(stillOffered(assistantOf({ proposals: [sentReplyOf()] }), 'undo', waiting.id)).toBe(
      false,
    );
    expect(stillOffered(assistantOf({ proposals: [statusProposalOf()] }), 'undo', other.id)).toBe(
      false,
    );
  });

  it('asks for no second draft while one is being written', () => {
    expect(stillOffered(assistantOf(), 'draft')).toBe(true);
    expect(stillOffered(assistantOf({ draft: endedDraftOf('failed') }), 'draft')).toBe(true);
    expect(stillOffered(assistantOf({ draft: draftOf() }), 'draft')).toBe(false);
  });
});
