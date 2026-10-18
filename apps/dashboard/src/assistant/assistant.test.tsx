// @vitest-environment jsdom
// The in-app assistant: what the panel and the full-screen view show for each
// answer of the API, what each button sends, and where the keyboard is afterwards. The API
// is stood in for here, answering as the server does; the same paths through a browser are
// in e2e/assistant-panel.spec.ts.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  assistantTurnInput,
  type AssistantContext,
  type AssistantMessage,
  type AssistantThread,
  type AssistantTurn,
  type Proposal,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asked,
  builtMessages,
  contextOf,
  embedSnippet,
  formContext,
  formId,
  formsListContext,
  hostedUrl,
  messageOf,
  noPermission,
  notConnected,
  publishedProposalOf,
  publishProposalOf,
  runningTurn,
  threadId,
  threadOf,
  turnOf,
} from '../../e2e/assistant-panel-fixtures';
import { Conversation } from './conversation';
import { assistantKeys } from './data';
import { AssistantLauncher, loadAssistantPanel } from './launcher';
import { AssistantPage } from './page';
import { forgetAssistantViews, readAssistantView, setAssistantView } from './view-state';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('../api', () => {
  const client = {
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  };
  return { api: client, apiIn: () => client };
});

interface Place {
  pathname: string;
  search: Record<string, unknown>;
  href: string;
  params: Record<string, string>;
}
const router = vi.hoisted(
  (): { navigate: ReturnType<typeof vi.fn<(to: unknown) => Promise<void>>>; place: Place } => ({
    navigate: vi.fn<(to: unknown) => Promise<void>>(() => Promise.resolve()),
    place: { pathname: '', search: {}, href: '', params: {} },
  }),
);
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useRouter: () => router,
  useNavigate: () => router.navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: router.place, matches: [{ params: router.place.params }] }),
}));
vi.mock('../workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
vi.mock('../shell/page', () => ({ usePageTitle: () => undefined }));

beforeAll(async () => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        // jsdom lays nothing out: there is nothing to watch.
      }
      disconnect(): void {
        // Nothing was watched.
      }
    },
  );
  // The panel's code, which the launcher fetches lazily, fetched before any test waits on it.
  await loadAssistantPanel();
});
beforeEach(() => {
  server.calls.length = 0;
  router.navigate.mockClear();
  router.place = {
    pathname: '/b/harbor/settings/forms',
    search: {},
    href: '/b/harbor/settings/forms',
    params: { slug: 'harbor' },
  };
  window.sessionStorage.clear();
  forgetAssistantViews();
});
afterEach(cleanup);

const id = threadId('1');
const problem = (status: number, detail: string): ApiError =>
  new ApiError({ type: 'about:blank', title: 'Refused', status, detail });

/** What the API holds, as a test set it up; answers are read from it at each call. */
interface World {
  context: AssistantContext;
  threads: AssistantThread[];
  messages: AssistantMessage[];
  turn: AssistantTurn | null;
  /** Answers one operation another way, such as with an error. */
  override?: (operation: string, input: unknown) => unknown;
}

function serve(start: Partial<World> = {}): World {
  const world: World = {
    context: contextOf(),
    threads: [],
    messages: [],
    turn: null,
    ...start,
  };
  const decided = (proposal: Proposal): Proposal => {
    world.messages = world.messages.map((message) =>
      message.proposal?.id === proposal.id ? { ...message, proposal } : message,
    );
    return proposal;
  };
  const start_ = (input: unknown): unknown => {
    const { body } = input as { body: unknown };
    const { message } = assistantTurnInput.parse(body);
    const said = messageOf(world.messages.length + 1, { kind: 'user', text: message });
    world.messages = [...world.messages, said];
    world.turn = runningTurn;
    const thread = threadOf({ title: message.slice(0, 80), turn: runningTurn });
    world.threads = [thread];
    return { thread, turn: runningTurn, message: said };
  };
  server.answer = (operation, input) => {
    const overridden = world.override?.(operation, input);
    if (overridden !== undefined) {
      if (overridden instanceof Error) throw overridden;
      return overridden;
    }
    const last = world.messages.at(-1)?.seq ?? 0;
    switch (operation) {
      case 'getAssistantContext':
        return world.context;
      case 'listAssistantThreads':
        return { items: world.threads, nextCursor: null };
      case 'getAssistantThread':
        return {
          thread: world.threads[0] ?? threadOf(),
          messages: { items: world.messages, cursor: last, more: false, turn: world.turn },
        };
      case 'listAssistantMessages': {
        const { after } = (input as { query: { after: number } }).query;
        return {
          items: world.messages.filter((message) => message.seq > after),
          cursor: Math.max(after, last),
          more: false,
          turn: world.turn,
        };
      }
      case 'createAssistantThread':
      case 'postAssistantTurn':
        return start_(input);
      case 'cancelAssistantTurn':
        world.turn = turnOf({ outcome: 'cancelled', message: 'Stopped.', costEstimate: null });
        world.messages = [
          ...world.messages,
          messageOf(last + 1, { kind: 'error', code: 'cancelled', text: 'Stopped.' }),
        ];
        return world.turn;
      case 'applyProposal':
        return decided(publishedProposalOf());
      case 'dismissProposal':
        return decided(publishProposalOf({ status: 'dismissed' }));
      case 'undoProposal':
        return decided(publishProposalOf({ status: 'undone', undoneAt: turnOf().createdAt }));
      case 'deleteAssistantThread':
        world.threads = [];
        return undefined;
      default:
        throw new Error(`Unexpected ${operation}`);
    }
  };
  return world;
}

let cache: QueryClient;
function draw(ui: ReactElement): ReturnType<typeof userEvent.setup> {
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={cache}>
      <I18nProvider i18n={i18n}>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup({ delay: null });
}

const formsPage = { route: '/forms', selection: [] };
const onThread = vi.fn<(threadId: string | null) => void>();

/** One conversation, as either size draws it, on the list of forms. */
function conversation(
  thread: string | null = null,
  here = '/b/harbor/settings/forms',
): ReturnType<typeof userEvent.setup> {
  onThread.mockClear();
  return draw(
    <Conversation
      businessId="biz_test"
      slug="harbor"
      threadId={thread}
      onThread={onThread}
      page={formsPage}
      here={here}
    />,
  );
}

/** A past conversation's row, told from the button beside it that deletes it. */
const rowOf = (within_: HTMLElement, title: string): HTMLElement =>
  within(within_).getByRole('button', { name: (name) => name.startsWith(title) });
const box = (): HTMLElement => screen.getByRole('textbox', { name: 'Message the assistant' });
const sent = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);
/** What a realtime hint does: every query of the business is read again. */
const hint = (): Promise<void> =>
  act(() => cache.invalidateQueries({ queryKey: assistantKeys.all('biz_test') }));

describe('where the assistant cannot be asked', () => {
  it('says no provider is connected, links to AI models, shows the checks, and has no box', async () => {
    serve({ context: { ...formContext(), ...pickUnavailable(notConnected) } });
    conversation();
    expect(await screen.findByText(notConnected.message ?? '')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Open Settings → AI models' })).toHaveProperty(
      'href',
      expect.stringContaining('/b/harbor/settings/ai-models'),
    );
    expect(screen.getByText('The second question has no label.')).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Things to ask' })).toBeNull();
  });

  it('says a role does not include it, with nowhere to send the person', async () => {
    serve({ context: noPermission });
    conversation();
    expect(await screen.findByText(noPermission.message ?? '')).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('says so when the page’s answer never arrived, and asks again', async () => {
    const world = serve();
    world.override = (operation) =>
      operation === 'getAssistantContext' ? new TypeError('Failed to fetch') : undefined;
    const user = conversation();
    expect(await screen.findByText(/couldn’t load/)).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
    delete world.override;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('textbox')).toBeDefined();
  });
});

function pickUnavailable(context: AssistantContext): Partial<AssistantContext> {
  return {
    ai: context.ai,
    canUse: context.canUse,
    message: context.message,
    connect: context.connect,
  };
}

describe('the checks', () => {
  it('lists what stops the form first, then what is usually wanted, each leading to its place', async () => {
    serve({ context: formContext() });
    conversation();
    const checks = await screen.findByRole('region', { name: 'On “Wedding enquiry”' });
    const items = within(checks).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(
      formContext().checks.map((check) => check.message),
    );
    expect(within(checks).getByText('Needs fixing')).toBeDefined();
    expect(within(checks).getByText('Suggestions')).toBeDefined();
    expect(
      within(checks).getByRole('link', { name: 'The second question has no label.' }),
    ).toHaveProperty('href', expect.stringContaining(`/settings/forms?form=${formId('1')}`));
    expect(within(checks).getByRole('link', { name: /No workflow starts/ })).toHaveProperty(
      'href',
      expect.stringContaining('/b/harbor/automations'),
    );
  });

  it('draws no link to the page the person is already on, and follows the others in the app', async () => {
    serve({ context: formContext() });
    const user = conversation(null, `/b/harbor/settings/forms?form=${formId('1')}`);
    const checks = await screen.findByRole('region', { name: 'On “Wedding enquiry”' });
    expect(within(checks).getAllByRole('link')).toHaveLength(1);
    await user.click(within(checks).getByRole('link', { name: /No workflow starts/ }));
    expect(router.navigate).toHaveBeenCalledWith({ href: '/b/harbor/automations' });
  });

  it('shows none on a page that has none, under a plain name where there is no record', async () => {
    serve({
      context: contextOf({
        checks: [{ severity: 'suggestion', code: 'x', message: 'Add a tag.', target: null }],
      }),
    });
    conversation();
    const checks = await screen.findByRole('region', { name: 'On this page' });
    expect(within(checks).queryByText('Needs fixing')).toBeNull();
    expect(within(checks).queryByRole('link')).toBeNull();
  });
});

describe('an empty conversation', () => {
  it('says what can be asked, and sends a chip’s prompt with the page it was asked from', async () => {
    serve({ context: formsListContext });
    const user = conversation();
    expect(await screen.findByText(/Nothing goes live until you confirm it/)).toBeDefined();
    const chips = screen.getByRole('group', { name: 'Things to ask' });
    await user.click(within(chips).getByRole('button', { name: 'Build a form for me' }));
    await waitFor(() => {
      expect(onThread).toHaveBeenCalledWith(id);
    });
    expect(sent('createAssistantThread')).toEqual([
      { body: { message: formsListContext.chips[0]?.prompt, page: formsPage } },
    ]);
  });

  it('sends what is typed with Enter, keeps a new line for Shift+Enter, and sends nothing empty', async () => {
    serve();
    const user = conversation();
    await user.click(await screen.findByRole('textbox'));
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('ariaDisabled', 'true');
    await user.keyboard('A form{Shift>}{Enter}{/Shift}for weddings{Enter}');
    await waitFor(() => {
      expect(sent('createAssistantThread')).toEqual([
        { body: { message: 'A form\nfor weddings', page: formsPage } },
      ]);
    });
    await waitFor(() => {
      expect(box()).toHaveProperty('value', '');
    });
  });

  it('sends with the button too', async () => {
    serve();
    const user = conversation();
    await user.type(await screen.findByRole('textbox'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(sent('createAssistantThread')).toHaveLength(1);
    });
  });

  it('shows the server’s own sentence when it refuses a message, and keeps what was typed', async () => {
    const world = serve();
    const refusal = 'You have started 30 conversations this hour. Try again later.';
    world.override = (operation) =>
      operation === 'createAssistantThread' ? problem(409, refusal) : undefined;
    const user = conversation();
    await user.type(await screen.findByRole('textbox'), 'Hello{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe(refusal);
    expect(box()).toHaveProperty('value', 'Hello');
    expect(onThread).not.toHaveBeenCalled();
  });

  it('says a message that never left can be sent again', async () => {
    const world = serve();
    world.override = (operation) =>
      operation === 'createAssistantThread' ? new TypeError('Failed to fetch') : undefined;
    const user = conversation();
    await user.type(await screen.findByRole('textbox'), 'Hello{Enter}');
    expect((await screen.findByRole('alert')).textContent).toContain('couldn’t be sent');
  });
});

describe('a conversation', () => {
  it('shows who said what, what was done with a link to it, and the card', async () => {
    serve({ messages: builtMessages(), turn: turnOf(), threads: [threadOf()] });
    conversation(id);
    const log = await screen.findByRole('log', { name: 'Messages' });
    expect(await within(log).findByText(asked, { exact: false })).toBeDefined();
    const steps = within(log).getByRole('list', { name: 'What the assistant did' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(2);
    expect(
      within(steps).getByRole('link', { name: 'Created the draft form “Wedding enquiry”' }),
    ).toHaveProperty('href', expect.stringContaining(`/settings/forms?form=${formId('1')}`));
    expect(
      within(log).getByRole('group', { name: 'Publish the form “Wedding enquiry”' }),
    ).toBeDefined();
    expect(within(log).getByText(/The draft is ready/)).toBeDefined();
    expect(screen.getByText('That answer cost about $0.0042.')).toBeDefined();
    expect(sent('postAssistantTurn')).toEqual([]);
  });

  it('sends the next message into the same conversation', async () => {
    serve({ messages: builtMessages(), turn: turnOf(), threads: [threadOf()] });
    const user = conversation(id);
    await user.type(await screen.findByRole('textbox'), 'Add a phone question{Enter}');
    await waitFor(() => {
      expect(sent('postAssistantTurn')).toEqual([
        { params: { id }, body: { message: 'Add a phone question', page: formsPage } },
      ]);
    });
    expect(onThread).not.toHaveBeenCalled();
    expect(await screen.findByText(/Add a phone question/)).toBeDefined();
  });

  it('marks a step that was refused, and says a step with no page of its own plainly', async () => {
    serve({
      messages: [
        messageOf(1, {
          kind: 'activity',
          text: 'Could not create the tag “VIP”',
          activity: { operationId: 'createTag', effect: 'draft', ok: false, target: null },
        }),
      ],
      turn: turnOf(),
    });
    conversation(id);
    const step = await screen.findByText('Could not create the tag “VIP”');
    expect(step.parentElement?.textContent).toContain('Not done:');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('waits on Stop while the assistant works, reads what is new on a hint, and gives the box back', async () => {
    const world = serve({
      messages: [messageOf(1, { kind: 'user', text: asked })],
      turn: runningTurn,
      threads: [threadOf({ turn: runningTurn })],
    });
    conversation(id);
    expect(await screen.findByText('Working…')).toBeDefined();
    expect(box()).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    screen.getByRole('button', { name: 'Stop' }).focus();

    world.messages = builtMessages();
    world.turn = turnOf();
    await hint();
    expect(await screen.findByText(/The draft is ready/)).toBeDefined();
    expect(screen.queryByText('Working…')).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(box());
    });
    expect(sent('listAssistantMessages').at(-1)).toMatchObject({ query: { after: 1 } });
  });

  it('stops a turn, and shows what the server said of it once', async () => {
    serve({
      messages: [messageOf(1, { kind: 'user', text: asked })],
      turn: runningTurn,
      threads: [threadOf({ turn: runningTurn })],
    });
    const user = conversation(id);
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stopped.')).toBeDefined();
    expect(screen.getAllByText('Stopped.')).toHaveLength(1);
    expect(sent('cancelAssistantTurn')).toEqual([{ params: { id: runningTurn.id } }]);
    expect(box()).toHaveProperty('disabled', false);
  });

  it('says a turn is stopping when the worker has not let go of it yet', async () => {
    const world = serve({
      messages: [messageOf(1, { kind: 'user', text: asked })],
      turn: runningTurn,
    });
    world.override = (operation) =>
      operation === 'cancelAssistantTurn' ? { ...runningTurn, cancelRequested: true } : undefined;
    const user = conversation(id);
    const stop = await screen.findByRole('button', { name: 'Stop' });
    world.turn = { ...runningTurn, cancelRequested: true };
    await user.click(stop);
    expect(await screen.findByText('Stopping…')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveProperty('ariaDisabled', 'true');
  });

  it('shows why a turn ended without an answer: the error it left, or the turn’s own sentence', async () => {
    const world = serve({
      messages: [
        messageOf(1, { kind: 'user', text: asked }),
        messageOf(2, {
          kind: 'error',
          code: 'paused',
          text: 'The business has reached its monthly AI spending limit, so I stopped.',
        }),
      ],
      turn: turnOf({
        outcome: 'paused',
        message: 'The business has reached its monthly AI spending limit, so I stopped.',
        costEstimate: null,
      }),
    });
    conversation(id);
    expect(await screen.findAllByText(/monthly AI spending limit/)).toHaveLength(1);
    expect(screen.queryByText(/That answer cost/)).toBeNull();

    world.messages = [messageOf(1, { kind: 'user', text: asked })];
    world.turn = turnOf({ outcome: 'failed', message: 'The AI provider could not be reached.' });
    await hint();
    expect(await screen.findByText('The AI provider could not be reached.')).toBeDefined();
  });

  it('says a conversation that is gone is gone, and starts a new one', async () => {
    const world = serve();
    world.override = (operation) =>
      operation === 'getAssistantThread' ? problem(404, 'Not found.') : undefined;
    const user = conversation(id);
    expect(await screen.findByText(/no longer here/)).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Start a new one' }));
    expect(onThread).toHaveBeenCalledWith(null);
  });

  it('says a conversation could not load, and tries again', async () => {
    const world = serve({ messages: builtMessages(), turn: turnOf() });
    world.override = (operation) =>
      operation === 'getAssistantThread' ? new TypeError('Failed to fetch') : undefined;
    const user = conversation(id);
    expect(await screen.findByText(/This conversation couldn’t load/)).toBeDefined();
    delete world.override;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/The draft is ready/)).toBeDefined();
  });
});

describe('the confirmation card', () => {
  const card = (): Promise<HTMLElement> =>
    screen.findByRole('group', { name: 'Publish the form “Wedding enquiry”' });
  const built = (proposal?: Proposal): Partial<World> => ({
    messages: builtMessages(proposal),
    turn: turnOf(),
    threads: [threadOf()],
  });

  it('says what would be published, publishes it, hands over the link and embed line, and undoes it', async () => {
    serve(built());
    const user = conversation(id);
    const pending = await card();
    expect(within(pending).getByText('5 questions · 1 consent box')).toBeDefined();
    expect(within(pending).getByText('Needs you')).toBeDefined();
    await user.click(within(pending).getByRole('button', { name: 'Publish' }));

    expect(await within(await card()).findByText('Published.')).toBeDefined();
    expect(sent('applyProposal')).toEqual([{ params: { id: publishProposalOf().id }, body: {} }]);
    const applied = await card();
    expect(document.activeElement).toBe(applied);
    expect(within(applied).getByRole('textbox', { name: 'Link' })).toHaveProperty(
      'value',
      hostedUrl,
    );
    expect(within(applied).getByRole('textbox', { name: 'Embed line' })).toHaveProperty(
      'value',
      embedSnippet,
    );
    // user-event stands in for the clipboard, and keeps what was written to it.
    await user.click(within(applied).getByRole('button', { name: 'Copy the link' }));
    expect(await within(applied).findAllByText('Copied.')).toHaveLength(1);
    expect(await navigator.clipboard.readText()).toBe(hostedUrl);
    await user.click(within(applied).getByRole('button', { name: 'Copy the embed line' }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(embedSnippet);
    });
    expect(within(applied).queryByRole('button', { name: 'Publish' })).toBeNull();

    await user.click(within(applied).getByRole('button', { name: 'Undo' }));
    expect(await within(await card()).findByText(/the form is a draft again/)).toBeDefined();
    expect(sent('undoProposal')).toEqual([{ params: { id: publishProposalOf().id } }]);
    expect(within(await card()).queryByRole('button')).toBeNull();
  });

  it('sets it aside with "Not now", and publishes nothing', async () => {
    serve(built());
    const user = conversation(id);
    await user.click(within(await card()).getByRole('button', { name: 'Not now' }));
    expect(await within(await card()).findByText(/Nothing was published/)).toBeDefined();
    expect(sent('applyProposal')).toEqual([]);
    expect(sent('dismissProposal')).toHaveLength(1);
  });

  it('cannot publish a form that changed since, says why, and can still set it aside', async () => {
    serve(built(publishProposalOf({ stale: true })));
    const user = conversation(id);
    const stale = await card();
    const publish = within(stale).getByRole('button', { name: 'Publish' });
    expect(publish).toHaveProperty('ariaDisabled', 'true');
    expect(within(stale).getByText(/This form changed after the assistant asked/)).toBeDefined();
    await user.click(publish);
    expect(sent('applyProposal')).toEqual([]);
    expect(within(stale).getByRole('button', { name: 'Not now' })).toBeDefined();
  });

  it('cannot be decided by someone whose role does not publish forms, and says why', async () => {
    serve(built(publishProposalOf({ canDecide: false })));
    conversation(id);
    const denied = await card();
    expect(within(denied).getByRole('button', { name: 'Publish' })).toHaveProperty(
      'ariaDisabled',
      'true',
    );
    expect(within(denied).getByText(/Your role doesn’t allow publishing forms/)).toBeDefined();
    expect(within(denied).queryByRole('button', { name: 'Not now' })).toBeNull();
  });

  it('says a form that is live already will be replaced', async () => {
    const change = { ...publishProposalOf().change, questions: 1, consents: 0, republish: true };
    serve(built(publishProposalOf({ change })));
    conversation(id);
    expect(within(await card()).getByText(/1 question · 0 consent boxes/)).toBeDefined();
    expect(within(await card()).getByText(/publishing replaces what websites show/)).toBeDefined();
  });

  it('shows the server’s sentence when it refuses, on the card it refused, and reads the card again', async () => {
    const world = serve(built());
    world.override = (operation) =>
      operation === 'applyProposal'
        ? problem(409, 'The form changed, so this can’t be published.')
        : undefined;
    const user = conversation(id);
    const publish = within(await card()).getByRole('button', { name: 'Publish' });
    world.messages = builtMessages(publishProposalOf({ stale: true }));
    await user.click(publish);
    expect((await within(await card()).findByRole('alert')).textContent).toBe(
      'The form changed, so this can’t be published.',
    );
    await waitFor(async () => {
      expect(within(await card()).getByRole('button', { name: 'Publish' })).toHaveProperty(
        'ariaDisabled',
        'true',
      );
    });
  });

  it('says a decision that never arrived can be tried again', async () => {
    const world = serve(built());
    world.override = (operation) =>
      operation === 'dismissProposal' ? new TypeError('Failed to fetch') : undefined;
    const user = conversation(id);
    await user.click(within(await card()).getByRole('button', { name: 'Not now' }));
    expect((await within(await card()).findByRole('alert')).textContent).toContain(
      'didn’t go through',
    );
  });

  it('says why a published form cannot be taken back, and what a card of another kind is', async () => {
    const live = publishedProposalOf({
      undo: { available: false, reason: 'published_before', message: 'It was live before.' },
      result: { formId: formId('1') },
    });
    serve(built(live));
    conversation(id);
    const applied = await card();
    expect(within(applied).getByText('It was live before.')).toBeDefined();
    expect(within(applied).queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(within(applied).queryByRole('textbox')).toBeNull();
  });

  it('draws a proposal of another kind with Confirm, and "Done." once applied', async () => {
    const other = {
      kind: 'conversation_status',
      from: 'open',
      to: 'closed',
      until: null,
    } as const;
    const world = serve(
      built(publishProposalOf({ summary: 'Close the conversation', change: other })),
    );
    conversation(id);
    const pending = await screen.findByRole('group', { name: 'Close the conversation' });
    expect(within(pending).getByRole('button', { name: 'Confirm' })).toBeDefined();
    expect(within(pending).queryByText(/questions/)).toBeNull();
    world.messages = builtMessages(
      publishedProposalOf({ summary: 'Close the conversation', change: other, result: {} }),
    );
    await hint();
    expect(await screen.findByText('Done.')).toBeDefined();
  });
});

describe('the floating panel', () => {
  const launcher = (): HTMLElement => screen.getByRole('button', { name: 'Assistant' });
  const open = async (): Promise<ReturnType<typeof userEvent.setup>> => {
    const user = draw(<AssistantLauncher businessId="biz_test" slug="harbor" />);
    await user.click(launcher());
    await screen.findByRole('region', { name: 'New conversation' });
    return user;
  };

  it('opens beside the page with the keyboard in the box, and Escape gives it back to the launcher', async () => {
    serve({ context: formsListContext });
    const user = await open();
    expect(launcher()).toHaveProperty('ariaExpanded', 'true');
    await waitFor(() => {
      expect(document.activeElement).toBe(box());
    });
    expect(sent('getAssistantContext')).toEqual([{ body: formsPage }]);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'New conversation' })).toBeNull();
    expect(document.activeElement).toBe(launcher());
    expect(launcher()).toHaveProperty('ariaExpanded', 'false');
  });

  it('closes with its own button and with the launcher', async () => {
    serve();
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Close the assistant' }));
    expect(screen.queryByRole('region', { name: 'New conversation' })).toBeNull();
    await user.click(launcher());
    expect(await screen.findByRole('region', { name: 'New conversation' })).toBeDefined();
    await user.click(launcher());
    expect(screen.queryByRole('region', { name: 'New conversation' })).toBeNull();
  });

  it('tells the assistant which record the page is about', async () => {
    router.place = {
      pathname: '/b/harbor/settings/forms',
      search: { form: formId('1') },
      href: `/b/harbor/settings/forms?form=${formId('1')}`,
      params: { slug: 'harbor' },
    };
    serve({ context: formContext() });
    await open();
    await screen.findByRole('region', { name: 'On “Wedding enquiry”' });
    expect(sent('getAssistantContext')).toEqual([
      {
        body: {
          route: `/forms/${formId('1')}`,
          record: { kind: 'form', id: formId('1') },
          selection: [],
        },
      },
    ]);
  });

  it('is named by its conversation once it has one, and keeps the keyboard through the first message', async () => {
    serve();
    const user = await open();
    await user.type(await screen.findByRole('textbox'), 'Hello{Enter}');
    expect(await screen.findByRole('region', { name: 'Hello' })).toBeDefined();
    expect(readAssistantView('biz_test').threadId).toBe(id);
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop' }));
    });
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(launcher());
  });

  it('opens again on the conversation the tab kept', async () => {
    serve({ messages: builtMessages(), turn: turnOf(), threads: [threadOf()] });
    setAssistantView('biz_test', { open: true, threadId: id });
    draw(<AssistantLauncher businessId="biz_test" slug="harbor" />);
    expect(await screen.findByRole('region', { name: threadOf().title })).toBeDefined();
    expect(await screen.findByText(/The draft is ready/)).toBeDefined();
  });

  it('lists past conversations, opens one, and starts a new one', async () => {
    serve({ messages: builtMessages(), turn: turnOf(), threads: [threadOf()] });
    const user = await open();
    const past = screen.getByRole('button', { name: 'Past conversations' });
    await user.click(past);
    expect(past).toHaveProperty('ariaPressed', 'true');
    const list = await screen.findByRole('list', { name: 'Past conversations' });
    await user.click(rowOf(list, threadOf().title));
    expect(await screen.findByText(/The draft is ready/)).toBeDefined();
    expect(readAssistantView('biz_test').threadId).toBe(id);

    await user.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(await screen.findByRole('region', { name: 'New conversation' })).toBeDefined();
    expect(screen.queryByText(/The draft is ready/)).toBeNull();
    expect(readAssistantView('biz_test').threadId).toBeNull();
  });

  it('deletes a past conversation after asking, and closes it where it was open', async () => {
    serve({ messages: builtMessages(), turn: turnOf(), threads: [threadOf()] });
    setAssistantView('biz_test', { threadId: id });
    const user = draw(<AssistantLauncher businessId="biz_test" slug="harbor" />);
    await user.click(launcher());
    await user.click(await screen.findByRole('button', { name: 'Past conversations' }));
    const title = threadOf().title;
    const remove = await screen.findByRole('button', {
      name: `Delete the conversation “${title}”`,
    });
    await user.click(remove);
    const asking = screen.getByRole('group', { name: `Delete the conversation “${title}”` });
    await user.click(within(asking).getByRole('button', { name: 'Keep' }));
    expect(sent('deleteAssistantThread')).toEqual([]);
    await user.click(remove);
    await user.click(
      within(screen.getByRole('group', { name: `Delete the conversation “${title}”` })).getByRole(
        'button',
        { name: 'Delete' },
      ),
    );
    expect(await screen.findByText(/No conversations yet/)).toBeDefined();
    expect(sent('deleteAssistantThread')).toEqual([{ params: { id } }]);
    expect(readAssistantView('biz_test').threadId).toBeNull();
  });

  it('says why a conversation cannot be deleted, in the server’s words or ours', async () => {
    const world = serve({ threads: [threadOf(), threadOf({ id: threadId('2'), title: 'Other' })] });
    const busy = 'The assistant is still working in this conversation. Stop it before deleting it.';
    world.override = (operation) =>
      operation === 'deleteAssistantThread' ? problem(409, busy) : undefined;
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Past conversations' }));
    await user.click(
      await screen.findByRole('button', { name: 'Delete the conversation “Other”' }),
    );
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect((await screen.findByRole('alert')).textContent).toBe(busy);
    world.override = (operation) =>
      operation === 'deleteAssistantThread' ? new TypeError('Failed to fetch') : undefined;
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('couldn’t be deleted');
    });
  });

  it('says past conversations could not load, tries again, and shows more when there are more', async () => {
    const world = serve({ threads: [threadOf()] });
    world.override = (operation) =>
      operation === 'listAssistantThreads' ? new TypeError('Failed to fetch') : undefined;
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Past conversations' }));
    expect(await screen.findByText(/Past conversations couldn’t load/)).toBeDefined();
    world.override = (operation, input) =>
      operation !== 'listAssistantThreads'
        ? undefined
        : (input as { query: { after?: string } }).query.after === undefined
          ? { items: [threadOf()], nextCursor: 'next' }
          : { items: [threadOf({ id: threadId('2'), title: 'An older one' })], nextCursor: null };
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await user.click(await screen.findByRole('button', { name: 'Show more conversations' }));
    expect(await screen.findByText('An older one')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Show more conversations' })).toBeNull();
  });

  it('opens full screen on the same conversation, remembering the page it came from', async () => {
    serve({ messages: builtMessages(), turn: turnOf(), threads: [threadOf()] });
    setAssistantView('biz_test', { threadId: id });
    const user = draw(<AssistantLauncher businessId="biz_test" slug="harbor" />);
    await user.click(launcher());
    await user.click(await screen.findByRole('button', { name: 'Open full screen' }));
    expect(router.navigate).toHaveBeenCalledWith({
      to: '/b/$slug/assistant/$threadId',
      params: { slug: 'harbor', threadId: id },
    });
    expect(readAssistantView('biz_test')).toEqual({
      open: false,
      threadId: id,
      from: '/b/harbor/settings/forms',
      fromPage: formsPage,
    });
  });

  it('opens full screen with no conversation yet', async () => {
    serve();
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Open full screen' }));
    expect(router.navigate).toHaveBeenCalledWith({
      to: '/b/$slug/assistant',
      params: { slug: 'harbor' },
    });
  });

  it('forgets the way back from full screen once the person is on a page again', async () => {
    serve();
    setAssistantView('biz_test', { from: '/b/harbor/deals', fromPage: formsPage });
    draw(<AssistantLauncher businessId="biz_test" slug="harbor" />);
    await waitFor(() => {
      expect(readAssistantView('biz_test')).toMatchObject({ from: null, fromPage: null });
    });
  });
});

describe('the full-screen view', () => {
  it('shows the conversation with past ones beside it, and sends from the page it was opened from', async () => {
    serve({ messages: builtMessages(), turn: turnOf(), threads: [threadOf()] });
    setAssistantView('biz_test', { from: '/b/harbor/settings/forms', fromPage: formsPage });
    const user = draw(<AssistantPage threadId={id} />);
    expect(await screen.findByRole('heading', { level: 1, name: threadOf().title })).toBeDefined();
    expect(await screen.findByText(/The draft is ready/)).toBeDefined();
    const list = await screen.findByRole('list', { name: 'Past conversations' });
    expect(rowOf(list, threadOf().title)).toHaveProperty('ariaCurrent', 'true');
    await user.type(box(), 'And a phone question{Enter}');
    await waitFor(() => {
      expect(sent('postAssistantTurn')).toEqual([
        { params: { id }, body: { message: 'And a phone question', page: formsPage } },
      ]);
    });
  });

  it('goes back to the page it came from, with the panel open on the same conversation', async () => {
    serve({ messages: builtMessages(), turn: turnOf(), threads: [threadOf()] });
    setAssistantView('biz_test', { from: '/b/harbor/settings/forms', fromPage: formsPage });
    const user = draw(<AssistantPage threadId={id} />);
    await user.click(await screen.findByRole('button', { name: 'Back to the page' }));
    expect(router.navigate).toHaveBeenCalledWith({ href: '/b/harbor/settings/forms' });
    expect(readAssistantView('biz_test')).toEqual({
      open: true,
      threadId: id,
      from: null,
      fromPage: null,
    });
  });

  it('goes to the Dashboard when it was opened by its own address, or from another business', async () => {
    serve();
    const user = draw(<AssistantPage threadId={null} />);
    await user.click(await screen.findByRole('button', { name: 'Back to the page' }));
    expect(router.navigate).toHaveBeenLastCalledWith({ href: '/b/harbor' });
    setAssistantView('biz_test', { from: '/b/other/deals' });
    await user.click(screen.getByRole('button', { name: 'Back to the page' }));
    expect(router.navigate).toHaveBeenLastCalledWith({ href: '/b/harbor' });
    setAssistantView('biz_test', { from: '/b/harbor' });
    await user.click(screen.getByRole('button', { name: 'Back to the page' }));
    expect(router.navigate).toHaveBeenLastCalledWith({ href: '/b/harbor' });
  });

  it('is about no page when opened by its own address, and gives a new conversation its address', async () => {
    serve();
    const user = draw(<AssistantPage threadId={null} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'New conversation' }),
    ).toBeDefined();
    await user.type(await screen.findByRole('textbox'), 'Hello{Enter}');
    await waitFor(() => {
      expect(router.navigate).toHaveBeenCalledWith({
        to: '/b/$slug/assistant/$threadId',
        params: { slug: 'harbor', threadId: id },
        replace: true,
      });
    });
    expect(sent('createAssistantThread')).toEqual([
      { body: { message: 'Hello', page: { route: '/assistant', selection: [] } } },
    ]);
  });

  it('opens another conversation, a new one, and the list as a drawer on a narrow window', async () => {
    serve({
      messages: builtMessages(),
      turn: turnOf(),
      threads: [threadOf(), threadOf({ id: threadId('2'), title: 'Other' })],
    });
    const user = draw(<AssistantPage threadId={id} />);
    const list = await screen.findByRole('list', { name: 'Past conversations' });
    await user.click(rowOf(list, 'Other'));
    expect(router.navigate).toHaveBeenLastCalledWith({
      to: '/b/$slug/assistant/$threadId',
      params: { slug: 'harbor', threadId: threadId('2') },
    });
    await user.click(
      within(screen.getByRole('region', { name: 'Your conversations' })).getByRole('button', {
        name: 'New conversation',
      }),
    );
    expect(router.navigate).toHaveBeenLastCalledWith({
      to: '/b/$slug/assistant',
      params: { slug: 'harbor' },
    });

    await user.click(screen.getByRole('button', { name: 'Past conversations' }));
    const drawer = await screen.findByRole('dialog', { name: 'Past conversations' });
    await within(drawer).findByRole('list', { name: 'Past conversations' });
    await user.click(rowOf(drawer, 'Other'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('starts a new conversation when the open one is deleted', async () => {
    serve({ messages: builtMessages(), turn: turnOf(), threads: [threadOf()] });
    const user = draw(<AssistantPage threadId={id} />);
    await user.click(
      await screen.findByRole('button', { name: `Delete the conversation “${threadOf().title}”` }),
    );
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(router.navigate).toHaveBeenLastCalledWith({
        to: '/b/$slug/assistant',
        params: { slug: 'harbor' },
      });
    });
  });

  it('starts a new conversation when the open one is gone', async () => {
    const world = serve();
    world.override = (operation) =>
      operation === 'getAssistantThread' ? problem(404, 'Not found.') : undefined;
    const user = draw(<AssistantPage threadId={id} />);
    await user.click(await screen.findByRole('button', { name: 'Start a new one' }));
    expect(router.navigate).toHaveBeenLastCalledWith({
      to: '/b/$slug/assistant',
      params: { slug: 'harbor' },
    });
  });
});
