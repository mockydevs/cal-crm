// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type {
  BulkMessageTemplatesResult,
  MessageTemplate,
  MessageTemplateFolder,
  MessageTemplateList,
  MessageTemplateSummary,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { TemplatesSearch } from './templates-search';
import TemplatesPage from './templates/page';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
vi.mock('./shell/page', () => ({
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
interface LeaveGuard {
  shouldBlockFn: () => boolean;
  enableBeforeUnload: () => boolean;
}
const router = vi.hoisted((): { guard: LeaveGuard | undefined } => ({ guard: undefined }));
vi.mock('@tanstack/react-router', () => ({
  useBlocker: (guard: LeaveGuard) => {
    router.guard = guard;
    return { status: 'idle' };
  },
  Link: ({
    children,
    to,
    search,
    params: _params,
    ...rest
  }: {
    children: ReactNode;
    to: string;
    search?: Record<string, string>;
    params?: unknown;
  }) => (
    <a
      href={`${to}${search === undefined ? '' : `?${new URLSearchParams(search).toString()}`}`}
      {...rest}
    >
      {children}
    </a>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
  router.guard = undefined;
  address.now = {};
});
afterEach(cleanup);

const id = 'tmpl_01h455vb4pex5vsknk084sn02q';
const otherId = 'tmpl_01h455vb4pex5vsknk084sn03q';
const folderId = 'tfld_01h455vb4pex5vsknk084sn02q';
const guide: MessageTemplate = {
  id,
  name: 'Pricing guide',
  subject: 'Your guide, {{contact.firstName}}',
  body: 'Hi {{contact.firstName}},\nWe cover {{contact.custom.services}}.',
  content: {
    format: 'text',
    text: 'Hi {{contact.firstName}},\nWe cover {{contact.custom.services}}.',
  },
  format: 'text',
  preheader: null,
  folder: null,
  preview: 'Hi {{contact.firstName}}, We cover {{contact.custom.services}}.',
  mergeFields: ['contact.firstName', 'contact.custom.services'],
  unfillableFields: [],
  createdAt: '2026-10-09T09:00:00.000Z',
  updatedAt: '2026-10-09T09:30:00.000Z',
  archivedAt: null,
  revision: 'a'.repeat(64),
  canManage: true,
  usedBy: [],
};
const offer: MessageTemplate = {
  ...guide,
  id: otherId,
  name: 'Spring offer',
  subject: 'Spring is here',
  format: 'html',
  content: { format: 'html', html: '<p>Spring</p>', text: 'Spring' },
  preview: 'Spring',
  revision: 'd'.repeat(64),
};
const summaryOf = (template: MessageTemplate): MessageTemplateSummary => ({
  id: template.id,
  name: template.name,
  subject: template.subject,
  createdAt: template.createdAt,
  updatedAt: template.updatedAt,
  archivedAt: template.archivedAt,
  revision: template.revision,
  format: template.format,
  preheader: template.preheader,
  folder: template.folder,
  preview: template.preview,
  ...(template.deletedAt === undefined ? {} : { deletedAt: template.deletedAt }),
});
const listOf = (
  templates: readonly MessageTemplate[],
  patch: Partial<MessageTemplateList> = {},
): MessageTemplateList => ({
  canManage: true,
  items: templates.map(summaryOf),
  nextCursor: null,
  total: templates.length,
  ...patch,
});
const guides: MessageTemplateFolder = {
  id: folderId,
  parentId: null,
  name: 'Guides',
  revision: 7,
  templateCount: 1,
  createdAt: '2026-10-11T09:00:00Z',
  updatedAt: '2026-10-11T09:00:00Z',
};
const fields = {
  canManage: true,
  objects: [{ key: 'contact', label: 'Contacts' }],
  items: [
    { objectKey: 'contact', key: 'services', label: 'Services', archived: false },
    { objectKey: 'deal', key: 'budget', label: 'Budget', archived: false },
  ],
};
const problem = (status: number, detail: string, errors?: { path: string; message: string }[]) =>
  new ApiError({
    type: 'about:blank',
    title: 'Refused',
    status,
    detail,
    ...(errors === undefined ? {} : { errors: errors.map((each) => ({ ...each, code: 'taken' })) }),
  });

/** A server holding these templates, answering as the API does. */
function serving(templates: MessageTemplate[], more: Partial<Server> = {}): void {
  server.answer = (operation, input) => {
    const custom = more.answer?.(operation, input);
    if (custom !== undefined) return custom;
    if (operation === 'listMessageTemplateFolders')
      return {
        canManage: true,
        items: [guides],
        counts: { all: templates.length, unfiled: 0, archived: 2, deleted: 1 },
      };
    if (operation === 'getFields') return fields;
    if (operation === 'listMessageTemplates') return listOf(templates);
    if (operation === 'getMessageTemplate') {
      const { params } = input as { params: { id: string } };
      return templates.find((each) => each.id === params.id) ?? templates[0];
    }
    throw new Error(`Unexpected ${operation}`);
  };
}

/** The page's address, as the route keeps it. */
const address = vi.hoisted((): { now: TemplatesSearch } => ({ now: {} }));
function Harness(): ReactElement {
  const [search, setSearch] = useState<TemplatesSearch>(address.now);
  return (
    <TemplatesPage
      search={search}
      onSearch={(change) => {
        setSearch((now) => {
          address.now = change(now);
          return address.now;
        });
      }}
    />
  );
}

function open(start: TemplatesSearch = {}): ReturnType<typeof userEvent.setup> {
  address.now = start;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <Harness />
      </I18nProvider>
    </QueryClientProvider>,
  );
  // Keys follow one another with no timer between them (user-event's `delay`). Every key
  // is still its own events and its own render; what goes is a wait per character, which
  // on a busy machine took a long test past its five seconds.
  return userEvent.setup({ delay: null });
}
const inputsOf = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);
const lastQuery = (): unknown =>
  (inputsOf('listMessageTemplates').at(-1) as { query: unknown } | undefined)?.query;
const field = (name: string): HTMLInputElement | HTMLTextAreaElement => screen.getByLabelText(name);
async function openGuide(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Open Pricing guide' }));
  await screen.findByLabelText('Name');
}
/** New template → Plain text, from the page's one New button. */
async function newPlain(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'New template' }));
  await user.click(await screen.findByRole('menuitem', { name: /^Plain text/ }));
  // The form is fetched when first opened.
  await screen.findByLabelText('Name');
}
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  option: string,
): Promise<void> {
  const list = screen.getByRole('combobox', { name });
  const value = within(list)
    .getAllByRole('option')
    .find((each) => each.textContent === option)
    ?.getAttribute('value');
  await user.selectOptions(list, value ?? option);
}
async function menu(
  user: ReturnType<typeof userEvent.setup>,
  of: string,
  action: string,
): Promise<void> {
  await user.click(await screen.findByRole('button', { name: `Actions for ${of}` }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
}
const panel = (): HTMLElement => screen.getByRole('navigation', { name: 'Template folders' });

it('lists templates compactly, with the library at the left and a page of them at a time', async () => {
  serving([guide, offer], {
    answer: (operation) =>
      operation === 'listMessageTemplates'
        ? {
            ...listOf([guide, offer]),
            items: [
              { ...summaryOf(guide), workflowUses: 0 },
              { ...summaryOf(offer), workflowUses: 3 },
            ],
          }
        : undefined,
  });
  open();
  expect(screen.getByRole('heading', { level: 1, name: 'Email templates' })).toBeDefined();
  const table = await screen.findByRole('table');
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((each) => each.textContent),
  ).toEqual(['', 'Name', 'Type', 'Workflows', 'Folder', 'Updated', 'Actions']);
  expect(within(table).getByText('Your guide, {{contact.firstName}}')).toBeDefined();
  expect(within(table).getByText('Plain text')).toBeDefined();
  expect(within(table).getByText('Designed')).toBeDefined();
  expect(within(table).getByText('Not used')).toBeDefined();
  expect(
    within(table).getByRole('button', { name: 'Used in 3 workflows: Spring offer' }),
  ).toBeDefined();
  expect(lastQuery()).toEqual({ archived: 'exclude', deleted: 'exclude', sort: 'name', limit: 50 });
  // The library: everything, what is in no folder, each folder, Archived and Trash, with
  // how many each holds.
  await within(panel()).findByRole('button', { name: /^Guides/ });
  expect(
    within(panel())
      .getAllByRole('button')
      .filter((each) => each.hasAttribute('aria-current'))
      .map((each) => each.textContent),
  ).toEqual(['All templates, 2', 'No folder, 0', 'Guides, 1', 'Archived, 2', 'Trash, 1']);
  expect(
    within(panel())
      .getByRole('button', { name: /^All templates/ })
      .getAttribute('aria-current'),
  ).toBe('true');
  expect(screen.getByText('1 - 2 of 2')).toBeDefined();
  // What the page is for is behind the mark beside its title.
  expect(screen.getByRole('button', { name: 'About templates' })).toBeDefined();
  // The list said the numbers: no template is asked for its workflows one by one.
  expect(inputsOf('listTemplateWorkflowActions')).toEqual([]);
});

it('lists the workflows that use a template when its number is pressed', async () => {
  serving([offer], {
    answer: (operation) => {
      if (operation === 'listMessageTemplates')
        return { ...listOf([offer]), items: [{ ...summaryOf(offer), workflowUses: 1 }] };
      if (operation === 'listTemplateWorkflowActions')
        return {
          items: [
            { automation: { id: 'aut_01h455vb4pex5vsknk084sn02q', name: 'Welcome series' } },
            { automation: { id: 'aut_01h455vb4pex5vsknk084sn02q', name: 'Welcome series' } },
          ],
          nextCursor: null,
        };
      return undefined;
    },
  });
  const user = open();
  await user.click(await screen.findByRole('button', { name: 'Used in 1 workflow: Spring offer' }));
  const link = await screen.findByRole('link', { name: 'Welcome series' });
  expect(link.getAttribute('href')).toBe(
    '/b/$slug/automations?automation=aut_01h455vb4pex5vsknk084sn02q',
  );
  expect(screen.getAllByRole('link', { name: 'Welcome series' })).toHaveLength(1);
});

it('goes to a folder, Archived or the Trash from the panel, keeping the search and order', async () => {
  serving([guide]);
  const user = open({ q: 'guide', sort: 'updated' });
  await user.click(await within(panel()).findByRole('button', { name: /^Guides/ }));
  expect(address.now).toEqual({ folder: folderId, q: 'guide', sort: 'updated' });
  await waitFor(() => {
    expect(lastQuery()).toEqual({
      archived: 'exclude',
      deleted: 'exclude',
      folder: folderId,
      q: 'guide',
      sort: 'updated',
      limit: 50,
    });
  });
  await user.click(within(panel()).getByRole('button', { name: /^Archived/ }));
  await waitFor(() => {
    expect(lastQuery()).toMatchObject({ archived: 'only', deleted: 'exclude' });
  });
  await user.click(within(panel()).getByRole('button', { name: /^Trash/ }));
  await waitFor(() => {
    expect(lastQuery()).toMatchObject({ archived: 'include', deleted: 'only' });
  });
  expect(address.now).toEqual({ show: 'trash', q: 'guide', sort: 'updated' });
});

it('shows the templates in no folder from the panel, with how many there are', async () => {
  serving([guide], {
    answer: (operation) => {
      if (operation === 'listMessageTemplateFolders')
        return {
          canManage: true,
          items: [guides],
          counts: { all: 3, unfiled: 2, archived: 0, deleted: 0 },
        };
      if (operation === 'createMessageTemplate')
        return { ...guide, name: 'New guide', subject: 'Hello', body: 'Welcome.' };
      return undefined;
    },
  });
  const user = open({ q: 'guide' });
  const unfiled = await within(panel()).findByRole('button', { name: /^No folder/ });
  await waitFor(() => {
    expect(unfiled.textContent).toContain('2');
  });
  await user.click(unfiled);
  expect(address.now).toEqual({ folder: 'root', q: 'guide' });
  await waitFor(() => {
    expect(lastQuery()).toMatchObject({ folder: 'root', archived: 'exclude', deleted: 'exclude' });
  });
  expect(unfiled.getAttribute('aria-current')).toBe('true');
  expect(screen.getByRole('heading', { level: 2, name: 'No folder' })).toBeDefined();
  // A template made here goes in no folder.
  await newPlain(user);
  await user.type(field('Name'), 'New guide');
  await user.type(field('Subject'), 'Hello');
  await user.type(field('Message'), 'Welcome.');
  await user.click(screen.getByRole('button', { name: 'Create template' }));
  await waitFor(() => {
    expect(inputsOf('createMessageTemplate')).toEqual([
      { body: { name: 'New guide', subject: 'Hello', body: 'Welcome.' } },
    ]);
  });
});

it('filters by type and workflow use, orders, and searches, all in the address', async () => {
  serving([guide]);
  const user = open();
  await screen.findByRole('table');
  await choose(user, 'Type', 'Designed');
  await choose(user, 'Workflows', 'Not used');
  await choose(user, 'Sort', 'Most used');
  await user.type(screen.getByRole('searchbox', { name: 'Search templates' }), 'pricing');
  await waitFor(() => {
    expect(lastQuery()).toEqual({
      archived: 'exclude',
      deleted: 'exclude',
      q: 'pricing',
      format: 'html',
      used: 'no',
      sort: 'uses',
      limit: 50,
    });
  });
  expect(address.now).toEqual({ type: 'html', used: 'no', sort: 'uses', q: 'pricing' });
  await choose(user, 'Type', 'All types');
  expect(address.now).toEqual({ used: 'no', sort: 'uses', q: 'pricing' });
});

it('pages with Previous and Next, from the cursor the server gave', async () => {
  const second = { ...guide, id: 'tmpl_01h455vb4pex5vsknk084sn02r', name: 'Welcome' };
  serving([guide], {
    answer: (operation, input) => {
      if (operation !== 'listMessageTemplates') return undefined;
      const { query } = input as { query: { after?: string } };
      return query.after === undefined
        ? listOf([guide], { nextCursor: id, total: 2 })
        : listOf([second], { total: 2 });
    },
  });
  const user = open();
  expect(await screen.findByText('1 - 1 of 2')).toBeDefined();
  await user.click(screen.getByRole('button', { name: 'Next page' }));
  expect(await screen.findByText('Welcome')).toBeDefined();
  expect(screen.queryByText('Pricing guide')).toBeNull();
  expect(lastQuery()).toMatchObject({ after: id });
  await user.click(screen.getByRole('button', { name: 'Previous page' }));
  expect(await screen.findByText('Pricing guide')).toBeDefined();
});

it('clears the ticks when another page is shown, and counts only this page', async () => {
  const second = { ...guide, id: 'tmpl_01h455vb4pex5vsknk084sn02r', name: 'Welcome' };
  serving([guide], {
    answer: (operation, input) => {
      if (operation !== 'listMessageTemplates') return undefined;
      const { query } = input as { query: { after?: string } };
      return query.after === undefined
        ? listOf([guide], { nextCursor: id, total: 2 })
        : listOf([second], { total: 2 });
    },
  });
  const user = open();
  await user.click(await screen.findByRole('checkbox', { name: 'Select Pricing guide' }));
  const bar = screen.getByRole('region', { name: 'Bulk actions' });
  expect(within(bar).getByText('1 selected on this page')).toBeDefined();
  await user.click(screen.getByRole('button', { name: 'Next page' }));
  expect(await screen.findByText('Welcome')).toBeDefined();
  expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Previous page' }));
  const back = await screen.findByRole('checkbox', { name: 'Select Pricing guide' });
  expect((back as HTMLInputElement).checked).toBe(false);
});

it('duplicates a template into a copy, and says so', async () => {
  serving([guide], {
    answer: (operation) =>
      operation === 'duplicateMessageTemplate'
        ? { ...guide, id: otherId, name: 'Copy of Pricing guide' }
        : undefined,
  });
  const user = open();
  await menu(user, 'Pricing guide', 'Duplicate');
  await waitFor(() => {
    expect(inputsOf('duplicateMessageTemplate')).toEqual([{ params: { id }, body: {} }]);
  });
  expect(
    (await screen.findByText('Copy of Pricing guide created.')).closest('[role="status"]'),
  ).not.toBeNull();
});

it('refuses to delete a template a published workflow sends, naming the workflows', async () => {
  const used = {
    ...guide,
    usedBy: [
      { id: 'aut_01h455vb4pex5vsknk084sn02q', name: 'Welcome series', status: 'active' as const },
    ],
  };
  serving([used]);
  const user = open();
  await menu(user, 'Pricing guide', 'Delete');
  const dialog = await screen.findByRole('dialog', { name: 'This template is in use' });
  expect(dialog.textContent).toContain('“Welcome series”');
  expect(within(dialog).queryByRole('button', { name: 'Move to trash' })).toBeNull();
  await user.click(within(dialog).getByRole('button', { name: 'OK' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  // The keyboard is back on the template's menu button.
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Actions for Pricing guide' }),
  );
  expect(inputsOf('deleteMessageTemplate')).toEqual([]);
});

it('refuses to delete a template that runs still in progress send, and says to wait for them', async () => {
  const used = {
    ...guide,
    usedBy: [
      {
        id: 'aut_01h455vb4pex5vsknk084sn02q',
        name: 'Old drip',
        status: 'active' as const,
        runsInProgress: true as const,
      },
    ],
  };
  serving([used]);
  const user = open();
  await menu(user, 'Pricing guide', 'Delete');
  const dialog = await screen.findByRole('dialog', { name: 'This template is in use' });
  expect(dialog.textContent).toContain(
    "Pricing guide can't be deleted while runs still in progress send it: “Old drip”. Delete it once they finish.",
  );
  expect(within(dialog).queryByRole('button', { name: 'Move to trash' })).toBeNull();
});

it('deletes to the trash after asking, and can take it back at once', async () => {
  const trashed = {
    ...guide,
    archivedAt: '2026-10-12T00:00:00.000Z',
    deletedAt: '2026-10-12T00:00:00.000Z',
    revision: 'e'.repeat(64),
  };
  serving([guide], {
    answer: (operation) => {
      if (operation === 'deleteMessageTemplate') return trashed;
      if (operation === 'restoreMessageTemplate') return { ...guide, revision: 'f'.repeat(64) };
      return undefined;
    },
  });
  const user = open();
  await menu(user, 'Pricing guide', 'Delete');
  const dialog = await screen.findByRole('dialog', { name: 'Delete template' });
  await within(dialog).findByText(/^Move Pricing guide to the trash\?/);
  await user.click(within(dialog).getByRole('button', { name: 'Move to trash' }));
  await waitFor(() => {
    expect(inputsOf('deleteMessageTemplate')).toEqual([
      { params: { id }, body: { revision: 'a'.repeat(64) } },
    ]);
  });
  expect(await screen.findByText('Pricing guide moved to the trash.')).toBeDefined();
  // The row leaves the list, so the keyboard goes to the list's heading, not the page.
  await waitFor(() => {
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2, name: 'All templates' }),
    );
  });
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => {
    expect(inputsOf('restoreMessageTemplate')).toEqual([
      { params: { id }, body: { revision: 'e'.repeat(64) } },
    ]);
  });
  expect(await screen.findByText('Pricing guide restored.')).toBeDefined();
});

it('offers only Restore in the trash', async () => {
  const trashed = {
    ...guide,
    archivedAt: '2026-10-12T00:00:00.000Z',
    deletedAt: '2026-10-12T00:00:00.000Z',
  };
  serving([trashed], {
    answer: (operation) =>
      operation === 'restoreMessageTemplate' ? { ...guide, revision: 'f'.repeat(64) } : undefined,
  });
  const user = open({ show: 'trash' });
  const table = await screen.findByRole('table');
  expect(within(table).getByRole('columnheader', { name: 'Deleted' })).toBeDefined();
  // A template in the trash is not opened from the list.
  expect(within(table).queryByRole('button', { name: 'Open Pricing guide' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Actions for Pricing guide' }));
  expect((await screen.findAllByRole('menuitem')).map((each) => each.textContent)).toEqual([
    'Restore',
  ]);
  await user.click(screen.getByRole('menuitem', { name: 'Restore' }));
  await waitFor(() => {
    expect(inputsOf('restoreMessageTemplate')).toEqual([
      { params: { id }, body: { revision: 'a'.repeat(64) } },
    ]);
  });
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Trash' }));
  });
});

it('refuses to archive from the menu while workflows send it, naming them', async () => {
  const used = {
    ...guide,
    usedBy: [
      { id: 'aut_01h455vb4pex5vsknk084sn02q', name: 'Welcome series', status: 'active' as const },
      {
        id: 'aut_01h455vb4pex5vsknk084sn02r',
        name: 'Old drip',
        status: 'active' as const,
        runsInProgress: true as const,
      },
    ],
  };
  serving([used]);
  const user = open();
  await menu(user, 'Pricing guide', 'Archive');
  const dialog = await screen.findByRole('dialog', { name: 'This template is in use' });
  expect(dialog.textContent).toContain(
    "Pricing guide can't be archived while published workflows send it: “Welcome series”. Take it out of their Send email step first; their emails would stop. Runs still in progress in “Old drip” send it too.",
  );
  expect(within(dialog).queryByRole('button', { name: 'Archive' })).toBeNull();
  await user.click(within(dialog).getByRole('button', { name: 'OK' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Actions for Pricing guide' }),
  );
  expect(inputsOf('archiveMessageTemplate')).toEqual([]);
});

it('archives from the menu once nothing sends it', async () => {
  serving([guide], {
    answer: (operation) =>
      operation === 'archiveMessageTemplate'
        ? { ...guide, archivedAt: '2026-10-12T00:00:00.000Z' }
        : undefined,
  });
  const user = open();
  await menu(user, 'Pricing guide', 'Archive');
  const dialog = await screen.findByRole('dialog', { name: 'Archive template' });
  await within(dialog).findByText(/No published workflow sends it/);
  await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
  await waitFor(() => {
    expect(inputsOf('archiveMessageTemplate')).toEqual([
      { params: { id }, body: { revision: 'a'.repeat(64) } },
    ]);
  });
  expect(await screen.findByText('Pricing guide archived.')).toBeDefined();
});

it('renames a template, saving its content as it is with the new name', async () => {
  serving([guide], {
    answer: (operation) =>
      operation === 'updateMessageTemplate' ? { ...guide, name: 'Price list' } : undefined,
  });
  const user = open();
  await menu(user, 'Pricing guide', 'Rename');
  const dialog = await screen.findByRole('dialog', { name: 'Rename template' });
  const name = within(dialog).getByRole('textbox', { name: 'Template name' });
  await user.clear(name);
  await user.type(name, 'Price list');
  await waitFor(() => {
    expect(within(dialog).getByRole('button', { name: 'Rename' }).matches(':disabled')).toBe(false);
  });
  await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
  await waitFor(() => {
    expect(inputsOf('updateMessageTemplate')).toEqual([
      {
        params: { id },
        body: {
          name: 'Price list',
          subject: guide.subject,
          content: guide.content,
          revision: 'a'.repeat(64),
        },
      },
    ]);
  });
  expect(await screen.findByText('Renamed to Price list.')).toBeDefined();
});

it('moves one template by id and revision, without resending its content', async () => {
  serving([guide], {
    answer: (operation) =>
      operation === 'moveMessageTemplate' ? { ...guide, revision: 'b'.repeat(64) } : undefined,
  });
  const user = open();
  await menu(user, 'Pricing guide', 'Move to folder');
  const dialog = await screen.findByRole('dialog', { name: 'Move to folder' });
  await waitFor(() => {
    expect(within(dialog).getByRole('button', { name: 'Move' }).matches(':disabled')).toBe(false);
  });
  await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Folder' }), folderId);
  await user.click(within(dialog).getByRole('button', { name: 'Move' }));
  await waitFor(() => {
    expect(inputsOf('moveMessageTemplate')).toEqual([
      { params: { id }, body: { revision: 'a'.repeat(64), folderId } },
    ]);
  });
  expect(await screen.findByText('Template moved.')).toBeDefined();
});

it('acts on ticked templates together, and says which were left as they were and why', async () => {
  const result: BulkMessageTemplatesResult = {
    action: 'delete',
    results: [
      { id, outcome: 'done', reason: null },
      {
        id: otherId,
        outcome: 'skipped',
        reason: { code: 'in_use', message: '“Welcome series” sends it.' },
      },
    ],
    done: 1,
    unchanged: 0,
    skipped: 1,
  };
  serving([guide, offer], {
    answer: (operation) => (operation === 'bulkMessageTemplates' ? result : undefined),
  });
  const user = open();
  await user.click(await screen.findByRole('checkbox', { name: 'Select Pricing guide' }));
  const bar = screen.getByRole('region', { name: 'Bulk actions' });
  expect(within(bar).getByText('1 selected on this page')).toBeDefined();
  // The page's box ticks the rest.
  const all = screen.getByRole('checkbox', { name: 'Select all templates on this page' });
  expect((all as HTMLInputElement).indeterminate).toBe(true);
  await user.click(all);
  expect(within(bar).getByText('2 selected on this page')).toBeDefined();
  expect(
    within(bar)
      .getAllByRole('button')
      .map((each) => each.textContent),
  ).toEqual(['Move to folder', 'Archive', 'Delete', 'Clear selection']);
  await user.click(within(bar).getByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete 2 templates' });
  await user.click(within(dialog).getByRole('button', { name: 'Move to trash' }));
  await waitFor(() => {
    expect(inputsOf('bulkMessageTemplates')).toEqual([
      { body: { action: 'delete', ids: [id, otherId] } },
    ]);
  });
  expect(
    await screen.findByText(
      '1 template moved to the trash. 1 left as it was: Spring offer: “Welcome series” sends it.',
    ),
  ).toBeDefined();
  expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull();
  // The bar has gone with the selection: the keyboard is on the list's heading.
  await waitFor(() => {
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2, name: 'All templates' }),
    );
  });
});

it('adds a folder from the New menu inside the folder showing, and renames one from its menu', async () => {
  serving([guide], {
    answer: (operation) => {
      if (operation === 'createMessageTemplateFolder')
        return {
          ...guides,
          id: 'tfld_01h455vb4pex5vsknk084sn03q',
          name: 'Welcome',
          parentId: folderId,
        };
      if (operation === 'updateMessageTemplateFolder') return { ...guides, name: 'How-tos' };
      return undefined;
    },
  });
  const user = open({ folder: folderId });
  await user.click(await screen.findByRole('button', { name: 'New template' }));
  await user.click(await screen.findByRole('menuitem', { name: /^Folder/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Create folder' });
  await user.type(within(dialog).getByRole('textbox', { name: 'Folder name' }), 'Welcome');
  await user.click(within(dialog).getByRole('button', { name: 'Save folder' }));
  await waitFor(() => {
    expect(inputsOf('createMessageTemplateFolder')).toEqual([
      { body: { name: 'Welcome', parentId: folderId } },
    ]);
  });
  await waitFor(() => {
    expect(address.now).toEqual({ folder: 'tfld_01h455vb4pex5vsknk084sn03q' });
  });

  await user.click(within(panel()).getByRole('button', { name: 'Actions for Guides' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Rename or move folder' }));
  const rename = await screen.findByRole('dialog', { name: 'Rename or move folder' });
  const name = within(rename).getByRole('textbox', { name: 'Folder name' });
  await user.clear(name);
  await user.type(name, 'How-tos');
  await user.click(within(rename).getByRole('button', { name: 'Save folder' }));
  await waitFor(() => {
    expect(inputsOf('updateMessageTemplateFolder')).toEqual([
      { params: { id: folderId }, body: { revision: 7, name: 'How-tos', parentId: null } },
    ]);
  });
});

it('shows cards with a picture of each designed email, and the first lines of plain text', async () => {
  serving([guide, offer], {
    answer: (operation) =>
      operation === 'renderEmailPreview'
        ? {
            subject: 'Spring is here',
            preheader: null,
            html: '<p>Spring</p>',
            text: 'Spring',
            mergeFields: [],
            missingFields: [],
            subjectLineBreak: [],
          }
        : undefined,
  });
  open({ layout: 'grid' });
  expect(await screen.findByText(guide.preview)).toBeDefined();
  await waitFor(() => {
    expect(inputsOf('renderEmailPreview')).toEqual([
      { body: { template: otherId, footer: false, values: {} } },
    ]);
  });
  const frame = await screen.findByTitle('Preview of Spring offer');
  expect(frame.getAttribute('sandbox')).toBe('');
  expect(frame.getAttribute('srcdoc')).toBe('<p>Spring</p>');
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.getByRole('button', { name: 'Grid view' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
});

it('says so when there are none, when loading fails, and offers nothing to someone who cannot manage', async () => {
  let fail = true;
  server.answer = (operation) => {
    if (operation === 'listMessageTemplateFolders') return { canManage: false, items: [] };
    if (operation !== 'listMessageTemplates') return fields;
    if (fail) throw problem(403, 'Not allowed.');
    return listOf([], { canManage: false });
  };
  const user = open();
  expect((await screen.findByRole('alert')).textContent).toContain(
    "We couldn't load the templates.",
  );
  fail = false;
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(
    await screen.findByText("Nobody has written a template yet, and your role can't add one."),
  ).toBeDefined();
  expect(screen.queryByRole('button', { name: 'New template' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Write the first template' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
});

it('creates a new plain-text template in the folder showing with one create request', async () => {
  serving([], {
    answer: (operation) =>
      operation === 'createMessageTemplate'
        ? { ...guide, name: 'New guide', subject: 'Hello', body: 'Welcome.' }
        : undefined,
  });
  const user = open({ folder: folderId });
  await newPlain(user);
  await user.type(field('Name'), 'New guide');
  await user.type(field('Subject'), 'Hello');
  await user.type(field('Message'), 'Welcome.');
  await user.click(screen.getByRole('button', { name: 'Create template' }));
  await waitFor(() => {
    expect(inputsOf('createMessageTemplate')).toEqual([
      { body: { name: 'New guide', subject: 'Hello', body: 'Welcome.', folderId } },
    ]);
  });
  expect(inputsOf('moveMessageTemplate')).toEqual([]);
});

it('creates a template from the keyboard, checked by the same rules as the server first', async () => {
  const saved = { ...guide, name: 'Welcome', subject: 'Hello', body: 'Hi there', mergeFields: [] };
  serving([], {
    answer: (operation) => (operation === 'createMessageTemplate' ? saved : undefined),
  });
  const user = open();
  // The first template can be written as formatted text (the popup editor) or as plain
  // text, which this form is.
  await screen.findByRole('button', { name: 'Write the first template' });
  await newPlain(user);
  await user.type(field('Subject'), '  Hello ');
  await user.type(field('Message'), 'Hi there');
  field('Subject').focus();
  await user.keyboard('{Enter}');
  // No name yet: said under the field, and nothing is sent.
  expect(await screen.findByText('Give the template a name.')).toBeDefined();
  expect(inputsOf('createMessageTemplate')).toEqual([]);
  await user.type(field('Name'), ' Welcome ');
  await user.click(screen.getByRole('button', { name: 'Create template' }));
  await waitFor(() => {
    expect(inputsOf('createMessageTemplate')).toEqual([
      { body: { name: 'Welcome', subject: 'Hello', body: 'Hi there' } },
    ]);
  });
  expect(await screen.findByText('Template saved.')).toBeDefined();
  // The form is now that saved template: the next save is an edit from its revision.
  await user.type(field('Message'), '!');
  server.answer = () => ({ ...saved, body: 'Hi there!', revision: 'b'.repeat(64) });
  await user.click(screen.getByRole('button', { name: 'Save template' }));
  await waitFor(() => {
    expect(inputsOf('updateMessageTemplate')).toEqual([
      {
        params: { id },
        body: { name: 'Welcome', subject: 'Hello', body: 'Hi there!', revision: 'a'.repeat(64) },
      },
    ]);
  });
});

it('shows a name the server says is taken under the name field', async () => {
  serving([guide], {
    answer: (operation) => {
      if (operation !== 'updateMessageTemplate') return undefined;
      throw problem(422, 'Invalid', [
        { path: '/name', message: 'A template is already named "Welcome". Choose another name.' },
      ]);
    },
  });
  const user = open();
  await openGuide(user);
  await user.clear(field('Name'));
  await user.type(field('Name'), 'Welcome');
  await user.click(screen.getByRole('button', { name: 'Save template' }));
  expect(
    await screen.findByText('A template is already named "Welcome". Choose another name.'),
  ).toBeDefined();
  expect(field('Name').value).toBe('Welcome');
  expect(screen.queryByText('Template saved.')).toBeNull();
});

it('inserts a merge field where the cursor was, in the message or the subject', async () => {
  serving([{ ...guide, subject: 'Hello', body: 'Hi ,' }]);
  const user = open();
  await openGuide(user);
  const message = field('Message');
  message.focus();
  message.setSelectionRange(3, 3);
  await user.click(screen.getByRole('button', { name: 'Insert contact.firstName' }));
  expect(message.value).toBe('Hi {{contact.firstName}},');
  // The keyboard is back in the text, just past the field.
  expect(document.activeElement).toBe(message);
  expect(message.selectionStart).toBe(24);

  // The business's own contact fields are offered by name; a deal's are not.
  expect(screen.queryByRole('button', { name: 'Insert Budget' })).toBeNull();
  const subject = field('Subject');
  await user.click(subject);
  expect(await screen.findByText('It goes into the subject, where the cursor was.')).toBeDefined();
  subject.setSelectionRange(0, 0);
  await user.click(screen.getByRole('button', { name: 'Insert Services' }));
  expect(subject.value).toBe('{{contact.custom.services}}Hello');
  expect(message.value).toBe('Hi {{contact.firstName}},');
});

it('previews with sample values, names fields with no value, and keeps markup as text', async () => {
  serving([
    { ...guide, body: 'Hi <b>{{contact.firstName}}</b>, we cover {{contact.custom.services}}.' },
  ]);
  const user = open();
  await openGuide(user);
  const preview = within(screen.getByRole('region', { name: 'Preview' }));
  // A built-in field has a sample; the custom one has none, and that is said, not hidden.
  expect(preview.getByLabelText<HTMLInputElement>('contact.firstName').value).toBe('Ada');
  expect(preview.getByLabelText<HTMLInputElement>('contact.custom.services').value).toBe('');
  expect(preview.getByText(/^No value for contact\.custom\.services\./)).toBeDefined();
  expect(preview.queryByText(/Hi <b>Ada<\/b>/)).toBeNull();

  await user.type(preview.getByLabelText('contact.custom.services'), 'Video');
  expect(preview.getByText('Your guide, Ada')).toBeDefined();
  const body = preview.getByText('Hi <b>Ada</b>, we cover Video.');
  expect(body.tagName).toBe('PRE');
  expect(body.querySelector('b')).toBeNull();

  // Clearing a sample is a contact without that value.
  await user.clear(preview.getByLabelText('contact.firstName'));
  expect(preview.getByText(/^No value for contact\.firstName\./)).toBeDefined();

  // A field that isn't a contact field here would stop every send.
  await user.type(field('Message'), ' {{{{values.reel}}}}');
  expect(preview.getByRole('alert').textContent).toContain(
    'Not a contact field here: values.reel.',
  );
});

it("shows what someone else saved when a save is stale, and reapplies the author's changes on request", async () => {
  const theirs: MessageTemplate = {
    ...guide,
    subject: 'Their subject',
    body: 'Their body',
    revision: 'b'.repeat(64),
  };
  let stale = true;
  serving([guide], {
    answer: (operation, input) => {
      if (operation === 'getMessageTemplate') return stale ? guide : theirs;
      if (operation !== 'updateMessageTemplate') return undefined;
      if (stale) {
        stale = false;
        throw problem(409, 'This template changed after you opened it.');
      }
      const { body } = input as { body: MessageTemplate };
      return { ...theirs, ...body, revision: 'c'.repeat(64) };
    },
  });
  const user = open();
  await openGuide(user);
  await user.clear(field('Name'));
  await user.type(field('Name'), 'My name');
  await user.clear(field('Message'));
  await user.type(field('Message'), 'My body');
  await user.click(screen.getByRole('button', { name: 'Save template' }));

  const alert = within(await screen.findByRole('alert'));
  expect(alert.getByText(/Someone else saved this template while you were editing/)).toBeDefined();
  expect(alert.getByText('Subject as saved now')).toBeDefined();
  expect(alert.getByLabelText<HTMLTextAreaElement>('Subject as saved now').value).toBe(
    'Their subject',
  );
  expect(alert.getByText(/Message as saved now/).textContent).toContain('(you changed this too)');
  expect(alert.getByLabelText<HTMLTextAreaElement>('Message as saved now').value).toBe(
    'Their body',
  );
  expect(alert.getByLabelText<HTMLTextAreaElement>('Message as saved now').readOnly).toBe(true);
  expect(alert.queryByLabelText('Name as saved now')).toBeNull();
  // Nothing was overwritten, and what was typed is still in the form, which waits.
  expect(field('Message').value).toBe('My body');
  expect(field('Name').matches(':disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Save template' }).matches(':disabled')).toBe(true);

  await user.click(alert.getByRole('button', { name: 'Keep my changes' }));
  expect(screen.queryByRole('alert')).toBeNull();
  // Their subject is taken, since it wasn't changed here; the name and message stay.
  expect(field('Name').value).toBe('My name');
  expect(field('Subject').value).toBe('Their subject');
  expect(field('Message').value).toBe('My body');
  await user.click(screen.getByRole('button', { name: 'Save template' }));
  await waitFor(() => {
    expect(inputsOf('updateMessageTemplate').at(-1)).toEqual({
      params: { id },
      body: {
        name: 'My name',
        subject: 'Their subject',
        body: 'My body',
        revision: 'b'.repeat(64),
      },
    });
  });
  expect(await screen.findByText('Template saved.')).toBeDefined();
});

it('can take the saved version instead, dropping what was typed', async () => {
  const theirs: MessageTemplate = { ...guide, body: 'Their body', revision: 'b'.repeat(64) };
  let read = 0;
  serving([guide], {
    answer: (operation) => {
      if (operation === 'getMessageTemplate') return (read += 1) === 1 ? guide : theirs;
      if (operation !== 'updateMessageTemplate') return undefined;
      throw problem(409, 'This template changed after you opened it.');
    },
  });
  const user = open();
  await openGuide(user);
  await user.type(field('Message'), ' Mine.');
  await user.click(screen.getByRole('button', { name: 'Save template' }));
  await user.click(await screen.findByRole('button', { name: 'Use the saved version' }));
  expect(field('Message').value).toBe('Their body');
  expect(router.guard?.shouldBlockFn()).toBe(false);
  expect(inputsOf('updateMessageTemplate')).toHaveLength(1);
});

it('refuses to archive from the editor while automations send it', async () => {
  const used: MessageTemplate = {
    ...guide,
    usedBy: [
      { id: 'aut_01h455vb4pex5vsknk084sn02q', name: 'Welcome series', status: 'active' },
      { id: 'aut_01h455vb4pex5vsknk084sn02r', name: 'Win back', status: 'paused' },
      {
        id: 'aut_01h455vb4pex5vsknk084sn02s',
        name: 'Old drip',
        status: 'active',
        runsInProgress: true,
      },
    ],
  };
  serving([used]);
  const user = open();
  await openGuide(user);
  // Unsaved changes would be lost, so archiving waits for them.
  await user.type(field('Message'), '!');
  expect(screen.getByRole('button', { name: 'Archive' }).matches(':disabled')).toBe(true);
  expect(screen.getByText('Save or undo your changes before archiving.')).toBeDefined();
  await user.type(field('Message'), '{Backspace}');
  await user.click(screen.getByRole('button', { name: 'Archive' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'This template is in use' }));
  expect(dialog.getByText('Welcome series (active)')).toBeDefined();
  expect(dialog.getByText('Win back (paused)')).toBeDefined();
  expect(dialog.getByText('Old drip (runs still in progress)')).toBeDefined();
  expect(dialog.queryByRole('button', { name: 'Archive template' })).toBeNull();
  await user.click(dialog.getByRole('button', { name: 'OK' }));
  expect(inputsOf('archiveMessageTemplate')).toEqual([]);
});

it('archives from the editor once no automation sends it, and can restore', async () => {
  const free: MessageTemplate = { ...guide, usedBy: [] };
  const archived = { ...free, archivedAt: '2026-10-09T10:00:00.000Z', revision: 'b'.repeat(64) };
  serving([free], {
    answer: (operation) =>
      operation === 'archiveMessageTemplate'
        ? archived
        : operation === 'restoreMessageTemplate'
          ? { ...free, revision: 'c'.repeat(64) }
          : undefined,
  });
  const user = open();
  await openGuide(user);
  await user.click(screen.getByRole('button', { name: 'Archive' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Archive this template?' }));
  expect(dialog.getByText('No published automation sends this template.')).toBeDefined();
  await user.click(dialog.getByRole('button', { name: 'Archive template' }));
  await waitFor(() => {
    expect(inputsOf('archiveMessageTemplate')).toEqual([
      { params: { id }, body: { revision: 'a'.repeat(64) } },
    ]);
  });
  expect(await screen.findByText('Template archived.')).toBeDefined();
  // Archived: nothing to edit, and one way back.
  expect(field('Message').matches(':disabled')).toBe(true);
  expect(screen.queryByRole('button', { name: 'Save template' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Restore template' }));
  await waitFor(() => {
    expect(inputsOf('restoreMessageTemplate')).toEqual([
      { params: { id }, body: { revision: 'b'.repeat(64) } },
    ]);
  });
  expect(await screen.findByText('Template restored.')).toBeDefined();
  expect(field('Message').matches(':disabled')).toBe(false);
});

it('says what archiving does when the server cannot tell which automations send it', async () => {
  serving([{ ...guide, usedBy: null }]);
  const user = open();
  await openGuide(user);
  await user.click(screen.getByRole('button', { name: 'Archive' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Archive this template?' }));
  expect(
    dialog.getByText(/^Any automation that sends this template will fail at that step/),
  ).toBeDefined();
  await user.click(dialog.getByRole('button', { name: 'Keep it' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  expect(inputsOf('archiveMessageTemplate')).toEqual([]);
});

it('says why a restore was refused when a live template has taken the name', async () => {
  serving([{ ...guide, archivedAt: '2026-10-09T10:00:00.000Z' }], {
    answer: (operation) => {
      if (operation !== 'restoreMessageTemplate') return undefined;
      throw problem(422, 'Invalid', [
        {
          path: '',
          message:
            'A template is already named "Pricing guide". Rename or archive that one, then restore this template.',
        },
      ]);
    },
  });
  const user = open();
  await openGuide(user);
  await user.click(screen.getByRole('button', { name: 'Restore template' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Rename or archive that one, then restore this template.',
  );
  expect(screen.getByRole('button', { name: 'Restore template' })).toBeDefined();
});

it('is read-only for someone whose role cannot change templates', async () => {
  serving([{ ...guide, canManage: false }], {
    answer: (operation) =>
      operation === 'listMessageTemplates'
        ? listOf([{ ...guide, canManage: false }], { canManage: false })
        : undefined,
  });
  const user = open();
  await screen.findByText('Pricing guide');
  expect(screen.queryByRole('button', { name: 'New template' })).toBeNull();
  await openGuide(user);
  for (const name of ['Name', 'Subject', 'Message'])
    expect(field(name).matches(':disabled')).toBe(true);
  expect(
    screen.getByRole('button', { name: 'Insert contact.firstName' }).matches(':disabled'),
  ).toBe(true);
  for (const name of ['Save template', 'Archive', 'Restore template'])
    expect(screen.queryByRole('button', { name })).toBeNull();
  expect(
    screen.getByText("You can read this template, but your role can't change it."),
  ).toBeDefined();
  // They can still read it and see how it would look.
  expect(field('Message').value).toBe(guide.body);
  expect(screen.getByRole('region', { name: 'Preview' })).toBeDefined();
  expect(router.guard?.shouldBlockFn()).toBe(false);
});

it('protects unsaved changes: leaving asks first, and staying keeps them', async () => {
  serving([guide]);
  const user = open();
  await openGuide(user);
  expect(router.guard?.shouldBlockFn()).toBe(false);
  expect(router.guard?.enableBeforeUnload()).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Back to templates' }));
  // Nothing typed: straight back to the list.
  await openGuide(user);
  await user.type(field('Message'), ' More.');
  expect(router.guard?.shouldBlockFn()).toBe(true);
  expect(router.guard?.enableBeforeUnload()).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Back to templates' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Leave without saving?' }));
  await user.click(dialog.getByRole('button', { name: 'Stay here' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  expect(field('Message').value).toBe(`${guide.body} More.`);
  await user.click(screen.getByRole('button', { name: 'Back to templates' }));
  await user.click(
    within(await screen.findByRole('dialog')).getByRole('button', {
      name: 'Leave and drop my changes',
    }),
  );
  expect(await screen.findByRole('button', { name: 'Open Pricing guide' })).toBeDefined();
});

it('says so when one template cannot be loaded, and lets the reader try again or go back', async () => {
  let fail = true;
  serving([guide], {
    answer: (operation) => {
      if (operation !== 'getMessageTemplate' || !fail) return undefined;
      throw problem(404, 'Template was not found.');
    },
  });
  const user = open();
  await user.click(await screen.findByRole('button', { name: 'Open Pricing guide' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    "We couldn't load this template.",
  );
  fail = false;
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByLabelText('Name')).toBeDefined();
});
