// The in-app assistant: the launcher on every page of a business, its floating panel, and
// the same conversation full screen. Against a stand-in for the API that keeps the person's
// conversations in memory, answers as the server does (a turn is queued, a worker finishes
// it, a card is applied once), and checks every write against the contract. The Inbox's own
// assistant (reply drafts) is in assistant.spec.ts; the whole product, with a real server
// and a stand-in model, is in e2e/tests at the repository's root.
import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import {
  applyProposalInput,
  assistantConversation,
  assistantMessages,
  assistantPageContext,
  assistantThreadList,
  assistantTurnInput,
  assistantTurnStarted,
  DEFAULT_FORM_DEFINITION,
  proposal as proposalSchema,
  type AssistantContext,
  type AssistantMessage,
  type AssistantPageContext,
  type AssistantThread,
  type AssistantTurn,
  type Form,
  type Proposal,
} from '@repo/contracts';
import {
  asked,
  at,
  builtMessages,
  contextOf,
  embedSnippet,
  formContext,
  formId,
  formsListContext,
  hostedUrl,
  messageId,
  messageOf,
  noPermission,
  notConnected,
  publishedProposalOf,
  publishProposalOf,
  runningTurn,
  threadId,
  threadOf,
  turnOf,
} from './assistant-panel-fixtures';
import { harbor, inHarbor, signedIn } from './session';

// Where the screenshots the owner looks at are kept (apps/dashboard/reports is not tracked).
const shots = 'reports/assistant';
mkdirSync(shots, { recursive: true });
const shot = (page: Page, name: string, width: number): Promise<Buffer> =>
  page.screenshot({ path: `${shots}/${name}-${String(width)}.png` });

interface World {
  /** What a page answers: its checks and chips, and whether the assistant can be asked. */
  context: (page: AssistantPageContext) => AssistantContext;
  threads: AssistantThread[];
  messages: AssistantMessage[];
  turn: AssistantTurn | null;
  /** What the worker writes once it has taken the turn; null leaves the turn running. */
  work: ((messages: AssistantMessage[]) => AssistantMessage[]) | null;
  /** Every page a context was asked for, and every message sent, with its page. */
  asked: AssistantPageContext[];
  sent: { message: string; page: AssistantPageContext }[];
  decisions: string[];
  cancelled: string[];
  deleted: string[];
}

const world = (patch: Partial<World> = {}): World => ({
  context: (page) =>
    page.record?.kind === 'form' ? formContext(page.record.id) : formsListContext,
  threads: [],
  messages: [],
  turn: null,
  // The story every test tells: the assistant builds the draft and asks to publish it.
  // Asked again in the same conversation, it only answers.
  work: (messages) =>
    messages.some((message) => message.kind === 'proposal')
      ? [messageOf(1, { text: 'Done.' })]
      : builtMessages(),
  asked: [],
  sent: [],
  decisions: [],
  cancelled: [],
  deleted: [],
  ...patch,
});

/** A conversation the person had before, already answered. */
const answered = (patch: Partial<World> = {}): World =>
  world({ threads: [threadOf()], messages: builtMessages(), turn: turnOf(), ...patch });

const problem = (route: Route, status: number, detail: string): Promise<void> =>
  route.fulfill({
    status,
    contentType: 'application/problem+json',
    body: JSON.stringify({ type: 'about:blank', title: 'Refused', status, detail }),
  });

const theForm: Form = {
  id: formId('1'),
  name: 'Wedding enquiry',
  status: 'draft',
  publicKey: 'A'.repeat(32),
  allowedOrigins: [],
  definition: DEFAULT_FORM_DEFINITION,
  publishedDefinition: null,
  publishedAt: null,
  hasUnpublishedChanges: false,
  problems: [],
  embedSnippet,
  hostedUrl,
  submissionCount: 0,
  revision: 'a'.repeat(64),
  canManage: true,
  createdAt: at,
  updatedAt: at,
};

/** The Forms page's own reads: one draft form, which the assistant's links open. */
async function formsApi(page: Page): Promise<void> {
  await page.route('**/api/v1/fields', (route) =>
    route.fulfill({ json: { items: [], objects: [], canManage: true } }),
  );
  await page.route(/\/api\/v1\/forms(?:[/?].*)?$/, (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1/forms', '');
    if (path === '')
      return route.fulfill({
        json: {
          items: [
            {
              id: theForm.id,
              name: theForm.name,
              status: theForm.status,
              hasUnpublishedChanges: false,
              submissionCount: 0,
              lastSubmissionAt: null,
              updatedAt: at,
            },
          ],
          nextCursor: null,
          canManage: true,
        },
      });
    if (path === `/${theForm.id}`) return route.fulfill({ json: theForm });
    return route.fulfill({ json: { items: [], nextCursor: null, canManage: true } });
  });
}

/** Stands in for the assistant's API. Every write is parsed with the contract's own schema. */
async function assistantApi(page: Page, state: World): Promise<void> {
  const last = (): number => state.messages.at(-1)?.seq ?? 0;
  const worked = (): void => {
    if (state.turn?.status === 'finished' || state.work === null) return;
    const [said] = state.messages.slice(-1);
    const written = state.work(state.messages).filter((message) => message.kind !== 'user');
    state.messages = [
      ...state.messages,
      ...written.map((message, index) => {
        const seq = (said?.seq ?? 0) + index + 1;
        return { ...message, seq, id: messageId(seq.toString(16)) };
      }),
    ];
    state.turn = turnOf();
  };
  const start = async (route: Route): Promise<void> => {
    const input = assistantTurnInput.parse(route.request().postDataJSON());
    state.sent.push(input);
    const said = messageOf(last() + 1, { kind: 'user', text: input.message });
    state.messages = [...state.messages, said];
    state.turn = runningTurn;
    // A thread keeps the title its first message gave it.
    const title = state.threads[0]?.title ?? input.message.slice(0, 80);
    const thread = threadOf({ title, turn: runningTurn });
    state.threads = [thread, ...state.threads.filter((each) => each.id !== thread.id)];
    await route.fulfill({
      status: 201,
      json: assistantTurnStarted.parse({ thread, turn: runningTurn, message: said }),
    });
  };
  const decide = (proposal: Proposal): Proposal => {
    state.messages = state.messages.map((message) =>
      message.proposal?.id === proposal.id ? { ...message, proposal } : message,
    );
    return proposalSchema.parse(proposal);
  };
  await page.route(/\/api\/v1\/assistant\/.*/, async (route) => {
    const request = route.request();
    expect(request.headers()['business-id']).toBe(harbor.id);
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1/assistant', '');
    const method = request.method();
    if (path === '/context' && method === 'POST') {
      const asking = assistantPageContext.parse(request.postDataJSON());
      state.asked.push(asking);
      return route.fulfill({ json: state.context(asking) });
    }
    if (path === '/threads' && method === 'GET')
      return route.fulfill({
        json: assistantThreadList.parse({ items: state.threads, nextCursor: null }),
      });
    if (path === '/threads' && method === 'POST') return start(route);
    const thread = /^\/threads\/(athr_[0-9a-z]+)(\/messages|\/turns)?$/.exec(path);
    if (thread !== null) {
      const found = state.threads.find((each) => each.id === thread[1]);
      if (found === undefined) return problem(route, 404, 'No such conversation.');
      if (thread[2] === '/turns' && method === 'POST') return start(route);
      if (thread[2] === '/messages') {
        // By the time the panel asks what is new, the worker has done its work.
        worked();
        const after = Number(url.searchParams.get('after') ?? '0');
        return route.fulfill({
          json: assistantMessages.parse({
            items: state.messages.filter((message) => message.seq > after),
            cursor: Math.max(after, last()),
            more: false,
            turn: state.turn,
          }),
        });
      }
      if (method === 'DELETE') {
        state.deleted.push(found.id);
        state.threads = state.threads.filter((each) => each !== found);
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({
        json: assistantConversation.parse({
          thread: found,
          messages: { items: state.messages, cursor: last(), more: false, turn: state.turn },
        }),
      });
    }
    const cancel = /^\/turns\/(aturn_[0-9a-z]+)\/cancel$/.exec(path);
    if (cancel !== null && method === 'POST') {
      state.cancelled.push(cancel[1] ?? '');
      state.turn = turnOf({ outcome: 'cancelled', costEstimate: null, message: 'Stopped.' });
      state.messages = [
        ...state.messages,
        messageOf(last() + 1, {
          kind: 'error',
          code: 'cancelled',
          text: 'Stopped. What was already done stays done.',
        }),
      ];
      return route.fulfill({ json: state.turn });
    }
    return problem(route, 404, 'No such route.');
  });
  await page.route(/\/api\/v1\/proposals\/[^/]+\/(apply|dismiss|undo)$/, async (route) => {
    const action = /(apply|dismiss|undo)$/.exec(new URL(route.request().url()).pathname)?.[1];
    state.decisions.push(action ?? '');
    if (action === 'apply') {
      expect(applyProposalInput.parse(route.request().postDataJSON())).toEqual({});
      return route.fulfill({ json: decide(publishedProposalOf()) });
    }
    if (action === 'dismiss')
      return route.fulfill({ json: decide(publishProposalOf({ status: 'dismissed' })) });
    return route.fulfill({ json: decide(publishProposalOf({ status: 'undone', undoneAt: at })) });
  });
}

async function setUp(page: Page, state: World): Promise<void> {
  await signedIn(page);
  await formsApi(page);
  await assistantApi(page, state);
}

const launcher = (page: Page): Locator =>
  page.getByRole('complementary', { name: 'Assistant' }).getByRole('button', {
    name: 'Assistant',
    exact: true,
  });
/** The floating panel, by the conversation it is named after. */
const panel = (page: Page, name: string | RegExp = 'New conversation'): Locator =>
  page.getByRole('complementary', { name: 'Assistant' }).getByRole('region', { name });
const box = (within: Page | Locator): Locator =>
  within.getByRole('textbox', { name: 'Message the assistant' });
const card = (within: Page | Locator): Locator =>
  within.getByRole('group', { name: 'Publish the form “Wedding enquiry”' });
/** A past conversation's row: the button that shows its title (the one beside it deletes it). */
const row = (within: Page | Locator, title: string): Locator =>
  within.getByRole('button').filter({ hasText: title });
const btn = (within: Page | Locator, name: string): Locator =>
  within.getByRole('button', { name, exact: true });

const axe = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze()
  ).violations;
const fits = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test('with no provider connected there is no box to type in, and a link to AI models', async ({
  page,
}) => {
  const state = world({
    context: () => ({ ...formContext(), ...notConnected, checks: formContext().checks }),
  });
  await setUp(page, state);
  await page.goto(inHarbor('/settings/forms'));
  await launcher(page).click();
  const open = panel(page);
  await expect(open.getByText(notConnected.message ?? '')).toBeVisible();
  // The checks still answer: they are the server's own, with no model.
  await expect(open.getByText('The second question has no label.')).toBeVisible();
  await expect(box(open)).toHaveCount(0);
  await expect(open.getByRole('group', { name: 'Things to ask' })).toHaveCount(0);
  await open.getByRole('link', { name: 'Open Settings → AI models' }).click();
  await expect(page).toHaveURL(new RegExp(`${inHarbor('/settings/ai-models')}$`));
});

test('someone whose role does not include the assistant is told so, and cannot ask', async ({
  page,
}) => {
  await setUp(page, world({ context: () => noPermission }));
  await page.goto(inHarbor());
  await launcher(page).click();
  await expect(panel(page).getByText(noPermission.message ?? '')).toBeVisible();
  await expect(box(page)).toHaveCount(0);
  await expect(panel(page).getByRole('link')).toHaveCount(0);
});

test('describing a form builds a draft, and nothing is published until Publish is pressed', async ({
  page,
}) => {
  const state = world();
  await setUp(page, state);
  await page.goto(inHarbor('/settings/forms'));
  await launcher(page).click();
  await expect(box(page)).toBeFocused();
  // The page told the assistant where the person is, as ids.
  expect(state.asked).toEqual([{ route: '/forms', selection: [] }]);
  await expect(btn(panel(page), 'Build a form for me')).toBeVisible();

  await box(page).fill(asked);
  await box(page).press('Enter');
  const open = panel(page, asked.slice(0, 80));
  await expect(open.getByText(/The draft is ready/)).toBeVisible();
  expect(state.sent).toEqual([{ message: asked, page: { route: '/forms', selection: [] } }]);

  // What it did, as quiet rows that lead to what it made.
  const steps = open.getByRole('list', { name: 'What the assistant did' });
  await expect(steps.getByRole('listitem')).toHaveCount(2);
  await steps.getByRole('link', { name: 'Created the draft form “Wedding enquiry”' }).click();
  await expect(page).toHaveURL(new RegExp(`form=${formId('1')}$`));
  await expect(
    page.getByRole('heading', { level: 2, name: 'Wedding enquiry', exact: true }),
  ).toBeVisible();
  // The panel stayed open on the conversation, and now knows the form the page shows.
  await expect(open.getByRole('region', { name: 'On “Wedding enquiry”' })).toBeVisible();
  expect(state.asked.at(-1)).toEqual({
    route: `/forms/${formId('1')}`,
    record: { kind: 'form', id: formId('1') },
    selection: [],
  });
  // On the form's own page, a link to that page is not drawn.
  await expect(steps.getByRole('link')).toHaveCount(0);

  const pending = card(open);
  await expect(pending.getByText('5 questions · 1 consent box')).toBeVisible();
  expect(state.decisions).toEqual([]);
  await btn(pending, 'Publish').click();
  await expect(pending.getByText('Published.')).toBeVisible();
  await expect(pending).toBeFocused();
  await expect(pending.getByRole('textbox', { name: 'Link' })).toHaveValue(hostedUrl);
  await expect(pending.getByRole('textbox', { name: 'Embed line' })).toHaveValue(embedSnippet);
  await expect(btn(pending, 'Copy the link')).toBeVisible();
  await expect(btn(pending, 'Copy the embed line')).toBeVisible();

  await btn(pending, 'Undo').click();
  await expect(pending.getByText('Undone: the form is a draft again.')).toBeVisible();
  expect(state.decisions).toEqual(['apply', 'undo']);
});

test('copies the link and the embed line', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const state = answered({ messages: builtMessages(publishedProposalOf()) });
  await setUp(page, state);
  await page.goto(inHarbor());
  await page.evaluate(
    ([key, id]) => {
      sessionStorage.setItem(key, JSON.stringify({ open: true, threadId: id }));
    },
    [`assistant:${harbor.id}`, threadId('1')] as const,
  );
  await page.reload();
  const applied = card(page);
  await btn(applied, 'Copy the link').click();
  await expect(applied.getByText('Copied.')).toHaveCount(1);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(hostedUrl);
  await btn(applied, 'Copy the embed line').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(embedSnippet);
});

test('someone who may not publish forms sees the card, and cannot press Publish', async ({
  page,
}) => {
  const state = answered({
    messages: builtMessages(publishProposalOf({ canDecide: false })),
  });
  await setUp(page, state);
  await page.goto(inHarbor());
  await launcher(page).click();
  await btn(page, 'Past conversations').click();
  await row(page, threadOf().title).click();
  const denied = card(page);
  await expect(btn(denied, 'Publish')).toBeDisabled();
  await expect(denied.getByText(/Your role doesn’t allow publishing forms/)).toBeVisible();
  await expect(btn(denied, 'Not now')).toHaveCount(0);
  await btn(denied, 'Publish').click({ force: true });
  expect(state.decisions).toEqual([]);
});

test('"Not now" sets the card aside and publishes nothing', async ({ page }) => {
  const state = answered();
  await setUp(page, state);
  await page.goto(inHarbor(`/assistant/${threadId('1')}`));
  await btn(card(page), 'Not now').click();
  await expect(card(page).getByText('Set aside. Nothing was published.')).toBeVisible();
  expect(state.decisions).toEqual(['dismiss']);
});

test('waits on Stop while the assistant works, and stops it', async ({ page }) => {
  const state = world({ work: null });
  await setUp(page, state);
  await page.goto(inHarbor());
  await launcher(page).click();
  await box(page).fill('Build a form');
  await box(page).press('Enter');
  await expect(page.getByText('Working…')).toBeVisible();
  await expect(box(page)).toBeDisabled();
  await expect(btn(page, 'Stop')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Stopped. What was already done stays done.')).toHaveCount(1);
  expect(state.cancelled).toEqual([runningTurn.id]);
  await expect(box(page)).toBeEnabled();
});

test('the server’s refusal of a message is shown as it wrote it', async ({ page }) => {
  await setUp(page, world());
  const refusal = 'You have sent the assistant 30 messages this hour. Try again later.';
  await page.route('**/api/v1/assistant/threads', (route) =>
    route.request().method() === 'POST' ? problem(route, 409, refusal) : route.fallback(),
  );
  await page.goto(inHarbor());
  await launcher(page).click();
  await box(page).fill('Hello');
  await box(page).press('Enter');
  await expect(panel(page).getByRole('alert')).toHaveText(refusal);
  await expect(box(page)).toHaveValue('Hello');
});

test('Escape closes the panel and the keyboard returns to the launcher', async ({ page }) => {
  await setUp(page, world());
  await page.goto(inHarbor());
  await expect(launcher(page)).toHaveAttribute('aria-expanded', 'false');
  await launcher(page).focus();
  await page.keyboard.press('Enter');
  await expect(box(page)).toBeFocused();
  await expect(launcher(page)).toHaveAttribute('aria-expanded', 'true');
  // It is not a dialog: the page behind it can still be used.
  await page.getByRole('banner').getByRole('link', { name: 'Reporting', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${inHarbor('/reports')}$`));
  await expect(panel(page)).toBeVisible();

  await box(page).focus();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(launcher(page)).toBeFocused();

  // Shift+Enter is a new line, Enter sends.
  await page.keyboard.press('Enter');
  await box(page).pressSequentially('One');
  await page.keyboard.press('Shift+Enter');
  await box(page).pressSequentially('Two');
  await expect(box(page)).toHaveValue('One\nTwo');
});

test('expanding and minimising keep the conversation', async ({ page }) => {
  const state = world();
  await setUp(page, state);
  await page.goto(inHarbor('/settings/forms'));
  await launcher(page).click();
  await box(page).fill(asked);
  await box(page).press('Enter');
  const title = asked.slice(0, 80);
  await expect(panel(page, title).getByText(/The draft is ready/)).toBeVisible();

  await btn(page, 'Open full screen').click();
  await expect(page).toHaveURL(new RegExp(`${inHarbor(`/assistant/${threadId('1')}`)}$`));
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(page.getByText(/The draft is ready/)).toBeVisible();
  await expect(card(page)).toBeVisible();
  // The conversation is on the page itself: there is no launcher over it.
  await expect(page.getByRole('complementary', { name: 'Assistant' })).toHaveCount(0);
  // A message typed here is still about the page it was opened from.
  await box(page).fill('Add a phone question');
  await box(page).press('Enter');
  await expect
    .poll(() => state.sent.at(-1))
    .toEqual({
      message: 'Add a phone question',
      page: { route: '/forms', selection: [] },
    });

  await btn(page, 'Back to the page').click();
  await expect(page).toHaveURL(new RegExp(`${inHarbor('/settings/forms')}$`));
  await expect(panel(page, title).getByText('Add a phone question')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Forms' })).toBeVisible();
});

test('a past conversation reopens, in the panel and full screen, and can be deleted', async ({
  page,
}) => {
  const state = answered();
  await setUp(page, state);
  await page.goto(inHarbor());
  await launcher(page).click();
  await btn(page, 'Past conversations').click();
  const list = page.getByRole('list', { name: 'Past conversations' });
  await row(list, threadOf().title).click();
  await expect(panel(page, threadOf().title).getByText(/The draft is ready/)).toBeVisible();

  // The panel opens on it again after a reload: the tab remembers.
  await page.reload();
  await expect(panel(page, threadOf().title).getByText(/The draft is ready/)).toBeVisible();

  await btn(page, 'Open full screen').click();
  const past = page.getByRole('region', { name: 'Your conversations' });
  await expect(row(past, threadOf().title)).toHaveAttribute('aria-current', 'true');
  await btn(past, 'New conversation').click();
  await expect(page).toHaveURL(new RegExp(`${inHarbor('/assistant')}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'New conversation' })).toBeVisible();
  await row(past, threadOf().title).click();
  await expect(page.getByText(/The draft is ready/)).toBeVisible();

  await past.getByRole('button', { name: /^Delete the conversation/ }).click();
  await btn(past, 'Delete').click();
  await expect(past.getByText(/No conversations yet/)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${inHarbor('/assistant')}$`));
  expect(state.deleted).toEqual([threadId('1')]);
});

test('the command bar opens the panel, and the full-screen view', async ({ page }) => {
  await setUp(page, answered());
  await page.goto(inHarbor());
  // The shortcut is the shell's: wait for the shell.
  await expect(launcher(page)).toBeVisible();
  await page.keyboard.press('Control+K');
  await page.getByRole('combobox', { name: 'Search or go to' }).fill('assistant');
  await page.getByRole('option', { name: 'Ask the assistant' }).click();
  await expect(box(panel(page))).toBeFocused();

  await page.keyboard.press('Control+K');
  await page.getByRole('combobox', { name: 'Search or go to' }).fill('assistant conv');
  await page.getByRole('option', { name: 'Assistant conversations' }).click();
  await expect(page).toHaveURL(new RegExp(`${inHarbor('/assistant')}$`));
  await expect(page.getByRole('list', { name: 'Past conversations' })).toBeVisible();
});

test('the old Ask AI and Launchpad addresses open the assistant', async ({ page }) => {
  await setUp(page, world());
  await page.goto(inHarbor('/ask-ai'));
  await expect(page).toHaveURL(new RegExp(`${inHarbor('/assistant')}$`));
  await expect(box(page)).toBeVisible();
  await page.goto(inHarbor('/launchpad'));
  await expect(page).toHaveURL(new RegExp(`${inHarbor('/assistant')}$`));
});

test('there is no launcher on the sign-in page', async ({ page }) => {
  await signedIn(page, null);
  await page.goto('/sign-in');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Assistant' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Assistant', exact: true })).toHaveCount(0);
});

for (const width of [360, 1440]) {
  test.describe(`at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: width === 360 ? 740 : 900 } });

    test('the panel with checks and chips, then a conversation with its card', async ({ page }) => {
      const state = world();
      await setUp(page, state);
      await page.goto(inHarbor(`/settings/forms?form=${formId('1')}`));
      await expect(page.getByRole('heading', { level: 2, name: 'Wedding enquiry' })).toBeVisible();
      // The launcher is in the corner, 48px round, and clear of the page's last line.
      const button = await launcher(page).boundingBox();
      expect(button).toMatchObject({ width: 48, height: 48 });
      expect(Math.round(width - ((button?.x ?? 0) + 48))).toBe(16);
      await launcher(page).click();
      const open = panel(page);
      await expect(open.getByRole('region', { name: 'On “Wedding enquiry”' })).toBeVisible();
      await expect(btn(open, 'Publish this form')).toBeVisible();
      const frame = await open.boundingBox();
      const tall = page.viewportSize()?.height ?? 0;
      if (width === 360) {
        // A sheet from the bottom edge, as wide as the phone.
        expect(frame).toMatchObject({ x: 0, width: 360 });
        expect(Math.round((frame?.y ?? 0) + (frame?.height ?? 0))).toBe(tall);
      } else {
        // Docked at the right, above the launcher.
        expect(frame?.width).toBe(400);
        expect(Math.round(width - ((frame?.x ?? 0) + 400))).toBe(16);
        expect(Math.round((frame?.y ?? 0) + (frame?.height ?? 0))).toBeLessThanOrEqual(
          Math.round(button?.y ?? 0),
        );
      }
      expect(await fits(page)).toBe(true);
      expect(await axe(page)).toEqual([]);
      await shot(page, 'panel-checks-chips', width);

      await btn(open, 'Publish this form').click();
      const pending = card(page);
      await expect(pending).toBeVisible();
      await expect(page.getByText(/The draft is ready/)).toBeVisible();
      expect(await fits(page)).toBe(true);
      expect(await axe(page)).toEqual([]);
      await shot(page, 'conversation-activity-card', width);

      await btn(pending, 'Publish').click();
      await expect(pending.getByText('Published.')).toBeVisible();
      expect(await fits(page)).toBe(true);
      expect(await axe(page)).toEqual([]);
      await shot(page, 'card-applied', width);
    });

    test('the full-screen view', async ({ page }) => {
      await setUp(page, answered());
      await page.goto(inHarbor(`/assistant/${threadId('1')}`));
      await expect(page.getByText(/The draft is ready/)).toBeVisible();
      await expect(card(page)).toBeVisible();
      await expect(box(page)).toBeVisible();
      if (width === 360) {
        // The list is a drawer behind a button.
        await expect(page.getByRole('region', { name: 'Your conversations' })).toBeHidden();
        await btn(page, 'Past conversations').click();
        const drawer = page.getByRole('dialog', { name: 'Past conversations' });
        await expect(row(drawer, threadOf().title)).toBeVisible();
        expect(await axe(page)).toEqual([]);
        await btn(drawer, 'Close the list').click();
        await expect(drawer).toHaveCount(0);
      } else {
        await expect(page.getByRole('region', { name: 'Your conversations' })).toBeVisible();
      }
      // The whole view fits the window: the box to type in is in view without scrolling.
      const composer = await box(page).boundingBox();
      expect((composer?.y ?? 0) + (composer?.height ?? 0)).toBeLessThanOrEqual(
        page.viewportSize()?.height ?? 0,
      );
      expect(await fits(page)).toBe(true);
      expect(await axe(page)).toEqual([]);
      await shot(page, 'expanded-view', width);
    });

    test('with no provider connected', async ({ page }) => {
      await setUp(
        page,
        world({
          context: () => ({ ...formContext(), ...notConnected, checks: formContext().checks }),
        }),
      );
      await page.goto(inHarbor());
      await launcher(page).click();
      await expect(panel(page).getByText(notConnected.message ?? '')).toBeVisible();
      await expect(box(page)).toHaveCount(0);
      expect(await fits(page)).toBe(true);
      expect(await axe(page)).toEqual([]);
      await shot(page, 'not-connected', width);
    });
  });
}

test('the launcher is not on the agency’s pages', async ({ page }) => {
  await signedIn(page, undefined, {}, { agencyStaff: true, businesses: [harbor] });
  await page.route('**/api/v1/businesses**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.goto('/agency');
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Assistant' })).toHaveCount(0);
});

test('a context that names the form is what a chip is sent with', async ({ page }) => {
  const state = world({ context: () => contextOf({ chips: formContext().chips }) });
  await setUp(page, state);
  await page.goto(inHarbor(`/settings/forms?form=${formId('1')}`));
  await launcher(page).click();
  await btn(page, 'What is missing on this form?').click();
  await expect
    .poll(() => state.sent)
    .toEqual([
      {
        message: formContext().chips[0]?.prompt,
        page: {
          route: `/forms/${formId('1')}`,
          record: { kind: 'form', id: formId('1') },
          selection: [],
        },
      },
    ]);
});
