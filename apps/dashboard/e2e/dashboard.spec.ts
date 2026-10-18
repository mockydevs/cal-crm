// The Dashboard: a date range, then the five opportunity widgets on the numbers GET
// /reports/opportunities serves, and the overdue tasks under them. Against a stand-in that
// checks each request as the contract does and answers what the contract describes.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  opportunityReport,
  opportunityReportQuery,
  pipelineConfiguration,
  type OpportunityReport,
} from '@repo/contracts';
import { reachesRightGutter } from './lists';
import { choose, expectChoice } from './select';
import { inHarbor, signedIn } from './session';

const weddings = 'pipe_01k8e2wzr0e008000000000001';
const corporate = 'pipe_01k8e2wzr0e008000000000002';
const lead = 'stage_01k8e2wzr0e008000000000001';
const quoted = 'stage_01k8e2wzr0e008000000000002';
const booked = 'stage_01k8e2wzr0e008000000000003';

const stageOf = (id: string, name: string) => ({ id, name, description: '', archived: false });
const pipelineOf = (id: string, name: string) => ({
  id,
  name,
  description: '',
  archived: false,
  stages: [stageOf(lead, 'New lead'), stageOf(quoted, 'Quoted'), stageOf(booked, 'Booked')],
});

type Numbers = Pick<OpportunityReport, 'count' | 'statuses' | 'conversion' | 'funnel' | 'stages'>;

/** Seven opportunities: four open and three won, in two currencies. */
const busy: Numbers = {
  count: 7,
  statuses: [
    {
      status: 'open',
      count: 4,
      totals: [
        { currency: 'KES', amount: '390000.0000' },
        { currency: 'USD', amount: '1200.0000' },
      ],
    },
    { status: 'won', count: 3, totals: [{ currency: 'KES', amount: '128000.5000' }] },
    { status: 'lost', count: 0, totals: [] },
  ],
  conversion: {
    won: 3,
    total: 7,
    rate: 3 / 7,
    wonTotals: [{ currency: 'KES', amount: '128000.5000' }],
  },
  funnel: [
    {
      stageId: lead,
      name: 'New lead',
      count: 7,
      totals: [
        { currency: 'KES', amount: '518000.5000' },
        { currency: 'USD', amount: '1200.0000' },
      ],
      cumulativeRate: 1,
      nextStepRate: null,
    },
    {
      stageId: quoted,
      name: 'Quoted',
      count: 5,
      totals: [{ currency: 'KES', amount: '300000.0000' }],
      cumulativeRate: 5 / 7,
      nextStepRate: 5 / 7,
    },
    {
      stageId: booked,
      name: 'Booked',
      count: 3,
      totals: [],
      cumulativeRate: 3 / 7,
      nextStepRate: 0.6,
    },
  ],
  stages: [
    {
      stageId: lead,
      name: 'New lead',
      archived: false,
      count: 2,
      totals: [{ currency: 'KES', amount: '90000.0000' }],
    },
    {
      stageId: quoted,
      name: 'Quoted',
      archived: false,
      count: 2,
      totals: [
        { currency: 'KES', amount: '300000.0000' },
        { currency: 'USD', amount: '1200.0000' },
      ],
    },
    { stageId: booked, name: 'Booked', archived: false, count: 0, totals: [] },
  ],
};

const nothing: Numbers = {
  count: 0,
  statuses: busy.statuses.map((status) => ({ ...status, count: 0, totals: [] })),
  conversion: { won: 0, total: 0, rate: null, wonTotals: [] },
  funnel: busy.funnel.map((section) => ({
    ...section,
    count: 0,
    totals: [],
    cumulativeRate: null,
    nextStepRate: null,
  })),
  stages: busy.stages.map((stage) => ({ ...stage, count: 0, totals: [] })),
};

interface ReportQuery {
  readonly pipelineId: string;
  readonly from: string;
  readonly to: string;
  readonly dateProperty: 'status_changed' | 'created';
}

interface DashboardApi {
  /** Every report asked for, as the contract read its query. */
  readonly reads: ReportQuery[];
  numbers: Numbers;
  /** While true, the report answers 503. */
  failing: boolean;
}

async function dashboard(
  page: Page,
  options: { pipelines?: ReturnType<typeof pipelineOf>[]; canManage?: boolean } = {},
): Promise<DashboardApi> {
  await signedIn(page);
  const api: DashboardApi = { reads: [], numbers: busy, failing: false };
  await page.route('**/api/v1/pipelines', (route) =>
    route.fulfill({
      json: pipelineConfiguration.parse({
        items: options.pipelines ?? [
          pipelineOf(weddings, 'Weddings'),
          pipelineOf(corporate, 'Corporate events'),
        ],
        revision: 'b'.repeat(64),
        canManage: options.canManage ?? false,
      }),
    }),
  );
  await page.route(/\/api\/v1\/reports\/opportunities\?/, async (route) => {
    const query = opportunityReportQuery.safeParse(
      Object.fromEntries(new URL(route.request().url()).searchParams),
    );
    if (!query.success) {
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Unprocessable', status: 422 }),
      });
      return;
    }
    api.reads.push(query.data);
    if (api.failing) {
      await route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Unavailable', status: 503 }),
      });
      return;
    }
    await route.fulfill({ json: opportunityReport.parse({ ...query.data, ...api.numbers }) });
  });
  return api;
}

const widget = (page: Page, name: string): Locator =>
  page.getByRole('region', { name, exact: true });
const names = [
  'Opportunity status',
  'Opportunity value',
  'Conversion rate',
  'Funnel',
  'Stages distribution',
] as const;

async function rowsOf(table: Locator): Promise<string[][]> {
  return table
    .getByRole('row')
    .evaluateAll((rows) =>
      rows.map((row) =>
        [...row.querySelectorAll('th, td')].map((cell) =>
          cell.textContent.replaceAll(/\s+/g, ' ').trim(),
        ),
      ),
    );
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const noSidewaysScroll = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

const DAY = 86_400_000;

test.describe('at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('shows the five widgets from one read of the report, with the tasks under them', async ({
    page,
  }) => {
    const api = await dashboard(page);
    await page.goto(inHarbor());
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

    const status = widget(page, 'Opportunity status');
    await expect(status.getByRole('table', { name: 'Opportunity status' })).toBeVisible();
    expect(await rowsOf(status.getByRole('table'))).toEqual([
      ['Status', 'Opportunities'],
      ['Open', '4'],
      ['Won', '3'],
      ['Lost', '0'],
    ]);
    await expect(status.getByText('7 opportunities', { exact: true })).toBeVisible();

    // A currency is never added to another: one table for each.
    const value = widget(page, 'Opportunity value');
    expect(await rowsOf(value.getByRole('table', { name: 'Opportunity value (KES)' }))).toEqual([
      ['Status', 'Value'],
      ['Open', 'KES 390,000'],
      ['Won', 'KES 128,000.50'],
      ['Lost', 'KES 0'],
    ]);
    expect(await rowsOf(value.getByRole('table', { name: 'Opportunity value (USD)' }))).toEqual([
      ['Status', 'Value'],
      ['Open', 'USD 1,200'],
      ['Won', 'USD 0'],
      ['Lost', 'USD 0'],
    ]);

    const conversion = widget(page, 'Conversion rate');
    await expect(conversion.getByText('42.86%', { exact: true })).toBeVisible();
    await expect(conversion.getByText('3 won of 7 opportunities', { exact: true })).toBeVisible();
    await expect(conversion.getByText('KES 128,000.50', { exact: true })).toBeVisible();

    expect(await rowsOf(widget(page, 'Funnel').getByRole('table'))).toEqual([
      ['Stage', 'Cumulative', 'Next step conversion'],
      ['New lead 7 opportunities · KES 518,000.50 · USD 1,200', '100.00%', '—'],
      ['Quoted 5 opportunities · KES 300,000', '71.43%', '71.43%'],
      ['Booked 3 opportunities', '42.86%', '60.00%'],
    ]);
    expect(await rowsOf(widget(page, 'Stages distribution').getByRole('table'))).toEqual([
      ['Stage', 'Open', 'Value'],
      ['New lead', '2', 'KES 90,000'],
      ['Quoted', '2', 'KES 300,000USD 1,200'],
      ['Booked', '0', '—'],
    ]);

    // One read: the last 30 days to the end of today, by the last status change.
    expect(api.reads).toHaveLength(1);
    const [read] = api.reads;
    expect(read).toMatchObject({ pipelineId: weddings, dateProperty: 'status_changed' });
    const span = Date.parse(read?.to ?? '') - Date.parse(read?.from ?? '');
    // A day here is 23 to 25 hours long where the clocks change.
    expect(Math.round(span / DAY)).toBe(30);
    await expectChoice(page.getByRole('combobox', { name: 'Date range' }), 'last_30_days');

    // Three cards in the first row, two in the second, balanced, then the tasks.
    const boxes = await Promise.all(names.map((name) => widget(page, name).boundingBox()));
    const [one, two, three, four, five] = boxes;
    if (!one || !two || !three || !four || !five) throw new Error('A widget is not laid out');
    expect(two.y).toBe(one.y);
    expect(three.y).toBe(one.y);
    expect(Math.abs(two.width - one.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(three.width - one.width)).toBeLessThanOrEqual(1);
    expect(two.height).toBe(one.height);
    expect(four.y).toBeGreaterThan(one.y + one.height);
    expect(five.y).toBe(four.y);
    expect(Math.abs(five.width - four.width)).toBeLessThanOrEqual(1);
    expect(await reachesRightGutter(page, widget(page, 'Stages distribution'))).toBe(true);
    const tasks = page.getByText('No overdue tasks.', { exact: true });
    await expect(tasks).toBeVisible();
    expect((await tasks.boundingBox())?.y).toBeGreaterThan(five.y + five.height);

    // Controls are 36 px tall on a desktop.
    for (const control of await page.getByRole('main').getByRole('combobox').all())
      expect((await control.boundingBox())?.height).toBe(36);
    expect(await noSidewaysScroll(page)).toBe(true);
    await expectNoAccessibilityViolations(page);
  });

  test('reads one widget again for the pipeline and the date chosen on it', async ({ page }) => {
    const api = await dashboard(page);
    await page.goto(inHarbor());
    const funnel = widget(page, 'Funnel');
    await expect(funnel.getByRole('table')).toBeVisible();

    const pipeline = funnel.getByRole('combobox', { name: 'Pipeline for Funnel' });
    await expectChoice(pipeline, weddings);
    await choose(pipeline, corporate);
    await expectChoice(pipeline, corporate);
    await expect.poll(() => api.reads.length).toBe(2);
    expect(api.reads[1]).toMatchObject({ pipelineId: corporate, dateProperty: 'status_changed' });

    const dates = funnel.getByRole('combobox', { name: 'Dates for Funnel' });
    await expectChoice(dates, 'status_changed');
    await choose(dates, 'created');
    await expectChoice(dates, 'created');
    await expect.poll(() => api.reads.length).toBe(3);
    expect(api.reads[2]).toMatchObject({ pipelineId: corporate, dateProperty: 'created' });

    // The other widgets keep theirs.
    await expectChoice(
      widget(page, 'Stages distribution').getByRole('combobox', {
        name: 'Pipeline for Stages distribution',
      }),
      weddings,
    );
    // The report is of one pipeline: there is no "All pipelines".
    await pipeline.click();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveText([
      'Weddings',
      'Corporate events',
    ]);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expectNoAccessibilityViolations(page);
  });

  test('changes the range for every widget, by name or by two days, and keeps it in the address', async ({
    page,
  }) => {
    const api = await dashboard(page);
    await page.goto(inHarbor());
    await expect(widget(page, 'Funnel').getByRole('table')).toBeVisible();

    const range = page.getByRole('combobox', { name: 'Date range' });
    await choose(range, 'last_7_days');
    await expect(page).toHaveURL(inHarbor('?range=last_7_days'));
    await expect.poll(() => api.reads.length).toBe(2);
    const week = api.reads[1];
    expect(Math.round((Date.parse(week?.to ?? '') - Date.parse(week?.from ?? '')) / DAY)).toBe(7);

    // Custom starts as the days that were shown, so nothing is read again until one changes.
    await choose(range, 'custom');
    await expect(page).toHaveURL(/range=custom&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
    const from = page.getByLabel('From', { exact: true });
    const to = page.getByLabel('To', { exact: true });
    await expect(from).toBeVisible();
    expect((await from.boundingBox())?.height).toBe(36);
    await from.fill('2026-09-01');
    await to.fill('2026-09-30');
    await expect(page).toHaveURL(inHarbor('?range=custom&from=2026-09-01&to=2026-09-30'));
    await expect(widget(page, 'Funnel').getByRole('table')).toBeVisible();
    const custom = api.reads.at(-1);
    // The whole of both days, where the reader is.
    expect(await page.evaluate(() => new Date(2026, 8, 1).toISOString())).toBe(custom?.from);
    expect(await page.evaluate(() => new Date(2026, 9, 1).toISOString())).toBe(custom?.to);

    // A range that ends before it starts is not asked for.
    const before = api.reads.length;
    await to.fill('2026-08-01');
    await expect(page.getByRole('alert')).toHaveText('End the range on or after its first day.');
    await expect(widget(page, 'Funnel')).toHaveCount(0);
    expect(api.reads).toHaveLength(before);
    await expectNoAccessibilityViolations(page);

    // The address alone brings the range back.
    await page.goto(inHarbor('?range=last_month'));
    await expectChoice(page.getByRole('combobox', { name: 'Date range' }), 'last_month');
    await expect(widget(page, 'Funnel').getByRole('table')).toBeVisible();
  });

  test('says "No data found" in each widget of an empty range', async ({ page }) => {
    const api = await dashboard(page);
    api.numbers = nothing;
    await page.goto(inHarbor());
    for (const name of names) {
      await expect(widget(page, name).getByText('No data found', { exact: true })).toBeVisible();
      await expect(widget(page, name).getByRole('table')).toHaveCount(0);
    }
    await expectNoAccessibilityViolations(page);
  });

  test('offers to try again when the numbers cannot be read', async ({ page }) => {
    const api = await dashboard(page);
    api.failing = true;
    await page.goto(inHarbor());
    const funnel = widget(page, 'Funnel');
    await expect(funnel.getByRole('alert')).toContainText("The numbers couldn't be loaded.", {
      timeout: 20_000,
    });
    await expectNoAccessibilityViolations(page);
    api.failing = false;
    await funnel.getByRole('button', { name: 'Try again' }).click();
    await expect(funnel.getByRole('table', { name: 'Funnel' })).toBeVisible();
    // The tasks are their own card: they were there all along.
    await expect(page.getByText('No overdue tasks.', { exact: true })).toBeVisible();
  });

  test('sends someone who may manage pipelines to create the first one', async ({ page }) => {
    const api = await dashboard(page, { pipelines: [], canManage: true });
    await page.goto(inHarbor());
    await expect(page.getByRole('heading', { name: 'No pipeline yet' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create pipeline' })).toHaveAttribute(
      'href',
      inHarbor('/deals/pipelines?mode=create'),
    );
    expect(api.reads).toHaveLength(0);
    await expect(page.getByText('No overdue tasks.', { exact: true })).toBeVisible();
    await expectNoAccessibilityViolations(page);
  });

  test('tells someone who may not manage pipelines to ask for one', async ({ page }) => {
    await dashboard(page, { pipelines: [], canManage: false });
    await page.goto(inHarbor());
    await expect(page.getByRole('heading', { name: 'No pipeline yet' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create pipeline' })).toHaveCount(0);
    await expect(page.getByText(/Ask someone who manages pipelines/)).toBeVisible();
  });
});

test.describe('at 360 px', () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test('stacks the widgets in one column with 44 px controls and no sideways scrolling', async ({
    page,
  }) => {
    await dashboard(page);
    await page.goto(inHarbor());
    await expect(widget(page, 'Stages distribution').getByRole('table')).toBeVisible();

    let bottom = 0;
    for (const name of names) {
      const box = await widget(page, name).boundingBox();
      if (!box) throw new Error(`${name} is not laid out`);
      expect(box.x).toBe(16);
      expect(box.width).toBe(328);
      expect(box.y).toBeGreaterThanOrEqual(bottom);
      bottom = box.y + box.height;
    }
    for (const control of await page.getByRole('main').getByRole('combobox').all())
      expect((await control.boundingBox())?.height).toBe(44);
    await expect(page.getByText('No overdue tasks.', { exact: true })).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    await expectNoAccessibilityViolations(page);

    // A custom range's two fields fit, at 44 px.
    await choose(page.getByRole('combobox', { name: 'Date range' }), 'custom');
    const from = page.getByLabel('From', { exact: true });
    await expect(from).toBeVisible();
    expect((await from.boundingBox())?.height).toBe(44);
    expect(await noSidewaysScroll(page)).toBe(true);
    await expectNoAccessibilityViolations(page);
  });
});

test.describe('at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('fills the width of the page', async ({ page }) => {
    await dashboard(page);
    await page.goto(inHarbor());
    await expect(widget(page, 'Stages distribution').getByRole('table')).toBeVisible();
    expect(await reachesRightGutter(page, widget(page, 'Conversion rate'))).toBe(true);
    expect(await reachesRightGutter(page, widget(page, 'Stages distribution'))).toBe(true);
    const first = await widget(page, 'Opportunity status').boundingBox();
    // The sidebar is 224 px wide, and the page's gutter 16.
    expect(first?.x).toBe(240);
    expect(await noSidewaysScroll(page)).toBe(true);
  });
});
