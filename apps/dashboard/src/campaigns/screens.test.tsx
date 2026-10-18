// @vitest-environment jsdom
// Marketing → Emails → Campaigns: the list, a draft's editor, the test and send dialogs, a
// sent campaign's page and the ceiling in Settings, each in the states a person meets. The
// API is a small world shaped by the contract's own types and schemas
// (e2e/campaigns-fixtures.ts).
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { EmailCampaign } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Suspense, useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  audienceOf,
  calari,
  campaignMailboxAnswer,
  campaignOf,
  cancelCampaign,
  checksOf,
  createCampaign,
  deleteCampaign,
  editedElsewhere,
  folderOf,
  foldersOf,
  getOf,
  isRefusal,
  listOf,
  moveCampaign,
  pauseCampaign,
  recipientsOf,
  recipientsUnderWay,
  resumeCampaign,
  scheduleCampaign,
  sendCampaign,
  sendTest,
  smartLists,
  statsOf,
  support,
  updateCampaign,
  updateSettings,
  worldOf,
  type CampaignsWorld,
} from '../../e2e/campaigns-fixtures';
import { tagId, tags } from '../../e2e/lead-sources-fixtures';
import { apiIn } from '../api';
import type { CampaignsSearch } from '../campaigns-search';
import CampaignEditor from './editor';
import CampaignsPage from './list-page';
import CampaignResults from './results';
import SendDialog from './send-dialog';
import CampaignLimit from './settings-limit';
import TestDialog from './test-dialog';

interface Input {
  readonly body?: unknown;
  readonly params?: { readonly id?: string };
  readonly query?: Readonly<Record<string, string | number | undefined>>;
}
interface Call {
  readonly operation: string;
  readonly input: Input;
}
const server = vi.hoisted((): { world: CampaignsWorld | undefined; calls: Call[] } => ({
  world: undefined,
  calls: [],
}));
const NOTHING = Symbol('nothing');

function answerOf(world: CampaignsWorld, operation: string, input: Input): unknown {
  const id = input.params?.id ?? '';
  const query = new URLSearchParams(
    Object.entries(input.query ?? {}).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, String(value)]],
    ),
  );
  const forbidden = { status: 403, detail: 'You may not manage mailboxes.' };
  switch (operation) {
    case 'listEmailCampaigns':
      return listOf(world, query);
    case 'getEmailCampaign':
      return getOf(world, id);
    case 'createEmailCampaign':
      return createCampaign(world, input.body);
    case 'updateEmailCampaign':
      return updateCampaign(world, id, input.body);
    case 'deleteEmailCampaign':
      return deleteCampaign(world, id, input.body as { revision?: number }) ?? NOTHING;
    case 'moveEmailCampaign':
      return moveCampaign(world, id, input.body);
    case 'getEmailCampaignAudience':
      return audienceOf(world, id);
    case 'getEmailCampaignChecks':
      return checksOf(world, id);
    case 'sendEmailCampaignTest':
      return sendTest(world, id, input.body);
    case 'sendEmailCampaign':
      return sendCampaign(world, id, input.body);
    case 'scheduleEmailCampaign':
      return scheduleCampaign(world, id, input.body);
    case 'pauseEmailCampaign':
      return pauseCampaign(world, id);
    case 'resumeEmailCampaign':
      return resumeCampaign(world, id);
    case 'cancelEmailCampaign':
      return cancelCampaign(world, id);
    case 'listEmailCampaignRecipients':
      return recipientsOf(world, id, query);
    case 'getEmailCampaignStats':
      return statsOf(world, id);
    case 'listEmailCampaignFolders':
      return foldersOf(world);
    case 'getEmailCampaignSettings':
      return world.canManageMailboxes ? world.settings : forbidden;
    case 'updateEmailCampaignSettings':
      return updateSettings(world, input.body);
    case 'listEmailCampaignMailboxes':
      return world.canManage
        ? { items: world.mailboxes.map(campaignMailboxAnswer) }
        : { status: 403, detail: 'You may not write campaigns.' };
    case 'listViews':
      return { canSave: true, items: smartLists };
    case 'getTagConfiguration':
      return tags;
    case 'getFields':
      return { items: [], objects: [], canManage: true };
    case 'listMessageTemplates':
      return { canManage: true, items: world.templates, nextCursor: null };
    case 'listContacts':
      return { items: [], next: null, canManage: true };
    case 'renderEmailPreview':
      return {
        subject: 'Rendered',
        preheader: null,
        html: null,
        text: 'Rendered text',
        mergeFields: [],
        missingFields: [],
        subjectLineBreak: [],
      };
    default:
      return undefined;
  }
}

vi.mock('../api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: Input) =>
      Promise.resolve().then(() => {
        const { world } = server;
        if (world === undefined) throw new Error('no server');
        server.calls.push({ operation: endpoint.operationId, input });
        const answer = answerOf(world, endpoint.operationId, input);
        if (answer === undefined) throw new Error(`unexpected ${endpoint.operationId}`);
        if (isRefusal(answer))
          throw new ApiError({ type: 'about:blank', title: 'Refused', ...answer });
        return answer === NOTHING ? undefined : answer;
      }),
  }),
}));
vi.mock('../workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
  meQuery: {
    queryKey: ['me'],
    queryFn: () => Promise.resolve({ user: { name: 'Dana', email: 'dana@harborlights.example' } }),
  },
}));
vi.mock('../shell/page', () => ({
  Page: ({
    title,
    actions,
    children,
  }: {
    title: string;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {actions}
      {children}
    </main>
  ),
}));
const router = vi.hoisted((): { went: unknown[] } => ({ went: [] }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    className,
    'aria-label': label,
  }: {
    to: string;
    children: ReactNode;
    className?: string;
    'aria-label'?: string;
  }) => (
    <a href={to} className={className} aria-label={label}>
      {children}
    </a>
  ),
  useNavigate: () => (to: unknown) => {
    router.went.push(to);
    return Promise.resolve();
  },
  useBlocker: () => ({ status: 'idle' }),
}));

configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 60000 });

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  server.world = undefined;
  server.calls.length = 0;
  router.went.length = 0;
});
afterEach(cleanup);

function show(
  world: CampaignsWorld,
  page: ReactElement,
): { world: CampaignsWorld; user: ReturnType<typeof userEvent.setup> } {
  server.world = world;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>
        <Suspense fallback={null}>{page}</Suspense>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { world, user: userEvent.setup() };
}
const called = (operation: string): Call[] =>
  server.calls.filter((call) => call.operation === operation);
const noRef = { current: null };

const ready = (patch: Partial<EmailCampaign> = {}): EmailCampaign =>
  campaignOf(1, {
    name: 'Spring open day',
    mailboxId: calari.id,
    subject: 'Come to our open day',
    content: { format: 'text', text: 'Hello {{contact.firstName}}' },
    audience: { kind: 'all' },
    ...patch,
  });

// The list -----------------------------------------------------------------------------------

/** The list page with its address, as the route keeps it. */
function List(): ReactElement {
  const [search, setSearch] = useState<CampaignsSearch>({});
  return <CampaignsPage search={search} onSearch={setSearch} />;
}

it('says what a campaign is and what it needs while there is none', async () => {
  const { user } = show(worldOf(), <List />);
  expect(
    await screen.findByText('No campaigns yet. Send one email to many contacts, now or later.'),
  ).toBeTruthy();
  // The page's one New button, and the empty list's own.
  expect(screen.getAllByRole('button', { name: 'New campaign' })).toHaveLength(2);
  // What a campaign needs is behind the mark beside the title.
  await user.click(screen.getByRole('button', { name: 'About campaigns' }));
  expect(
    await screen.findByText(/a mailbox switched on for campaigns that passes its setup checks/),
  ).toBeTruthy();
  expect(screen.getByText(/contacts who agreed to marketing email/)).toBeTruthy();
  // Emails names its pages: Campaigns first, then Templates.
  const emails = within(screen.getByRole('navigation', { name: 'Emails' })).getAllByRole('link');
  expect(emails.map((link) => link.textContent)).toEqual(['Campaigns', 'Templates']);
});

it('offers no way to write a campaign to someone whose role cannot', async () => {
  show(worldOf({ canManage: false, canSend: false }), <List />);
  expect(await screen.findByText("No campaigns yet, and your role can't write one.")).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'New campaign' })).toBeNull();
});

it('lists each campaign with its status, why it waits, who it is for and how far it is', async () => {
  const sending = campaignOf(2, {
    name: 'October news',
    status: 'sending',
    audience: { kind: 'tags', tagIds: [tagId(1), tagId(2)], match: 'any' },
    startedAt: '2026-10-14T14:00:00.000Z',
    counts: { audience: 86, pending: 60, queued: 0, sent: 20, skipped: 6, failed: 0 },
    waiting: { reason: 'mailbox_daily_limit', until: '2026-10-15T05:00:00.000Z' },
  });
  const paused = campaignOf(3, {
    name: 'Old list',
    status: 'paused',
    statusReason: 'bounce_rate',
    audience: { kind: 'smart_list', viewId: smartLists[0].id },
    startedAt: '2026-10-13T14:00:00.000Z',
    counts: { audience: 420, pending: 300, queued: 0, sent: 120, skipped: 0, failed: 0 },
  });
  const scheduled = campaignOf(4, {
    name: 'Black Friday',
    status: 'scheduled',
    audience: { kind: 'all' },
    schedule: { sendAt: '2026-11-27T15:00:00.000Z', batches: null },
  });
  show(worldOf({ campaigns: [sending, paused, scheduled, ready()] }), <List />);

  const row = async (name: string): Promise<HTMLElement> => {
    const link = await screen.findByRole('link', { name });
    const found = link.closest('tr');
    if (found === null) throw new Error('no row');
    return found;
  };
  const october = await row('October news');
  expect(within(october).getByText('Sending')).toBeTruthy();
  expect(
    within(october).getByText(
      "Waiting until Oct 15, 2026, 12:00 AM because the mailbox's daily limit is reached.",
    ),
  ).toBeTruthy();
  expect(
    await within(october).findByText('Contacts with any of these tags: Promo, VIP'),
  ).toBeTruthy();
  expect(within(october).getByText('20 of 86')).toBeTruthy();

  const old = await row('Old list');
  expect(within(old).getByText('It paused itself: too many of its emails bounced.')).toBeTruthy();
  expect(await within(old).findByText('Smart list: Newsletter readers')).toBeTruthy();

  const friday = await row('Black Friday');
  expect(within(friday).getByText('Due Nov 27, 2026, 9:00 AM')).toBeTruthy();
  expect(within(friday).getByText('Not started')).toBeTruthy();

  const draft = await row('Spring open day');
  expect(within(draft).getByText('Draft')).toBeTruthy();
  expect(await within(draft).findByText('Every contact')).toBeTruthy();
  // Each row's audience came with the list: no row read its own campaign.
  expect(called('getEmailCampaign')).toEqual([]);
});

it('deletes a draft after asking, and cancels a sending campaign with what that really does', async () => {
  const sending = campaignOf(2, {
    name: 'October news',
    status: 'sending',
    startedAt: at(),
    counts: { audience: 86, pending: 60, queued: 0, sent: 20, skipped: 6, failed: 0 },
  });
  const { world, user } = show(worldOf({ campaigns: [sending, ready()] }), <List />);

  await user.click(await screen.findByRole('button', { name: 'Actions for Spring open day' }));
  expect(screen.queryByRole('menuitem', { name: 'Cancel campaign' })).toBeNull();
  await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
  const asked = await screen.findByRole('dialog', { name: 'Delete this draft?' });
  expect(within(asked).getByText(/Nothing was sent, so nothing else changes/)).toBeTruthy();
  await user.click(within(asked).getByRole('button', { name: 'Delete draft' }));
  await waitFor(() => {
    expect(world.campaigns.map((campaign) => campaign.name)).toEqual(['October news']);
  });
  await waitFor(() => {
    expect(screen.queryByRole('link', { name: 'Spring open day' })).toBeNull();
  });
  // The row went with its menu button: the keyboard is on the list's heading.
  await waitFor(() => {
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2, name: 'All campaigns' }),
    );
  });

  await user.click(screen.getByRole('button', { name: 'Actions for October news' }));
  expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  await user.click(await screen.findByRole('menuitem', { name: 'Cancel campaign' }));
  const cancel = await screen.findByRole('dialog', { name: 'Cancel this campaign?' });
  expect(within(cancel).getByText(/stops for good and cannot be resumed/)).toBeTruthy();
  await user.click(within(cancel).getByRole('button', { name: 'Cancel campaign' }));
  await waitFor(() => {
    expect(world.campaigns[0]?.status).toBe('cancelled');
  });
});

it('gives a member who cannot send no way to cancel from the list', async () => {
  const sending = campaignOf(2, { name: 'October news', status: 'sending', startedAt: at() });
  const { user } = show(worldOf({ campaigns: [sending], canSend: false }), <List />);
  await user.click(await screen.findByRole('button', { name: 'Actions for October news' }));
  expect(await screen.findByRole('menuitem', { name: 'Duplicate' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'Cancel campaign' })).toBeNull();
});

it('starts a blank campaign from the dialog and opens it', async () => {
  const { world, user } = show(worldOf(), <List />);
  const [menu] = await screen.findAllByRole('button', { name: 'New campaign' });
  if (menu === undefined) throw new Error('no New campaign');
  await user.click(menu);
  await user.click(await screen.findByRole('menuitem', { name: /^Campaign/ }));
  const dialog = await screen.findByRole('dialog', { name: 'New campaign' });
  await user.click(within(dialog).getByRole('button', { name: 'Create campaign' }));
  expect(await within(dialog).findByText('Give the campaign a name.')).toBeTruthy();
  await user.type(within(dialog).getByLabelText('Campaign name'), 'Winter news');
  expect(within(dialog).getByRole('radio', { name: 'Blank' })).toHaveProperty('checked', true);
  await user.click(within(dialog).getByRole('button', { name: 'Create campaign' }));
  await waitFor(() => {
    expect(world.campaigns[0]?.name).toBe('Winter news');
  });
  await waitFor(() => {
    expect(router.went).toHaveLength(1);
  });
});

it('shows the folders at the left with what each holds, and keeps the folder and status in the address', async () => {
  const news = folderOf(50, 'Newsletters');
  const inNews = campaignOf(2, { name: 'October news', status: 'sent', folderId: news.id });
  const { user } = show(worldOf({ campaigns: [inNews, ready()], folders: [news] }), <List />);
  const panel = await screen.findByRole('navigation', { name: 'Campaign folders' });
  await within(panel).findByRole('button', { name: /^Newsletters/ });
  expect(
    within(panel)
      .getAllByRole('button')
      .filter((each) => each.hasAttribute('aria-current'))
      .map((each) => each.textContent),
  ).toEqual(['All campaigns, 2', 'No folder, 1', 'Newsletters, 1']);
  expect(await screen.findByText('1 - 2 of 2')).toBeTruthy();
  await user.click(within(panel).getByRole('button', { name: /^Newsletters/ }));
  await waitFor(() => {
    expect(screen.queryByRole('link', { name: 'Spring open day' })).toBeNull();
  });
  expect(called('listEmailCampaigns').at(-1)?.input.query).toMatchObject({ folder: news.id });
  await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'draft');
  expect(await screen.findByText('Nothing matches. Try another search or filter.')).toBeTruthy();
  expect(called('listEmailCampaigns').at(-1)?.input.query).toMatchObject({
    folder: news.id,
    status: 'draft',
  });
});

it('pauses and resumes from the menu after saying what each does, and edits a draft', async () => {
  const sending = campaignOf(2, { name: 'October news', status: 'sending', startedAt: at() });
  const { world, user } = show(worldOf({ campaigns: [sending, ready()] }), <List />);
  await user.click(await screen.findByRole('button', { name: 'Actions for October news' }));
  expect((await screen.findAllByRole('menuitem')).map((each) => each.textContent)).toEqual([
    'Open',
    'Duplicate',
    'Move to folder',
    'Pause',
    'Cancel campaign',
  ]);
  await user.click(screen.getByRole('menuitem', { name: 'Pause' }));
  const pause = await screen.findByRole('dialog', { name: 'Pause this campaign?' });
  await user.click(within(pause).getByRole('button', { name: 'Pause sending' }));
  await waitFor(() => {
    expect(world.campaigns[0]?.status).toBe('paused');
  });
  expect(await screen.findByText('Paused “October news”.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Actions for October news' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Resume' }));
  const resume = await screen.findByRole('dialog', { name: 'Resume this campaign?' });
  await user.click(within(resume).getByRole('button', { name: 'Resume sending' }));
  await waitFor(() => {
    expect(world.campaigns[0]?.status).toBe('sending');
  });
  await user.click(screen.getByRole('button', { name: 'Actions for Spring open day' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
  expect(router.went).toHaveLength(1);
});

it('moves ticked campaigns together, and deletes only the drafts among them', async () => {
  const news = folderOf(50, 'Newsletters');
  const sent = campaignOf(2, { name: 'October news', status: 'sent', startedAt: at() });
  const { world, user } = show(worldOf({ campaigns: [sent, ready()], folders: [news] }), <List />);
  await user.click(
    await screen.findByRole('checkbox', { name: 'Select all campaigns on this page' }),
  );
  const bar = screen.getByRole('region', { name: 'Bulk actions' });
  expect(within(bar).getByText('2 selected on this page')).toBeTruthy();
  await user.click(within(bar).getByRole('button', { name: 'Move to folder' }));
  const move = await screen.findByRole('dialog', { name: 'Move 2 campaigns' });
  // The folders are read before one can be chosen.
  await waitFor(() => {
    expect(within(move).getByRole('button', { name: 'Move' }).matches(':disabled')).toBe(false);
  });
  await user.selectOptions(within(move).getByRole('combobox', { name: 'Folder' }), news.id);
  await user.click(within(move).getByRole('button', { name: 'Move' }));
  await waitFor(() => {
    expect(world.campaigns.map((each) => each.folderId)).toEqual([news.id, news.id]);
  });
  expect(await screen.findByText('2 campaigns moved.')).toBeTruthy();

  await user.click(screen.getByRole('checkbox', { name: 'Select all campaigns on this page' }));
  await user.click(
    within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', {
      name: 'Delete drafts',
    }),
  );
  const asked = await screen.findByRole('dialog', { name: 'Delete 1 draft?' });
  await user.click(within(asked).getByRole('button', { name: 'Delete drafts' }));
  await waitFor(() => {
    expect(world.campaigns.map((each) => each.name)).toEqual(['October news']);
  });
  expect(
    await screen.findByText('1 draft deleted. 1 campaign was kept: only a draft can be deleted.'),
  ).toBeTruthy();
  // The bar went with the selection: the keyboard is on the list's heading.
  await waitFor(() => {
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2, name: 'All campaigns' }),
    );
  });
});

it('says why each draft it could not delete was kept, as the server said it', async () => {
  const first = ready();
  const second = campaignOf(3, { name: 'Autumn news' });
  const { world, user } = show(worldOf({ campaigns: [first, second] }), <List />);
  await user.click(
    await screen.findByRole('checkbox', { name: 'Select all campaigns on this page' }),
  );
  // Someone saves one of them after the list was read.
  editedElsewhere(world, second.id, 'Autumn newsletter');
  await user.click(
    within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', {
      name: 'Delete drafts',
    }),
  );
  const asked = await screen.findByRole('dialog', { name: 'Delete 2 drafts?' });
  await user.click(within(asked).getByRole('button', { name: 'Delete drafts' }));
  expect(
    await screen.findByText(
      '1 draft deleted. Not deleted: “Autumn news”: The campaign changed since it was read. Read it again.',
    ),
  ).toBeTruthy();
  expect(world.campaigns.map((each) => each.name)).toEqual(['Autumn newsletter']);
});

it('shows the campaigns in no folder from the panel', async () => {
  const news = folderOf(50, 'Newsletters');
  const inNews = campaignOf(2, { name: 'October news', status: 'sent', folderId: news.id });
  const { user } = show(worldOf({ campaigns: [inNews, ready()], folders: [news] }), <List />);
  const panel = await screen.findByRole('navigation', { name: 'Campaign folders' });
  await user.click(await within(panel).findByRole('button', { name: /^No folder/ }));
  await waitFor(() => {
    expect(screen.queryByRole('link', { name: 'October news' })).toBeNull();
  });
  expect(screen.getByRole('link', { name: 'Spring open day' })).toBeTruthy();
  expect(called('listEmailCampaigns').at(-1)?.input.query).toMatchObject({ folder: 'root' });
  expect(screen.getByRole('heading', { level: 2, name: 'No folder' })).toBeTruthy();
});

it('clears the ticks when another page is shown', async () => {
  const many = Array.from({ length: 12 }, (_, index) =>
    campaignOf(10 + index, { name: `Draft ${String(10 + index)}` }),
  );
  const { user } = show(worldOf({ campaigns: many }), <List />);
  await user.selectOptions(
    await screen.findByRole('combobox', { name: 'Campaigns per page' }),
    '10',
  );
  await user.click(await screen.findByRole('checkbox', { name: 'Select Draft 10' }));
  expect(
    within(screen.getByRole('region', { name: 'Bulk actions' })).getByText(
      '1 selected on this page',
    ),
  ).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Next page' }));
  expect(await screen.findByRole('link', { name: 'Draft 20' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Previous page' }));
  const back = await screen.findByRole('checkbox', { name: 'Select Draft 10' });
  expect((back as HTMLInputElement).checked).toBe(false);
});

function at(): string {
  return '2026-10-14T14:00:00.000Z';
}

// The editor ---------------------------------------------------------------------------------

it('saves the draft by itself, then reads the audience and the checks of what was saved', async () => {
  const draft = campaignOf(1, { name: 'Spring open day', mailboxId: calari.id });
  const { world, user } = show(
    worldOf({ campaigns: [draft] }),
    <CampaignEditor campaign={draft} />,
  );

  // Nothing written, nobody chosen: sending is blocked, and the reason is beside the button.
  const send = await screen.findByRole('button', { name: 'Send or schedule' });
  await waitFor(() => {
    expect(send).toHaveProperty('disabled', true);
  });
  expect(await screen.findByText('Give the email a subject.', { selector: 'p' })).toBeTruthy();
  const checks = await screen.findByRole('list', { name: 'Checks before sending' });
  expect(within(checks).getAllByText('Must be fixed before sending')).toHaveLength(3);

  await user.type(screen.getByLabelText('Subject'), 'Come to our open day');
  expect(await screen.findByText('Saving…')).toBeTruthy();
  expect(await screen.findByText('All changes saved')).toBeTruthy();
  expect(world.campaigns[0]).toMatchObject({ subject: 'Come to our open day', revision: 2 });

  await user.click(screen.getByRole('radio', { name: 'Everyone' }));
  expect(await screen.findByText('1,240 will receive it')).toBeTruthy();
  expect(screen.getByText('310 will not')).toBeTruthy();
  const reasons = screen.getByRole('list', { name: 'Why some will not receive it' });
  const rows = within(reasons).getAllByRole('listitem');
  expect(rows).toHaveLength(8);
  expect(rows[0]?.textContent).toContain('No marketing consent');
  expect(rows[0]?.textContent).toContain('180');
  expect(rows[0]?.textContent).toContain('Ada Okafor');
  expect(rows[0]?.textContent).toContain('and 178 more');
  expect(within(reasons).getByText(/Only they can sign up again/)).toBeTruthy();

  // The body is still missing: it is the first thing said, and the way to it is offered.
  await waitFor(() => {
    expect(screen.getByText('Write the email.', { selector: 'p' })).toBeTruthy();
  });
  expect(within(checks).getAllByRole('button', { name: 'Go to Email' }).length).toBeGreaterThan(0);
  expect(
    await within(checks).findByText(
      '310 contacts in the audience will not get it. The audience preview says why.',
    ),
  ).toBeTruthy();
  expect(
    within(checks).getByText(
      'At most 500 campaign emails can leave this mailbox in a day now, so this send will take about 3 days.',
    ),
  ).toBeTruthy();
});

it('lets someone who may send do so once nothing blocks, and tells a member to ask', async () => {
  const draft = ready();
  const first = show(worldOf({ campaigns: [draft] }), <CampaignEditor campaign={draft} />);
  const send = await screen.findByRole('button', { name: 'Send or schedule' });
  await waitFor(() => {
    expect(send).toHaveProperty('disabled', false);
  });
  expect(screen.getByText('Nothing leaves until you confirm in the next step.')).toBeTruthy();
  await first.user.click(send);
  expect(await screen.findByRole('dialog', { name: 'Send or schedule' })).toBeTruthy();
  cleanup();

  const member = getMember(draft);
  show(worldOf({ campaigns: [draft], canSend: false }), <CampaignEditor campaign={member} />);
  const blocked = await screen.findByRole('button', { name: 'Send or schedule' });
  expect(blocked).toHaveProperty('disabled', true);
  expect(screen.getByText('Ask an owner or admin to send.')).toBeTruthy();
  // A member may still test, to themselves.
  expect(screen.getByRole('button', { name: 'Send a test' })).toHaveProperty('disabled', false);
});

const getMember = (campaign: EmailCampaign): EmailCampaign => ({ ...campaign, canSend: false });

it('says so when no mailbox is switched on for campaigns, with the way to Settings', async () => {
  const draft = campaignOf(1, { name: 'Spring open day' });
  show(worldOf({ campaigns: [draft], mailboxes: [support] }), <CampaignEditor campaign={draft} />);
  expect(await screen.findByText(/No mailbox is switched on for campaigns/)).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'Open Settings → Email Services' }).getAttribute('href'),
  ).toBe('/b/$slug/settings/email');
});

it('lets someone who may write campaigns and not manage mailboxes choose the mailbox', async () => {
  const draft = campaignOf(1, { name: 'Spring open day' });
  const { world, user } = show(
    worldOf({ campaigns: [draft], canManageMailboxes: false, canSend: false }),
    <CampaignEditor campaign={getMember(draft)} />,
  );
  const from = await screen.findByRole('combobox', { name: 'From mailbox' });
  // Only the mailbox switched on for campaigns is offered.
  expect(
    within(from)
      .getAllByRole('option')
      .map((option) => option.textContent),
  ).toEqual(['Choose a mailbox', 'Calari mailbox · hello@calari.example']);
  await user.selectOptions(from, calari.id);
  expect(await screen.findByText('All changes saved')).toBeTruthy();
  expect(world.campaigns[0]?.mailboxId).toBe(calari.id);
});

it('does not save over someone else: it offers their version, or a copy of mine', async () => {
  const draft = ready();
  const { world, user } = show(
    worldOf({ campaigns: [draft] }),
    <CampaignEditor campaign={draft} />,
  );
  await screen.findByRole('button', { name: 'Send or schedule' });
  editedElsewhere(world, draft.id, 'Renamed by Sam');
  await user.type(screen.getByLabelText('Subject'), '!');
  expect(
    await screen.findByText(/Someone else changed this campaign while you were editing/),
  ).toBeTruthy();
  expect(screen.getByText('Not saved: someone else changed it')).toBeTruthy();
  expect(world.campaigns[0]?.subject).toBe('Come to our open day');

  await user.click(screen.getByRole('button', { name: 'Load their version' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Renamed by Sam' })).toBeTruthy();
  expect(await screen.findByText('All changes saved')).toBeTruthy();
  expect(screen.getByLabelText('Subject')).toHaveProperty('value', 'Come to our open day');
});

it('keeps my changes as a copy when I choose that', async () => {
  const draft = ready();
  const { world, user } = show(
    worldOf({ campaigns: [draft] }),
    <CampaignEditor campaign={draft} />,
  );
  await screen.findByRole('button', { name: 'Send or schedule' });
  editedElsewhere(world, draft.id, 'Renamed by Sam');
  await user.type(screen.getByLabelText('Subject'), '!');
  await user.click(await screen.findByRole('button', { name: 'Keep mine as a copy' }));
  await waitFor(() => {
    expect(world.campaigns).toHaveLength(2);
  });
  await waitFor(() => {
    expect(world.campaigns[0]).toMatchObject({
      name: 'Spring open day (my copy)',
      subject: 'Come to our open day!',
    });
  });
  expect(world.campaigns[1]?.name).toBe('Renamed by Sam');
  await waitFor(() => {
    expect(router.went).toHaveLength(1);
  });
});

it('marks a box the API would refuse and does not save until it is put right', async () => {
  const draft = ready();
  const { world, user } = show(
    worldOf({ campaigns: [draft] }),
    <CampaignEditor campaign={draft} />,
  );
  await user.type(await screen.findByLabelText('Reply-To'), 'not-an-address');
  expect(
    await screen.findByText('Give one email address, such as hello@example.com.'),
  ).toBeTruthy();
  expect(await screen.findByText('Not saved: put right what is marked')).toBeTruthy();
  expect(screen.getByText('Put right what is marked above first.')).toBeTruthy();
  expect(world.campaigns[0]?.revision).toBe(1);
  await user.clear(screen.getByLabelText('Reply-To'));
  await user.type(screen.getByLabelText('Reply-To'), 'events@calari.example');
  expect(await screen.findByText('All changes saved')).toBeTruthy();
  expect(world.campaigns[0]?.replyTo).toBe('events@calari.example');
});

// Test, send, schedule -----------------------------------------------------------------------

it('sends a test to me, and lets only someone who may send name other addresses', async () => {
  const draft = ready();
  const { world, user } = show(
    worldOf({ campaigns: [draft], canSend: false }),
    <TestDialog
      client={clientOf()}
      businessId="biz_test"
      campaignId={draft.id}
      canSend={false}
      returnFocus={noRef}
      beforeSend={() => Promise.resolve(true)}
      onClose={() => undefined}
    />,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Send a test' });
  expect(within(dialog).getByLabelText('Other addresses')).toHaveProperty('disabled', true);
  expect(within(dialog).getByText(/Your role can send a test to yourself only/)).toBeTruthy();
  expect(within(dialog).getByText(/A business can send 20 tests an hour/)).toBeTruthy();
  expect(
    within(dialog).getByRole('checkbox', { name: 'To me (dana@harborlights.example)' }),
  ).toHaveProperty('checked', true);
  await user.click(within(dialog).getByRole('button', { name: 'Send test' }));
  expect(
    await within(dialog).findByText(/The test is on its way to dana@harborlights.example/),
  ).toBeTruthy();
  expect(world.tests).toEqual([
    { id: draft.id, to: ['dana@harborlights.example'], contactId: undefined },
  ]);
});

it('refuses more test addresses than the server takes, in words, before asking it', async () => {
  const draft = ready();
  const { world, user } = show(
    worldOf({ campaigns: [draft] }),
    <TestDialog
      client={clientOf()}
      businessId="biz_test"
      campaignId={draft.id}
      canSend
      returnFocus={noRef}
      beforeSend={() => Promise.resolve(true)}
      onClose={() => undefined}
    />,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Send a test' });
  const others = within(dialog).getByLabelText('Other addresses');
  await user.type(others, 'a@x.io, b@x.io, c@x.io, d@x.io, e@x.io');
  await user.click(within(dialog).getByRole('button', { name: 'Send test' }));
  expect(await within(dialog).findByText('A test goes to at most 5 addresses.')).toBeTruthy();
  expect(world.tests).toHaveLength(0);
  await user.clear(others);
  await user.type(others, 'sam@calari.example');
  await user.click(within(dialog).getByRole('button', { name: 'Send test' }));
  await waitFor(() => {
    expect(world.tests[0]?.to).toEqual(['dana@harborlights.example', 'sam@calari.example']);
  });
});

// The mocked API: the same stand-in the pages get from apiIn.
function clientOf(): ReturnType<typeof apiIn> {
  return apiIn('biz_test');
}

it('says how long a send will take before it is confirmed, and names who and from where', async () => {
  const draft = ready();
  const done = vi.fn<(campaign: EmailCampaign) => void>();
  const { world, user } = show(
    worldOf({ campaigns: [draft] }),
    <SendDialog
      client={clientOf()}
      campaign={draft}
      willReceive={1240}
      dailyCeiling={500}
      mailboxName="Calari mailbox"
      returnFocus={noRef}
      onClose={() => undefined}
      onDone={done}
    />,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Send or schedule' });
  expect(
    within(dialog).getByText('About 3 days: at most 500 a day from Calari mailbox.'),
  ).toBeTruthy();

  await user.click(within(dialog).getByRole('checkbox', { name: 'Send in batches' }));
  const every = within(dialog).getByLabelText('One batch every');
  await user.clear(every);
  await user.type(every, '45');
  expect(await within(dialog).findByText('Leave at most 30 days between batches.')).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true);
  expect(within(dialog).getByText('Put right what is marked above to see it.')).toBeTruthy();
  await user.clear(every);
  await user.type(every, '1');
  const size = within(dialog).getByLabelText('Emails in a batch');
  await user.clear(size);
  await user.type(size, '400');
  expect(await within(dialog).findByText(/^4 batches; the last may start /)).toBeTruthy();

  await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
  const confirm = await screen.findByRole('dialog', { name: 'Confirm' });
  expect(
    within(confirm).getByText('Send “Spring open day” to 1,240 contacts from Calari mailbox now?'),
  ).toBeTruthy();
  expect(within(confirm).getByText('400 emails every day')).toBeTruthy();
  expect(within(confirm).getByText(/emails that have left\s+stay sent/)).toBeTruthy();
  await user.click(within(confirm).getByRole('button', { name: 'Send now' }));
  await waitFor(() => {
    expect(done).toHaveBeenCalledTimes(1);
  });
  expect(called('sendEmailCampaign')[0]?.input.body).toEqual({
    revision: 1,
    batches: { size: 400, every: 1, unit: 'days', window: null },
  });
  expect(world.campaigns[0]?.status).toBe('sending');
});

it('schedules for a date and time on the business clock', async () => {
  const draft = ready();
  const done = vi.fn<(campaign: EmailCampaign) => void>();
  const { world, user } = show(
    worldOf({ campaigns: [draft] }),
    <SendDialog
      client={clientOf()}
      campaign={draft}
      willReceive={80}
      dailyCeiling={500}
      mailboxName="Calari mailbox"
      returnFocus={noRef}
      onClose={() => undefined}
      onDone={done}
    />,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Send or schedule' });
  await user.click(within(dialog).getByRole('radio', { name: 'Schedule for a date and time' }));
  expect(within(dialog).getByText("On the business's clock: America/Chicago.")).toBeTruthy();
  expect(
    within(dialog).getByText(
      'About a day: Calari mailbox can release up to 500 campaign emails a day now.',
    ),
  ).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
  const confirm = await screen.findByRole('dialog', { name: 'Confirm' });
  expect(
    within(confirm).getByText(
      /^Schedule “Spring open day” for 80 contacts from Calari mailbox, starting /,
    ),
  ).toBeTruthy();
  expect(within(confirm).getByText(/it becomes a draft again/)).toBeTruthy();
  await user.click(within(confirm).getByRole('button', { name: 'Schedule campaign' }));
  await waitFor(() => {
    expect(done).toHaveBeenCalledTimes(1);
  });
  const sent = called('scheduleEmailCampaign')[0]?.input.body as { sendAt: string; batches: null };
  expect(new Date(sent.sendAt).getTime()).toBeGreaterThan(Date.now());
  expect(sent.batches).toBeNull();
  expect(world.campaigns[0]?.status).toBe('scheduled');
});

// A campaign that is sending -----------------------------------------------------------------

function sendingWorld(patch: Partial<CampaignsWorld> = {}): {
  world: CampaignsWorld;
  campaign: EmailCampaign;
} {
  const campaign = ready({
    status: 'sending',
    startedAt: at(),
    counts: { audience: 1550, pending: 1237, queued: 1, sent: 2, skipped: 310, failed: 0 },
    waiting: { reason: 'business_daily_limit', until: '2026-10-15T05:00:00.000Z' },
  });
  const world = worldOf({ campaigns: [campaign], ...patch });
  world.recipients[campaign.id] = recipientsUnderWay();
  return { world, campaign: { ...campaign, canSend: world.canSend, canManage: world.canManage } };
}

it('shows a sending campaign: why it waits, its numbers, its recipients, and no opens or clicks', async () => {
  const { world, campaign } = sendingWorld();
  show(world, <CampaignResults campaign={campaign} />);
  expect(await screen.findByText('Sending since Oct 14, 2026, 9:00 AM')).toBeTruthy();
  expect(
    screen.getByText(
      "Waiting until Oct 15, 2026, 12:00 AM because the business's daily campaign limit is reached.",
    ),
  ).toBeTruthy();
  const numbers = screen.getByRole('region', { name: 'Numbers' });
  expect(await within(numbers).findByText('Hard bounced')).toBeTruthy();
  expect(
    within(numbers).getByText('312 of 1,550 finished with (20%): sent, skipped or failed.'),
  ).toBeTruthy();
  expect(within(numbers).getByText(/Opens and clicks are not tracked yet/)).toBeTruthy();
  expect(within(numbers).getByText('No marketing consent')).toBeTruthy();
  expect(within(numbers).queryByText(/Opened|Clicked|Delivered/)).toBeNull();

  const recipients = screen.getByRole('region', { name: 'Recipients' });
  const grace = (await within(recipients).findByRole('link', { name: 'Grace Hall' })).closest('tr');
  expect(grace?.textContent).toContain('Sent');
  const gus = within(recipients).getByRole('link', { name: 'Gus Moreno' }).closest('tr');
  expect(gus?.textContent).toContain('Missing a merge value: {{contact.firstName}}');
  const hugo = within(recipients).getByRole('link', { name: 'Hugo Park' }).closest('tr');
  expect(hugo?.textContent).toContain('Bounced');

  const sent = screen.getByRole('region', { name: 'What was sent' });
  expect(within(sent).getByText('Come to our open day')).toBeTruthy();
  expect(within(sent).getByText('Every contact')).toBeTruthy();
});

it('pauses and resumes after saying what each does, and cancels for good', async () => {
  const { world, campaign } = sendingWorld();
  const { user } = show(world, <CampaignResults campaign={campaign} />);
  await user.click(await screen.findByRole('button', { name: 'Pause' }));
  const pause = await screen.findByRole('dialog', { name: 'Pause this campaign?' });
  expect(within(pause).getByText(/Emails that have left stay sent/)).toBeTruthy();
  await user.click(within(pause).getByRole('button', { name: 'Pause sending' }));
  await waitFor(() => {
    expect(world.campaigns[0]?.status).toBe('paused');
  });
  cleanup();

  const paused = getOf(world, campaign.id);
  if (isRefusal(paused)) throw new Error('gone');
  const second = show(world, <CampaignResults campaign={paused} />);
  expect(await screen.findByText('Paused by a person.')).toBeTruthy();
  await second.user.click(screen.getByRole('button', { name: 'Resume' }));
  const resume = await screen.findByRole('dialog', { name: 'Resume this campaign?' });
  expect(within(resume).getByText(/Nobody is sent the campaign twice/)).toBeTruthy();
  await second.user.click(within(resume).getByRole('button', { name: 'Resume sending' }));
  await waitFor(() => {
    expect(world.campaigns[0]?.status).toBe('sending');
  });
  cleanup();

  const resumed = getOf(world, campaign.id);
  if (isRefusal(resumed)) throw new Error('gone');
  const third = show(world, <CampaignResults campaign={resumed} />);
  await third.user.click(await screen.findByRole('button', { name: 'Cancel campaign' }));
  const cancel = await screen.findByRole('dialog', { name: 'Cancel this campaign?' });
  expect(within(cancel).getByText(/stops for good and cannot be resumed/)).toBeTruthy();
  await third.user.click(within(cancel).getByRole('button', { name: 'Cancel campaign' }));
  await waitFor(() => {
    expect(world.campaigns[0]?.status).toBe('cancelled');
  });
});

it('says why a campaign paused itself and what to do', async () => {
  const { world, campaign } = sendingWorld();
  const paused: EmailCampaign = {
    ...campaign,
    status: 'paused',
    statusReason: 'bounce_rate',
    waiting: null,
  };
  world.campaigns = [paused];
  show(world, <CampaignResults campaign={paused} />);
  expect(await screen.findByText('It paused itself: too many of its emails bounced.')).toBeTruthy();
  expect(screen.getByText(/Look at the recipients that bounced/)).toBeTruthy();
});

it('shows a member the controls disabled, with whom to ask', async () => {
  const { world, campaign } = sendingWorld({ canSend: false });
  show(world, <CampaignResults campaign={campaign} />);
  expect(await screen.findByRole('button', { name: 'Pause' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Cancel campaign' })).toHaveProperty('disabled', true);
  expect(screen.getByText('Ask an owner or admin to pause, resume or cancel it.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Duplicate as a new draft' })).toHaveProperty(
    'disabled',
    false,
  );
});

it('shows a scheduled campaign with when it starts, and that cancelling makes it a draft', async () => {
  const scheduled = ready({
    status: 'scheduled',
    schedule: {
      sendAt: '2026-11-27T15:00:00.000Z',
      batches: { size: 500, every: 1, unit: 'days', window: null },
    },
  });
  const { world, user } = show(
    worldOf({ campaigns: [scheduled] }),
    <CampaignResults campaign={scheduled} />,
  );
  expect(await screen.findByText('Scheduled to start Nov 27, 2026, 9:00 AM')).toBeTruthy();
  expect(screen.getByText('In batches: 500 emails every day.')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Numbers' })).toBeNull();
  expect(screen.getByRole('region', { name: 'What will be sent' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Cancel campaign' }));
  const cancel = await screen.findByRole('dialog', { name: 'Cancel this campaign?' });
  expect(within(cancel).getByText(/becomes a draft again/)).toBeTruthy();
  await user.click(within(cancel).getByRole('button', { name: 'Cancel campaign' }));
  await waitFor(() => {
    expect(world.campaigns[0]?.status).toBe('draft');
  });
});

// Settings -----------------------------------------------------------------------------------

it('sets the campaign ceiling with a true explanation, and refuses a number it cannot be', async () => {
  const { world, user } = show(worldOf(), <CampaignLimit />);
  const card = await screen.findByRole('region', { name: 'Campaign sending limit' });
  expect(
    await within(card).findByText(
      /Replies and workflow emails always leave first and are never held back/,
    ),
  ).toBeTruthy();
  expect(
    within(card).getByText(
      'A campaign pauses itself once 5% of its sent emails hard-bounced, counted after 100 were sent.',
    ),
  ).toBeTruthy();
  const box = await within(card).findByLabelText('Campaign emails a day');
  await user.type(box, '0');
  await user.click(within(card).getByRole('button', { name: 'Save limit' }));
  expect(
    await within(card).findByText('Give a whole number from 1 to 100,000, or leave it empty.'),
  ).toBeTruthy();
  expect(world.settings.dailyLimit).toBeNull();
  await user.clear(box);
  await user.type(box, '800');
  await user.click(within(card).getByRole('button', { name: 'Save limit' }));
  await waitFor(() => {
    expect(world.settings.dailyLimit).toBe(800);
  });
});

it('shows the ceiling read-only to someone who may not change it, and nothing when refused', async () => {
  const world = worldOf();
  world.settings = { ...world.settings, dailyLimit: 300, agencyDailyLimit: 5000, canManage: false };
  show(world, <CampaignLimit />);
  const card = await screen.findByRole('region', { name: 'Campaign sending limit' });
  expect(await within(card).findByLabelText('Campaign emails a day')).toHaveProperty(
    'disabled',
    true,
  );
  expect(within(card).queryByRole('button', { name: 'Save limit' })).toBeNull();
  expect(within(card).getByText(/limits the whole agency to 5,000 campaign emails/)).toBeTruthy();
  cleanup();

  show(worldOf({ canManageMailboxes: false }), <CampaignLimit />);
  await waitFor(() => {
    expect(called('getEmailCampaignSettings').length).toBeGreaterThan(0);
  });
  await waitFor(() => {
    expect(screen.queryByRole('region', { name: 'Campaign sending limit' })).toBeNull();
  });
});
