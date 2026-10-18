// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { Site, SiteFolder, SiteSummary, SiteTemplateSummary } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SitesPage } from './sites';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
const went = vi.hoisted(() => ({ to: [] as string[] }));
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
  usePageTitle: () => undefined,
}));
vi.mock('./shell/not-found', () => ({ NotFound: () => <p>Nothing at this address</p> }));
vi.mock('./sites-links', () => ({
  SitesLink: ({ splat, children }: { splat: string; children: ReactNode }) => (
    <a href={`#${splat}`}>{children}</a>
  ),
  useSitesNavigate: () => (splat: string) => {
    went.to.push(splat);
  },
}));

// A busy machine (another lane's build, a two-core runner) answers late: wait longer for it.
configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 30000 });

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
  went.to.length = 0;
});
afterEach(cleanup);

const at = '2026-10-11T09:00:00.000Z';
const springId = 'site_01h455vb4pex5vsknk084sn02q';
const folderId = 'sfld_01h455vb4pex5vsknk084sn02q';

function summaryOf(id: string, name: string, rest: Partial<SiteSummary> = {}): SiteSummary {
  return {
    id,
    kind: 'funnel',
    name,
    folderId: null,
    stepCount: 4,
    domain: null,
    path: '',
    createdAt: at,
    updatedAt: at,
    ...rest,
  };
}
function siteOf(summary: SiteSummary): Site {
  return {
    ...summary,
    faviconUrl: null,
    headCode: '',
    bodyCode: '',
    chatWidgetId: null,
    paymentLive: false,
    requireCard: false,
    optimizeImages: true,
    lazyCustomCode: false,
    privacyFonts: false,
    autoSchema: false,
    keepArrival: 'unless_opted_out',
    securityHeaders: [],
    steps: [],
    originTemplateId: null,
    revision: 7,
    canManage: true,
    canPublish: true,
    canShare: true,
  };
}
const spring = summaryOf(springId, 'Spring offer');
const campaigns: SiteFolder = {
  id: folderId,
  kind: 'funnel',
  name: 'Campaigns',
  siteCount: 2,
  revision: 3,
  createdAt: at,
  updatedAt: at,
};
const starter: SiteTemplateSummary = {
  id: 'stpl_01h455vb4pex5vsknk084sn02q',
  kind: 'funnel',
  scope: 'builtin',
  name: 'Lead magnet',
  description: 'A landing page and a thank-you page.',
  category: 'Coaching',
  pageType: 'Opt-in',
  tags: ['leads'],
  colors: ['#155eef'],
  previewFileId: null,
  stepCount: 2,
  uses: 3,
  favorite: false,
  canManage: false,
  revision: 1,
  createdAt: at,
  updatedAt: at,
};

function refusal(status: number, errors?: { path: string; code: string; message: string }[]) {
  return new ApiError({
    type: 'about:blank',
    title: 'Refused',
    status,
    ...(errors === undefined ? {} : { errors }),
  });
}

function serve(
  {
    sites = [spring],
    folders = [campaigns],
    canManage = true,
  }: {
    sites?: readonly SiteSummary[];
    folders?: readonly SiteFolder[];
    canManage?: boolean;
  } = {},
  on: (operation: string, input: unknown) => unknown = () => undefined,
): void {
  server.answer = (operation, input) => {
    const own = on(operation, input);
    if (own !== undefined) return own;
    if (operation === 'listSites')
      return { items: sites, total: sites.length, next: null, canManage };
    if (operation === 'listSiteFolders') return { items: folders, canManage };
    if (operation === 'getSite') return siteOf(spring);
    if (operation === 'listSiteTemplates')
      return {
        items: [starter],
        total: 1,
        next: null,
        facets: {
          categories: [
            { value: 'Coaching', count: 1 },
            { value: 'Business, Coaching and Consulting', count: 4 },
          ],
          types: [{ value: 'Opt-in', count: 1 }],
          tags: [],
        },
        canManage,
        canShare: false,
      };
    return undefined;
  };
}

function show(splat: string | undefined = 'funnels'): ReturnType<typeof userEvent.setup> {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <SitesPage splat={splat} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup({ delay: null });
}

const inputOf = (operation: string): unknown =>
  server.calls.findLast((call) => call.operation === operation)?.input;

async function rowOf(name: string): Promise<HTMLElement> {
  const row = (await screen.findByRole('rowheader', { name })).closest('tr');
  if (row === null) throw new Error('No row.');
  return row;
}

async function pick(user: ReturnType<typeof userEvent.setup>, row: string, action: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${row}` }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
}

describe('the Funnels and Websites lists', () => {
  it("lists Home's folders and funnels under GoHighLevel's words", async () => {
    serve();
    show();
    const row = await rowOf('Spring offer');
    expect(screen.getByRole('heading', { level: 1, name: 'Funnels' })).toBeTruthy();
    expect(
      screen.getByText(
        'Create and manage funnels to generate leads, appointments and receive payments.',
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((each) => each.textContent.trim())).toEqual([
      'Name',
      'Last updated',
      'Funnel steps',
      'Actions',
    ]);
    expect(within(row).getByText('4 Steps')).toBeTruthy();
    expect(within(await rowOf('Campaigns')).getByText('2 Funnels')).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Spring offer' }).getAttribute('href')).toBe(
      `#funnels/${springId}`,
    );
    expect(inputOf('listSites')).toEqual({
      query: { kind: 'funnel', sort: 'updated', limit: 20, folder: 'none' },
    });
    expect(inputOf('listSiteFolders')).toEqual({ query: { kind: 'funnel' } });
    expect(screen.getByText('1 - 1 of 1')).toBeTruthy();
  });

  it('says what an empty Websites list is for, and opens the nameless address on Funnels', async () => {
    serve({ sites: [], folders: [] });
    show('websites');
    expect(
      await screen.findByText(
        'Start by creating a website. All your websites and folders will live here.',
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New website' })).toHaveLength(2);
    expect(inputOf('listSites')).toMatchObject({ query: { kind: 'website' } });
    cleanup();
    show(undefined);
    expect(await screen.findByRole('heading', { level: 1, name: 'Funnels' })).toBeTruthy();
    cleanup();
    show('stores');
    expect(await screen.findByText('Nothing at this address')).toBeTruthy();
  });

  it('shows a folder under its name, and only its funnels', async () => {
    serve();
    show(`funnels/folder/${folderId}`);
    await rowOf('Spring offer');
    expect(
      within(screen.getByRole('navigation', { name: 'Folders' })).getByText('Campaigns'),
    ).toBeTruthy();
    expect(screen.queryByRole('rowheader', { name: 'Campaigns' })).toBeNull();
    expect(inputOf('listSites')).toMatchObject({ query: { folder: folderId } });
  });

  it('searches every folder from Home', async () => {
    serve();
    const user = show();
    await rowOf('Spring offer');
    await user.type(screen.getByRole('searchbox', { name: 'Search funnels' }), 'spring');
    await waitFor(() => {
      expect(inputOf('listSites')).toEqual({
        query: { kind: 'funnel', sort: 'updated', limit: 20, q: 'spring' },
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('rowheader', { name: 'Campaigns' })).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'List' }));
    await waitFor(() => {
      expect(inputOf('listSites')).toMatchObject({ query: { sort: 'name' } });
    });
  });

  it('offers nothing to change to someone who may only read', async () => {
    serve({ canManage: false });
    show();
    await rowOf('Spring offer');
    expect(screen.queryByRole('button', { name: 'New funnel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create folder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for Spring offer' })).toBeNull();
    expect(screen.getByText(/needs permission to manage sites/)).toBeTruthy();
  });

  it('says when the business may not be read', async () => {
    serve({}, (operation) => {
      if (operation === 'listSites') throw refusal(403);
      return undefined;
    });
    show();
    expect((await screen.findByRole('alert')).textContent).toContain(
      "You don't have permission to see this business's sites.",
    );
  });

  it('creates a folder and renames one', async () => {
    serve();
    const user = show();
    await rowOf('Spring offer');
    await user.click(screen.getByRole('button', { name: 'Create folder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create folder' });
    await user.type(within(dialog).getByLabelText('Folder name'), 'Autumn');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Folder created.')).toBeTruthy();
    expect(inputOf('createSiteFolder')).toEqual({ body: { kind: 'funnel', name: 'Autumn' } });

    await pick(user, 'the folder Campaigns', 'Rename');
    const rename = await screen.findByRole('dialog', { name: 'Rename folder' });
    const box = within(rename).getByLabelText('Folder name');
    await user.clear(box);
    await user.type(box, 'Seasonal');
    await user.click(within(rename).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Folder renamed.')).toBeTruthy();
    expect(inputOf('updateSiteFolder')).toEqual({
      params: { id: folderId },
      body: { name: 'Seasonal', revision: 3 },
    });
  });

  it('renames a funnel at the revision it is at now, and shows a refusal under the name', async () => {
    let refuse = true;
    serve({}, (operation) => {
      if (operation !== 'updateSite' || !refuse) return undefined;
      refuse = false;
      throw refusal(422, [
        { path: '/name', code: 'too_big', message: 'Use at most 120 characters.' },
      ]);
    });
    const user = show();
    await pick(user, 'Spring offer', 'Rename');
    const dialog = await screen.findByRole('dialog', { name: 'Rename funnel' });
    const box = within(dialog).getByLabelText('Funnel name');
    await user.clear(box);
    await user.type(box, 'Summer offer');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Use at most 120 characters.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Renamed to Summer offer.')).toBeTruthy();
    expect(inputOf('updateSite')).toEqual({
      params: { id: springId },
      body: { revision: 7, name: 'Summer offer' },
    });
  });

  it('clones at once, and deletes only after saying it is for good', async () => {
    serve({}, (operation) =>
      operation === 'cloneSite'
        ? siteOf(summaryOf('site_01h455vb4pex5vsknk084sn02r', 'Spring offer (copy)'))
        : undefined,
    );
    const user = show();
    await pick(user, 'Spring offer', 'Clone');
    expect(await screen.findByText('Copied as Spring offer (copy).')).toBeTruthy();
    expect(inputOf('cloneSite')).toEqual({ params: { id: springId }, body: {} });

    await pick(user, 'Spring offer', 'Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete funnel' });
    expect(dialog.textContent).toContain('Spring offer will be deleted for good');
    expect(server.calls.some((call) => call.operation === 'deleteSite')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Delete for good' }));
    expect(await screen.findByText('Spring offer was deleted.')).toBeTruthy();
    expect(inputOf('deleteSite')).toEqual({ params: { id: springId } });
  });

  it('moves a funnel into a folder', async () => {
    serve();
    const user = show();
    await pick(user, 'Spring offer', 'Move to folder');
    const dialog = await screen.findByRole('dialog', { name: 'Move to folder' });
    await user.click(within(dialog).getByRole('combobox', { name: 'Folder' }));
    await user.click(await screen.findByRole('option', { name: 'Campaigns' }));
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(await screen.findByText('Spring offer was moved.')).toBeTruthy();
    expect(inputOf('updateSite')).toEqual({
      params: { id: springId },
      body: { revision: 7, folderId },
    });
  });
});

describe('creating a funnel', () => {
  it('creates one from blank with the name typed, in the folder showing', async () => {
    const made = siteOf(summaryOf('site_01h455vb4pex5vsknk084sn02s', 'Autumn offer'));
    serve({}, (operation) => (operation === 'createSite' ? made : undefined));
    const user = show(`funnels/folder/${folderId}`);
    await rowOf('Spring offer');
    await user.click(screen.getByRole('button', { name: 'New funnel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create new funnel' });
    expect(within(dialog).queryByText(/Build with AI/)).toBeNull();
    const create = within(dialog).getByRole('button', { name: 'Create' });
    expect(create).toHaveProperty('disabled', true);
    await user.type(within(dialog).getByLabelText('Funnel name'), 'Autumn offer');
    await user.click(create);
    await waitFor(() => {
      expect(went.to).toEqual([`funnels/${made.id}`]);
    });
    expect(inputOf('createSite')).toEqual({
      body: { kind: 'funnel', folderId, name: 'Autumn offer' },
    });
  });

  it('creates one from a template chosen in the library, and marks a favorite', async () => {
    const made = siteOf(summaryOf('site_01h455vb4pex5vsknk084sn02t', 'Lead magnet'));
    serve({}, (operation) =>
      operation === 'createSite'
        ? made
        : operation === 'setSiteTemplateFavorite'
          ? { ...starter, favorite: true }
          : undefined,
    );
    const user = show();
    await rowOf('Spring offer');
    await user.click(screen.getByRole('button', { name: 'New funnel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create new funnel' });
    await user.click(within(dialog).getByRole('radio', { name: /From templates/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    const library = await screen.findByRole('dialog', { name: 'Funnel templates' });
    expect(await within(library).findByRole('heading', { name: 'Lead magnet' })).toBeTruthy();
    expect(inputOf('listSiteTemplates')).toEqual({
      query: { kind: 'funnel', list: 'all', sort: 'recent', limit: 24 },
    });
    expect(
      within(library)
        .getAllByRole('button', { pressed: true })
        .map((each) => each.textContent),
    ).toEqual(['All templates']);
    // A value with a comma cannot be asked for, so it is not offered.
    expect(within(library).getAllByRole('checkbox')).toHaveLength(2);
    await user.click(within(library).getByRole('checkbox', { name: /Coaching/ }));
    await waitFor(() => {
      expect(inputOf('listSiteTemplates')).toMatchObject({ query: { category: 'Coaching' } });
    });
    await user.click(within(library).getByRole('button', { name: 'Favorites' }));
    await waitFor(() => {
      expect(inputOf('listSiteTemplates')).toMatchObject({ query: { list: 'favorites' } });
    });
    await user.click(within(library).getByRole('button', { name: 'Favorite Lead magnet' }));
    expect(await within(library).findByText('Lead magnet is in your favorites.')).toBeTruthy();
    expect(inputOf('setSiteTemplateFavorite')).toEqual({
      params: { id: starter.id },
      body: { favorite: true },
    });

    await user.click(within(library).getByRole('button', { name: 'Choose Lead magnet' }));
    const naming = await screen.findByRole('dialog', { name: 'Name your funnel' });
    expect(within(naming).getByLabelText('Funnel name')).toHaveProperty('value', 'Lead magnet');
    await user.click(within(naming).getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(went.to).toEqual([`funnels/${made.id}`]);
    });
    expect(inputOf('createSite')).toEqual({
      body: { kind: 'funnel', folderId: null, name: 'Lead magnet', templateId: starter.id },
    });
  });

  it('imports a shared bundle and says why one is refused', async () => {
    let refuse = true;
    const made = siteOf(summaryOf('site_01h455vb4pex5vsknk084sn02v', 'Shared funnel'));
    serve({}, (operation) => {
      if (operation !== 'importSite') return undefined;
      if (!refuse) return made;
      refuse = false;
      throw refusal(422, [
        { path: '/bundle', code: 'invalid', message: 'This is not a bundle of this install.' },
      ]);
    });
    const user = show();
    await rowOf('Spring offer');
    await user.click(screen.getByRole('button', { name: 'Import' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Import a shared funnel or website',
    });
    await user.type(within(dialog).getByLabelText('Shared text'), 'abc.def');
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(await within(dialog).findByText('This is not a bundle of this install.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() => {
      expect(went.to).toEqual([`funnels/${made.id}`]);
    });
    expect(inputOf('importSite')).toEqual({ body: { bundle: 'abc.def', folderId: null } });
  });
});
