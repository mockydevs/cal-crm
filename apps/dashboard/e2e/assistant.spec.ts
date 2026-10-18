// The assistant in the Inbox: reply drafts, suggested changes with Apply and Undo, and how
// much the assistant does on its own. Against a stand-in for the API that keeps one
// conversation and its proposals in memory, answers as the server does (a stale draft is
// refused, an applied one is not applied twice), and checks every write and every answer
// against the contract. The whole product, with a real server and a stand-in model, is in
// e2e/tests at the repository's root.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import {
  applyProposalInput,
  autonomySetting,
  conversationAssistant,
  draftRequest,
  proposal as proposalSchema,
  sendConversationReplyInput,
  setAutonomyInput,
  type AutonomyLevel,
  type Conversation,
  type ConversationAssistant,
  type ConversationComposer,
  type Proposal,
  type SetAutonomyInput,
  type ThreadItem,
  type ThreadMessage,
} from '@repo/contracts';
import {
  appliedStatusOf,
  assistantOf,
  autonomyOf,
  draftedChange,
  draftedText,
  draftOf,
  endedDraftOf,
  noAssistant,
  proposalId,
  replyProposalOf,
  sentReplyOf,
  statusProposalOf,
  theAssistant,
  you,
} from './assistant-fixtures';
import {
  composerOf,
  conversationId,
  conversationOf,
  dana,
  maya,
  mayaOtherEmail,
  membershipId,
  messageId,
  messageOf,
} from './inbox-fixtures';
import { harbor, inHarbor, signedIn } from './session';

/**
 * What a changed draft carries, checked as the reply command would check it: exactly the
 * channel, account, address, subject and text, and no key of its own (the proposal is the
 * key).
 */
function changedReply(changes: Record<string, unknown>): {
  readonly subject: string | null;
  readonly text: string;
} {
  expect(Object.keys(changes).sort()).toEqual(['accountId', 'channel', 'subject', 'text', 'to']);
  const { subject, text } = sendConversationReplyInput.parse({
    ...changes,
    idempotencyKey: 'e2e'.padEnd(32, '0'),
  });
  return { subject, text };
}

/** What the stand-in server holds, and what the page asked of it. */
interface World {
  conversation: Conversation;
  /** Newest first, as the API answers. */
  items: ThreadItem[];
  composer: ConversationComposer;
  assistant: ConversationAssistant;
  /** What a reply becomes: queued, unless a test says the pipeline refuses or holds it. */
  delivery: Partial<ThreadMessage>;
  /** Called before an apply is answered: a test can hold the answer, or cut the line. */
  beforeApply: (route: Route) => Promise<'answer' | 'handled'>;
  applies: { id: string; body: unknown }[];
  dismissals: string[];
  undos: string[];
  draftRequests: number;
  /** Replies sent the ordinary way, by the composer on its own. */
  replies: unknown[];
  autonomySaves: SetAutonomyInput[];
  assistantReads: number;
}

const id = conversationId('1');
const draftId = proposalId('1');
const suggestionId = proposalId('2');
const inbound = messageOf({ id: messageId('2') });

function world(overrides: Partial<World> = {}): World {
  return {
    conversation: conversationOf({ id, unreadCount: 0 }),
    items: [inbound],
    composer: composerOf(),
    assistant: assistantOf({ proposals: [replyProposalOf()] }),
    delivery: { status: 'queued' },
    beforeApply: () => Promise.resolve('answer'),
    applies: [],
    dismissals: [],
    undos: [],
    draftRequests: 0,
    replies: [],
    autonomySaves: [],
    assistantReads: 0,
    ...overrides,
  };
}

const problem = (route: Route, status: number, detail: string): Promise<void> =>
  route.fulfill({
    status,
    contentType: 'application/problem+json',
    json: { type: 'about:blank', title: 'Problem', status, detail },
  });

/** Stands in for the Inbox's API and the assistant's. Every write is parsed with the contract. */
async function assistantApi(page: Page, state: World): Promise<void> {
  const replace = (next: Proposal): Proposal => {
    state.assistant = {
      ...state.assistant,
      proposals: state.assistant.proposals.map((each) => (each.id === next.id ? next : each)),
    };
    return proposalSchema.parse(next);
  };

  await page.route(/\/api\/v1\/inbox\/assignees(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        items: [{ id: membershipId('1'), name: 'Dana Brooks', you: true }],
        nextCursor: null,
      },
    }),
  );
  await page.route(/\/api\/v1\/conversations(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: { canManage: true, canReply: true, items: [state.conversation], nextCursor: null },
    }),
  );
  await page.route(/\/api\/v1\/conversations\/cvn_[^/?]+(?:\/[a-z]+)?(?:\?.*)?$/, async (route) => {
    const request = route.request();
    expect(request.headers()['business-id']).toBe(harbor.id);
    const [, action = ''] =
      /\/conversations\/cvn_[^/?]+(?:\/([a-z]+))?/.exec(new URL(request.url()).pathname) ?? [];
    if (request.method() === 'GET') {
      if (action === 'assistant') {
        state.assistantReads++;
        await route.fulfill({ json: conversationAssistant.parse(state.assistant) });
        return;
      }
      await route.fulfill({
        json:
          action === 'messages'
            ? { items: state.items, nextCursor: null }
            : action === 'composer'
              ? state.composer
              : state.conversation,
      });
      return;
    }
    if (action === 'read') {
      state.conversation = { ...state.conversation, unreadCount: 0 };
      await route.fulfill({ json: state.conversation });
      return;
    }
    if (action === 'replies') {
      const sent = sendConversationReplyInput.parse(request.postDataJSON());
      state.replies.push(sent);
      const message = messageOf({
        id: messageId('8'),
        direction: 'outbound',
        author: you,
        status: 'queued',
        subject: sent.subject,
        text: sent.text,
        createdAt: new Date().toISOString(),
      });
      state.items = [message, ...state.items];
      await route.fulfill({ status: 201, json: message });
      return;
    }
    await problem(route, 404, 'No such route.');
  });

  await page.route(/\/api\/v1\/conversations\/cvn_[^/?]+\/assistant\/draft$/, async (route) => {
    expect(route.request().method()).toBe('POST');
    state.draftRequests++;
    // Asking again while one is being written answers with that one.
    const pending = state.assistant.draft?.status === 'pending' ? state.assistant.draft : draftOf();
    state.assistant = { ...state.assistant, draft: pending };
    await route.fulfill({ status: 201, json: draftRequest.parse(pending) });
  });

  await page.route(/\/api\/v1\/proposals\/prop_[^/?]+\/(?:apply|dismiss|undo)$/, async (route) => {
    const request = route.request();
    expect(request.headers()['business-id']).toBe(harbor.id);
    const [, wanted = '', action = ''] =
      /\/proposals\/(prop_[^/?]+)\/([a-z]+)$/.exec(new URL(request.url()).pathname) ?? [];
    const found = state.assistant.proposals.find((each) => each.id === wanted);
    if (found === undefined) {
      await problem(route, 404, 'No such proposal.');
      return;
    }
    if (action === 'dismiss') {
      state.dismissals.push(wanted);
      await route.fulfill({
        json: replace({
          ...found,
          status: 'dismissed',
          decidedAt: new Date().toISOString(),
          decidedBy: you,
        }),
      });
      return;
    }
    if (action === 'undo') {
      state.undos.push(wanted);
      if (found.change.kind !== 'conversation_status' || found.undo?.available !== true) {
        await problem(route, 409, 'A message that was sent can’t be unsent.');
        return;
      }
      state.conversation = {
        ...state.conversation,
        status: found.change.from,
        revision: 'c'.repeat(64),
      };
      await route.fulfill({
        json: replace({
          ...found,
          status: 'undone',
          undo: null,
          undoneAt: new Date().toISOString(),
          undoneBy: you,
        }),
      });
      return;
    }
    const body = applyProposalInput.parse(request.postDataJSON());
    state.applies.push({ id: wanted, body });
    if ((await state.beforeApply(route)) === 'handled') return;
    // Applying one that is already applied answers with it, and runs nothing again.
    if (found.status === 'applied') {
      await route.fulfill({ json: proposalSchema.parse(found) });
      return;
    }
    if (found.stale) {
      await problem(
        route,
        409,
        'This conversation changed after the suggestion was made. Ask for a new one.',
      );
      return;
    }
    if (found.change.kind === 'conversation_status') {
      state.conversation = {
        ...state.conversation,
        status: found.change.to,
        needsReply: false,
        revision: 'b'.repeat(64),
      };
      await route.fulfill({ json: replace(appliedStatusOf({ id: wanted, change: found.change })) });
      return;
    }
    // The assistant proposes other changes too (a field value, a fact about the contact);
    // this stand-in applies the two a conversation shows.
    if (found.change.kind !== 'reply') throw new Error(`No stand-in applies ${found.change.kind}.`);
    const changes = body.changes === undefined ? undefined : changedReply(body.changes);
    const sent = changes ?? found.change;
    const message = messageOf({
      id: messageId('7'),
      direction: 'outbound',
      author: you,
      status: 'queued',
      subject: sent.subject,
      text: sent.text,
      createdAt: new Date().toISOString(),
      ...state.delivery,
    });
    state.items = [message, ...state.items];
    await route.fulfill({
      json: replace(
        sentReplyOf({
          id: wanted,
          edited: changes !== undefined,
          change: { ...found.change, ...sent },
          ...(message.status === 'failed'
            ? {
                undo: {
                  available: false,
                  reason: 'not_sent',
                  message: 'This reply was never sent, so there is nothing to undo.',
                },
              }
            : {}),
        }),
      ),
    });
  });

  await page.route(/\/api\/v1\/ai\/autonomy(?:\?.*)?$/, async (route) => {
    const request = route.request();
    expect(request.method()).toBe('PUT');
    const input = setAutonomyInput.parse(request.postDataJSON());
    state.autonomySaves.push(input);
    const { businessLevel, canChange } = state.assistant.autonomy;
    const saved = autonomyOf({
      level: input.level ?? businessLevel,
      source: input.level === null ? 'business' : 'contact',
      businessLevel,
    });
    state.assistant = { ...state.assistant, autonomy: { ...saved, canChange } };
    await route.fulfill({ json: autonomySetting.parse(saved) });
  });
}

/**
 * Stands in for the realtime socket (socket.io 4 over Engine.IO 4, websocket only), as
 * inbox.spec.ts does: it returns a way to say "something changed in this business".
 */
async function realtime(page: Page): Promise<{ changed: () => void }> {
  const sockets: { send: (frame: string) => void }[] = [];
  await page.routeWebSocket(/\/socket\.io\//, (socket) => {
    socket.send(
      `0${JSON.stringify({ sid: 'e2e', upgrades: [], pingInterval: 600_000, pingTimeout: 600_000, maxPayload: 1_000_000 })}`,
    );
    socket.onMessage((frame) => {
      if (typeof frame === 'string' && frame.startsWith('40')) {
        socket.send(`40${JSON.stringify({ sid: 'e2e-socket' })}`);
        sockets.push(socket);
      }
    });
  });
  return {
    changed: () => {
      for (const socket of sockets) {
        socket.send(`42${JSON.stringify(['business.changed', { businessId: harbor.id }])}`);
      }
    },
  };
}

async function openThread(page: Page, state: World): Promise<void> {
  await signedIn(page);
  await assistantApi(page, state);
  await page.goto(inHarbor(`/inbox?conversation=${id}`));
  await expect(page.getByRole('heading', { name: 'Maya Thompson', exact: true })).toBeVisible();
  await expect.poll(() => state.assistantReads).toBeGreaterThan(0);
}

const assistantOf_ = (page: Page): Locator =>
  page.getByRole('region', { name: 'Assistant', exact: true });
const draftCard = (page: Page): Locator =>
  assistantOf_(page).getByRole('group', { name: /^Suggested reply/ });
const suggestionCard = (page: Page): Locator =>
  assistantOf_(page).getByRole('group', { name: /^Your assistant suggests/ });
const done = (page: Page): Locator =>
  assistantOf_(page).getByRole('list', {
    name: 'What was done on your assistant’s suggestions',
    exact: true,
  });
const autonomy = (page: Page): Locator =>
  assistantOf_(page).getByRole('group', { name: 'Your assistant for Maya', exact: true });
const messages = (page: Page): Locator =>
  page.getByRole('region', { name: 'Messages with Maya Thompson', exact: true });
const outbound = (page: Page): Locator => messages(page).locator('li[data-direction="outbound"]');
const replyBox = (page: Page): Locator =>
  page.getByRole('textbox', { name: 'Message to Maya Thompson', exact: true });
const btn = (within: Locator, name: string): Locator =>
  within.getByRole('button', { name, exact: true });
const pressed = (page: Page): Promise<(string | null)[]> =>
  autonomy(page)
    .getByRole('button')
    .evaluateAll((all) =>
      all.map((each) => `${each.textContent}:${each.getAttribute('aria-pressed') ?? ''}`),
    );
const noOverflow = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const axe = async (page: Page): Promise<unknown[]> =>
  (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze())
    .violations;

test('shows the draft, sends it as it is, and the reply appears once', async ({ page }) => {
  const state = world();
  await openThread(page, state);
  const card = draftCard(page);
  await expect(card).toContainText('Assistant');
  await expect(card).toContainText('Suggested reply, waiting for you');
  await expect(card).toContainText('Hi Maya, June 13 is open for both DJ and video.');
  await expect(card).toContainText(
    'By email, from Bookings · bookings@harbor.test to maya@example.test',
  );
  // The line break in the draft is kept, as text.
  expect(await card.getByText(/June 13 is open/).evaluate((text) => text.textContent)).toBe(
    draftedText,
  );
  const why = btn(card, 'Why this reply?');
  await expect(why).toHaveAttribute('aria-expanded', 'false');
  await why.click();
  await expect(why).toHaveAttribute('aria-expanded', 'true');
  await expect(card).toContainText(
    'Written from the last 4 messages here, 2 things your assistant knows about Maya, and their saved summary. It was also given: Business profile.',
  );
  await expect(btn(assistantOf_(page), 'Draft a reply')).toHaveCount(0);

  await btn(card, 'Send it').click();
  const said = assistantOf_(page).getByRole('status').filter({ hasText: 'Reply queued to send.' });
  await expect(said).toBeVisible();
  expect(state.applies).toEqual([{ id: draftId, body: {} }]);
  expect(state.replies).toEqual([]);
  await expect(card).toHaveCount(0);
  // The keyboard is on what came of it, not lost with the card.
  await expect(page.locator(':focus')).toHaveText('Reply queued to send.');
  await expect(outbound(page)).toHaveCount(1);
  await expect(outbound(page)).toContainText('Email to Maya Thompson, from you');
  await expect(outbound(page)).toContainText('Hi Maya, June 13 is open for both DJ and video.');
  await expect(outbound(page)).toContainText('Queued to send');
  await expect(done(page)).toContainText('You sent your assistant’s draft');
  await expect(btn(done(page), 'Undo')).toHaveCount(0);
});

test('a double click sends once, and the buttons wait while it is on its way', async ({ page }) => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = world({
    beforeApply: async () => {
      await held;
      return 'answer';
    },
  });
  await openThread(page, state);
  const send = btn(draftCard(page), 'Send it');
  await send.dblclick();
  await expect.poll(() => state.applies.length).toBe(1);
  await expect(send).toBeDisabled();
  await expect(btn(draftCard(page), 'Not now')).toBeDisabled();
  await expect(
    assistantOf_(page).getByRole('status').filter({ hasText: 'Sending…' }),
  ).toBeVisible();
  await expect(send).toBeFocused();
  release?.();
  await expect(assistantOf_(page).getByText('Reply queued to send.')).toBeVisible();
  expect(state.applies).toHaveLength(1);
  expect(state.dismissals).toEqual([]);
  await expect(outbound(page)).toHaveCount(1);
});

test('changes the draft in the reply box, and its send applies the proposal with the changes', async ({
  page,
}) => {
  const state = world({
    assistant: assistantOf({
      proposals: [
        replyProposalOf({
          change: {
            ...draftedChange,
            accountId: dana.id,
            to: mayaOtherEmail.id,
            subject: 'About June 13',
          },
        }),
      ],
    }),
  });
  await openThread(page, state);
  await btn(draftCard(page), 'Change it').click();
  const form = page.getByRole('form', { name: 'Reply to Maya Thompson', exact: true });
  const box = replyBox(page);
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(draftedText);
  await expect(form.getByLabel('Subject', { exact: true })).toHaveValue('About June 13');
  const banner = form.getByRole('group', {
    name: 'You’re editing your assistant’s draft',
    exact: true,
  });
  await expect(btn(banner, 'Start over')).toBeVisible();
  // One way to send while it is being changed, not two.
  await expect(draftCard(page)).toContainText('You’re changing this draft in the reply box below.');
  await expect(btn(draftCard(page), 'Send it')).toHaveCount(0);

  await box.fill('June 13 is open. Shall we talk Thursday?');
  await btn(form, 'Send email').click();
  await expect(page.getByRole('status').filter({ hasText: 'Reply queued to send.' })).toBeVisible();
  expect(state.applies).toEqual([
    {
      id: draftId,
      body: {
        changes: {
          channel: 'email',
          accountId: dana.id,
          to: mayaOtherEmail.id,
          subject: 'About June 13',
          text: 'June 13 is open. Shall we talk Thursday?',
        },
      },
    },
  ]);
  // The proposal is the key: the composer's own send, with its idempotency key, is not used.
  expect(JSON.stringify(state.applies)).not.toContain('idempotencyKey');
  expect(state.replies).toEqual([]);
  await expect(outbound(page)).toHaveCount(1);
  await expect(outbound(page)).toContainText('June 13 is open. Shall we talk Thursday?');
  await expect(box).toHaveValue('');
  await expect(box).toBeFocused();
  await expect(banner).toHaveCount(0);
  await expect(draftCard(page)).toHaveCount(0);
  await expect(done(page)).toContainText('You changed your assistant’s draft and sent it');
});

test('"Start over" gives the reply box back, and what is sent then is the person’s own reply', async ({
  page,
}) => {
  const state = world();
  await openThread(page, state);
  await btn(draftCard(page), 'Change it').click();
  await btn(page.getByRole('form', { name: 'Reply to Maya Thompson' }), 'Start over').click();
  await expect(replyBox(page)).toHaveValue('');
  await expect(replyBox(page)).toBeFocused();
  await expect(page.getByText('You’re editing your assistant’s draft')).toHaveCount(0);
  await expect(btn(draftCard(page), 'Send it')).toBeVisible();
  await replyBox(page).fill('I will call you.');
  await page.getByRole('button', { name: 'Send email', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reply queued to send.' })).toBeVisible();
  expect(state.replies).toHaveLength(1);
  expect(state.applies).toEqual([]);
});

test('"Not now" sets the draft aside and sends nothing', async ({ page }) => {
  const state = world();
  await openThread(page, state);
  await btn(draftCard(page), 'Not now').click();
  await expect(
    assistantOf_(page)
      .getByRole('status')
      .filter({ hasText: 'Draft set aside. Nothing was sent.' }),
  ).toBeVisible();
  expect(state.dismissals).toEqual([draftId]);
  expect(state.applies).toEqual([]);
  await expect(draftCard(page)).toHaveCount(0);
  await expect(page.locator(':focus')).toHaveText('Draft set aside. Nothing was sent.');
  await expect(outbound(page)).toHaveCount(0);
  await expect(btn(assistantOf_(page), 'Draft a reply')).toBeVisible();
});

test('a draft that is out of date is never sent: it can be drafted again or set aside', async ({
  page,
}) => {
  const again = messageOf({
    id: messageId('3'),
    text: 'Actually, could we do June 14?',
    createdAt: '2026-10-09T08:05:00.000Z',
  });
  const state = world({
    items: [again, inbound],
    assistant: assistantOf({ proposals: [replyProposalOf({ stale: true })] }),
  });
  await openThread(page, state);
  const card = draftCard(page);
  await expect(card).toContainText('Suggested reply, now out of date');
  await expect(card).toContainText(
    'Maya Thompson wrote again after this was drafted, so it can’t be sent as it is.',
  );
  await expect(btn(card, 'Send it')).toHaveCount(0);
  await expect(btn(card, 'Change it')).toHaveCount(0);
  await expect(btn(card, 'Not now')).toBeVisible();
  await btn(card, 'Draft a new reply').click();
  const writing = assistantOf_(page)
    .getByRole('status')
    .filter({ hasText: 'Your assistant is writing a reply…' });
  await expect(writing).toBeVisible();
  await expect(writing).toBeFocused();
  expect(state.draftRequests).toBe(1);
  expect(state.applies).toEqual([]);
  // The worker writes a new draft; the page finds it by asking again, with no hint.
  state.assistant = assistantOf({
    proposals: [
      replyProposalOf({
        id: proposalId('3'),
        change: { ...draftedChange, text: 'Hi Maya, June 14 works too.' },
      }),
    ],
  });
  await expect(draftCard(page)).toContainText('Hi Maya, June 14 works too.');
  await expect(draftCard(page)).toContainText('Suggested reply, waiting for you');
  await expect(writing).toHaveCount(0);
  // The keyboard was waiting on "writing…": it is on the draft now.
  await expect(draftCard(page)).toBeFocused();
  await expect(btn(draftCard(page), 'Send it')).toBeVisible();
});

test('says the conversation changed when the server refuses a draft that went stale meanwhile', async ({
  page,
}) => {
  const state = world();
  await openThread(page, state);
  await expect(btn(draftCard(page), 'Send it')).toBeVisible();
  // Someone on the team replied from elsewhere after the page read the draft.
  state.assistant = assistantOf({ proposals: [replyProposalOf({ stale: true })] });
  await btn(draftCard(page), 'Send it').click();
  await expect(assistantOf_(page).getByRole('alert')).toHaveText(
    'This conversation changed after the suggestion was made. Ask for a new one.',
  );
  await expect(draftCard(page)).toContainText(
    'This conversation changed after this was drafted, so it can’t be sent as it is.',
  );
  await expect(btn(draftCard(page), 'Send it')).toHaveCount(0);
  await expect(page.locator(':focus')).toHaveText(
    'This conversation changed after the suggestion was made. Ask for a new one.',
  );
  await expect(outbound(page)).toHaveCount(0);
});

test('says what became of a reply the pipeline refused, and one it could not confirm', async ({
  page,
}) => {
  const state = world({
    delivery: {
      status: 'failed',
      problem: { code: 'consent_required', message: 'Maya has not agreed to receive email.' },
    },
  });
  await openThread(page, state);
  await btn(draftCard(page), 'Send it').click();
  const refusal = assistantOf_(page).getByRole('alert');
  await expect(refusal).toContainText("Your reply wasn't sent. Nothing reached Maya Thompson.");
  await expect(refusal).toContainText(
    "This contact hasn't agreed to receive messages on this channel.",
  );
  await expect(refusal).toContainText('The thread shows the refused reply.');
  await expect(refusal).not.toContainText('Maya has not agreed to receive email.');
  await expect(outbound(page)).toContainText('Not sent');
  await expect(done(page)).toContainText(
    'You approved your assistant’s draft, but it wasn’t sent. The thread says why.',
  );
});

test('says a lost connection is safe to try again, and the second try sends once', async ({
  page,
}) => {
  let attempts = 0;
  const state = world({
    beforeApply: async (route) => {
      if (++attempts > 1) return 'answer';
      await route.abort('connectionfailed');
      return 'handled';
    },
  });
  await openThread(page, state);
  await btn(draftCard(page), 'Send it').click();
  await expect(assistantOf_(page).getByRole('alert')).toHaveText(
    'That didn’t go through. Check your connection and try again. Trying again won’t send it twice.',
  );
  await expect(btn(draftCard(page), 'Send it')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(assistantOf_(page).getByText('Reply queued to send.')).toBeVisible();
  expect(state.applies).toHaveLength(2);
  await expect(outbound(page)).toHaveCount(1);
});

test('says a draft is being written, then why there is none, and tries again', async ({ page }) => {
  const state = world({ assistant: assistantOf() });
  const socket = await realtime(page);
  await openThread(page, state);
  await btn(assistantOf_(page), 'Draft a reply').dblclick();
  const writing = assistantOf_(page)
    .getByRole('status')
    .filter({ hasText: 'Your assistant is writing a reply…' });
  await expect(writing).toBeVisible();
  expect(state.draftRequests).toBe(1);
  await expect(btn(assistantOf_(page), 'Draft a reply')).toHaveCount(0);
  // Nothing is blocked meanwhile: the person can write their own reply.
  await replyBox(page).fill('My own words.');
  await expect(replyBox(page)).toHaveValue('My own words.');

  // The provider times out: the realtime hint says to read again.
  const notice = assistantOf_(page).getByRole('group', { name: 'No draft', exact: true });
  state.assistant = assistantOf({ draft: endedDraftOf('failed', 'timeout') });
  socket.changed();
  await expect(notice).toContainText(
    'The AI provider took too long to answer, so no draft was written. Try again, or write your own reply.',
  );
  await expect(writing).toHaveCount(0);
  await expect(notice.getByRole('link')).toHaveCount(0);
  await expect(replyBox(page)).toHaveValue('My own words.');

  // Another try is refused by the model: "Draft again".
  await btn(notice, 'Try again').click();
  await expect(writing).toBeVisible();
  expect(state.draftRequests).toBe(2);
  state.assistant = assistantOf({ draft: endedDraftOf('refused') });
  await expect(notice).toContainText(
    'Your assistant declined to draft a reply to this one. You can write your own reply.',
  );
  await expect(btn(notice, 'Draft again')).toBeVisible();

  // The spending limit: those who manage AI are sent to its settings.
  state.assistant = assistantOf({ draft: endedDraftOf('paused', 'limit_reached') });
  socket.changed();
  await expect(notice).toContainText(
    'This month’s AI spending limit has been reached, so no draft was written. You can still write your own reply.',
  );
  await expect(
    notice.getByRole('link', { name: 'Open AI models in Settings', exact: true }),
  ).toHaveAttribute('href', inHarbor('/settings/ai-models'));

  // Someone who can't manage AI is told whom to ask instead.
  state.assistant = assistantOf({
    autonomy: { canChange: false },
    draft: endedDraftOf('not_configured'),
  });
  socket.changed();
  await expect(notice).toContainText(
    'No AI provider that can write replies is connected, so no draft was written. You can still write your own reply.',
  );
  await expect(notice).toContainText(
    'Ask someone who manages AI for this business to look at it in Settings.',
  );
  await expect(notice.getByRole('link')).toHaveCount(0);

  // Nothing new to answer: no button, since another try would end the same way.
  state.assistant = assistantOf({ draft: endedDraftOf('nothing_to_answer', 'answered') });
  socket.changed();
  await expect(notice).toContainText('There’s nothing new to answer');
  await expect(notice.getByRole('button')).toHaveCount(0);
});

test('shows nothing of the assistant where there is none', async ({ page }) => {
  const state = world({ assistant: noAssistant() });
  await openThread(page, state);
  await expect(replyBox(page)).toBeVisible();
  await expect(assistantOf_(page)).toHaveCount(0);
  await expect(page.getByText(/assistant/i)).toHaveCount(0);
});

test('applies a suggested change, shows who did it, and undoes it where it shows', async ({
  page,
}) => {
  const state = world({ assistant: assistantOf({ proposals: [statusProposalOf()] }) });
  await openThread(page, state);
  const card = suggestionCard(page);
  await expect(card).toContainText('Your assistant suggests closing this conversation');
  await expect(card).toContainText('Open → Closed');
  await btn(card, 'Apply').dblclick();
  await expect(
    assistantOf_(page).getByRole('status').filter({ hasText: 'Conversation closed.' }),
  ).toBeVisible();
  expect(state.applies).toEqual([{ id: suggestionId, body: {} }]);
  await expect(card).toHaveCount(0);
  await expect(page.locator(':focus')).toHaveText('Conversation closed.');
  // The thread's own header shows it closed, without a reload.
  await expect(
    page.getByRole('button', { name: 'Reopen conversation', exact: true }),
  ).toBeVisible();

  await expect(done(page)).toContainText('Closed on your assistant’s suggestion by you');
  await btn(done(page), 'Undo').click();
  await expect(
    assistantOf_(page)
      .getByRole('status')
      .filter({ hasText: 'Undone: the conversation is open again.' }),
  ).toBeVisible();
  expect(state.undos).toEqual([suggestionId]);
  await expect(page.locator(':focus')).toHaveText('Undone: the conversation is open again.');
  await expect(page.getByRole('button', { name: 'Close conversation', exact: true })).toBeVisible();
  await expect(done(page)).toContainText(
    'You undid a change your assistant suggested (Open → Closed)',
  );
  await expect(btn(done(page), 'Undo')).toHaveCount(0);
});

test('dismisses a suggested change without changing anything', async ({ page }) => {
  const state = world({ assistant: assistantOf({ proposals: [statusProposalOf()] }) });
  await openThread(page, state);
  await btn(suggestionCard(page), 'Dismiss').click();
  await expect(
    assistantOf_(page)
      .getByRole('status')
      .filter({ hasText: 'Suggestion dismissed. Nothing was changed.' }),
  ).toBeVisible();
  expect(state.dismissals).toEqual([suggestionId]);
  expect(state.applies).toEqual([]);
  await expect(page.getByRole('button', { name: 'Close conversation', exact: true })).toBeVisible();
});

test('sets how much the assistant does for this contact, asking before it may act', async ({
  page,
}) => {
  const state = world({ assistant: assistantOf() });
  await openThread(page, state);
  expect(await pressed(page)).toEqual(['Suggest:false', 'Ask first:true', 'Act:false']);
  await expect(assistantOf_(page)).toContainText('Writes replies and asks you before sending.');

  await btn(autonomy(page), 'Act').click();
  const question = assistantOf_(page).getByRole('group', {
    name: 'Your assistant will send replies to Maya without asking.',
    exact: true,
  });
  await expect(question).toBeVisible();
  await expect(page.locator(':focus')).toHaveText(
    'Your assistant will send replies to Maya without asking.',
  );
  expect(state.autonomySaves).toEqual([]);
  await btn(question, 'Cancel').click();
  await expect(question).toHaveCount(0);
  await expect(btn(autonomy(page), 'Act')).toBeFocused();
  expect(state.autonomySaves).toEqual([]);

  await btn(autonomy(page), 'Act').click();
  await btn(question, 'Let it act').click();
  await expect(
    assistantOf_(page).getByRole('status').filter({
      hasText: 'Saved. Your assistant replies to Maya on its own and tells you what it sent.',
    }),
  ).toBeVisible();
  expect(state.autonomySaves).toEqual([
    { agent: 'inbox', action: 'send_message', contactId: maya.id, level: 'act' },
  ]);
  expect(await pressed(page)).toEqual(['Suggest:false', 'Ask first:false', 'Act:true']);
  await expect(assistantOf_(page)).toContainText('Replies on its own and tells you what it sent.');
  await expect(btn(autonomy(page), 'Act')).toBeFocused();

  // Maya has a level of her own now: it can be given up for the business's.
  const back = btn(assistantOf_(page), 'Use the business’s setting (Ask first)');
  await back.click();
  await expect(
    assistantOf_(page).getByRole('status').filter({
      hasText:
        'Saved. Maya follows the business’s setting again. Your assistant asks before sending anything to Maya.',
    }),
  ).toBeVisible();
  expect(state.autonomySaves.at(-1)).toEqual({
    agent: 'inbox',
    action: 'send_message',
    contactId: maya.id,
    level: null,
  });
  await expect(back).toHaveCount(0);
  await expect(btn(autonomy(page), 'Ask first')).toBeFocused();

  await btn(autonomy(page), 'Suggest').dblclick();
  await expect(
    assistantOf_(page).getByRole('status').filter({
      hasText: 'Saved. Your assistant writes drafts for Maya, for you to send yourself.',
    }),
  ).toBeVisible();
  expect(state.autonomySaves).toHaveLength(3);
});

test('says the level as a sentence to someone who may not change it', async ({ page }) => {
  const levels: readonly (readonly [AutonomyLevel, string])[] = [
    ['ask', 'Your assistant asks before sending anything to Maya.'],
    ['suggest', 'Your assistant writes drafts for Maya, for you to send yourself.'],
    ['act', 'Your assistant replies to Maya on its own and tells you what it sent.'],
  ];
  const state = world({ assistant: assistantOf({ autonomy: { canChange: false } }) });
  const socket = await realtime(page);
  await openThread(page, state);
  for (const [level, sentence] of levels) {
    state.assistant = assistantOf({ autonomy: { canChange: false, level } });
    socket.changed();
    await expect(assistantOf_(page).getByText(sentence, { exact: true })).toBeVisible();
  }
  await expect(
    assistantOf_(page).getByText('Your assistant for Maya', { exact: true }),
  ).toBeVisible();
  await expect(autonomy(page)).toHaveCount(0);
  await expect(
    assistantOf_(page).getByRole('button', { name: /Suggest|Ask first|Act/ }),
  ).toHaveCount(0);
});

test('offers "Use this draft", not Send, when the assistant only suggests', async ({ page }) => {
  const state = world({
    assistant: assistantOf({
      autonomy: { level: 'suggest', source: 'business', businessLevel: 'suggest' },
      proposals: [replyProposalOf({ autonomy: 'suggest' })],
    }),
  });
  await openThread(page, state);
  const card = draftCard(page);
  await expect(btn(card, 'Send it')).toHaveCount(0);
  await expect(btn(card, 'Change it')).toHaveCount(0);
  await btn(card, 'Use this draft').click();
  await expect(replyBox(page)).toBeFocused();
  await expect(replyBox(page)).toHaveValue(draftedText);
  expect(state.applies).toEqual([]);
  await page.getByRole('button', { name: 'Send email', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reply queued to send.' })).toBeVisible();
  expect(state.applies).toHaveLength(1);
  expect(state.replies).toEqual([]);
  await expect(outbound(page)).toHaveCount(1);
});

test('says the assistant replied on its own, with no Undo, when it may act', async ({ page }) => {
  const state = world({
    items: [
      messageOf({
        id: messageId('7'),
        direction: 'outbound',
        author: theAssistant,
        status: 'sent',
        text: 'Hi Maya, June 13 is open.',
        createdAt: '2026-10-09T08:10:00.000Z',
        sentAt: '2026-10-09T08:10:02.000Z',
      }),
      inbound,
    ],
    assistant: assistantOf({
      autonomy: { level: 'act', source: 'contact' },
      proposals: [sentReplyOf({ autonomy: 'act', decidedBy: theAssistant })],
    }),
  });
  await openThread(page, state);
  await expect(done(page)).toContainText('Your assistant replied on its own');
  await expect(done(page)).toContainText('A message that was sent can’t be unsent.');
  await expect(btn(done(page), 'Undo')).toHaveCount(0);
  await expect(draftCard(page)).toHaveCount(0);
  await expect(outbound(page)).toContainText('Email to Maya Thompson, from AI assistant');
  expect(await pressed(page)).toEqual(['Suggest:false', 'Ask first:false', 'Act:true']);
});

test('shows a draft read-only to someone whose role cannot send it', async ({ page }) => {
  const state = world({
    assistant: assistantOf({
      canDraft: false,
      autonomy: { canChange: false },
      proposals: [replyProposalOf({ canDecide: false })],
    }),
  });
  await openThread(page, state);
  const card = draftCard(page);
  await expect(card).toContainText('Hi Maya, June 13 is open');
  await expect(card).toContainText('Sending this reply needs a permission your role doesn’t have.');
  await expect(card.getByRole('button')).toHaveText(['Why this reply?']);
});

test('works from the keyboard alone, through the draft card', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = world();
  await openThread(page, state);
  const card = draftCard(page);
  const why = btn(card, 'Why this reply?');
  await expect(why).toBeVisible();
  // Tab from the thread's heading reaches the card without a pointer.
  await page.getByRole('heading', { name: 'Maya Thompson', exact: true }).focus();
  for (let presses = 0; presses < 40; presses++) {
    if (await why.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(why).toBeFocused();
  await page.keyboard.press('Space');
  await expect(why).toHaveAttribute('aria-expanded', 'true');
  await expect(card).toContainText('Written from the last 4 messages here');
  await page.keyboard.press('Tab');
  await expect(btn(card, 'Send it')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(btn(card, 'Change it')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(btn(card, 'Not now')).toBeFocused();
  // Back to "Change it": the keyboard lands in the reply box, on the draft.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(replyBox(page)).toBeFocused();
  await expect(replyBox(page)).toHaveValue(draftedText);
  await page.keyboard.press('End');
  await page.keyboard.type(' Thanks!');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Send email', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Reply queued to send.' })).toBeVisible();
  expect(state.applies).toHaveLength(1);
  expect(state.applies[0]?.body).toMatchObject({ changes: { text: `${draftedText} Thanks!` } });
  await expect(replyBox(page)).toBeFocused();
});

for (const width of [360, 1440])
  test(`fits ${String(width)}px with no sideways scrolling, and passes axe`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const state = world({
      assistant: assistantOf({
        autonomy: { level: 'ask', source: 'contact', businessLevel: 'suggest' },
        draft: endedDraftOf('paused', 'limit_reached'),
        proposals: [
          replyProposalOf({
            change: {
              ...draftedChange,
              text: `${draftedText}\nOur guide: https://example.test/${'a'.repeat(300)}`,
            },
            basis: {
              messages: 4,
              facts: 2,
              summary: true,
              knowledge: ['Business profile', 'A long name for a price list, with every package'],
            },
          }),
          statusProposalOf({
            change: {
              kind: 'conversation_status',
              from: 'open',
              to: 'snoozed',
              until: '2026-10-12T09:00:00.000Z',
            },
          }),
          appliedStatusOf({ id: proposalId('4') }),
          sentReplyOf({ id: proposalId('5'), decidedBy: theAssistant }),
        ],
      }),
    });
    const socket = await realtime(page);
    await openThread(page, state);
    await expect(draftCard(page)).toBeVisible();
    await expect(suggestionCard(page)).toContainText(
      'Your assistant suggests snoozing this conversation until',
    );
    await expect(done(page).getByRole('listitem')).toHaveCount(2);
    await btn(draftCard(page), 'Why this reply?').click();
    expect(await noOverflow(page)).toBe(true);
    expect(await axe(page)).toEqual([]);

    // The question before "Act", and the reply box holding the draft.
    await btn(autonomy(page), 'Act').click();
    await expect(btn(assistantOf_(page), 'Let it act')).toBeVisible();
    await btn(draftCard(page), 'Change it').click();
    await expect(page.getByText('You’re editing your assistant’s draft')).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
    expect(await axe(page)).toEqual([]);

    // "Writing…", once the reply box is the person's own again.
    await btn(page.getByRole('form', { name: 'Reply to Maya Thompson' }), 'Start over').click();
    state.assistant = { ...state.assistant, draft: draftOf() };
    socket.changed();
    await expect(assistantOf_(page).getByText('Your assistant is writing a reply…')).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
    expect(await axe(page)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('assistant.png'), fullPage: true });
  });
