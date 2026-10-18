// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  automationId,
  automationOf,
  catalogOf,
  folderIds,
  folderOf,
  followUp,
  followUpStats,
  summaryOf,
} from '../e2e/automation-fixtures';
import { AutomationOverview } from './automation-overview';
import type { AutomationsSearch } from './automation-navigation';
import { AutomationsPage, automationsSearch } from './automations';
// Loaded here, before any test starts: the page fetches these lazily, and a test that had to
// wait for their code to be read for the first time lost that race on a busy machine. With
// them loaded, a test waits on React alone.
import './automation-builder';
import './automation-canvas';
import './automation-runs';
import './automation-canvas-library';
import './automation-step-dialog';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
  catalog: () => unknown;
}
const server = vi.hoisted((): Server => ({
  calls: [],
  answer: () => undefined,
  catalog: () => {
    throw new Error('No catalog.');
  },
}));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      // The catalog is the same for every test here, and is not what any of them counts.
      if (endpoint.operationId === 'getAutomationCatalog')
        return Promise.resolve().then(() => server.catalog());
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
vi.mock('./shell/page', () => ({
  usePageTitle: () => undefined,
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
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => '/b/harbor/automations',
  useBlocker: () => ({ status: 'idle' }),
  CatchBoundary: ({ children }: { children: ReactNode }) => children,
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
  server.catalog = () => catalogOf();
});
afterEach(cleanup);

function open(search: AutomationsSearch = {}): {
  user: ReturnType<typeof userEvent.setup>;
  went: AutomationsSearch[];
} {
  const went: AutomationsSearch[] = [];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <AutomationsPage
          search={search}
          onSearch={(next) => {
            went.push(next);
          }}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  // Keys follow one another with no timer between them (user-event's `delay`). Every key
  // is still its own events and its own render; what goes is a wait per character, which
  // on a busy machine took a long test past its five seconds.
  return { user: userEvent.setup({ delay: null }), went };
}

// Loaded before any test starts, as the builder's lazy views are in their tests.
import './automation-transfer';
import './automation-list-parts';

const live = automationOf({
  status: 'active',
  liveVersion: 4,
  lastRunAt: '2026-10-08T14:30:00.000Z',
  totalEnrolled: 1204,
  activeEnrolled: 37,
});
const paused = automationOf({
  id: 'aut_01k8e2wzr0e008000000000012',
  name: 'Win back',
  status: 'paused',
  liveVersion: 1,
});
const draft = automationOf({ id: 'aut_01k8e2wzr0e008000000000013', name: 'Birthday note' });
const leads = folderOf(folderIds.leads, 'Leads', { automationCount: 2 });
const weddings = folderOf(folderIds.weddings, 'Weddings', { parentId: folderIds.leads });

interface Call {
  readonly operation: string;
  readonly input: unknown;
}
const called = (operation: string): Call[] =>
  server.calls.filter((call) => call.operation === operation);

/** A server with these workflows and folders, which answers every other request with `more`. */
function serve(
  automations: readonly ReturnType<typeof automationOf>[],
  folders: readonly ReturnType<typeof folderOf>[] = [],
  more: (operation: string, input: unknown) => unknown = () => ({}),
  flags: { canManage?: boolean } = { canManage: true },
): void {
  server.answer = (operation, input) => {
    if (operation === 'listAutomationFolders') return { items: folders, ...flags };
    if (operation === 'listAutomations')
      return { items: automations.map(summaryOf), nextCursor: null, ...flags };
    return more(operation, input);
  };
}

/** The row of a workflow or a folder, by the name its first cell shows. */
const row = (name: string): HTMLElement => {
  const found = screen
    .getAllByRole('rowheader')
    .find((header) => header.textContent === name)
    ?.closest('tr');
  if (found === null || found === undefined) throw new Error(`No row is named ${name}.`);
  return found;
};

/** Opens a row's menu and chooses one of its actions. */
async function act(
  user: ReturnType<typeof userEvent.setup>,
  menu: string,
  action: string,
): Promise<void> {
  await user.click(await screen.findByRole('button', { name: menu }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
}

describe('the workflows list', () => {
  it("shows each workflow's name, status, how many it enrolled, and when it changed", async () => {
    serve([live, paused, draft]);
    open();
    const table = await screen.findByRole('table', { name: 'Workflows' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Name',
      'Status',
      'Total enrolled',
      'Active enrolled',
      'Last updated',
      'Created on',
      'Stats',
      'Actions',
    ]);
    const cells = (name: string): (string | null)[] =>
      within(row(name))
        .getAllByRole('cell')
        .map((cell) => cell.textContent);
    expect(cells('New lead follow-up').slice(0, 3)).toEqual(['Published', '1,204', '37']);
    expect(cells('New lead follow-up')[3]).toMatch(/2026/);
    expect(cells('Win back').slice(0, 3)).toEqual(['Paused', '0', '0']);
    expect(cells('Birthday note').slice(0, 3)).toEqual(['Draft', '0', '0']);
    expect(
      within(table).getByRole('link', { name: 'New lead follow-up' }).getAttribute('href'),
    ).toBe(`/b/harbor/automations?automation=${automationId}`);
    const elsewhere = within(table).getByRole('link', {
      name: 'Open New lead follow-up in a new tab',
    });
    expect(elsewhere.getAttribute('target')).toBe('_blank');
    expect(elsewhere.getAttribute('href')).toBe(`/b/harbor/automations?automation=${automationId}`);
    expect(
      within(table)
        .getByRole('link', { name: 'Enrollment history of New lead follow-up' })
        .getAttribute('href'),
    ).toBe(`/b/harbor/automations?automation=${automationId}&view=runs`);
    expect(screen.getByRole('heading', { level: 1, name: 'Workflows list' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Create workflow' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Create folder' })).toBeDefined();
    // The top level alone is asked for: what is in a folder is listed in the folder.
    expect(called('listAutomations').map((call) => call.input)).toEqual([
      { query: { folder: 'root' } },
    ]);
  });

  it('opens a workflow without reloading the page', async () => {
    serve([live]);
    const { user, went } = open();
    await user.click(await screen.findByRole('link', { name: 'New lead follow-up' }));
    expect(went).toEqual([{ automation: automationId }]);
  });

  it('says so when there are none, and creates one as GoHighLevel does: named, then opened', async () => {
    serve([], [], (operation) =>
      operation === 'createAutomation'
        ? {
            automation: automationOf({ name: 'New Workflow : 1' }),
            validation: { valid: false, errors: [], warnings: [] },
          }
        : {},
    );
    const { user, went } = open();
    expect(await screen.findByRole('heading', { name: 'No workflows yet' })).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Create workflow' }));
    await waitFor(() => {
      expect(went).toEqual([{ automation: automationId }]);
    });
    expect(called('createAutomation')).toEqual([
      {
        operation: 'createAutomation',
        input: {
          body: {
            document: {
              name: expect.stringMatching(/^New Workflow : \d+$/) as string,
              triggers: [],
              steps: {},
            },
          },
        },
      },
    ]);
    expect(called('moveAutomation')).toEqual([]);
  });

  it("offers no way to create or change anything to someone who can't", async () => {
    serve([live], [leads], undefined, {});
    open();
    await screen.findByRole('link', { name: 'New lead follow-up' });
    expect(screen.queryByRole('button', { name: 'Create workflow' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create folder' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    cleanup();

    serve([], [], undefined, {});
    open();
    expect(await screen.findByRole('heading', { name: 'No workflows yet' })).toBeDefined();
    expect(screen.getByText('Workflows set up for this business are listed here.')).toBeDefined();
  });

  it("says when the list can't be loaded, never that it is empty, and tries again", async () => {
    let failing = true;
    server.answer = (operation) => {
      if (operation === 'listAutomationFolders') return { items: [], canManage: true };
      if (failing)
        throw new ApiError({ type: 'about:blank', title: 'Service Unavailable', status: 503 });
      return { items: [summaryOf(live)], nextCursor: null, canManage: true };
    };
    const { user } = open();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /We couldn't load the workflows\./,
    );
    expect(screen.queryByRole('heading', { name: 'No workflows yet' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'New lead follow-up' })).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("says when the folders can't be loaded, and shows no list without them", async () => {
    server.answer = (operation) => {
      if (operation === 'listAutomationFolders')
        throw new ApiError({ type: 'about:blank', title: 'Service Unavailable', status: 503 });
      return { items: [summaryOf(live)], nextCursor: null, canManage: true };
    };
    open();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /We couldn't load the workflows\./,
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'No workflows yet' })).toBeNull();
  });

  it('loads the next page when asked', async () => {
    server.answer = (operation, input) =>
      operation === 'listAutomationFolders'
        ? { items: [], canManage: true }
        : JSON.stringify(input).includes(live.id)
          ? { items: [summaryOf(paused)], nextCursor: null, canManage: true }
          : { items: [summaryOf(live)], nextCursor: live.id, canManage: true };
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: 'Win back' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(called('listAutomations').map((call) => call.input)).toEqual([
      { query: { folder: 'root' } },
      { query: { folder: 'root', after: live.id } },
    ]);
  });

  it('narrows by status and by name, in every folder, and says when nothing matches', async () => {
    server.answer = (operation, input) => {
      if (operation === 'listAutomationFolders') return { items: [leads], canManage: true };
      const narrowed = JSON.stringify(input).includes('"q"');
      return { items: narrowed ? [] : [summaryOf(live)], nextCursor: null, canManage: true };
    };
    const { user } = open();
    expect(await screen.findByRole('link', { name: 'Open the folder Leads' })).toBeDefined();
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Published' }));
    await waitFor(() => {
      expect(called('listAutomations').at(-1)?.input).toEqual({ query: { status: 'active' } });
    });
    // A folder has no status: it is not among what a status finds.
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Open the folder Leads' })).toBeNull();
    });
    await user.type(screen.getByRole('searchbox', { name: 'Search workflows' }), 'quote');
    expect(await screen.findByText('No workflows match.')).toBeDefined();
    expect(called('listAutomations').at(-1)?.input).toEqual({
      query: { status: 'active', q: 'quote' },
    });
  });
});

describe('creating a workflow', () => {
  const refusals: readonly (readonly [string, () => unknown, string])[] = [
    [
      'without permission',
      () => new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 }),
      "You don't have permission to create workflows.",
    ],
    [
      'with a name the server refuses',
      () =>
        new ApiError({
          type: 'about:blank',
          title: 'Unprocessable Content',
          status: 422,
          errors: [
            {
              path: '/document/name',
              code: 'invalid_name',
              message: 'Name the automation, in 1 to 120 characters.',
            },
          ],
        }),
      'Name the automation, in 1 to 120 characters.',
    ],
    [
      'with only a reason given',
      () =>
        new ApiError({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'This business has as many automations as it may have.',
        }),
      'This business has as many automations as it may have.',
    ],
    [
      'with no reason given',
      () => new ApiError({ type: 'about:blank', title: 'Server Error', status: 500 }),
      "We couldn't create the workflow. Check your connection and try again.",
    ],
    [
      'while offline',
      () => new TypeError('Failed to fetch'),
      "We couldn't create the workflow. Check your connection and try again.",
    ],
  ];

  it.each(refusals)(
    'says why it was not created, %s, and stays on the list',
    async (_, failure, message) => {
      serve([live], [], (operation) => {
        if (operation === 'createAutomation') throw failure();
        return {};
      });
      const { user, went } = open();
      await user.click(await screen.findByRole('button', { name: 'Create workflow' }));
      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toBe(message);
      });
      expect(went).toEqual([]);
      expect(screen.getByRole('link', { name: 'New lead follow-up' })).toBeDefined();
    },
  );
});

describe('folders', () => {
  it('lists the folders of the top level first, each opening its own list', async () => {
    serve([live], [leads, weddings]);
    const { user, went } = open();
    const table = await screen.findByRole('table', { name: 'Workflows' });
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((header) => header.textContent),
    ).toEqual(['Leads', 'New lead follow-up']);
    const crumbs = screen.getByRole('navigation', { name: 'Folders' });
    expect(within(crumbs).getByText('Home').getAttribute('aria-current')).toBe('page');
    await user.click(within(table).getByRole('link', { name: 'Open the folder Leads' }));
    expect(went).toEqual([{ folder: folderIds.leads }]);
  });

  it('shows what is in the folder the address names, with the way back up', async () => {
    serve([draft], [leads, weddings]);
    const { user, went } = open({ folder: folderIds.weddings });
    await screen.findByRole('link', { name: 'Birthday note' });
    expect(called('listAutomations').map((call) => call.input)).toEqual([
      { query: { folder: folderIds.weddings } },
    ]);
    const crumbs = screen.getByRole('navigation', { name: 'Folders' });
    expect(within(crumbs).getByText('Weddings').getAttribute('aria-current')).toBe('page');
    expect(within(crumbs).getByRole('link', { name: 'Home' }).getAttribute('href')).toBe(
      '/b/harbor/automations',
    );
    await user.click(within(crumbs).getByRole('link', { name: 'Leads' }));
    expect(went).toEqual([{ folder: folderIds.leads }]);
  });

  it('says so in an empty folder, and treats a folder that is gone as the top level', async () => {
    serve([], [leads]);
    open({ folder: folderIds.leads });
    expect(await screen.findByText('This folder is empty.')).toBeDefined();
    cleanup();
    server.calls.length = 0;

    serve([live], [leads]);
    open({ folder: folderIds.weddings });
    await screen.findByRole('link', { name: 'New lead follow-up' });
    expect(called('listAutomations').map((call) => call.input)).toEqual([
      { query: { folder: 'root' } },
    ]);
  });

  it('creates a folder in the folder that is open, and a workflow too', async () => {
    serve([], [leads], (operation) =>
      operation === 'createAutomation'
        ? { automation: automationOf(), validation: { valid: false, errors: [], warnings: [] } }
        : {},
    );
    const { user, went } = open({ folder: folderIds.leads });
    await user.click(await screen.findByRole('button', { name: 'Create folder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create folder' });
    await user.click(within(dialog).getByRole('button', { name: 'Create folder' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Give it a name.');
    await user.type(within(dialog).getByRole('textbox', { name: 'Folder name' }), ' Weddings ');
    await user.click(within(dialog).getByRole('button', { name: 'Create folder' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(called('createAutomationFolder').map((call) => call.input)).toEqual([
      { body: { name: 'Weddings', parentId: folderIds.leads } },
    ]);
    expect(screen.getByRole('status').textContent).toBe('Folder created.');

    await user.click(screen.getByRole('button', { name: 'Create workflow' }));
    await waitFor(() => {
      expect(went).toEqual([{ automation: automationId }]);
    });
    expect(called('moveAutomation').map((call) => call.input)).toEqual([
      { params: { id: automationId }, body: { folderId: folderIds.leads } },
    ]);
  });

  it('renames a folder from the revision it was read at, and says why it could not', async () => {
    let refuse = true;
    serve([], [leads], (operation) => {
      if (operation === 'updateAutomationFolder' && refuse)
        throw new ApiError({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'Another folder here has that name.',
        });
      return {};
    });
    const { user } = open();
    await act(user, 'Actions for the folder Leads', 'Rename');
    const dialog = await screen.findByRole('dialog', { name: 'Rename folder' });
    const name = within(dialog).getByRole('textbox', { name: 'Folder name' });
    expect(name).toHaveProperty('value', 'Leads');
    await user.clear(name);
    await user.type(name, 'Prospects');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Another folder here has that name.',
    );
    refuse = false;
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(called('updateAutomationFolder').at(-1)?.input).toEqual({
      params: { id: folderIds.leads },
      body: { revision: 1, name: 'Prospects' },
    });
  });

  it('deletes a folder after asking, saying what happens to what is in it', async () => {
    serve([], [leads]);
    const { user } = open();
    await act(user, 'Actions for the folder Leads', 'Delete folder');
    const dialog = await screen.findByRole('dialog', { name: 'Delete this folder?' });
    expect(dialog.textContent).toContain(
      'Leads: the workflows and folders in it move up one level. None is deleted.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Delete folder' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(called('deleteAutomationFolder').map((call) => call.input)).toEqual([
      { params: { id: folderIds.leads } },
    ]);
    expect(screen.getByRole('status').textContent).toBe('Folder deleted.');
  });
});

describe("a workflow's row", () => {
  it('opens its numbers under the row: every version, and the live one', async () => {
    let failing = true;
    serve([live], [], (operation) => {
      if (operation !== 'getAutomationStats') return {};
      if (failing) throw new ApiError({ type: 'about:blank', title: 'Unavailable', status: 503 });
      return followUpStats;
    });
    const { user } = open();
    const toggle = await screen.findByRole('button', { name: 'Stats for New lead follow-up' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(called('getAutomationStats')).toEqual([]);
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /The numbers couldn't be loaded\./,
    );
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    const all = await screen.findByRole('group', { name: 'Every version' });
    expect(all.textContent).toBe(
      'Every versionEnrolled12Active3Completed8Stopped early0Failed1Cancelled0',
    );
    expect(screen.getByRole('group', { name: 'Live version 2' }).textContent).toBe(
      'Live version 2Enrolled5Active2Completed3Stopped early0Failed0Cancelled0',
    );
    await user.click(toggle);
    expect(screen.queryByRole('group', { name: 'Every version' })).toBeNull();
  });

  it('shows only the numbers of every version for a workflow never published', async () => {
    serve([draft], [], () => ({
      ...followUpStats,
      liveVersion: null,
      runs: { ...followUpStats.runs, live: null },
    }));
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Stats for Birthday note' }));
    expect(await screen.findByRole('group', { name: 'Every version' })).toBeDefined();
    expect(screen.queryByRole('group', { name: /^Live version/ })).toBeNull();
  });

  it('renames a workflow in its draft, from the draft version the list read', async () => {
    serve([live]);
    const { user } = open();
    await act(user, 'Actions for New lead follow-up', 'Rename');
    const dialog = await screen.findByRole('dialog', { name: 'Rename workflow' });
    const name = within(dialog).getByRole('textbox', { name: 'Workflow name' });
    await user.clear(name);
    await user.type(name, 'Quote follow-up');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(called('patchAutomationDraft').map((call) => call.input)).toEqual([
      {
        params: { id: automationId },
        body: {
          baseDraftVersion: 3,
          patch: [{ op: 'replace', path: '/name', value: 'Quote follow-up' }],
        },
      },
    ]);
    expect(screen.getByRole('status').textContent).toBe('Workflow renamed.');
  });

  it('moves a workflow to a folder chosen by its whole path, or back to the top level', async () => {
    let refuse = true;
    serve([live], [leads, weddings], (operation) => {
      if (operation === 'moveAutomation' && refuse)
        throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
      return {};
    });
    const { user } = open();
    await act(user, 'Actions for New lead follow-up', 'Move to folder');
    const dialog = await screen.findByRole('dialog', { name: 'Move to folder' });
    await user.click(within(dialog).getByRole('combobox', { name: 'Folder' }));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Home',
      'Leads',
      'Leads / Weddings',
    ]);
    await user.click(screen.getByRole('option', { name: 'Leads / Weddings' }));
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      "You don't have permission to move workflows.",
    );
    refuse = false;
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(called('moveAutomation').at(-1)?.input).toEqual({
      params: { id: automationId },
      body: { folderId: folderIds.weddings },
    });
    cleanup();
    server.calls.length = 0;

    serve([automationOf({ folderId: folderIds.leads })], [leads]);
    const again = open({ folder: folderIds.leads });
    await act(again.user, 'Actions for New lead follow-up', 'Move to folder');
    const second = await screen.findByRole('dialog', { name: 'Move to folder' });
    await again.user.click(within(second).getByRole('combobox', { name: 'Folder' }));
    await again.user.click(await screen.findByRole('option', { name: 'Home' }));
    await again.user.click(within(second).getByRole('button', { name: 'Move' }));
    await waitFor(() => {
      expect(called('moveAutomation').map((call) => call.input)).toEqual([
        { params: { id: automationId }, body: { folderId: null } },
      ]);
    });
  });

  it('duplicates a workflow as a new draft with the same steps, in the same folder', async () => {
    const copy = automationOf({
      id: 'aut_01k8e2wzr0e008000000000019',
      name: 'New lead follow-up (copy)',
    });
    const filed = automationOf({ ...live, folderId: folderIds.leads });
    let refuse = true;
    serve([filed], [leads], (operation) => {
      if (operation === 'getAutomation') {
        if (refuse) throw new TypeError('Failed to fetch');
        return filed;
      }
      return operation === 'createAutomation'
        ? { automation: copy, validation: { valid: true, errors: [], warnings: [] } }
        : {};
    });
    const { user, went } = open({ folder: folderIds.leads });
    await act(user, 'Actions for New lead follow-up', 'Duplicate');
    expect((await screen.findByRole('alert')).textContent).toBe(
      "We couldn't duplicate the workflow. Try again.",
    );
    refuse = false;
    await act(user, 'Actions for New lead follow-up', 'Duplicate');
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        'Created New lead follow-up (copy) as a draft.',
      );
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(called('createAutomation').map((call) => call.input)).toEqual([
      { body: { document: { ...followUp, name: 'New lead follow-up (copy)' } } },
    ]);
    expect(called('moveAutomation').map((call) => call.input)).toEqual([
      { params: { id: copy.id }, body: { folderId: folderIds.leads } },
    ]);
    // The copy is listed; nobody is taken to it.
    expect(went).toEqual([]);
  });

  it('exports a workflow as a file with its references by name, and says why when it cannot', async () => {
    const made: Blob[] = [];
    const clicked: string[] = [];
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      made.push(blob as Blob);
      return 'blob:export';
    };
    URL.revokeObjectURL = () => undefined;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    let warnings: unknown[] = [];
    let refuse = true;
    serve([live], [], (operation) => {
      if (operation !== 'exportAutomation') return {};
      if (refuse) throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
      return {
        format: 'crm.automation',
        formatVersion: 1,
        exportedAt: '2026-10-12T09:00:00.000Z',
        document: followUp,
        warnings,
      };
    });
    const { user } = open();
    await act(user, 'Actions for New lead follow-up', 'Export');
    expect((await screen.findByRole('alert')).textContent).toBe(
      "You don't have permission to export workflows.",
    );
    refuse = false;
    await act(user, 'Actions for New lead follow-up', 'Export');
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        'Exported “New lead follow-up”. The file is in your downloads.',
      );
    });
    expect(clicked).toEqual(['new-lead-follow-up.workflow.json']);
    expect(JSON.parse((await made[0]?.text()) ?? '')).toMatchObject({
      format: 'crm.automation',
      document: { name: 'New lead follow-up' },
    });
    expect(called('exportAutomation').at(-1)?.input).toEqual({
      params: { id: live.id },
      query: { source: 'draft' },
    });
    warnings = [{ path: '/steps/a/config/template', code: 'unnamed_reference', message: 'x' }];
    await act(user, 'Actions for New lead follow-up', 'Export');
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        'Exported “New lead follow-up”. 1 of its references could not be named, and only work in this business.',
      );
    });
    click.mockRestore();
  });

  it('imports a workflow file: checks it against this business, shows what is wrong, then creates it', async () => {
    const imported = automationOf({ id: 'aut_01k8e2wzr0e008000000000019', name: 'From a file' });
    let refuse = true;
    serve([live], [], (operation) => {
      if (operation === 'validateAutomation')
        return {
          valid: false,
          errors: [
            {
              path: '/steps/send_guide/config/template',
              code: 'unknown_reference',
              message: 'This business has no email template named “Pricing guide”.',
            },
          ],
          warnings: [],
        };
      if (operation === 'importAutomation') {
        if (refuse)
          throw new ApiError({
            type: 'about:blank',
            title: 'Unprocessable',
            status: 422,
            detail: 'The document is too large.',
          });
        return { automation: imported, validation: { valid: false, errors: [], warnings: [] } };
      }
      return {};
    });
    const { user, went } = open();
    await user.click(await screen.findByRole('button', { name: 'Import workflow' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import workflow' });
    const create = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Create the workflow',
    });
    expect(create.disabled).toBe(true);
    const file = (text: string): File =>
      new File([text], 'lead.workflow.json', { type: 'application/json' });
    const input = within(dialog).getByLabelText('Workflow file');
    // Not JSON, and JSON that is not an export: neither is sent anywhere.
    await user.upload(input, file('not json'));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      "That file isn't a workflow exported from here. Choose a file made with Export.",
    );
    await user.upload(input, file(JSON.stringify({ name: 'Just a document' })));
    await within(dialog).findByRole('alert');
    expect(called('validateAutomation')).toEqual([]);
    expect(create.disabled).toBe(true);

    const exported = {
      format: 'crm.automation',
      formatVersion: 1,
      document: { ...followUp, name: 'From a file' },
    };
    await user.upload(input, file(JSON.stringify(exported)));
    const found = await within(dialog).findByRole('region', { name: 'What the check found' });
    expect(found.textContent).toContain('“From a file” can be imported as a draft');
    expect(
      within(found).getByText('This business has no email template named “Pricing guide”.'),
    ).toBeDefined();
    expect(called('validateAutomation').map((call) => call.input)).toEqual([
      { body: { document: exported.document } },
    ]);
    // Nothing is created until asked.
    expect(called('importAutomation')).toEqual([]);
    await user.click(create);
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'The document is too large.',
    );
    refuse = false;
    await user.click(create);
    await waitFor(() => {
      expect(went).toEqual([{ automation: imported.id }]);
    });
    expect(called('importAutomation').at(-1)?.input).toEqual({ body: exported });
  });

  it('says a file is ready when the check finds nothing, and when the check itself fails', async () => {
    let fail = true;
    serve([live], [], (operation) => {
      if (operation !== 'validateAutomation') return {};
      if (fail) throw new Error('offline');
      return { valid: true, errors: [], warnings: [] };
    });
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Import workflow' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import workflow' });
    const text = JSON.stringify({
      format: 'crm.automation',
      formatVersion: 1,
      document: { steps: {} },
    });
    const input = within(dialog).getByLabelText('Workflow file');
    await user.upload(input, new File([text], 'a.json', { type: 'application/json' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      "We couldn't reach the server. Check your connection and try again.",
    );
    fail = false;
    await user.upload(input, new File([text], 'b.json', { type: 'application/json' }));
    const found = await within(dialog).findByRole('region', { name: 'What the check found' });
    expect(found.textContent).toBe('“Untitled workflow” is ready to import. Nothing needs fixing.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Import workflow' })).toBeNull();
    });
  });

  it('deletes a workflow after saying what that does, and says why when it is refused', async () => {
    let refuse = true;
    serve([live], [], (operation) => {
      if (operation === 'deleteAutomation' && refuse)
        throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
      return {};
    });
    const { user } = open();
    await act(user, 'Actions for New lead follow-up', 'Delete workflow');
    const dialog = await screen.findByRole('dialog', { name: 'Delete this workflow?' });
    expect(dialog.textContent).toContain(
      'New lead follow-up: nothing new starts it, and every contact in it now is taken out. It stays under Deleted for 30 days, where it can be restored.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Delete workflow' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      "You don't have permission to delete this.",
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    refuse = false;
    await act(user, 'Actions for New lead follow-up', 'Delete workflow');
    const again = await screen.findByRole('dialog', { name: 'Delete this workflow?' });
    expect(within(again).queryByRole('alert')).toBeNull();
    await user.click(within(again).getByRole('button', { name: 'Delete workflow' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(called('deleteAutomation').at(-1)?.input).toEqual({ params: { id: automationId } });
    expect(screen.getByRole('status').textContent).toBe('Workflow deleted.');
  });
});

describe('the Deleted list', () => {
  const gone = automationOf({
    status: 'archived',
    deletedAt: '2026-10-09T10:00:00.000Z',
    purgeAt: '2026-11-08T10:00:00.000Z',
  });

  it('lists what was deleted with the day it goes for good, and restores it', async () => {
    let refuse = true;
    serve([gone], [leads], (operation) => {
      if (operation !== 'restoreAutomation') return {};
      if (refuse) throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
      return automationOf({ status: 'paused' });
    });
    const { user } = open({ list: 'deleted' });
    const table = await screen.findByRole('table', { name: 'Deleted workflows' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Name', 'Deleted on', 'Removed for good on', 'Actions']);
    expect(called('listAutomations').map((call) => call.input)).toEqual([
      { query: { status: 'archived' } },
    ]);
    const cells = within(row('New lead follow-up')).getAllByRole('cell');
    expect(cells[0]?.textContent).toMatch(/Oct 9, 2026/);
    expect(cells[1]?.textContent).toMatch(/^Nov [78], 2026$/);
    // Nothing deleted is opened, filed or counted here.
    expect(within(table).queryByRole('link')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Folders' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create folder' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Deleted' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'All workflows' }).getAttribute('href')).toBe(
      '/b/harbor/automations',
    );

    await user.click(within(table).getByRole('button', { name: 'Restore New lead follow-up' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      "You don't have permission to restore workflows.",
    );
    refuse = false;
    await user.click(within(table).getByRole('button', { name: 'Restore New lead follow-up' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        'Restored New lead follow-up. It is paused: nothing new starts until it is published again.',
      );
    });
    expect(called('restoreAutomation').at(-1)?.input).toEqual({ params: { id: automationId } });
  });

  it('says a workflow never published comes back as a draft, and when nothing is deleted', async () => {
    serve([gone], [], (operation) =>
      operation === 'restoreAutomation' ? automationOf({ status: 'draft' }) : {},
    );
    const { user } = open({ list: 'deleted' });
    await user.click(await screen.findByRole('button', { name: 'Restore New lead follow-up' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        'Restored New lead follow-up as a draft.',
      );
    });
    cleanup();

    serve([], [], undefined, {});
    open({ list: 'deleted' });
    expect(
      await screen.findByText('No workflow has been deleted in the last 30 days.'),
    ).toBeDefined();
    cleanup();

    serve([gone], [], undefined, {});
    open({ list: 'deleted' });
    await screen.findByRole('table', { name: 'Deleted workflows' });
    expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull();
  });
});

describe('the Overview', () => {
  function overview(): void {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nProvider i18n={i18n}>
          <AutomationOverview />
        </I18nProvider>
      </QueryClientProvider>,
    );
  }

  it('counts every workflow, page after page, before it shows a number', async () => {
    server.answer = (_operation, input) =>
      JSON.stringify(input).includes(live.id)
        ? { items: [paused, draft].map(summaryOf), nextCursor: null, canManage: true }
        : { items: [summaryOf(live)], nextCursor: live.id, canManage: true };
    overview();
    expect(screen.getByRole('status').textContent).toBe('Loading the numbers…');
    await waitFor(() => {
      expect(screen.getAllByRole('term').map((term) => term.textContent)).toEqual([
        'Total workflows',
        'Published workflows',
        'Total enrollments',
        'Active enrollments',
      ]);
    });
    expect(
      screen
        .getAllByRole('definition')
        .filter((_, index) => index % 2 === 0)
        .map((value) => value.textContent),
    ).toEqual(['3', '1', '1,204', '37']);
    expect(called('listAutomations').map((call) => call.input)).toEqual([
      { query: {} },
      { query: { after: live.id } },
    ]);
  });

  it("says when the workflows can't be read, with no numbers, and tries again", async () => {
    let failing = true;
    server.answer = () => {
      if (failing) throw new ApiError({ type: 'about:blank', title: 'Unavailable', status: 503 });
      return { items: [], nextCursor: null, canManage: true };
    };
    overview();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /We couldn't load the workflows\./,
    );
    expect(screen.queryByRole('term')).toBeNull();
    failing = false;
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(screen.getAllByRole('definition')[0]?.textContent).toBe('0');
    });
  });
});

describe('automationsSearch', () => {
  it('keeps an automation id and a view it knows, and drops everything else', () => {
    expect(automationsSearch({ automation: automationId, view: 'json', other: 1 })).toEqual({
      automation: automationId,
      view: 'json',
    });
    // The canvas is the view an address without one opens, so it is never written.
    expect(automationsSearch({ automation: automationId, view: 'canvas' })).toEqual({
      automation: automationId,
    });
    for (const view of ['steps', 'settings', 'runs', 'logs'] as const)
      expect(automationsSearch({ automation: automationId, view })).toEqual({
        automation: automationId,
        view,
      });
    expect(
      automationsSearch({ automation: 'con_01k8e2wzr0e008000000000010', view: 'steps' }),
    ).toEqual({ view: 'steps' });
    expect(automationsSearch({ automation: 7, view: 'canvas' })).toEqual({});
    expect(automationsSearch({ automation: automationId, view: 'timeline' })).toEqual({
      automation: automationId,
    });
  });

  it('keeps a run only inside the runs of an automation', () => {
    const run = 'arun_01k8e2wzr0e008000000000021';
    expect(automationsSearch({ automation: automationId, view: 'runs', run })).toEqual({
      automation: automationId,
      view: 'runs',
      run,
    });
    expect(automationsSearch({ automation: automationId, view: 'json', run })).toEqual({
      automation: automationId,
      view: 'json',
    });
    expect(automationsSearch({ view: 'runs', run })).toEqual({ view: 'runs' });
    expect(
      automationsSearch({ automation: automationId, view: 'runs', run: automationId }),
    ).toEqual({
      automation: automationId,
      view: 'runs',
    });
  });

  it("keeps the list's folder or its Deleted tab, only while no workflow is open", () => {
    expect(automationsSearch({ folder: folderIds.leads })).toEqual({ folder: folderIds.leads });
    expect(automationsSearch({ folder: 'con_01k8e2wzr0e008000000000010' })).toEqual({});
    expect(automationsSearch({ list: 'deleted', folder: folderIds.leads })).toEqual({
      list: 'deleted',
    });
    expect(automationsSearch({ list: 'everything' })).toEqual({});
    expect(
      automationsSearch({ automation: automationId, folder: folderIds.leads, list: 'deleted' }),
    ).toEqual({ automation: automationId });
  });
});
