// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { Site, SitePageSummary, SiteStepSummary } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SitePage from './site-page';
import { SITE_STAGES, type SiteTab } from './sites-rules';

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
vi.mock('./shell/page', () => ({ usePageTitle: () => undefined }));
// The library's dialog is tested where it is made (src/media, site-media-choice.test.tsx):
// here it is a button that chooses one public file.
vi.mock('./site-media-choice', () => ({
  default: ({ onChosen }: { onChosen: (address: string) => void }) => (
    <button
      type="button"
      onClick={() => {
        onChosen('https://crm.example/m/k4v9x2m7/favicon.png');
      }}
    >
      Choose favicon.png
    </button>
  ),
}));
vi.mock('./sites-links', () => ({
  SitesLink: ({
    splat,
    current,
    children,
  }: {
    splat: string;
    current?: boolean;
    children: ReactNode;
  }) => (
    <a href={`#${splat}`} aria-current={current === true ? 'page' : undefined}>
      {children}
    </a>
  ),
  SiteEditorLink: ({ pageId, children }: { pageId: string; children: ReactNode }) => (
    <a href={`#edit:${pageId}`}>{children}</a>
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

// What nothing serves yet is out of view until its stage lands (sites-rules.ts,
// SITE_STAGES). Its screens are kept, so a test of one of them switches its stage on, as
// the stage itself will.
const stages: Record<string, boolean> = SITE_STAGES;
const asShipped = { ...SITE_STAGES };
function withStage(...names: (keyof typeof SITE_STAGES)[]): void {
  for (const name of names) stages[name] = true;
}
afterEach(() => {
  Object.assign(stages, asShipped);
});

const at = '2026-10-11T09:00:00.000Z';
const siteId = 'site_01h455vb4pex5vsknk084sn02q';
const landingId = 'sstp_01h455vb4pex5vsknk084sn02q';
const thanksId = 'sstp_01h455vb4pex5vsknk084sn02r';
const controlId = 'spg_01h455vb4pex5vsknk084sn02q';
const variationId = 'spg_01h455vb4pex5vsknk084sn02r';

function pageOf(id: string, rest: Partial<SitePageSummary> = {}): SitePageSummary {
  return {
    id,
    role: 'control',
    weight: 100,
    currentVersion: 1,
    publishedVersion: null,
    publishedAt: null,
    hasUnpublishedChanges: true,
    ...rest,
  };
}
function stepOf(id: string, name: string, rest: Partial<SiteStepSummary> = {}): SiteStepSummary {
  return {
    id,
    name,
    path: name.toLowerCase().replaceAll(' ', '-'),
    position: 0,
    splitTest: false,
    pages: [pageOf(controlId)],
    revision: 2,
    updatedAt: at,
    ...rest,
  };
}
const landing = stepOf(landingId, 'Landing Page');
const thanks = stepOf(thanksId, 'Thank You', { position: 1 });
const tested = stepOf(landingId, 'Landing Page', {
  pages: [
    pageOf(controlId, { weight: 50 }),
    pageOf(variationId, { role: 'variation', weight: 50 }),
  ],
});

function siteOf(rest: Partial<Site> = {}): Site {
  return {
    id: siteId,
    kind: 'funnel',
    name: 'Spring offer',
    folderId: null,
    stepCount: 2,
    domain: null,
    path: '',
    createdAt: at,
    updatedAt: at,
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
    securityHeaders: [{ name: 'X-Frame-Options', value: 'DENY' }],
    steps: [landing, thanks],
    originTemplateId: null,
    revision: 7,
    canManage: true,
    canPublish: true,
    canShare: true,
    ...rest,
  };
}

function refusal(
  status: number,
  rest: { detail?: string; errors?: { path: string; code: string; message: string }[] } = {},
) {
  return new ApiError({ type: 'about:blank', title: 'Refused', status, ...rest });
}

/** An install that serves public pages, as most do. */
const publicPages = {
  enabled: true,
  code: 'enabled',
  reason: null,
  baseUrl: 'https://crm.example/s',
  scripts: { countdown: true, popup: true },
};
const noPublicPages = {
  enabled: false,
  code: 'no_public_secret',
  reason: 'Set PUBLIC_INTAKE_SECRET in the server settings and restart it.',
  baseUrl: null,
  scripts: { countdown: true, popup: true },
};

function serve(
  site: () => Site,
  on: (operation: string, input: unknown) => unknown = () => undefined,
): void {
  server.answer = (operation, input) => {
    const own = on(operation, input);
    if (own !== undefined) return own;
    if (operation === 'getSite') return site();
    if (operation === 'listSiteDomains')
      return {
        items: [
          {
            id: 'sdom_01h455vb4pex5vsknk084sn02q',
            hostname: 'go.harbor.example',
            record: null,
            verification: { status: 'verified', error: null, checkedAt: at, verifiedAt: at },
            certificateStatus: 'none',
            wwwRedirect: false,
            defaultStepId: null,
            notFoundStepId: null,
            siteCount: 0,
            revision: 1,
            createdAt: at,
            updatedAt: at,
          },
        ],
        canManage: true,
      };
    if (operation === 'listWebchatWidgets') return { data: [] };
    if (operation === 'getSitePublicStatus') return publicPages;
    if (operation === 'getSiteStats')
      return {
        from: '2026-09-28',
        to: '2026-10-11',
        steps: [
          {
            stepId: landingId,
            name: 'Landing Page',
            views: 1200,
            uniqueViews: 800,
            optIns: 100,
            optInRate: 0.125,
            orders: 0,
            orderQuantity: 0,
            orderAmount: '0',
            pages: [],
          },
        ],
      };
    return undefined;
  };
}

function show(
  tab: SiteTab = 'steps',
  stepId?: string,
  kind: 'funnel' | 'website' = 'funnel',
): ReturnType<typeof userEvent.setup> {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <SitePage kind={kind} siteId={siteId} tab={tab} stepId={stepId} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup({ delay: null });
}

const inputOf = (operation: string): unknown =>
  server.calls.findLast((call) => call.operation === operation)?.input;
const asked = (operation: string): boolean =>
  server.calls.some((call) => call.operation === operation);

describe("a funnel's page", () => {
  it('shows Back, the name, Share and its tabs, with the first step chosen', async () => {
    serve(() => siteOf());
    show();
    expect(await screen.findByRole('heading', { level: 1, name: 'Spring offer' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back' }).getAttribute('href')).toBe('#funnels');
    expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy();
    const tabs = within(screen.getByRole('navigation', { name: 'Funnel sections' }));
    // Stats and Security wait for their stages: nothing counts a visit or sends a header yet.
    expect(tabs.getAllByRole('link').map((each) => each.textContent)).toEqual([
      'Steps',
      'Settings',
    ]);
    expect(tabs.getByRole('link', { name: 'Steps' }).getAttribute('aria-current')).toBe('page');
    const steps = within(screen.getByRole('region', { name: 'Funnel steps' }));
    expect(steps.getAllByRole('link').map((each) => each.getAttribute('aria-current'))).toEqual([
      'page',
      null,
    ]);
    const detail = within(screen.getByRole('region', { name: 'Landing Page' }));
    // An unpublished page has no address, and nothing is said about a domain.
    expect(detail.queryByText(/domain/i)).toBeNull();
    expect(detail.queryByText(/Live at/)).toBeNull();
    expect(detail.getByText('Not published')).toBeTruthy();
    // Edit opens the page editor; Preview and Publish are beside it.
    expect(detail.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe(
      `#edit:${controlId}`,
    );
    expect(detail.getByRole('button', { name: 'Preview' })).toBeTruthy();
    expect(detail.getByRole('button', { name: 'Publish' })).toBeTruthy();
    expect(detail.queryByRole('button', { name: 'Unpublish' })).toBeNull();
    // The variation and its split test wait for the stage that shares visitors.
    expect(detail.queryByRole('button', { name: 'Create variation' })).toBeNull();
    expect(detail.queryByText(/split test/i)).toBeNull();
  });

  it('says where a published page stands, with its live address, or what to set when it has none', async () => {
    const live = 'https://crm.example/s/k4v9x2m7q1w8e5r3t6y0u2i4/landing-page';
    const published = pageOf(controlId, {
      publishedVersion: 1,
      publishedAt: at,
      hasUnpublishedChanges: false,
    });
    serve(() =>
      siteOf({
        steps: [stepOf(landingId, 'Landing Page', { pages: [published], liveUrl: live }), thanks],
      }),
    );
    show();
    const detail = within(await screen.findByRole('region', { name: 'Landing Page' }));
    expect(detail.getByTestId('publish-state').textContent).toBe('Published');
    expect(detail.getByTestId('live-address').textContent).toBe(live);
    const open = detail.getByRole('link', { name: 'Open the live page in a new tab' });
    expect(open.getAttribute('href')).toBe(live);
    expect(open.textContent).toBe('Open live page');
    expect(open.getAttribute('target')).toBe('_blank');
    // An install that serves pages has nothing to say about it up front.
    expect(screen.queryByTestId('public-pages-off')).toBeNull();
    expect(detail.getByRole('button', { name: 'Copy the live address' })).toBeTruthy();
    // Published as saved: there is nothing new to publish, and it can be taken down.
    expect(detail.queryByRole('button', { name: /^Publish( changes)?$/ })).toBeNull();
    expect(detail.getByRole('button', { name: 'Unpublish' })).toBeTruthy();
    cleanup();

    const changed = { ...published, currentVersion: 2, hasUnpublishedChanges: true };
    serve(() =>
      siteOf({
        steps: [stepOf(landingId, 'Landing Page', { pages: [changed], liveUrl: null }), thanks],
      }),
    );
    show();
    const later = within(await screen.findByRole('region', { name: 'Landing Page' }));
    expect(later.getByTestId('publish-state').textContent).toBe(
      'Published · changes not yet published',
    );
    expect(later.getByRole('button', { name: 'Publish changes' })).toBeTruthy();
    // Published, yet no address: the install serves no public page, and the page says what to set.
    expect(later.queryByTestId('live-address')).toBeNull();
    expect(later.getByText(/Public pages are switched off on this install/)).toBeTruthy();
    expect(later.getByText(/PUBLIC_INTAKE_SECRET/)).toBeTruthy();
  });

  it('says up front, in the server’s words, when this install serves no public page', async () => {
    const published = pageOf(controlId, {
      publishedVersion: 1,
      publishedAt: at,
      hasUnpublishedChanges: false,
    });
    serve(
      () =>
        siteOf({
          steps: [stepOf(landingId, 'Landing Page', { pages: [published], liveUrl: null }), thanks],
        }),
      (operation) => (operation === 'getSitePublicStatus' ? noPublicPages : undefined),
    );
    show();
    const notice = await screen.findByTestId('public-pages-off');
    expect(notice.textContent).toBe(
      "Visitors can't reach pages on this install yet: public pages are switched off. " +
        'Set PUBLIC_INTAKE_SECRET in the server settings and restart it. ' +
        'You can still build, save and publish; a published page gets its address once they are on.',
    );
    // The published step says the same reason where its address would be.
    const detail = within(screen.getByRole('region', { name: 'Landing Page' }));
    expect(detail.queryByTestId('live-address')).toBeNull();
    expect(
      detail.getByText(
        'Public pages are switched off on this install. Set PUBLIC_INTAKE_SECRET in the server settings and restart it.',
      ),
    ).toBeTruthy();
  });

  it('shows a page as published the moment it is, and reads the site again when the dialog closes', async () => {
    const live = 'https://crm.example/s/k4v9x2m7q1w8e5r3t6y0u2i4/landing-page';
    let reads = 0;
    const detailOf = (published: boolean) => ({
      ...pageOf(controlId, {
        publishedVersion: published ? 1 : null,
        publishedAt: published ? at : null,
        hasUnpublishedChanges: !published,
      }),
      stepId: landingId,
      siteId,
      siteKind: 'funnel',
      document: { format: 1, mode: 'visual' },
      storedFormat: 1,
      problems: [],
      liveUrl: published ? live : null,
      revision: published ? 4 : 3,
      updatedAt: at,
      canManage: true,
      canPublish: true,
    });
    serve(
      () => {
        reads += 1;
        // The site as the server has it: still as it was until it is read after the publish.
        return siteOf();
      },
      (operation) =>
        operation === 'getSitePage'
          ? detailOf(false)
          : operation === 'publishSitePage'
            ? detailOf(true)
            : undefined,
    );
    const user = show();
    const detail = within(await screen.findByRole('region', { name: 'Landing Page' }));
    expect(detail.getByTestId('publish-state').textContent).toBe('Not published');
    await user.click(detail.getByRole('button', { name: 'Publish' }));
    const asking = await screen.findByRole('dialog', { name: 'Publish page' });
    expect(await within(asking).findByText('Nothing stands in the way.')).toBeTruthy();
    const before = reads;
    await user.click(within(asking).getByRole('button', { name: 'Publish' }));
    const done = await screen.findByRole('dialog', { name: 'The page is live' });
    // Behind the dialog the step already says so, from the publish's own answer.
    expect(detail.getByTestId('publish-state').textContent).toBe('Published');
    expect(detail.getByTestId('live-address').textContent).toBe(live);
    expect(reads).toBe(before);
    expect(inputOf('publishSitePage')).toEqual({
      params: { id: controlId },
      body: { revision: 3 },
    });
    await user.click(within(done).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(reads).toBeGreaterThan(before);
    });
  });

  it('adds a step with a path suggested from its name, and shows a refused path', async () => {
    let refuse = true;
    const added = { ...stepOf('sstp_01h455vb4pex5vsknk084sn02s', 'Not In Area'), siteId };
    serve(
      () => siteOf(),
      (operation) => {
        if (operation !== 'createSiteStep') return undefined;
        if (!refuse) return added;
        refuse = false;
        throw refusal(422, {
          errors: [{ path: '/path', code: 'taken', message: 'Another step has this path.' }],
        });
      },
    );
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Add new step' }));
    const dialog = await screen.findByRole('dialog', { name: 'New step in funnel' });
    await user.type(within(dialog).getByLabelText('Name for page'), 'Not In Area');
    expect(within(dialog).getByLabelText('Path')).toHaveProperty('value', 'not-in-area');
    await user.click(within(dialog).getByRole('button', { name: 'Create funnel step' }));
    expect(await within(dialog).findByText('Another step has this path.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Create funnel step' }));
    await waitFor(() => {
      expect(went.to).toEqual([`funnels/${siteId}/steps/${added.id}`]);
    });
    expect(inputOf('createSiteStep')).toEqual({
      params: { id: siteId },
      body: { name: 'Not In Area', path: 'not-in-area' },
    });
  });

  it('moves a step down with the site revision', async () => {
    serve(
      () => siteOf(),
      (operation) => (operation === 'reorderSiteSteps' ? { items: [thanks, landing] } : undefined),
    );
    const user = show();
    const up = await screen.findByRole('button', { name: 'Move Landing Page up' });
    expect(up).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Move Landing Page down' }));
    expect(await screen.findByText('The order was saved.')).toBeTruthy();
    expect(inputOf('reorderSiteSteps')).toEqual({
      params: { id: siteId },
      body: { revision: 7, stepIds: [thanksId, landingId] },
    });
  });

  it('clones a step at once and deletes one only after saying it is for good', async () => {
    const copy = { ...stepOf('sstp_01h455vb4pex5vsknk084sn02t', 'Landing Page (copy)'), siteId };
    serve(
      () => siteOf(),
      (operation) => (operation === 'cloneSiteStep' ? copy : undefined),
    );
    const user = show('steps', landingId);
    await user.click(await screen.findByRole('button', { name: 'Clone Funnel Step' }));
    await waitFor(() => {
      expect(went.to).toEqual([`funnels/${siteId}/steps/${copy.id}`]);
    });
    expect(inputOf('cloneSiteStep')).toEqual({ params: { id: landingId }, body: {} });

    await user.click(screen.getByRole('button', { name: 'Delete Funnel Step' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Funnel Step' });
    expect(dialog.textContent).toContain('Landing Page will be deleted for good');
    expect(asked('deleteSiteStep')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Delete for good' }));
    await waitFor(() => {
      expect(went.to.at(-1)).toBe(`funnels/${siteId}`);
    });
    expect(inputOf('deleteSiteStep')).toEqual({ params: { id: landingId } });
  });

  it('creates a variation, starts the split test and declares a winner', async () => {
    withStage('splitTests');
    let site = siteOf();
    serve(
      () => site,
      (operation) => {
        if (operation === 'createSiteVariation') {
          site = siteOf({ steps: [tested, thanks] });
          return { ...tested, siteId };
        }
        if (operation === 'setSiteSplitTest') {
          site = siteOf({ steps: [{ ...tested, splitTest: true, revision: 3 }, thanks] });
          return { ...tested, splitTest: true, revision: 3, siteId };
        }
        if (operation === 'declareSiteWinner') {
          site = siteOf();
          return { ...landing, siteId };
        }
        return undefined;
      },
    );
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Create variation' }));
    expect(
      await screen.findByText('Variation created as a copy of the control page.'),
    ).toBeTruthy();
    expect(inputOf('createSiteVariation')).toEqual({
      params: { id: landingId },
      body: { revision: 2, copyControl: true },
    });

    const share = await screen.findByLabelText('Control share (%)');
    expect(share).toHaveProperty('value', '50');
    await user.clear(share);
    await user.type(share, '70');
    await user.click(screen.getByRole('button', { name: 'Start split test' }));
    expect(await screen.findByText('The split test is running.')).toBeTruthy();
    expect(inputOf('setSiteSplitTest')).toEqual({
      params: { id: landingId },
      body: { revision: 2, active: true, controlWeight: 70 },
    });
    expect(await screen.findByRole('button', { name: 'Stop split test' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Declare the variation the winner' }));
    const dialog = await screen.findByRole('dialog', { name: 'Declare winner' });
    expect(dialog.textContent).toContain('the control page is deleted for good');
    await user.click(within(dialog).getByRole('button', { name: 'Declare winner' }));
    expect(await screen.findByText("The winner is now the step's only page.")).toBeTruthy();
    expect(inputOf('declareSiteWinner')).toEqual({
      params: { id: landingId },
      body: { revision: 3, pageId: variationId },
    });
  });

  it('updates a step from Publishing and stays there', async () => {
    serve(
      () => siteOf(),
      (operation) => (operation === 'updateSiteStep' ? { ...landing, siteId } : undefined),
    );
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Publishing' }));
    const path = screen.getByLabelText('Step path');
    await user.clear(path);
    await user.type(path, 'offers/spring');
    await user.click(screen.getByRole('button', { name: 'Update step' }));
    expect(await screen.findByText('Step updated.')).toBeTruthy();
    expect(inputOf('updateSiteStep')).toEqual({
      params: { id: landingId },
      body: { revision: 2, name: 'Landing Page', path: 'offers/spring' },
    });
    expect(screen.getByRole('button', { name: 'Publishing' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('shows nothing to change to someone who may only read, and no Share without the right', async () => {
    serve(() => siteOf({ canManage: false, canShare: false }));
    show();
    await screen.findByRole('heading', { level: 1, name: 'Spring offer' });
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add new step' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Funnel Step' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create variation' })).toBeNull();
    expect(screen.getByText(/needs permission to manage sites/)).toBeTruthy();
  });

  it('says when the funnel is gone, and when it may not be read', async () => {
    serve(
      () => siteOf(),
      (operation) => {
        if (operation === 'getSite') throw refusal(404);
        return undefined;
      },
    );
    show();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This funnel is no longer here.',
    );
    cleanup();
    serve(
      () => siteOf(),
      (operation) => {
        if (operation === 'getSite') throw refusal(403);
        return undefined;
      },
    );
    show();
    expect((await screen.findByRole('alert')).textContent).toContain(
      "You don't have permission to see this business's sites.",
    );
  });
});

describe("a website's page", () => {
  it('has pages with no order, no variation and no split test', async () => {
    serve(() => siteOf({ kind: 'website' }));
    show('steps', undefined, 'website');
    await screen.findByRole('heading', { level: 1, name: 'Spring offer' });
    expect(screen.getByRole('region', { name: 'Website pages' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add new page' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create variation' })).toBeNull();
    expect(screen.queryByText(/split test/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Clone page' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back' }).getAttribute('href')).toBe('#websites');
  });
});

describe('the other tabs', () => {
  it('shows page views and opt-ins per step, and resets them after asking', async () => {
    serve(
      () => siteOf(),
      (operation) => (operation === 'resetSiteStats' ? null : undefined),
    );
    const user = show('stats');
    const row = (await screen.findByRole('rowheader', { name: 'Landing Page' })).closest('tr');
    if (row === null) throw new Error('No row.');
    expect(
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['1,200', '800', '100', '12.5%']);
    expect(inputOf('getSiteStats')).toEqual({ params: { id: siteId }, query: {} });
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reset statistics' });
    expect(dialog.textContent).toContain('for good');
    await user.click(within(dialog).getByRole('button', { name: 'Reset for good' }));
    expect(await screen.findByText('The statistics were reset.')).toBeTruthy();
    expect(inputOf('resetSiteStats')).toEqual({ params: { id: siteId } });
  });

  it('adds and removes a security header by sending the whole list', async () => {
    let site = siteOf();
    serve(
      () => site,
      (operation, input) => {
        if (operation !== 'setSiteSecurityHeaders') return undefined;
        const { body } = input as { body: { headers: Site['securityHeaders'] } };
        site = siteOf({ securityHeaders: body.headers, revision: site.revision + 1 });
        return site;
      },
    );
    const user = show('security');
    await screen.findByRole('rowheader', { name: 'X-Frame-Options' });
    await user.click(screen.getByRole('button', { name: 'Add security header' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add security header' });
    const name = within(dialog).getByLabelText('Header');
    await user.type(name, 'x-frame-options');
    await user.type(within(dialog).getByLabelText('Value'), 'no-referrer');
    expect(within(dialog).getByText('This site already adds that header.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true);
    await user.clear(name);
    await user.type(name, 'Referrer-Policy');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Referrer-Policy was added.')).toBeTruthy();
    expect(inputOf('setSiteSecurityHeaders')).toEqual({
      params: { id: siteId },
      body: {
        revision: 7,
        headers: [
          { name: 'X-Frame-Options', value: 'DENY' },
          { name: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    });
  });

  it('saves only the settings that changed, and shows a refusal under its field', async () => {
    withStage('connectedDomains', 'pageSpeed');
    let refuse = true;
    serve(
      () => siteOf(),
      (operation) => {
        if (operation !== 'updateSite') return undefined;
        if (!refuse) return siteOf({ path: 'offers', privacyFonts: true, revision: 8 });
        refuse = false;
        throw refusal(422, {
          errors: [{ path: '/path', code: 'invalid', message: 'Use lowercase letters.' }],
        });
      },
    );
    const user = show('settings');
    const form = within(await screen.findByRole('form', { name: 'Funnel settings' }));
    const save = form.getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);
    await user.type(form.getByLabelText('Path'), 'Offers');
    await user.click(form.getByRole('switch', { name: 'GDPR compliant fonts' }));
    await user.click(save);
    expect(await form.findByText('Use lowercase letters.')).toBeTruthy();
    expect(inputOf('updateSite')).toEqual({
      params: { id: siteId },
      body: { revision: 7, path: 'Offers', privacyFonts: true },
    });
    const path = form.getByLabelText('Path');
    await user.clear(path);
    await user.type(path, 'offers');
    await user.click(save);
    expect(await form.findByText('Settings saved.')).toBeTruthy();
    expect(form.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  it('asks whether the site remembers how visitors arrived, three answers each said in a sentence, and saves the one chosen', async () => {
    serve(
      () => siteOf(),
      (operation) =>
        operation === 'updateSite' ? siteOf({ keepArrival: 'always', revision: 8 }) : undefined,
    );
    const user = show('settings');
    const form = within(await screen.findByRole('form', { name: 'Funnel settings' }));
    const group = within(
      await form.findByRole('radiogroup', { name: 'Remember how visitors arrived' }),
    );
    const answers = group.getAllByRole<HTMLInputElement>('radio');
    expect(answers.map((answer) => answer.parentElement?.textContent)).toEqual([
      'Yes, unless their browser asks us not to (recommended)',
      'Yes, always',
      'No',
    ]);
    // A site starts on the cautious answer.
    expect(answers.map((answer) => answer.checked)).toEqual([true, false, false]);
    // Each answer is described by its own sentence, and the whole by what is kept and where.
    for (const answer of answers) {
      const said = document.getElementById(answer.getAttribute('aria-describedby') ?? '');
      expect(said?.textContent.length ?? 0).toBeGreaterThan(20);
    }
    expect(form.getByText(/No cookie is set, and nothing is sent to us before/)).toBeTruthy();
    expect(form.getByText(/This is not legal advice/)).toBeTruthy();

    const save = form.getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);
    await user.click(group.getByRole('radio', { name: 'Yes, always' }));
    await user.click(save);
    expect(await form.findByText('Settings saved.')).toBeTruthy();
    expect(inputOf('updateSite')).toEqual({
      params: { id: siteId },
      body: { revision: 7, keepArrival: 'always' },
    });
    await waitFor(() => {
      expect(group.getByRole<HTMLInputElement>('radio', { name: 'Yes, always' }).checked).toBe(
        true,
      );
    });
    expect(form.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  it('shows the answer and lets nobody change it who may not manage the site', async () => {
    serve(() => siteOf({ keepArrival: 'never', canManage: false }));
    show('settings');
    const form = within(await screen.findByRole('form', { name: 'Funnel settings' }));
    const group = within(
      await form.findByRole('radiogroup', { name: 'Remember how visitors arrived' }),
    );
    const answers = group.getAllByRole<HTMLInputElement>('radio');
    expect(answers.map((answer) => answer.checked)).toEqual([false, false, true]);
    expect(answers.every((answer) => answer.disabled)).toBe(true);
  });

  it('takes a favicon from Media Storage as its public address', async () => {
    serve(
      () => siteOf(),
      (operation) => (operation === 'updateSite' ? siteOf({ revision: 8 }) : undefined),
    );
    const user = show('settings');
    await user.click(await screen.findByRole('button', { name: 'Choose from Media Storage' }));
    await user.click(await screen.findByRole('button', { name: 'Choose favicon.png' }));
    expect(screen.getByLabelText('Favicon URL')).toHaveProperty(
      'value',
      'https://crm.example/m/k4v9x2m7/favicon.png',
    );
    expect(screen.queryByRole('button', { name: 'Choose favicon.png' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(inputOf('updateSite')).toMatchObject({
        body: { faviconUrl: 'https://crm.example/m/k4v9x2m7/favicon.png' },
      });
    });
  });

  it('offers the saved version when someone else saved first', async () => {
    let stale = true;
    serve(
      () => (stale ? siteOf() : siteOf({ name: 'Renamed elsewhere', revision: 9 })),
      (operation) => {
        if (operation !== 'updateSite') return undefined;
        stale = false;
        throw refusal(409, { detail: 'Someone else changed this site.' });
      },
    );
    const user = show('settings');
    const form = within(await screen.findByRole('form', { name: 'Funnel settings' }));
    await user.type(form.getByLabelText('Name'), '!');
    await user.click(form.getByRole('button', { name: 'Save' }));
    expect(await form.findByText('Someone else changed this site.')).toBeTruthy();
    await user.click(form.getByRole('button', { name: 'Reload saved version' }));
    await waitFor(() => {
      expect(form.getByLabelText('Name')).toHaveProperty('value', 'Renamed elsewhere');
    });
  });

  it('deletes the funnel for good from Settings and goes back to the list', async () => {
    serve(
      () => siteOf(),
      (operation) => (operation === 'deleteSite' ? null : undefined),
    );
    const user = show('settings');
    const form = within(await screen.findByRole('form', { name: 'Funnel settings' }));
    await user.click(form.getByRole('button', { name: 'Delete funnel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete funnel' });
    expect(dialog.textContent).toContain('deleted for good');
    await user.click(within(dialog).getByRole('button', { name: 'Delete for good' }));
    await waitFor(() => {
      expect(went.to).toEqual(['funnels']);
    });
  });

  it('makes the share text when asked', async () => {
    serve(
      () => siteOf(),
      (operation) => (operation === 'exportSite' ? { bundle: 'abc.def' } : undefined),
    );
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share funnel' });
    await user.click(within(dialog).getByRole('button', { name: 'Create share text' }));
    await waitFor(() => {
      expect(within(dialog).getByLabelText('Share text')).toHaveProperty('value', 'abc.def');
    });
    expect(inputOf('exportSite')).toEqual({ params: { id: siteId } });
  });
});
