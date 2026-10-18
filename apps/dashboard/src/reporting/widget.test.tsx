// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  reportQuery,
  reportResult,
  type ReportQuery,
  type ReportResult,
  type ReportWidget,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerOf } from '../../e2e/reporting-fixtures';
import { WidgetBody, type ReportDates } from './widget';

interface Server {
  calls: ReportQuery[];
  answer: (query: ReportQuery) => ReportResult | Promise<ReportResult>;
}
const server = vi.hoisted((): Server => ({
  calls: [],
  answer: () => {
    throw new Error('no answer set');
  },
}));
vi.mock('../api', () => ({
  apiIn: () => ({
    request: (_endpoint: unknown, input: { body: ReportQuery }) => {
      server.calls.push(input.body);
      return Promise.resolve().then(() => server.answer(input.body));
    },
  }),
}));

configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 30000 });

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
  server.answer = (query) => answerOf(query);
});
afterEach(cleanup);

const textOf = (element: Element | undefined): string => element?.textContent ?? '';
const attributeOf = (element: Element | undefined, name: string): string | null =>
  element?.getAttribute(name) ?? null;

const dates: ReportDates = { range: { preset: 'last_30_days' }, compare: null };

function widgetOf(rest: Partial<ReportWidget> = {}): ReportWidget {
  return {
    id: 'leads',
    kind: 'bar',
    title: 'Leads by session source',
    query: { source: 'contacts', measures: ['count'], groupBy: ['sessionSource'] },
    w: 6,
    h: 4,
    ...rest,
  };
}

function show(widget: ReportWidget, given: ReportDates = dates, onResolved = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <WidgetBody businessId="biz_test" widget={widget} dates={given} onResolved={onResolved} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return onResolved;
}

const refusal = (status: number, code?: string, message = 'Refused.') =>
  new ApiError({
    type: 'about:blank',
    title: 'Refused',
    status,
    ...(code === undefined ? {} : { errors: [{ path: '', code, message }] }),
  });

describe('a widget’s answer', () => {
  it('says it is loading, then draws a bar chart with every value reachable and in a table', async () => {
    const onResolved = show(widgetOf());
    expect(textOf(screen.getByRole('status'))).toContain('Loading…');
    const chart = await screen.findByRole('group', { name: 'Leads by session source' });
    // What it sent is a query the contract accepts, with the report's range.
    expect(reportQuery.safeParse(server.calls[0]).success).toBe(true);
    expect(server.calls[0]).toMatchObject({ range: { preset: 'last_30_days' } });
    expect(server.calls[0]).not.toHaveProperty('compare');
    const sent = server.calls[0];
    if (sent === undefined) throw new Error('nothing was sent');
    expect(reportResult.safeParse(answerOf(sent)).success).toBe(true);

    const points = within(chart).getAllByRole('listitem');
    expect(points.map((point) => point.getAttribute('aria-label'))).toEqual([
      'Others: 1',
      'CRM UI: 4',
      'Paid Social: 2',
    ]);
    // One stop for the Tab key; the arrow keys move between the points.
    expect(points.map((point) => point.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(points[0]);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(points[1]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(points[2]);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(points[2]);
    await user.keyboard('{Home}{ArrowLeft}');
    expect(document.activeElement).toBe(points[0]);
    await user.keyboard('{ArrowDown}{ArrowUp}a');
    expect(document.activeElement).toBe(points[0]);

    const table = screen.getByRole('table', { name: 'Leads by session source' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual(['Session sourceContacts', 'Others1', 'CRM UI4', 'Paid Social2']);
    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-09-13', to: '2026-10-12' }),
      'Africa/Nairobi',
    );
  });

  it('draws a number with how it stands against the period before, in words and sign', async () => {
    server.answer = (query) => ({
      ...answerOf(query),
      rows: [],
      totals: [
        15,
        [
          { currency: 'KES', amount: '125000.0000' },
          { currency: 'USD', amount: '40.0000' },
        ],
      ],
      compare: {
        mode: 'previous_period',
        range: answerOf(query).range,
        totals: [12, [{ currency: 'KES', amount: '250000.0000' }]],
      },
    });
    show(
      widgetOf({
        kind: 'stat',
        query: { source: 'opportunities', measures: ['count', 'value'], groupBy: [] },
      }),
      { ...dates, compare: 'previous_period' },
    );
    expect(await screen.findByText('15')).toBeTruthy();
    expect(server.calls[0]).toMatchObject({ compare: 'previous_period' });
    expect(screen.getByText('+25%')).toBeTruthy();
    expect(screen.getByText('up from 12')).toBeTruthy();
    // Each currency on its own line, compared only with itself.
    expect(screen.getByText('KES 125,000')).toBeTruthy();
    expect(screen.getByText('−50%')).toBeTruthy();
    expect(screen.getByText('down from KES 250,000')).toBeTruthy();
    expect(screen.getByText('USD 40')).toBeTruthy();
    expect(screen.getAllByText(/from/)).toHaveLength(2);
  });

  it('says a number did not change, and shows a dash for money with no value', async () => {
    server.answer = (query) => ({
      ...answerOf(query),
      rows: [],
      totals: [3, []],
      compare: { mode: 'previous_year', range: answerOf(query).range, totals: [3, []] },
    });
    show(
      widgetOf({
        kind: 'stat',
        compare: 'previous_year',
        query: { source: 'opportunities', measures: ['count', 'value'], groupBy: [] },
      }),
    );
    expect(await screen.findByText('No change from 3')).toBeTruthy();
    expect(screen.getByText('No value')).toBeTruthy();
  });

  it('draws a donut with each segment’s name, value and share written out', async () => {
    show(widgetOf({ kind: 'donut' }));
    const list = await screen.findByRole('list', { name: 'Leads by session source' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Others114%', 'CRM UI457%', 'Paid Social229%']);
  });

  it('draws a funnel with what each step kept of the one before', async () => {
    show(widgetOf({ kind: 'funnel' }));
    const list = await screen.findByRole('list', { name: 'Leads by session source' });
    const steps = within(list).getAllByRole('listitem');
    expect(textOf(steps[0])).toContain('Others1');
    expect(textOf(steps[1])).toContain('CRM UI4100% of the step before');
    expect(textOf(steps[2])).toContain('Paid Social250% of the step before');
  });

  it('draws horizontal bars with every value written beside its name', async () => {
    show(widgetOf({ kind: 'hbar' }));
    const list = await screen.findByRole('list', { name: 'Leads by session source' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Others1', 'CRM UI4', 'Paid Social2']);
  });

  it('draws a line over time, and an area the same way', async () => {
    show(
      widgetOf({
        kind: 'area',
        title: 'Leads over time',
        query: { source: 'contacts', measures: ['count'], groupBy: [], time: { grain: 'day' } },
      }),
    );
    const chart = await screen.findByRole('group', { name: 'Leads over time' });
    const points = within(chart).getAllByRole('listitem');
    expect(points).toHaveLength(7);
    expect(attributeOf(points[0], 'aria-label')).toBe('Sep 13, 2026: 1');
    const user = userEvent.setup();
    await user.hover(points[1] as Element);
    expect(screen.getByText('Sep 14, 2026: 3')).toBeTruthy();
    await user.unhover(points[1] as Element);
    expect(screen.queryByText('Sep 14, 2026: 3')).toBeNull();
  });

  it('draws money in a panel for each currency, apart from counts', async () => {
    server.answer = (query) => {
      const answer = answerOf(query);
      return {
        ...answer,
        rows: answer.rows.map((row, index) =>
          index === 0
            ? {
                ...row,
                values: [
                  row.values[0] ?? 0,
                  [
                    { currency: 'KES', amount: '25000.0000' },
                    { currency: 'USD', amount: '10.0000' },
                  ],
                ],
              }
            : row,
        ),
      };
    };
    show(
      widgetOf({
        kind: 'bar',
        title: 'Won',
        query: { source: 'opportunities', measures: ['count', 'value'], groupBy: ['status'] },
      }),
    );
    expect(await screen.findByRole('group', { name: 'Won' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Won (KES)' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Won (USD)' })).toBeTruthy();
    expect(screen.getByText('Counts')).toBeTruthy();
  });

  it('draws a table that sorts, marks the row of the rest, and says what was cut', async () => {
    server.answer = (query) => {
      const answer = answerOf(query);
      return {
        ...answer,
        rows: [...answer.rows, { group: [{ key: null, label: '' }], other: true, values: [9] }],
        totals: [16],
        truncated: { other: true, incomplete: true, limit: 3 },
      };
    };
    show(widgetOf({ kind: 'table' }));
    const table = await screen.findByRole('table', { name: 'Leads by session source' });
    const names = () =>
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent);
    expect(names()).toEqual(['Others', 'CRM UI', 'Paid Social', 'OtherThe rest, added up']);
    const user = userEvent.setup();
    await user.click(within(table).getByRole('button', { name: /Contacts/ }));
    expect(names()).toEqual(['CRM UI', 'Paid Social', 'Others', 'OtherThe rest, added up']);
    expect(
      attributeOf(within(table).getByRole('columnheader', { name: /Contacts/ }), 'aria-sort'),
    ).toBe('descending');
    await user.click(within(table).getByRole('button', { name: /Contacts/ }));
    expect(names()).toEqual(['Others', 'Paid Social', 'CRM UI', 'OtherThe rest, added up']);
    await user.click(within(table).getByRole('button', { name: /Session source/ }));
    expect(names()).toEqual(['CRM UI', 'Others', 'Paid Social', 'OtherThe rest, added up']);
    expect(screen.getByText('Showing the top 3; the rest are added up as Other.')).toBeTruthy();
    expect(screen.getByText(/so Other is incomplete/)).toBeTruthy();
    expect(
      attributeOf(
        screen.getByRole('region', { name: 'Leads by session source, table' }),
        'tabindex',
      ),
    ).toBe('0');
  });

  it('shows a table of one total as the number itself', async () => {
    server.answer = (query) => ({ ...answerOf(query), rows: [], totals: [7] });
    show(
      widgetOf({ kind: 'table', query: { source: 'contacts', measures: ['count'], groupBy: [] } }),
    );
    expect(await screen.findByText('7')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says there is no data when nothing was counted', async () => {
    server.answer = (query) => ({ ...answerOf(query), rows: [], totals: [0] });
    show(widgetOf());
    expect(await screen.findByText('No data found for these dates.')).toBeTruthy();
  });

  it('uses the kind as the name of a widget without a title', async () => {
    show(widgetOf({ title: '' }));
    expect(await screen.findByRole('group', { name: 'Bar' })).toBeTruthy();
  });

  it('runs with its own range and comparison in place of the report’s', async () => {
    const onResolved = show(widgetOf({ range: { preset: 'today' }, compare: null }), {
      ...dates,
      compare: 'previous_period',
    });
    await screen.findByRole('group', { name: 'Leads by session source' });
    expect(server.calls[0]).toMatchObject({ range: { preset: 'today' } });
    expect(server.calls[0]).not.toHaveProperty('compare');
    // Its own days are not the report's: the page is not told them.
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('shows a text widget’s words and asks the server nothing', () => {
    show(widgetOf({ kind: 'text', title: 'Notes', text: 'Read this first.', query: undefined }));
    expect(screen.getByText('Read this first.')).toBeTruthy();
    expect(server.calls).toEqual([]);
  });
});

describe('a widget that cannot answer', () => {
  it('says what is wrong with a query before sending it', () => {
    show(
      widgetOf({
        query: {
          source: 'contacts',
          measures: ['count'],
          groupBy: [],
          filters: {
            match: 'all',
            groups: [{ match: 'all', conditions: [{ field: 'utmCampaign', operator: 'is' }] }],
          },
        },
      }),
    );
    const alert = screen.getByRole('alert');
    expect(textOf(alert)).toContain("This widget can't run yet:");
    expect(textOf(alert)).toContain('Give a value.');
    expect(server.calls).toEqual([]);
  });

  it('says a query took too long, and can try again', async () => {
    server.answer = () => {
      throw refusal(422, 'query_timeout', 'The query took too long.');
    };
    show(widgetOf());
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toContain(
      'This query took too long. Narrow the dates, or group by less.',
    );
    // A refusal is not asked again by itself.
    expect(server.calls).toHaveLength(1);
    server.answer = (query) => answerOf(query);
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('group', { name: 'Leads by session source' })).toBeTruthy();
  });

  it('says there were too many requests', async () => {
    server.answer = () => {
      throw refusal(422, 'rate_limited');
    };
    show(widgetOf());
    expect(textOf(await screen.findByRole('alert'))).toContain(
      'Too many requests just now. Wait a minute, then try again.',
    );
  });

  it('says a source needs a permission, with nothing to try again', async () => {
    server.answer = () => {
      throw refusal(403);
    };
    show(widgetOf());
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toContain('You need permission to read what this widget shows.');
    expect(within(alert).queryByRole('button')).toBeNull();
  });

  it('shows the server’s own sentences for a query it refuses', async () => {
    server.answer = () => {
      throw refusal(422, 'unknown_reference', 'Choose a tag of this business.');
    };
    show(widgetOf());
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toContain("The server refused this widget's query:");
    expect(textOf(alert)).toContain('Choose a tag of this business.');
  });

  it('asks again by itself after a fault, then says it could not load', async () => {
    server.answer = () => {
      throw refusal(503);
    };
    show(widgetOf());
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toContain("This widget couldn't be loaded.");
    await waitFor(() => {
      expect(server.calls).toHaveLength(3);
    });
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('treats an error that is not the server’s as a fault', async () => {
    server.answer = () => {
      throw new Error('offline');
    };
    show(widgetOf());
    expect(textOf(await screen.findByRole('alert'))).toContain("This widget couldn't be loaded.");
  });
});
