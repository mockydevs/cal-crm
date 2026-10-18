// @vitest-environment jsdom
// The assistant in a conversation: what the thread shows for each
// answer of the API, what each button sends, and where the keyboard is afterwards. The
// whole thread is drawn, with its composer, so "Change it" is followed all the way to the
// request it ends in. The API is stood in for here; the same paths through a browser are
// in e2e/assistant.spec.ts.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type {
  Conversation,
  ConversationAssistant,
  ConversationComposer,
  Proposal,
  ThreadItem,
  ThreadMessage,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createRef, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  sam,
  sentReplyOf,
  statusProposalOf,
  theAssistant,
  you,
} from '../e2e/assistant-fixtures';
import {
  composerOf,
  conversationId,
  conversationOf,
  dana,
  maya,
  mayaOtherEmail,
  messageId,
  messageOf,
  threadOf,
} from '../e2e/inbox-fixtures';
import { loadAssistant } from './inbox-assistant-loader';
import { InboxThread } from './inbox-thread';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('./api', () => {
  const client = {
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  };
  return { api: client, apiIn: () => client };
});
vi.mock('./workspace', async (original) => ({
  ...(await original<typeof import('./workspace')>()),
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  // jsdom lays nothing out, so it has nothing to scroll and nothing to watch come into view.
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(): void {
        // Nothing is ever in view.
      }
      disconnect(): void {
        // Nothing was watched.
      }
    },
  );
});
// Two things cost the first test what they cost no later one, and on a busy machine that
// was more than the second a wait for the page allows. Both are paid here, on no clock but
// the page's own:
//
//   * the assistant's code, which the page fetches lazily, is fetched the way the page
//     fetches it;
//   * the thread is drawn once and thrown away, until the assistant has asked for what it
//     shows, and the page is searched by role once. The first drawing and the first search
//     are several times slower than any after them.
beforeAll(async () => {
  await loadAssistant();
  const world = serve();
  const seen = { asked: false };
  world.override = (operation) => {
    seen.asked ||= operation === 'getConversationAssistant';
    return undefined;
  };
  open();
  // A turn at a time, each one letting the page draw what it was answered, until the
  // assistant has asked; then one more, in which it draws its own answer.
  const turn = (): Promise<void> => act(() => new Promise<void>((done) => setTimeout(done, 0)));
  while (!seen.asked) await turn();
  await turn();
  screen.queryByRole('region', { name: 'Assistant' });
  cleanup();
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const id = conversationId('1');
const draftId = proposalId('1');
const sentId = messageId('7');

/** What the API holds, as a test set it up; answers are read from it at each call. */
interface World {
  assistant: ConversationAssistant;
  conversation: Conversation;
  composer: ConversationComposer;
  /** Newest first, as the API answers. */
  items: ThreadItem[];
  /** How the pipeline treats a reply a proposal makes: queued, unless a test says. */
  delivery: Partial<ThreadMessage>;
  /** Answers one operation another way, such as with an error. */
  override?: ((operation: string, input: unknown) => unknown) | undefined;
}

const inputOf = (input: unknown): { params?: { id?: string }; body?: Record<string, unknown> } =>
  input as { params?: { id?: string }; body?: Record<string, unknown> };

function serve(patch: Partial<World> = {}): World {
  const world: World = {
    assistant: assistantOf({ proposals: [replyProposalOf()] }),
    conversation: conversationOf({ unreadCount: 0 }),
    composer: composerOf(),
    items: [messageOf()],
    delivery: { status: 'queued' },
    ...patch,
  };
  const replace = (next: Proposal): Proposal => {
    world.assistant = {
      ...world.assistant,
      proposals: world.assistant.proposals.map((each) => (each.id === next.id ? next : each)),
    };
    return next;
  };
  const find = (input: unknown): Proposal => {
    const found = world.assistant.proposals.find((each) => each.id === inputOf(input).params?.id);
    if (found === undefined) throw new Error('No such proposal.');
    return found;
  };
  server.answer = (operation, input) => {
    const other: unknown = world.override?.(operation, input);
    if (other !== undefined) return other;
    switch (operation) {
      case 'getConversation':
        return world.conversation;
      case 'listConversationMessages':
        return threadOf(world.items);
      case 'getConversationComposer':
        return world.composer;
      case 'getConversationAssistant':
        return world.assistant;
      case 'listConversationAssignees':
        return { items: [], nextCursor: null };
      case 'applyProposal': {
        const proposal = find(input);
        const changes = inputOf(input).body?.['changes'] as Record<string, unknown> | undefined;
        if (proposal.change.kind === 'conversation_status') {
          world.conversation = { ...world.conversation, status: proposal.change.to };
          return replace(appliedStatusOf({ id: proposal.id, change: proposal.change }));
        }
        // The assistant proposes other changes too (a field value, a fact about the
        // contact); this stand-in applies the two a conversation shows.
        if (proposal.change.kind !== 'reply')
          throw new Error(`No stand-in applies ${proposal.change.kind}.`);
        const text = typeof changes?.['text'] === 'string' ? changes['text'] : proposal.change.text;
        world.items = [
          messageOf({
            id: sentId,
            direction: 'outbound',
            author: you,
            text,
            createdAt: '2026-10-09T08:10:00.000Z',
            ...world.delivery,
          }),
          ...world.items,
        ];
        return replace(
          sentReplyOf({
            id: proposal.id,
            edited: changes !== undefined,
            change: { ...proposal.change, text },
            // A message the pipeline refused was never sent: there is nothing to undo.
            ...(world.delivery.status === 'failed'
              ? {
                  undo: {
                    available: false,
                    reason: 'not_sent',
                    message: 'This reply was never sent, so there is nothing to undo.',
                  },
                }
              : {}),
          }),
        );
      }
      case 'dismissProposal':
        return replace({ ...find(input), status: 'dismissed', decidedBy: you });
      case 'undoProposal': {
        const proposal = find(input);
        if (proposal.change.kind === 'conversation_status') {
          world.conversation = { ...world.conversation, status: proposal.change.from };
        }
        return replace({
          ...proposal,
          status: 'undone',
          undo: null,
          undoneAt: '2026-10-09T08:20:00.000Z',
          undoneBy: you,
        });
      }
      case 'requestReplyDraft':
        world.assistant = { ...world.assistant, draft: draftOf() };
        return world.assistant.draft;
      case 'setAutonomy': {
        const body = inputOf(input).body ?? {};
        const level = body['level'] as ConversationAssistant['autonomy']['level'] | null;
        const saved = autonomyOf({
          level: level ?? world.assistant.autonomy.businessLevel,
          source: level === null ? 'business' : 'contact',
          businessLevel: world.assistant.autonomy.businessLevel,
        });
        world.assistant = {
          ...world.assistant,
          autonomy: { ...saved, canChange: world.assistant.autonomy.canChange },
        };
        return saved;
      }
      default:
        return undefined;
    }
  };
  return world;
}

function open(): {
  user: ReturnType<typeof userEvent.setup>;
  sendReply: ReturnType<typeof vi.fn>;
  client: QueryClient;
} {
  const client = new QueryClient({
    // The thread's reads try again by themselves; here they don't wait between tries.
    defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } },
  });
  const sendReply = vi.fn((_conversation: string, content: { text: string }) =>
    Promise.resolve(
      messageOf({
        id: messageId('8'),
        direction: 'outbound',
        author: you,
        status: 'queued',
        text: content.text,
      }),
    ),
  );
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <InboxThread
          conversationId={id}
          list={{
            search: { conversation: id },
            navigation: { hrefFor: () => '#', go: vi.fn() },
            onBack: vi.fn(),
            details: { open: false, controls: 'details', onToggle: vi.fn() },
          }}
          drafts={new Map()}
          sendReply={sendReply}
          addNote={vi.fn()}
          headingRef={createRef<HTMLHeadingElement>()}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  // Keys follow one another with no timer between them (user-event's `delay`). Every key
  // is still its own events and its own render; what goes is a wait per character, which
  // on a busy machine took a long test past its five seconds.
  return { user: userEvent.setup({ delay: null }), sendReply, client };
}

const callsTo = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);
const problem = (status: number, detail: string, errors?: unknown[]): ApiError =>
  new ApiError({
    type: 'about:blank',
    title: 'Problem',
    status,
    detail,
    ...(errors === undefined ? {} : { errors }),
  } as ApiError['problem']);
const refuse =
  (operation: string, error: Error) =>
  (asked: string): unknown =>
    asked === operation ? Promise.reject(error) : undefined;

/** Holds the first answer to an operation until released; it then answers as usual. */
function hold(world: World, operation: string): () => void {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  world.override = (asked, input) => {
    if (asked !== operation) return undefined;
    world.override = undefined;
    return held.then(() => server.answer(asked, input));
  };
  return () => release?.();
}

const region = (): Promise<HTMLElement> => screen.findByRole('region', { name: 'Assistant' });
const card = async (): Promise<HTMLElement> =>
  within(await region()).findByRole('group', { name: /^Suggested reply/ });
const button = (within_: HTMLElement, name: string): HTMLElement =>
  within(within_).getByRole('button', { name });
const noButton = (within_: HTMLElement, name: string): void => {
  expect(within(within_).queryByRole('button', { name })).toBeNull();
};
const box = (): HTMLTextAreaElement =>
  screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Maya Thompson' });
const focused = (): string => document.activeElement?.textContent ?? '';
const outbound = (): number => document.querySelectorAll('li[data-direction="outbound"]').length;

describe('the draft card', () => {
  it('shows the draft as text, where it would go, and what can be done with it', async () => {
    serve({
      assistant: assistantOf({
        proposals: [
          replyProposalOf({
            change: {
              ...draftedChange,
              text: 'Hi Maya,\n<img src=x onerror=alert(1)> June 13 is open.',
            },
          }),
        ],
      }),
    });
    open();
    const draft = await card();
    expect(within(draft).getByText('Assistant')).toBeDefined();
    expect(within(draft).getByText('Suggested reply, waiting for you')).toBeDefined();
    // Text only, with its line break kept: markup in a draft is seen, never run.
    const text = within(draft).getByText(/June 13 is open\./);
    expect(text.textContent).toBe('Hi Maya,\n<img src=x onerror=alert(1)> June 13 is open.');
    expect(text.className).toContain('whitespace-pre-wrap');
    expect(draft.querySelector('img')).toBeNull();
    expect(within(draft).getByText('Re: June 13')).toBeDefined();
    expect(
      within(draft).getByText(
        'By email, from Bookings · bookings@harbor.test to maya@example.test',
      ),
    ).toBeDefined();
    expect(
      within(draft)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['Why this reply?', 'Send it', 'Change it', 'Not now']);
    // Nothing waits to be drafted while a draft waits to be decided.
    noButton(await region(), 'Draft a reply');
  });

  it('leaves out where it would go when the composer no longer offers that account', async () => {
    serve({
      assistant: assistantOf({
        proposals: [
          replyProposalOf({
            change: { ...draftedChange, accountId: 'chan_01k8e2wzr0e008000000000009' },
          }),
        ],
      }),
    });
    open();
    const draft = await card();
    expect(within(draft).queryByText(/^By email/)).toBeNull();
    expect(button(draft, 'Send it')).toBeDefined();
  });

  it('says what the draft was written from, counted by the product', async () => {
    serve();
    const { user } = open();
    const draft = await card();
    const why = button(draft, 'Why this reply?');
    expect(why.getAttribute('aria-expanded')).toBe('false');
    expect(within(draft).queryByText(/^Written from/)).toBeNull();
    await user.click(why);
    expect(why.getAttribute('aria-expanded')).toBe('true');
    const words = within(draft).getByText(/^Written from/);
    expect(words.textContent).toBe(
      'Written from the last 4 messages here, 2 things your assistant knows about Maya, and their saved summary. It was also given: Business profile.',
    );
    expect(why.getAttribute('aria-controls')).toBe(words.parentElement?.id);
    await user.click(why);
    expect(why.getAttribute('aria-expanded')).toBe('false');
    expect(within(draft).queryByText(/^Written from/)).toBeNull();
  });

  it('counts one of each in the singular, and says so when nothing was recorded', async () => {
    const world = serve({
      assistant: assistantOf({
        proposals: [
          replyProposalOf({ basis: { messages: 1, facts: 1, summary: false, knowledge: [] } }),
        ],
      }),
    });
    const { user, client } = open();
    await user.click(button(await card(), 'Why this reply?'));
    expect((await card()).textContent).toContain(
      'Written from the last message here and 1 thing your assistant knows about Maya.',
    );
    world.assistant = assistantOf({
      proposals: [
        replyProposalOf({
          basis: {
            messages: 0,
            facts: 0,
            summary: false,
            knowledge: ['Price list', 'Venue guide'],
          },
        }),
      ],
    });
    await client.invalidateQueries();
    expect(
      await within(await card()).findByText(
        'Your assistant was given: Price list and Venue guide.',
      ),
    ).toBeDefined();
    world.assistant = assistantOf({ proposals: [replyProposalOf({ basis: null })] });
    await client.invalidateQueries();
    expect(
      await within(await card()).findByText(
        'Nothing was recorded about what this draft was written from.',
      ),
    ).toBeDefined();
  });

  it('sends the draft as it is, says how it fared, and shows the reply once', async () => {
    serve();
    const { user, sendReply } = open();
    await user.click(button(await card(), 'Send it'));
    expect(await screen.findByText('Reply queued to send.')).toBeDefined();
    expect(callsTo('applyProposal')).toEqual([{ params: { id: draftId }, body: {} }]);
    expect(sendReply).not.toHaveBeenCalled();
    // The card is gone, and the keyboard is on what came of it, not lost.
    expect(within(await region()).queryByRole('group', { name: /^Suggested reply/ })).toBeNull();
    await waitFor(() => {
      expect(focused()).toBe('Reply queued to send.');
    });
    expect(outbound()).toBe(1);
    expect(
      within(await region()).getByText('You sent your assistant’s draft', { exact: false }),
    ).toBeDefined();
  });

  it('sends once on a double click, and says it is sending meanwhile', async () => {
    const release = hold(serve(), 'applyProposal');
    const { user } = open();
    const send = button(await card(), 'Send it');
    await user.dblClick(send);
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(button(await card(), 'Not now').getAttribute('aria-disabled')).toBe('true');
    expect(within(await region()).getByText('Sending…')).toBeDefined();
    // Still focusable while it works, so the keyboard isn't dropped.
    expect(document.activeElement).toBe(send);
    await user.click(button(await card(), 'Not now'));
    release();
    expect(await screen.findByText('Reply queued to send.')).toBeDefined();
    expect(callsTo('applyProposal')).toHaveLength(1);
    expect(callsTo('dismissProposal')).toHaveLength(0);
    expect(outbound()).toBe(1);
  });

  it('says a reply is waiting, and why, in the composer’s own words', async () => {
    serve({
      delivery: {
        status: 'queued',
        held: {
          code: 'quiet_hours',
          message: "It's outside Maya's contact hours.",
          until: '2026-10-10T05:00:00.000Z',
        },
      },
    });
    const { user } = open();
    await user.click(button(await card(), 'Send it'));
    const waiting = await within(await region()).findByRole('status', {
      name: (_name, element) => element.textContent.includes('Your reply is waiting to send.'),
    });
    expect(waiting.textContent).toContain("It hasn't reached Maya Thompson yet.");
    expect(waiting.textContent).toContain("It's quiet hours where this contact is.");
    expect(waiting.textContent).toContain('It will be tried again on');
    expect(waiting.textContent).not.toContain("It's outside Maya's contact hours.");
    await waitFor(() => {
      expect(focused()).toContain('Your reply is waiting to send.');
    });
  });

  it('says a reply was refused, why, and that nothing reached the contact', async () => {
    serve({
      delivery: {
        status: 'failed',
        problem: { code: 'consent_required', message: 'Maya has not agreed to receive email.' },
      },
    });
    const { user } = open();
    await user.click(button(await card(), 'Send it'));
    const refused = await within(await region()).findByRole('alert');
    expect(refused.textContent).toContain("Your reply wasn't sent. Nothing reached Maya Thompson.");
    expect(refused.textContent).toContain(
      "This contact hasn't agreed to receive messages on this channel.",
    );
    expect(refused.textContent).toContain('The thread shows the refused reply.');
    expect(refused.textContent).not.toContain('Your words are still in the box');
    expect(refused.textContent).not.toContain('Maya has not agreed to receive email.');
    expect(
      within(await region()).getByText(
        'You approved your assistant’s draft, but it wasn’t sent. The thread says why.',
        { exact: false },
      ),
    ).toBeDefined();
  });

  it('says so when the reply was applied but the thread could not be read', async () => {
    const world = serve();
    let reads = 0;
    world.override = (operation) =>
      operation === 'listConversationMessages' && reads++ > 0
        ? Promise.reject(problem(404, 'No such conversation.'))
        : undefined;
    const { user } = open();
    await user.click(button(await card(), 'Send it'));
    expect(
      await screen.findByText('Your reply was handed over to send. The thread shows how it went.'),
    ).toBeDefined();
  });

  it('shows the server’s plain words when the draft changed first, and reads it again', async () => {
    const world = serve();
    world.override = (operation) => {
      if (operation !== 'applyProposal') return undefined;
      world.assistant = assistantOf({ proposals: [replyProposalOf({ stale: true })] });
      return Promise.reject(problem(409, 'Maya wrote again after this was drafted.'));
    };
    const { user } = open();
    await user.click(button(await card(), 'Send it'));
    const alert = await within(await region()).findByRole('alert');
    expect(alert.textContent).toBe('Maya wrote again after this was drafted.');
    // Read again: the card now says it is out of date, and offers no Send.
    expect(
      await within(await region()).findByText('Suggested reply, now out of date'),
    ).toBeDefined();
    noButton(await card(), 'Send it');
    expect(callsTo('getConversationAssistant').length).toBeGreaterThan(1);
    // The button it was on is gone: the keyboard is on the reason.
    await waitFor(() => {
      expect(focused()).toBe('Maya wrote again after this was drafted.');
    });
    expect(outbound()).toBe(0);
  });

  it('uses the composer’s words for a refusal it knows, and the server’s for one it does not', async () => {
    const world = serve();
    world.override = refuse(
      'applyProposal',
      problem(422, 'Refused.', [
        { path: '/reply/text', code: 'text_too_long', message: 'Too long for SMS.' },
      ]),
    );
    const { user } = open();
    await user.click(button(await card(), 'Send it'));
    expect((await within(await region()).findByRole('alert')).textContent).toBe(
      'A text message can hold 1,600 characters at most. Shorten it, or send an email.',
    );
    // The card is still there, and so is the keyboard.
    expect(document.activeElement).toBe(button(await card(), 'Send it'));
    world.override = refuse(
      'applyProposal',
      problem(422, 'Refused.', [
        {
          path: '/reply',
          code: 'something_new',
          message: 'The reply was refused for a new reason.',
        },
      ]),
    );
    await user.click(button(await card(), 'Send it'));
    expect(await screen.findByText('The reply was refused for a new reason.')).toBeDefined();
    world.override = refuse('applyProposal', problem(503, 'The server is restarting.'));
    await user.click(button(await card(), 'Send it'));
    expect(await screen.findByText('The server is restarting.')).toBeDefined();
  });

  it('says a role may not send, and that a lost connection is safe to try again', async () => {
    const world = serve();
    world.override = refuse('applyProposal', problem(403, 'It needs conversations.reply.'));
    const { user } = open();
    await user.click(button(await card(), 'Send it'));
    expect((await within(await region()).findByRole('alert')).textContent).toBe(
      'Sending this reply needs a permission your role doesn’t have.',
    );
    world.override = refuse('applyProposal', new TypeError('Failed to fetch'));
    await user.click(button(await card(), 'Send it'));
    expect(
      await screen.findByText(
        'That didn’t go through. Check your connection and try again. Trying again won’t send it twice.',
      ),
    ).toBeDefined();
    expect(document.activeElement).toBe(button(await card(), 'Send it'));
    // Trying again goes through, once.
    world.override = undefined;
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Reply queued to send.')).toBeDefined();
    expect(outbound()).toBe(1);
  });

  it('sets the draft aside on "Not now", once, and then offers to draft another', async () => {
    serve();
    const { user } = open();
    await user.dblClick(button(await card(), 'Not now'));
    expect(await screen.findByText('Draft set aside. Nothing was sent.')).toBeDefined();
    expect(callsTo('dismissProposal')).toEqual([{ params: { id: draftId } }]);
    expect(callsTo('applyProposal')).toEqual([]);
    expect(within(await region()).queryByRole('group', { name: /^Suggested reply/ })).toBeNull();
    await waitFor(() => {
      expect(focused()).toBe('Draft set aside. Nothing was sent.');
    });
    expect(button(await region(), 'Draft a reply')).toBeDefined();
    expect(outbound()).toBe(0);
  });

  it('says why "Not now" did not go through', async () => {
    const world = serve();
    world.override = refuse('dismissProposal', new TypeError('Failed to fetch'));
    const { user } = open();
    await user.click(button(await card(), 'Not now'));
    expect(
      await screen.findByText('That didn’t go through. Check your connection and try again.'),
    ).toBeDefined();
    expect(document.activeElement).toBe(button(await card(), 'Not now'));
  });

  it('works from the keyboard alone', async () => {
    serve();
    const { user } = open();
    const draft = await card();
    button(draft, 'Why this reply?').focus();
    await user.keyboard(' ');
    expect(within(draft).getByText(/^Written from/)).toBeDefined();
    await user.tab();
    expect(document.activeElement).toBe(button(draft, 'Send it'));
    await user.tab();
    expect(document.activeElement).toBe(button(draft, 'Change it'));
    await user.tab();
    expect(document.activeElement).toBe(button(draft, 'Not now'));
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Reply queued to send.')).toBeDefined();
    expect(callsTo('applyProposal')).toHaveLength(1);
  });
});

describe('changing a draft before it goes', () => {
  const routed = (): ConversationAssistant =>
    assistantOf({
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
    });

  it('puts the draft in the reply box, and its send applies the proposal with the changes', async () => {
    const world = serve({ assistant: routed() });
    const { user, sendReply } = open();
    await user.click(button(await card(), 'Change it'));
    // The reply form holds the draft, says so, and has the keyboard.
    const form = screen.getByRole('form', { name: 'Reply to Maya Thompson' });
    expect(box().value).toBe(draftedText);
    expect(document.activeElement).toBe(box());
    expect(within(form).getByLabelText<HTMLInputElement>('Subject').value).toBe('About June 13');
    const banner = within(form).getByRole('group', {
      name: 'You’re editing your assistant’s draft',
    });
    expect(button(banner, 'Start over')).toBeDefined();
    // The card steps back while its draft is being changed: one way to send, not two.
    const draft = await card();
    expect(
      within(draft).getByText('You’re changing this draft in the reply box below.'),
    ).toBeDefined();
    noButton(draft, 'Send it');
    noButton(draft, 'Not now');

    await user.clear(box());
    await user.type(box(), 'June 13 is open. Shall we talk Thursday?');
    // A double click while the first is on its way sends once.
    const release = hold(world, 'applyProposal');
    await user.dblClick(button(form, 'Send email'));
    expect(box().disabled).toBe(true);
    release();
    expect(await screen.findByText('Reply queued to send.')).toBeDefined();
    const [applied, ...more] = callsTo('applyProposal');
    expect(more).toEqual([]);
    expect(applied).toEqual({
      params: { id: draftId },
      body: {
        changes: {
          channel: 'email',
          accountId: dana.id,
          to: mayaOtherEmail.id,
          subject: 'About June 13',
          text: 'June 13 is open. Shall we talk Thursday?',
        },
      },
    });
    expect(JSON.stringify(applied)).not.toContain('idempotencyKey');
    expect(sendReply).not.toHaveBeenCalled();
    // Done: the box is empty and has the keyboard, and it no longer holds the draft.
    await waitFor(() => {
      expect(box().value).toBe('');
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(box());
    });
    expect(screen.queryByText('You’re editing your assistant’s draft')).toBeNull();
    expect(outbound()).toBe(1);
    expect(
      await within(await region()).findByText('You changed your assistant’s draft and sent it', {
        exact: false,
      }),
    ).toBeDefined();
  });

  it('keeps the subject the conversation suggests for a draft that has none', async () => {
    serve({
      assistant: assistantOf({
        proposals: [replyProposalOf({ change: { ...draftedChange, subject: null } })],
      }),
    });
    const { user } = open();
    await user.click(button(await card(), 'Change it'));
    expect(screen.getByLabelText<HTMLInputElement>('Subject').value).toBe('Re: June 13');
    await user.click(screen.getByRole('button', { name: 'Send email' }));
    await screen.findByText('Reply queued to send.');
    expect(callsTo('applyProposal')).toEqual([
      {
        params: { id: draftId },
        body: {
          changes: {
            channel: 'email',
            accountId: draftedChange.accountId,
            to: draftedChange.to,
            subject: 'Re: June 13',
            text: draftedText,
          },
        },
      },
    ]);
  });

  it('comes back from an internal note to the reply', async () => {
    serve();
    const { user } = open();
    await card();
    await user.click(screen.getByRole('button', { name: 'Internal note' }));
    expect(screen.getByRole('form', { name: 'Internal note' })).toBeDefined();
    await user.click(button(await card(), 'Change it'));
    expect(screen.queryByRole('form', { name: 'Internal note' })).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(box());
    });
  });

  it('starts over: the reply box is the person’s own again, and sends as their own reply', async () => {
    serve();
    const { user, sendReply } = open();
    await user.click(button(await card(), 'Change it'));
    await user.click(screen.getByRole('button', { name: 'Start over' }));
    expect(box().value).toBe('');
    expect(document.activeElement).toBe(box());
    expect(screen.queryByText('You’re editing your assistant’s draft')).toBeNull();
    // The draft still waits, with everything it offered.
    expect(button(await card(), 'Send it')).toBeDefined();
    await user.type(box(), 'I will call you.');
    await user.click(screen.getByRole('button', { name: 'Send email' }));
    await screen.findByText('Reply queued to send.');
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[1]).toMatchObject({ text: 'I will call you.' });
    expect(callsTo('applyProposal')).toEqual([]);
  });

  it('keeps the words when the draft can no longer be applied, as the person’s own reply', async () => {
    const world = serve();
    world.override = refuse(
      'applyProposal',
      problem(409, 'Maya wrote again after this was drafted.'),
    );
    const { user, sendReply } = open();
    await user.click(button(await card(), 'Change it'));
    await user.type(box(), ' Thanks!');
    await user.click(screen.getByRole('button', { name: 'Send email' }));
    const alert = await screen.findByText('Maya wrote again after this was drafted.');
    expect(alert.parentElement?.getAttribute('role')).toBe('alert');
    expect(alert.parentElement?.textContent).toContain(
      'Nothing was sent. Your words are still in the box: sending them now sends your own reply.',
    );
    await waitFor(() => {
      expect(box().value).toContain('Thanks!');
    });
    expect(screen.queryByText('You’re editing your assistant’s draft')).toBeNull();
    expect(sendReply).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(box().disabled).toBe(false);
    });
    await user.click(screen.getByRole('button', { name: 'Send email' }));
    await screen.findByText('Reply queued to send.');
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(callsTo('applyProposal')).toHaveLength(1);
  });

  it('says why a changed draft was not sent: a role, a refusal, a lost connection', async () => {
    const world = serve();
    world.override = refuse('applyProposal', problem(403, 'It needs conversations.reply.'));
    const { user, sendReply } = open();
    await user.click(button(await card(), 'Change it'));
    const send = (): HTMLElement => screen.getByRole('button', { name: 'Send email' });
    await user.click(send());
    expect(
      await screen.findByText('Sending this reply needs a permission your role doesn’t have.'),
    ).toBeDefined();
    world.override = refuse(
      'applyProposal',
      problem(422, 'Refused.', [
        { path: '/reply/to', code: 'recipient_not_in_conversation', message: 'Not theirs.' },
      ]),
    );
    await waitFor(() => {
      expect(box().disabled).toBe(false);
    });
    await user.click(send());
    expect(
      await screen.findByText("Choose one of this contact's own addresses or numbers."),
    ).toBeDefined();
    world.override = refuse('applyProposal', new TypeError('Failed to fetch'));
    await waitFor(() => {
      expect(box().disabled).toBe(false);
    });
    await user.click(send());
    expect(
      await screen.findByText(
        "The reply wasn't sent. Check your connection and try again. Trying again won't send it twice.",
      ),
    ).toBeDefined();
    // The words and the draft are kept for the next try, which applies the same proposal.
    expect(screen.getByText('You’re editing your assistant’s draft')).toBeDefined();
    expect(sendReply).not.toHaveBeenCalled();
    world.override = undefined;
    await waitFor(() => {
      expect(box().disabled).toBe(false);
    });
    await user.click(send());
    await screen.findByText('Reply queued to send.');
    expect(callsTo('applyProposal')).toHaveLength(4);
    expect(outbound()).toBe(1);
  });

  it('keeps a refused reply in the box, no longer as the assistant’s', async () => {
    serve({
      delivery: {
        status: 'failed',
        problem: { code: 'consent_required', message: 'Maya has not agreed to receive email.' },
      },
    });
    const { user } = open();
    await user.click(button(await card(), 'Change it'));
    await user.click(screen.getByRole('button', { name: 'Send email' }));
    const refused = await screen.findByText(/Your reply wasn't sent\./);
    expect(refused.parentElement?.textContent).toContain(
      'Your words are still in the box, and the thread shows the refused reply.',
    );
    await waitFor(() => {
      expect(screen.queryByText('You’re editing your assistant’s draft')).toBeNull();
    });
    expect(box().value).toContain('Hi Maya, June 13 is open');
  });

  it('offers no change where there is no reply box to change it in', async () => {
    serve({ composer: composerOf({ channels: [] }) });
    open();
    const draft = await card();
    expect(button(draft, 'Send it')).toBeDefined();
    noButton(draft, 'Change it');
  });
});

describe('how much the assistant does, on the draft card', () => {
  it('offers "Use this draft", and no Send, when the assistant only suggests', async () => {
    serve({
      assistant: assistantOf({
        autonomy: { level: 'suggest', source: 'business', businessLevel: 'suggest' },
        proposals: [replyProposalOf({ autonomy: 'suggest' })],
      }),
    });
    const { user, sendReply } = open();
    const draft = await card();
    expect(
      within(draft)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['Why this reply?', 'Use this draft', 'Not now']);
    await user.click(button(draft, 'Use this draft'));
    expect(box().value).toContain('Hi Maya, June 13 is open');
    expect(document.activeElement).toBe(box());
    expect(screen.getByText('You’re editing your assistant’s draft')).toBeDefined();
    expect(callsTo('applyProposal')).toEqual([]);
    // Sending it is still the person's own act, and still applies the proposal.
    await user.click(screen.getByRole('button', { name: 'Send email' }));
    await screen.findByText('Reply queued to send.');
    expect(callsTo('applyProposal')).toHaveLength(1);
    expect(sendReply).not.toHaveBeenCalled();
  });

  it('offers Send it when the assistant asks first, and when it acts', async () => {
    for (const level of ['ask', 'act'] as const) {
      serve({
        assistant: assistantOf({
          autonomy: { level, source: 'business', businessLevel: level },
          proposals: [replyProposalOf({ autonomy: level })],
        }),
      });
      open();
      const draft = await card();
      expect(button(draft, 'Send it')).toBeDefined();
      noButton(draft, 'Use this draft');
      cleanup();
    }
  });

  it('says the assistant replied on its own, with no Undo, and why there is none', async () => {
    serve({
      assistant: assistantOf({
        autonomy: { level: 'act', source: 'contact' },
        proposals: [sentReplyOf({ autonomy: 'act', decidedBy: theAssistant })],
      }),
      items: [
        messageOf({
          id: sentId,
          direction: 'outbound',
          author: theAssistant,
          status: 'sent',
          text: 'June 13 is open.',
        }),
        messageOf(),
      ],
    });
    open();
    const done = within(await region()).getByRole('list', {
      name: 'What was done on your assistant’s suggestions',
    });
    expect(done.textContent).toContain('Your assistant replied on its own');
    expect(done.textContent).toContain('A message that was sent can’t be unsent.');
    expect(done.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-09T08:10:00.000Z');
    noButton(done, 'Undo');
    expect(within(await region()).queryByRole('group', { name: /^Suggested reply/ })).toBeNull();
    // The thread shows the message as the assistant's.
    expect(screen.getByText('Email to Maya Thompson, from AI assistant')).toBeDefined();
  });

  it('shows the server’s own reason where it names one this version does not know', async () => {
    serve({
      assistant: assistantOf({
        proposals: [
          sentReplyOf({
            decidedBy: theAssistant,
            undo: { available: false, reason: null, message: 'This can’t be undone from here.' },
          }),
        ],
      }),
    });
    open();
    expect((await region()).textContent).toContain('This can’t be undone from here.');
  });
});

describe('a draft someone cannot send, or that is out of date', () => {
  it('shows the draft read-only to someone whose role cannot decide it', async () => {
    serve({
      assistant: assistantOf({
        canDraft: false,
        autonomy: { canChange: false },
        proposals: [replyProposalOf({ canDecide: false })],
      }),
    });
    open();
    const draft = await card();
    expect(within(draft).getByText(/June 13 is open/)).toBeDefined();
    expect(
      within(draft).getByText('Sending this reply needs a permission your role doesn’t have.'),
    ).toBeDefined();
    expect(
      within(draft)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['Why this reply?']);
  });

  it('says the contact wrote again, and offers a new draft or to set it aside', async () => {
    serve({
      assistant: assistantOf({ proposals: [replyProposalOf({ stale: true })] }),
      items: [
        messageOf({
          id: messageId('3'),
          text: 'Actually, make it June 14.',
          createdAt: '2026-10-09T08:05:00.000Z',
        }),
        messageOf(),
      ],
    });
    const { user } = open();
    const draft = await card();
    expect(within(draft).getByText('Suggested reply, now out of date')).toBeDefined();
    expect(
      within(draft).getByText(
        'Maya Thompson wrote again after this was drafted, so it can’t be sent as it is.',
      ),
    ).toBeDefined();
    expect(
      within(draft)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['Why this reply?', 'Draft a new reply', 'Not now']);
    await user.click(button(draft, 'Draft a new reply'));
    expect(await screen.findByText('Your assistant is writing a reply…')).toBeDefined();
    expect(callsTo('requestReplyDraft')).toEqual([{ params: { id } }]);
    expect(callsTo('applyProposal')).toEqual([]);
  });

  it('says the conversation changed when it was not the contact who wrote', async () => {
    serve({
      assistant: assistantOf({ canDraft: false, proposals: [replyProposalOf({ stale: true })] }),
    });
    const { user } = open();
    const draft = await card();
    expect(
      within(draft).getByText(
        'This conversation changed after this was drafted, so it can’t be sent as it is.',
      ),
    ).toBeDefined();
    // Someone who may not ask for a draft can still set this one aside.
    expect(
      within(draft)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['Why this reply?', 'Not now']);
    await user.click(button(draft, 'Not now'));
    expect(await screen.findByText('Draft set aside. Nothing was sent.')).toBeDefined();
  });
});

describe('asking for a draft', () => {
  it('shows nothing at all where there is no assistant', async () => {
    for (const assistant of [noAssistant(), assistantOf({ ai: 'off' })]) {
      serve({ assistant });
      open();
      expect(await screen.findByRole('form', { name: 'Reply to Maya Thompson' })).toBeDefined();
      await waitFor(() => {
        expect(callsTo('getConversationAssistant')).toHaveLength(1);
      });
      expect(screen.queryByRole('region', { name: 'Assistant' })).toBeNull();
      expect(screen.queryByText(/assistant/i)).toBeNull();
      cleanup();
      server.calls.length = 0;
    }
  });

  it('offers a quiet "Draft a reply", asks once, and says a reply is being written', async () => {
    serve({ assistant: assistantOf() });
    const { user } = open();
    const ask = button(await region(), 'Draft a reply');
    await user.dblClick(ask);
    const writing = await screen.findByText('Your assistant is writing a reply…');
    expect(writing.getAttribute('role')).toBe('status');
    expect(callsTo('requestReplyDraft')).toEqual([{ params: { id } }]);
    noButton(await region(), 'Draft a reply');
    // The button is gone: the keyboard is on what replaced it.
    await waitFor(() => {
      expect(document.activeElement).toBe(writing);
    });
    // Nothing is blocked meanwhile: the person can write their own reply.
    expect(box().disabled).toBe(false);
    await user.type(box(), 'My own words.');
    expect(box().value).toBe('My own words.');
  });

  it('says a draft arrived, and moves the keyboard from "writing" to it', async () => {
    const world = serve({ assistant: assistantOf() });
    const { user, client } = open();
    await user.click(button(await region(), 'Draft a reply'));
    const writing = await screen.findByText('Your assistant is writing a reply…');
    await waitFor(() => {
      expect(document.activeElement).toBe(writing);
    });
    world.assistant = assistantOf({ proposals: [replyProposalOf()] });
    await client.invalidateQueries();
    const draft = await card();
    expect(
      within(await region()).getByText('Your assistant drafted a reply. It’s waiting for you.'),
    ).toBeDefined();
    expect(screen.queryByText('Your assistant is writing a reply…')).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(draft);
    });
    // Once the draft is no longer waiting, the page stops saying that it is.
    world.assistant = assistantOf();
    await client.invalidateQueries();
    await waitFor(() => {
      expect(
        screen.queryByText('Your assistant drafted a reply. It’s waiting for you.'),
      ).toBeNull();
    });
  });

  it('moves the keyboard to why there is no draft when writing ends without one', async () => {
    const world = serve({ assistant: assistantOf() });
    const { user, client } = open();
    await user.click(button(await region(), 'Draft a reply'));
    const writing = await screen.findByText('Your assistant is writing a reply…');
    await waitFor(() => {
      expect(document.activeElement).toBe(writing);
    });
    world.assistant = assistantOf({ draft: endedDraftOf('failed', 'timeout') });
    await client.invalidateQueries();
    const notice = await within(await region()).findByRole('group', { name: 'No draft' });
    await waitFor(() => {
      expect(document.activeElement).toBe(notice);
    });
  });

  it('says why asking did not go through', async () => {
    const world = serve({ assistant: assistantOf() });
    world.override = refuse('requestReplyDraft', problem(403, 'It needs conversations.reply.'));
    const { user } = open();
    await user.click(button(await region(), 'Draft a reply'));
    expect(
      await screen.findByText(
        'Asking your assistant for a draft needs a permission your role doesn’t have.',
      ),
    ).toBeDefined();
    world.override = refuse('requestReplyDraft', new TypeError('Failed to fetch'));
    await user.click(button(await region(), 'Draft a reply'));
    expect(
      await screen.findByText('That didn’t go through. Check your connection and try again.'),
    ).toBeDefined();
  });

  it('offers no draft to someone who may not ask for one', async () => {
    serve({ assistant: assistantOf({ canDraft: false }) });
    open();
    noButton(await region(), 'Draft a reply');
  });

  it('says in plain words why there is no draft, and offers another try where one could help', async () => {
    const world = serve({ assistant: assistantOf({ draft: endedDraftOf('failed', 'timeout') }) });
    const { user, client } = open();
    const notice = async (): Promise<HTMLElement> =>
      within(await region()).findByRole('group', { name: 'No draft' });
    expect((await notice()).textContent).toContain(
      'The AI provider took too long to answer, so no draft was written. Try again, or write your own reply.',
    );
    // The API's own English words are never what is shown.
    expect((await notice()).textContent).not.toContain('No draft was written.');
    noButton(await region(), 'Draft a reply');
    expect(within(await notice()).queryByRole('link')).toBeNull();

    world.assistant = assistantOf({ draft: endedDraftOf('refused') });
    await client.invalidateQueries();
    expect(
      await screen.findByText(
        'Your assistant declined to draft a reply to this one. You can write your own reply.',
      ),
    ).toBeDefined();
    expect(button(await notice(), 'Draft again')).toBeDefined();

    world.assistant = assistantOf({ draft: endedDraftOf('nothing_to_answer', 'answered') });
    await client.invalidateQueries();
    expect(await screen.findByText(/^There’s nothing new to answer/)).toBeDefined();
    expect(within(await notice()).queryByRole('button')).toBeNull();

    world.assistant = assistantOf({ draft: endedDraftOf('expired') });
    await client.invalidateQueries();
    expect(await screen.findByText(/nothing picked the request up/)).toBeDefined();
    await user.click(button(await notice(), 'Try again'));
    expect(await screen.findByText('Your assistant is writing a reply…')).toBeDefined();
    expect(callsTo('requestReplyDraft')).toHaveLength(1);
  });

  it('sends those who manage AI to its settings, and tells the rest whom to ask', async () => {
    const world = serve({
      assistant: assistantOf({ draft: endedDraftOf('paused', 'limit_reached') }),
    });
    const { client } = open();
    expect(
      await screen.findByText(
        'This month’s AI spending limit has been reached, so no draft was written. You can still write your own reply.',
      ),
    ).toBeDefined();
    const link = within(await region()).getByRole('link', { name: 'Open AI models in Settings' });
    expect(link.getAttribute('href')).toBe('/b/$slug/settings/ai-models');
    expect(screen.queryByText(/Ask someone who manages AI/)).toBeNull();

    for (const [draft, words] of [
      [endedDraftOf('not_configured'), /^No AI provider that can write replies is connected/],
      [endedDraftOf('ai_off'), /^AI is turned off for this business/],
      [endedDraftOf('paused', 'price_unknown'), /^The model chosen for replies has no price/],
    ] as const) {
      world.assistant = assistantOf({ ai: 'off', autonomy: { canChange: false }, draft });
      await client.invalidateQueries();
      expect(await screen.findByText(words)).toBeDefined();
      expect(within(await region()).queryByRole('link')).toBeNull();
      expect(
        screen.getByText('Ask someone who manages AI for this business to look at it in Settings.'),
      ).toBeDefined();
      // With AI off, another try could not help.
      noButton(await region(), 'Try again');
    }
  });
});

describe('a suggested change of status', () => {
  const suggestion = async (): Promise<HTMLElement> =>
    within(await region()).findByRole('group', { name: /^Your assistant suggests/ });

  it('shows before and after, applies once, and can be undone where it shows', async () => {
    serve({ assistant: assistantOf({ proposals: [statusProposalOf()] }) });
    const { user } = open();
    const approval = await suggestion();
    expect(
      within(approval).getByText('Your assistant suggests closing this conversation'),
    ).toBeDefined();
    expect(within(approval).getByText('Open → Closed')).toBeDefined();
    expect(
      within(approval)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['Apply', 'Dismiss']);
    await user.dblClick(button(approval, 'Apply'));
    const closed = await within(await region()).findByText('Conversation closed.');
    expect(closed.getAttribute('role')).toBe('status');
    expect(callsTo('applyProposal')).toEqual([{ params: { id: proposalId('2') }, body: {} }]);
    await waitFor(() => {
      expect(focused()).toBe('Conversation closed.');
    });
    // The thread's own header shows it closed, without a reload.
    expect(await screen.findByRole('button', { name: 'Reopen conversation' })).toBeDefined();

    const done = within(await region()).getByRole('list', {
      name: 'What was done on your assistant’s suggestions',
    });
    expect(done.textContent).toContain('Closed on your assistant’s suggestion by you');
    const undo = button(done, 'Undo');
    expect(document.getElementById(undo.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Closed on your assistant’s suggestion by you',
    );
    await user.dblClick(undo);
    expect(await screen.findByText('Undone: the conversation is open again.')).toBeDefined();
    expect(callsTo('undoProposal')).toEqual([{ params: { id: proposalId('2') } }]);
    await waitFor(() => {
      expect(focused()).toBe('Undone: the conversation is open again.');
    });
    expect(await screen.findByRole('button', { name: 'Close conversation' })).toBeDefined();
    expect(
      within(await region()).getByText(
        'You undid a change your assistant suggested (Open → Closed)',
      ),
    ).toBeDefined();
    noButton(await region(), 'Undo');
  });

  it('shows the server’s plain words when it cannot be undone any more', async () => {
    const world = serve({ assistant: assistantOf({ proposals: [appliedStatusOf()] }) });
    world.override = refuse(
      'undoProposal',
      problem(409, 'This conversation was changed again since, so it can’t be undone from here.'),
    );
    const { user } = open();
    await user.click(button(await region(), 'Undo'));
    expect((await within(await region()).findByRole('alert')).textContent).toBe(
      'This conversation was changed again since, so it can’t be undone from here.',
    );
  });

  it('dismisses without changing anything', async () => {
    serve({ assistant: assistantOf({ proposals: [statusProposalOf()] }) });
    const { user } = open();
    await user.click(button(await suggestion(), 'Dismiss'));
    expect(await screen.findByText('Suggestion dismissed. Nothing was changed.')).toBeDefined();
    expect(callsTo('dismissProposal')).toEqual([{ params: { id: proposalId('2') } }]);
    expect(callsTo('applyProposal')).toEqual([]);
    expect(screen.getByRole('button', { name: 'Close conversation' })).toBeDefined();
  });

  it('says a role may not change the conversation', async () => {
    const world = serve({ assistant: assistantOf({ proposals: [statusProposalOf()] }) });
    world.override = refuse('applyProposal', problem(403, 'It needs conversations.manage.'));
    const { user } = open();
    await user.click(button(await suggestion(), 'Apply'));
    expect((await within(await region()).findByRole('alert')).textContent).toBe(
      'Changing this conversation needs a permission your role doesn’t have.',
    );
  });

  it('words reopening and snoozing, with the time a snooze would end', async () => {
    const world = serve({
      assistant: assistantOf({
        proposals: [
          statusProposalOf({
            change: { kind: 'conversation_status', from: 'closed', to: 'open', until: null },
          }),
        ],
      }),
      conversation: conversationOf({ status: 'closed', unreadCount: 0 }),
    });
    const { user, client } = open();
    expect(
      await screen.findByText('Your assistant suggests reopening this conversation'),
    ).toBeDefined();
    expect(within(await suggestion()).getByText('Closed → Open')).toBeDefined();
    await user.click(button(await suggestion(), 'Apply'));
    expect(await screen.findByText('Conversation reopened.')).toBeDefined();
    expect((await region()).textContent).toContain(
      'Reopened on your assistant’s suggestion by you',
    );

    const until = '2026-10-12T09:00:00.000Z';
    world.assistant = assistantOf({
      proposals: [
        statusProposalOf({
          change: { kind: 'conversation_status', from: 'open', to: 'snoozed', until },
        }),
      ],
    });
    await client.invalidateQueries();
    const when = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(until),
    );
    expect(
      await screen.findByText(`Your assistant suggests snoozing this conversation until ${when}`),
    ).toBeDefined();
    expect(within(await suggestion()).getByText('Open → Snoozed')).toBeDefined();
    await user.click(button(await suggestion(), 'Apply'));
    expect(await screen.findByText('Conversation snoozed.')).toBeDefined();
    expect((await region()).textContent).toContain('Snoozed on your assistant’s suggestion by you');

    world.assistant = assistantOf({
      proposals: [
        statusProposalOf({
          change: { kind: 'conversation_status', from: 'open', to: 'snoozed', until: null },
        }),
      ],
    });
    await client.invalidateQueries();
    expect(
      await screen.findByText('Your assistant suggests snoozing this conversation'),
    ).toBeDefined();
  });

  it('offers only Dismiss for one that is out of date, and nothing to a role that cannot decide', async () => {
    const world = serve({
      assistant: assistantOf({ proposals: [statusProposalOf({ stale: true })] }),
    });
    const { client } = open();
    const approval = await suggestion();
    expect(
      within(approval).getByText(
        'This conversation changed after this was suggested, so it can’t be applied as it is.',
      ),
    ).toBeDefined();
    expect(
      within(approval)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['Dismiss']);
    world.assistant = assistantOf({ proposals: [statusProposalOf({ canDecide: false })] });
    await client.invalidateQueries();
    expect(
      await screen.findByText(
        'Changing this conversation needs a permission your role doesn’t have.',
      ),
    ).toBeDefined();
    expect(within(await suggestion()).queryByRole('button')).toBeNull();
  });

  it('names who decided, and what they undid', async () => {
    serve({
      assistant: assistantOf({
        proposals: [
          appliedStatusOf({
            decidedBy: sam,
            undo: { available: false, reason: null, message: null },
          }),
          appliedStatusOf({
            id: proposalId('3'),
            change: { kind: 'conversation_status', from: 'open', to: 'snoozed', until: null },
            decidedBy: sam,
            canDecide: false,
          }),
          appliedStatusOf({
            id: proposalId('4'),
            change: { kind: 'conversation_status', from: 'closed', to: 'open', until: null },
            decidedBy: sam,
          }),
          appliedStatusOf({ id: proposalId('5'), status: 'undone', undo: null, undoneBy: sam }),
          appliedStatusOf({ id: proposalId('6'), status: 'undone', undo: null, undoneBy: null }),
          sentReplyOf({ id: proposalId('7'), decidedBy: sam }),
          sentReplyOf({ id: proposalId('8'), decidedBy: sam, edited: true }),
          sentReplyOf({
            id: proposalId('9'),
            decidedBy: sam,
            undo: { available: false, reason: 'not_sent', message: 'This reply was never sent.' },
          }),
        ],
      }),
    });
    open();
    const done = within(await region()).getByRole('list', {
      name: 'What was done on your assistant’s suggestions',
    });
    const lines = within(done)
      .getAllByRole('listitem')
      .map((each) => each.querySelector('span')?.textContent);
    expect(lines).toEqual([
      'Closed on your assistant’s suggestion by Sam Lee',
      'Snoozed on your assistant’s suggestion by Sam Lee',
      'Reopened on your assistant’s suggestion by Sam Lee',
      'Sam Lee undid a change your assistant suggested (Open → Closed)',
      'Someone on your team undid a change your assistant suggested (Open → Closed)',
      'Sam Lee sent your assistant’s draft',
      'Sam Lee changed your assistant’s draft and sent it',
      'Sam Lee approved your assistant’s draft, but it wasn’t sent. The thread says why.',
    ]);
    // Undo only where the server says it can be, and the role allows it.
    expect(within(done).getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    // The server's reason for a reply nobody sent is not repeated beside a person's own act.
    expect(done.textContent).not.toContain('This reply was never sent.');
  });
});

describe('how much the assistant does for this contact', () => {
  const control = async (): Promise<HTMLElement> =>
    within(await region()).findByRole('group', { name: 'Your assistant for Maya' });
  const pressed = (group: HTMLElement): (string | null)[] =>
    within(group)
      .getAllByRole('button')
      .map((each) => `${each.textContent}:${each.getAttribute('aria-pressed') ?? ''}`);

  it('shows the three levels, the one that applies, and what it means', async () => {
    serve({ assistant: assistantOf() });
    open();
    const group = await control();
    expect(pressed(group)).toEqual(['Suggest:false', 'Ask first:true', 'Act:false']);
    expect(document.getElementById(group.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Writes replies and asks you before sending.',
    );
    noButton(await region(), 'Use the business’s setting (Ask first)');
  });

  it('saves a level the moment it is chosen, and says what now applies', async () => {
    serve({ assistant: assistantOf() });
    const { user } = open();
    await user.click(button(await control(), 'Suggest'));
    expect(
      await screen.findByText(
        'Saved. Your assistant writes drafts for Maya, for you to send yourself.',
      ),
    ).toBeDefined();
    expect(callsTo('setAutonomy')).toEqual([
      { body: { agent: 'inbox', action: 'send_message', contactId: maya.id, level: 'suggest' } },
    ]);
    expect(pressed(await control())).toEqual(['Suggest:true', 'Ask first:false', 'Act:false']);
    expect(screen.getByText('Writes drafts for you to send yourself.')).toBeDefined();
    expect(document.activeElement).toBe(button(await control(), 'Suggest'));
    // Choosing the level that already applies saves nothing.
    await user.click(button(await control(), 'Suggest'));
    expect(callsTo('setAutonomy')).toHaveLength(1);
  });

  it('asks before letting the assistant act, and saves nothing on Cancel', async () => {
    serve({ assistant: assistantOf() });
    const { user } = open();
    await user.click(button(await control(), 'Act'));
    const question = await screen.findByText(
      'Your assistant will send replies to Maya without asking.',
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(question);
    });
    expect(callsTo('setAutonomy')).toEqual([]);
    expect(pressed(await control())).toEqual(['Suggest:false', 'Ask first:true', 'Act:false']);
    const confirmation = within(await region()).getByRole('group', {
      name: 'Your assistant will send replies to Maya without asking.',
    });
    await user.click(button(confirmation, 'Cancel'));
    expect(
      screen.queryByText('Your assistant will send replies to Maya without asking.'),
    ).toBeNull();
    expect(callsTo('setAutonomy')).toEqual([]);
    await waitFor(async () => {
      expect(document.activeElement).toBe(button(await control(), 'Act'));
    });
  });

  it('lets the assistant act once that is confirmed, from the keyboard', async () => {
    serve({ assistant: assistantOf() });
    const { user } = open();
    button(await control(), 'Act').focus();
    await user.keyboard('{Enter}');
    await screen.findByText('Your assistant will send replies to Maya without asking.');
    await user.tab();
    expect(document.activeElement?.textContent).toBe('Let it act');
    await user.keyboard('{Enter}');
    expect(
      await screen.findByText(
        'Saved. Your assistant replies to Maya on its own and tells you what it sent.',
      ),
    ).toBeDefined();
    expect(callsTo('setAutonomy')).toEqual([
      { body: { agent: 'inbox', action: 'send_message', contactId: maya.id, level: 'act' } },
    ]);
    expect(pressed(await control())).toEqual(['Suggest:false', 'Ask first:false', 'Act:true']);
    expect(document.activeElement).toBe(button(await control(), 'Act'));
    expect(screen.queryByRole('button', { name: 'Let it act' })).toBeNull();
    expect(screen.getByText('Replies on its own and tells you what it sent.')).toBeDefined();
  });

  it('gives up a contact’s own level for the business’s', async () => {
    serve({
      assistant: assistantOf({
        autonomy: { level: 'act', source: 'contact', businessLevel: 'ask' },
      }),
    });
    const { user } = open();
    expect(pressed(await control())).toEqual(['Suggest:false', 'Ask first:false', 'Act:true']);
    await user.click(button(await region(), 'Use the business’s setting (Ask first)'));
    expect(
      await screen.findByText(
        'Saved. Maya follows the business’s setting again. Your assistant asks before sending anything to Maya.',
      ),
    ).toBeDefined();
    expect(callsTo('setAutonomy')).toEqual([
      { body: { agent: 'inbox', action: 'send_message', contactId: maya.id, level: null } },
    ]);
    // The button did its work and is gone: the keyboard is on the level that applies.
    noButton(await region(), 'Use the business’s setting (Ask first)');
    await waitFor(async () => {
      expect(document.activeElement).toBe(button(await control(), 'Ask first'));
    });
  });

  it('says the level as a sentence to someone who may not change it', async () => {
    const world = serve({ assistant: assistantOf({ autonomy: { canChange: false } }) });
    const { client } = open();
    expect(await screen.findByText('Your assistant for Maya')).toBeDefined();
    expect(screen.getByText('Your assistant asks before sending anything to Maya.')).toBeDefined();
    expect(
      within(await region()).queryByRole('group', { name: 'Your assistant for Maya' }),
    ).toBeNull();
    noButton(await region(), 'Act');
    world.assistant = assistantOf({ autonomy: { canChange: false, level: 'suggest' } });
    await client.invalidateQueries();
    expect(
      await screen.findByText('Your assistant writes drafts for Maya, for you to send yourself.'),
    ).toBeDefined();
    world.assistant = assistantOf({ autonomy: { canChange: false, level: 'act' } });
    await client.invalidateQueries();
    expect(
      await screen.findByText(
        'Your assistant replies to Maya on its own and tells you what it sent.',
      ),
    ).toBeDefined();
  });

  it('says why a level was not saved, and saves one at a time', async () => {
    const world = serve({ assistant: assistantOf() });
    world.override = refuse('setAutonomy', problem(403, 'It needs ai.manage.'));
    const { user } = open();
    await user.click(button(await control(), 'Suggest'));
    expect(
      await screen.findByText('Changing this needs a permission your role doesn’t have.'),
    ).toBeDefined();
    expect(callsTo('setAutonomy')).toHaveLength(1);
    expect(pressed(await control())).toEqual(['Suggest:false', 'Ask first:true', 'Act:false']);
    world.override = refuse('setAutonomy', new TypeError('Failed to fetch'));
    await user.click(button(await control(), 'Suggest'));
    expect(
      await screen.findByText('That wasn’t saved. Check your connection and try again.'),
    ).toBeDefined();
    world.override = refuse('setAutonomy', problem(503, 'The server is restarting.'));
    await user.click(button(await control(), 'Suggest'));
    expect(await screen.findByText('The server is restarting.')).toBeDefined();
  });

  it('saves once on a double click, whether the answer is slow or instant', async () => {
    const world = serve({ assistant: assistantOf() });
    const release = hold(world, 'setAutonomy');
    const { user } = open();
    await user.dblClick(button(await control(), 'Suggest'));
    expect(within(await region()).getByText('Saving…')).toBeDefined();
    expect(button(await control(), 'Suggest').getAttribute('aria-disabled')).toBe('true');
    release();
    await screen.findByText(/^Saved\./);
    expect(callsTo('setAutonomy')).toHaveLength(1);
    // An instant answer leaves a moment before the page is drawn again: still once.
    await user.dblClick(button(await control(), 'Ask first'));
    await waitFor(async () => {
      expect(pressed(await control())).toEqual(['Suggest:false', 'Ask first:true', 'Act:false']);
    });
    expect(callsTo('setAutonomy')).toHaveLength(2);
  });

  it('calls a contact with no name "this contact"', async () => {
    serve({
      assistant: assistantOf(),
      conversation: conversationOf({ unreadCount: 0, contact: { ...maya, name: '' } }),
    });
    const { user } = open();
    const group = await within(await region()).findByRole('group', {
      name: 'Your assistant for this contact',
    });
    await user.click(button(group, 'Act'));
    expect(
      await screen.findByText('Your assistant will send replies to this contact without asking.'),
    ).toBeDefined();
  });
});

describe('before the assistant is read', () => {
  it('shows nothing while it loads, and nothing when the server says why it won’t answer', async () => {
    const world = serve({ assistant: assistantOf() });
    world.override = refuse('getConversationAssistant', problem(404, 'No such conversation.'));
    open();
    expect(await screen.findByRole('form', { name: 'Reply to Maya Thompson' })).toBeDefined();
    await waitFor(() => {
      expect(callsTo('getConversationAssistant')).toHaveLength(1);
    });
    expect(screen.queryByRole('region', { name: 'Assistant' })).toBeNull();
    expect(screen.queryByText(/assistant/i)).toBeNull();
  });

  it('says so, quietly, when it could not be read, and reads it on another try', async () => {
    const world = serve({ assistant: assistantOf() });
    world.override = refuse('getConversationAssistant', new TypeError('Failed to fetch'));
    const { user } = open();
    expect(
      await screen.findByText('Your assistant’s suggestions couldn’t be loaded.'),
    ).toBeDefined();
    // The thread and the composer are untouched by it.
    expect(box().disabled).toBe(false);
    world.override = undefined;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(button(await region(), 'Draft a reply')).toBeDefined();
    expect(screen.queryByText('Your assistant’s suggestions couldn’t be loaded.')).toBeNull();
  });
});
