// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { opportunityReport, type OpportunityReport, type Pipeline } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSearch } from './dashboard-report-rules';
import DashboardWidgets from './dashboard-widgets';

interface ReportQuery {
  readonly pipelineId: string;
  readonly from: string;
  readonly to: string;
  readonly dateProperty: string;
}
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
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({
    to,
    params,
    search,
    children,
  }: {
    to: string;
    params: { slug: string };
    search?: Record<string, string>;
    children: ReactNode;
  }) => (
    <a href={`${to.replace('$slug', params.slug)}?${new URLSearchParams(search ?? {}).toString()}`}>
      {children}
    </a>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const sales = 'pipe_01k8e2wzr0e008000000000001';
const corporate = 'pipe_01k8e2wzr0e008000000000002';
const lead = 'stage_01k8e2wzr0e008000000000001';
const quoted = 'stage_01k8e2wzr0e008000000000002';
const booked = 'stage_01k8e2wzr0e008000000000003';

const pipelineOf = (id: string, name: string, archived = false): Pipeline => ({
  id,
  name,
  description: '',
  archived,
  stages: [],
});

/** Seven deals: four open, three won; checked against the contract before it is served. */
const report: OpportunityReport = opportunityReport.parse({
  pipelineId: sales,
  from: '2026-09-11T21:00:00.000Z',
  to: '2026-10-11T21:00:00.000Z',
  dateProperty: 'status_changed',
  count: 7,
  statuses: [
    { status: 'open', count: 4, totals: [{ currency: 'KES', amount: '390000.0000' }] },
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
      totals: [{ currency: 'KES', amount: '518000.5000' }],
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
    { stageId: booked, name: 'Booked', count: 0, totals: [], cumulativeRate: 0, nextStepRate: 0 },
  ],
  stages: [
    {
      stageId: lead,
      name: 'New lead',
      archived: false,
      count: 3,
      totals: [{ currency: 'KES', amount: '90000.0000' }],
    },
    {
      stageId: quoted,
      name: 'Quoted',
      archived: true,
      count: 1,
      totals: [
        { currency: 'KES', amount: '300000.0000' },
        { currency: 'USD', amount: '120.0000' },
      ],
    },
    { stageId: booked, name: 'Booked', archived: false, count: 0, totals: [] },
  ],
});

const emptyReport: OpportunityReport = opportunityReport.parse({
  ...report,
  count: 0,
  statuses: report.statuses.map((status) => ({ ...status, count: 0, totals: [] })),
  conversion: { won: 0, total: 0, rate: null, wonTotals: [] },
  funnel: report.funnel.map((section) => ({
    ...section,
    count: 0,
    totals: [],
    cumulativeRate: null,
    nextStepRate: null,
  })),
  stages: report.stages
    .filter((stage) => !stage.archived)
    .map((stage) => ({ ...stage, count: 0, totals: [] })),
});

function serve(
  options: {
    pipelines?: Pipeline[];
    canManage?: boolean;
    reportOf?: (query: ReportQuery) => unknown;
  } = {},
): void {
  server.answer = (operation, input) => {
    if (operation === 'getPipelines')
      return {
        items: options.pipelines ?? [
          pipelineOf(sales, 'Sales'),
          pipelineOf(corporate, 'Corporate'),
        ],
        revision: 'a'.repeat(64),
        canManage: options.canManage ?? false,
      };
    if (operation === 'getOpportunityReport') {
      const { query } = input as { query: ReportQuery };
      return (options.reportOf ?? (() => report))(query);
    }
    // The email and booking widgets read their own reports: quiet ones here.
    if (operation === 'getEmailReport') return emailReport;
    if (operation === 'getAppointmentReport') return appointmentReport;
    throw new Error(`Unexpected ${operation}`);
  };
}

const emailReport = {
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-08T00:00:00.000Z',
  timeZone: 'UTC',
  totals: {
    sent: 12,
    notSent: 3,
    bounced: 1,
    hardBounced: 1,
    received: 5,
    replies: 4,
    unsubscribed: 2,
  },
  notSentReasons: [
    { reason: 'consent_required', count: 2 },
    { reason: 'made_up_reason', count: 1 },
  ],
  senders: [
    { sender: 'workflow', count: 9 },
    { sender: 'person', count: 3 },
    { sender: 'assistant', count: 0 },
    { sender: 'other', count: 0 },
  ],
  days: [
    {
      date: '2026-10-01',
      sent: 12,
      notSent: 3,
      bounced: 1,
      received: 5,
      replies: 4,
      unsubscribed: 2,
    },
  ],
};
const tally = (counts: Partial<Record<string, number>>) => ({
  count: Object.values(counts).reduce<number>((sum, each) => sum + (each ?? 0), 0),
  statuses: ['booked', 'confirmed', 'cancelled', 'no_show', 'completed', 'invalid'].map(
    (status) => ({
      status,
      count: counts[status] ?? 0,
    }),
  ),
});
const appointmentReport = {
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-08T00:00:00.000Z',
  timeZone: 'UTC',
  dateProperty: 'starts',
  ...tally({ booked: 2, confirmed: 1, completed: 3, no_show: 1 }),
  days: [{ date: '2026-10-01', ...tally({ booked: 2, confirmed: 1, completed: 3, no_show: 1 }) }],
  calendars: [
    {
      calendar: { id: 'cal_01k8e2wzr0e008000000000001', name: 'Site visits' },
      ...tally({ booked: 2 }),
    },
  ],
  teamMembers: [
    { assignee: null, ...tally({ booked: 1 }) },
    { assignee: { membershipId: null, name: '' }, ...tally({ booked: 1 }) },
  ],
  upcoming: { from: '2026-10-08T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z', count: 4 },
};

const reportCalls = (): ReportQuery[] =>
  server.calls
    .filter((call) => call.operation === 'getOpportunityReport')
    .map((call) => (call.input as { query: ReportQuery }).query);

function Harness({ initial }: { readonly initial: DashboardSearch }): ReactElement {
  const [search, setSearch] = useState(initial);
  return (
    <>
      <output data-testid="search">{JSON.stringify(search)}</output>
      <DashboardWidgets search={search} onSearch={setSearch} />
    </>
  );
}

function show(initial: DashboardSearch = {}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <Harness initial={initial} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  control: HTMLElement,
  option: string,
): Promise<void> {
  await user.click(control);
  await user.click(await screen.findByRole('option', { name: option }));
}

const card = (name: string): Promise<HTMLElement> => screen.findByRole('region', { name });
const rowsOf = (table: HTMLElement): string[][] =>
  within(table)
    .getAllByRole('row')
    .map((row) =>
      [...row.querySelectorAll('th, td')].map((cell) =>
        cell.textContent.replaceAll(/\s+/g, ' ').trim(),
      ),
    );

describe('the dashboard widgets', () => {
  it('draw the five widgets from one read of the report, each number also as text', async () => {
    serve();
    show();

    const status = await card('Opportunity status');
    expect(
      rowsOf(await within(status).findByRole('table', { name: 'Opportunity status' })),
    ).toEqual([
      ['Status', 'Opportunities'],
      ['Open', '4'],
      ['Won', '3'],
      ['Lost', '0'],
    ]);
    expect(within(status).getByText('7 opportunities')).toBeTruthy();

    const value = await card('Opportunity value');
    expect(rowsOf(within(value).getByRole('table', { name: 'Opportunity value' }))).toEqual([
      ['Status', 'Value'],
      ['Open', 'KES 390,000'],
      ['Won', 'KES 128,000.50'],
      ['Lost', 'KES 0'],
    ]);

    const conversion = await card('Conversion rate');
    expect(within(conversion).getByText('42.86%')).toBeTruthy();
    expect(within(conversion).getByText('3 won of 7 opportunities')).toBeTruthy();
    expect(within(conversion).getByText('Won revenue')).toBeTruthy();
    expect(within(conversion).getByText('KES 128,000.50')).toBeTruthy();

    const funnel = await card('Funnel');
    expect(rowsOf(within(funnel).getByRole('table', { name: 'Funnel' }))).toEqual([
      ['Stage', 'Cumulative', 'Next step conversion'],
      ['New lead 7 opportunities · KES 518,000.50', '100.00%', '—'],
      ['Quoted 5 opportunities · KES 300,000', '71.43%', '71.43%'],
      ['Booked 0 opportunities', '0.00%', '0.00%'],
    ]);

    const stages = await card('Stages distribution');
    expect(rowsOf(within(stages).getByRole('table', { name: 'Stages distribution' }))).toEqual([
      ['Stage', 'Open', 'Value'],
      ['New lead', '3', 'KES 90,000'],
      ['Quoted (archived)', '1', 'KES 300,000USD 120'],
      ['Booked', '0', '—'],
    ]);

    // Five widgets on the same pipeline, range and date read the report once.
    const calls = reportCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ pipelineId: sales, dateProperty: 'status_changed' });
    expect(opportunityReport.shape.from.safeParse(calls[0]?.from).success).toBe(true);
    expect(Date.parse(calls[0]?.to ?? '') - Date.parse(calls[0]?.from ?? '')).toBe(30 * 86_400_000);
  });

  it('draws each bar and the ring to the numbers beside them', async () => {
    serve();
    show();
    const status = await card('Opportunity status');
    await within(status).findByRole('table');
    const shares = (region: HTMLElement): (string | null)[] =>
      [...region.querySelectorAll('[data-share]')].map((bar) => bar.getAttribute('data-share'));
    expect(shares(status)).toEqual(['100', '75', '0']);
    expect(shares(await card('Funnel'))).toEqual(['100', '71.43', '0']);
    expect(shares(await card('Stages distribution'))).toEqual(['100', '33.33', '0']);
    const arc = (await card('Conversion rate')).querySelector('[data-ring]');
    expect(arc?.getAttribute('stroke-dasharray')).toBe('134.64 179.52');
    // Drawings are for the eye only: the text beside them is what is read out.
    for (const drawing of document.querySelectorAll('svg'))
      expect(drawing.getAttribute('aria-hidden')).toBe('true');
  });

  it('reads a widget again for the pipeline and the date chosen on it alone', async () => {
    serve();
    show();
    const user = userEvent.setup();
    const funnel = await card('Funnel');
    await within(funnel).findByRole('table');

    await choose(
      user,
      within(funnel).getByRole('combobox', { name: 'Pipeline for Funnel' }),
      'Corporate',
    );
    await waitFor(() => {
      expect(reportCalls()).toHaveLength(2);
    });
    expect(reportCalls()[1]).toMatchObject({
      pipelineId: corporate,
      dateProperty: 'status_changed',
    });

    await choose(
      user,
      within(funnel).getByRole('combobox', { name: 'Dates for Funnel' }),
      'Created date',
    );
    await waitFor(() => {
      expect(reportCalls()).toHaveLength(3);
    });
    expect(reportCalls()[2]).toMatchObject({ pipelineId: corporate, dateProperty: 'created' });
    // There is no "All pipelines": the report is of one pipeline.
    await user.click(within(funnel).getByRole('combobox', { name: 'Pipeline for Funnel' }));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Sales',
      'Corporate',
    ]);
  });

  it('changes the range for every widget from the toolbar', async () => {
    serve();
    show();
    const user = userEvent.setup();
    await within(await card('Funnel')).findByRole('table');

    await choose(user, screen.getByRole('combobox', { name: 'Date range' }), 'Last 7 days');
    expect(screen.getByTestId('search').textContent).toBe('{"range":"last_7_days"}');
    await waitFor(() => {
      expect(reportCalls()).toHaveLength(2);
    });
    const [, week] = reportCalls();
    expect(Date.parse(week?.to ?? '') - Date.parse(week?.from ?? '')).toBe(7 * 86_400_000);
  });

  it('takes a custom range from two date fields, and says why one cannot be read', async () => {
    serve();
    show({ range: 'custom', from: '2026-09-01', to: '2026-09-30' });
    await within(await card('Funnel')).findByRole('table');
    expect(reportCalls()[0]).toMatchObject({
      from: new Date(2026, 8, 1).toISOString(),
      to: new Date(2026, 9, 1).toISOString(),
    });

    const user = userEvent.setup();
    const from = screen.getByLabelText('From');
    await user.clear(from);
    await user.type(from, '2026-10-05');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'End the range on or after its first day.',
    );
    expect(screen.queryByRole('region', { name: 'Funnel' })).toBeNull();
    expect(reportCalls()).toHaveLength(1);

    const to = screen.getByLabelText('To');
    await user.clear(to);
    expect((await screen.findByRole('alert')).textContent).toBe('Choose both days.');
    await user.type(to, '2026-10-06');
    await within(await card('Funnel')).findByRole('table');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('starts a custom range from the days that were shown', async () => {
    serve();
    show({ range: 'last_month' });
    const user = userEvent.setup();
    await within(await card('Funnel')).findByRole('table');
    await choose(user, screen.getByRole('combobox', { name: 'Date range' }), 'Custom range');
    const search = JSON.parse(screen.getByTestId('search').textContent) as DashboardSearch;
    expect(search.range).toBe('custom');
    expect(search.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(screen.getByLabelText<HTMLInputElement>('From').value).toBe(search.from);
    expect(screen.getByLabelText<HTMLInputElement>('To').value).toBe(search.to);
  });

  it('says "No data found" in each widget of an empty range', async () => {
    serve({ reportOf: () => emptyReport });
    show();
    for (const name of [
      'Opportunity status',
      'Opportunity value',
      'Conversion rate',
      'Funnel',
      'Stages distribution',
    ]) {
      const region = await card(name);
      expect(await within(region).findByText('No data found')).toBeTruthy();
      expect(within(region).queryByRole('table')).toBeNull();
    }
  });

  it('offers to try again when the numbers cannot be read, widget by widget', async () => {
    let failing = true;
    serve({
      reportOf: () => {
        if (failing) throw new Error('503');
        return report;
      },
    });
    show();
    const user = userEvent.setup();
    const funnel = await card('Funnel');
    const alert = await within(funnel).findByRole('alert');
    expect(alert.textContent).toContain("The numbers couldn't be loaded.");
    failing = false;
    await user.click(within(funnel).getByRole('button', { name: 'Try again' }));
    expect(await within(funnel).findByRole('table', { name: 'Funnel' })).toBeTruthy();
  });

  it('shows the email and booking numbers of the same dates, in plain words', async () => {
    serve();
    show();
    const email = await card('Email');
    expect((await within(email).findByText('Sent')).previousElementSibling?.textContent).toBe('12');
    expect(within(email).getByText('Unsubscribed').previousElementSibling?.textContent).toBe('2');
    // A reason with words of its own, and one this install has none for yet.
    expect(within(email).getByText('No consent to email')).toBeTruthy();
    expect(within(email).getByText('made up reason')).toBeTruthy();
    expect(within(email).getByText('Workflows').nextElementSibling?.textContent).toBe('9');
    // Nothing the server does not count is offered.
    expect(within(email).queryByText(/Opened|Clicked|Delivered/)).toBeNull();
    const bookings = await card('Bookings');
    expect((await within(bookings).findByText('Showed')).previousElementSibling?.textContent).toBe(
      '3',
    );
    expect(
      within(bookings).getByText('Booked or confirmed').previousElementSibling?.textContent,
    ).toBe('3');
    expect(within(bookings).getByText(/4 more are booked for the next 7 days/)).toBeTruthy();
    expect(within(bookings).getByText('Nobody assigned')).toBeTruthy();
    expect(within(bookings).getByText('Former team member')).toBeTruthy();
    const asked = server.calls.find((call) => call.operation === 'getEmailReport')?.input as {
      query: { from: string; to: string };
    };
    expect(asked.query).toEqual({
      from: reportCalls()[0]?.from,
      to: reportCalls()[0]?.to,
    });
  });

  it('offers to try again when the pipelines cannot be read', async () => {
    let failing = true;
    serve();
    const answer = server.answer;
    server.answer = (operation, input) => {
      if (operation === 'getPipelines' && failing) throw new Error('503');
      return answer(operation, input);
    };
    show();
    const user = userEvent.setup();
    expect((await screen.findByRole('alert')).textContent).toContain(
      "The dashboard couldn't be loaded.",
    );
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await card('Funnel')).toBeTruthy();
  });

  it('sends someone who may manage pipelines to create the first one', async () => {
    serve({ pipelines: [], canManage: true });
    show();
    const link = await screen.findByRole('link', { name: 'Create pipeline' });
    expect(link.getAttribute('href')).toBe('/b/harbor/deals/pipelines?mode=create');
    expect(screen.getByRole('heading', { name: 'No pipeline yet' })).toBeTruthy();
    expect(reportCalls()).toHaveLength(0);
  });

  it('tells anyone else to ask for a pipeline', async () => {
    serve({ pipelines: [], canManage: false });
    show();
    expect(await screen.findByRole('heading', { name: 'No pipeline yet' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Create pipeline' })).toBeNull();
    expect(screen.getByText(/Ask someone who manages pipelines/)).toBeTruthy();
  });

  it('offers an archived pipeline only when there is no other', async () => {
    serve({ pipelines: [pipelineOf(corporate, 'Old corporate', true)] });
    show();
    await within(await card('Funnel')).findByRole('table');
    expect(reportCalls()[0]).toMatchObject({ pipelineId: corporate });
  });
});
