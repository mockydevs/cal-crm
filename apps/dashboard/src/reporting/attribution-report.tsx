// Reporting → Attribution report: where contacts came from and what each source produced,
// by their first or their latest touch. Two views, as GoHighLevel has them: the Conversion
// report (leads over time, and the numbers for each session source) and the Source report
// (campaigns, referrers, and the newest touches). Every number is the server's (GET
// /reports/attribution).
import { Trans, useLingui } from '@lingui/react/macro';
import { getAttributionReport, type AttributionReport, type ReportCell } from '@repo/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { ListProblem } from '../list-table';
import { Page } from '../shell/page';
import { useBusiness } from '../workspace';
import { ChartEmpty, DataTable, LineChart } from './charts';
import {
  axisText,
  bucketText,
  cellLines,
  cellOrder,
  countText,
  momentText,
  NOTHING,
} from './format';
import { isForbidden, reportingKeys, retryFaults } from './keys';
import {
  Loading,
  NoAccess,
  NumberCard,
  ReportCard,
  ResolvedRange,
  SearchBox,
  Switch,
  useCatalog,
} from './parts';
import { RangeControl } from './range-control';
import {
  rangeOfSearch,
  replaceRange,
  withCustomDays,
  withoutKeys,
  withRangeChoice,
} from './query-rules';
import type { TableColumn, TableRow } from './result-model';
import { useReportWords, type ReportWords } from './words';

const route = getRouteApi('/_app/b/$slug/reports/attribution');

interface Funnel {
  readonly leads: number;
  readonly appointments: number;
  readonly opportunities: number;
  readonly won: number;
  readonly wonValue: ReportCell;
}

export function AttributionReportPage(): ReactElement {
  const { t, i18n } = useLingui();
  const words = useReportWords();
  const business = useBusiness();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const catalog = useCatalog(business.id);
  const range = rangeOfSearch(search);
  const attribution: 'first' | 'latest' = search.attribution === 'latest' ? 'latest' : 'first';
  const view = search.view === 'source' ? 'source' : 'conversion';
  const query = range.ok ? { ...range.input, attribution } : undefined;
  const report = useQuery({
    queryKey: reportingKeys.attribution(business.id, query),
    queryFn: () => apiIn(business.id).request(getAttributionReport, { query: query ?? {} }),
    enabled: query !== undefined,
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const set = (next: typeof search): void => {
    void navigate({ search: next, replace: true });
  };
  const data = report.data;
  const shownDays =
    search.range === 'custom'
      ? { from: search.from ?? '', to: search.to ?? '' }
      : { from: data?.range.from ?? '', to: data?.range.to ?? '' };

  if (isForbidden(report.error) || isForbidden(catalog.error))
    return (
      <Page title={t`Attribution report`}>
        <NoAccess />
      </Page>
    );

  return (
    <Page title={t`Attribution report`}>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <RangeControl
            presets={catalog.data?.presets}
            state={range}
            days={shownDays}
            onChoice={(choice) => {
              set(replaceRange(search, withRangeChoice(choice, data?.range)));
            }}
            onDays={(from, to) => {
              set(replaceRange(search, withCustomDays(from, to)));
            }}
          />
          <Switch
            label={t`Which touch a contact is counted under`}
            value={attribution}
            onChange={(value) => {
              set(
                value === 'latest'
                  ? { ...search, attribution: 'latest' }
                  : withoutKeys(search, 'attribution'),
              );
            }}
            views={[
              { value: 'first', label: t`First attribution` },
              { value: 'latest', label: t`Latest attribution` },
            ]}
          />
          <Switch
            label={t`Report`}
            value={view}
            onChange={(value) => {
              set(value === 'source' ? { ...search, view: 'source' } : withoutKeys(search, 'view'));
            }}
            views={[
              { value: 'conversion', label: t`Conversion report` },
              { value: 'source', label: t`Source report` },
            ]}
          />
        </div>
        {data === undefined ? null : <ResolvedRange range={data.range} timeZone={data.timeZone} />}
      </div>
      {report.isError ? (
        <ListProblem
          onRetry={() => {
            void report.refetch();
          }}
        >
          <Trans>The attribution report couldn't be loaded.</Trans>
        </ListProblem>
      ) : null}
      {data === undefined ? (
        range.ok && !report.isError ? (
          <Loading />
        ) : null
      ) : (
        <div className="flex min-w-0 flex-col gap-4" aria-busy={report.isPlaceholderData}>
          <Totals totals={data.totals} locale={i18n.locale} />
          <p className="text-xs text-muted-foreground">
            <Trans>
              A lead is a contact, counted on the day it was added. Won value is the value of the
              opportunities won, not money received.
            </Trans>
          </p>
          {view === 'conversion' ? (
            <Conversion data={data} locale={i18n.locale} words={words} />
          ) : (
            <Sources data={data} slug={business.slug} locale={i18n.locale} words={words} />
          )}
          <p className="text-xs text-muted-foreground">
            <Trans>
              Capture is still partial: a web chat records only the site its widget is on, and a
              booking made on the booking page counts as Direct Traffic until that page sends the
              visit.
            </Trans>
          </p>
        </div>
      )}
    </Page>
  );
}

function Totals({
  totals,
  locale,
}: {
  readonly totals: Funnel;
  readonly locale: string;
}): ReactElement {
  const { t } = useLingui();
  return (
    <dl
      aria-label={t`Totals`}
      className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
    >
      <NumberCard label={t`Leads`} lines={[countText(totals.leads, locale)]} />
      <NumberCard label={t`Appointments`} lines={[countText(totals.appointments, locale)]} />
      <NumberCard label={t`Opportunities`} lines={[countText(totals.opportunities, locale)]} />
      <NumberCard label={t`Won`} lines={[countText(totals.won, locale)]} />
      <NumberCard label={t`Won value`} lines={cellLines(totals.wonValue, locale)} />
    </dl>
  );
}

/** The five numbers every row of the report carries, as a table's cells. */
function funnelCells(row: Funnel, locale: string): { cells: string[][]; order: number[] } {
  const counts = [row.leads, row.appointments, row.opportunities, row.won];
  return {
    cells: [...counts.map((count) => [countText(count, locale)]), cellLines(row.wonValue, locale)],
    order: [...counts, cellOrder(row.wonValue)],
  };
}

function useFunnelColumns(first: readonly TableColumn[]): TableColumn[] {
  const { t } = useLingui();
  return [
    ...first,
    { key: 'leads', label: t`Leads`, numeric: true },
    { key: 'appointments', label: t`Appointments`, numeric: true },
    { key: 'opportunities', label: t`Opportunities`, numeric: true },
    { key: 'won', label: t`Won`, numeric: true },
    { key: 'wonValue', label: t`Won value`, numeric: true },
  ];
}

function Conversion({
  data,
  locale,
  words,
}: {
  readonly data: AttributionReport;
  readonly locale: string;
  readonly words: ReportWords;
}): ReactElement {
  const { t } = useLingui();
  const grain = data.series.grain;
  const columns = useFunnelColumns([
    { key: 'sessionSource', label: t`Session source`, numeric: false },
  ]);
  const rows: TableRow[] = data.sources.map((row) => {
    const name = words.sessionSource(row.sessionSource);
    const numbers = funnelCells(row, locale);
    return {
      key: row.sessionSource ?? 'none',
      other: false,
      cells: [[name], ...numbers.cells],
      order: [name.toLowerCase(), ...numbers.order],
    };
  });
  const leads = t`Leads`;
  return (
    <>
      <ReportCard
        title={t`Leads over time`}
        note={
          grain === 'day' ? (
            <Trans>Contacts added each day.</Trans>
          ) : grain === 'week' ? (
            <Trans>Contacts added each week, from Monday.</Trans>
          ) : (
            <Trans>Contacts added each month.</Trans>
          )
        }
      >
        {data.totals.leads === 0 ? (
          <ChartEmpty>
            <Trans>No contacts were added in these dates.</Trans>
          </ChartEmpty>
        ) : (
          <LineChart
            area
            label={t`Leads over time`}
            categoryLabel={grain === 'day' ? t`Day` : grain === 'week' ? t`Week` : t`Month`}
            tickText={(value) => axisText(value, locale)}
            categories={data.series.points.map((point) => {
              const long = bucketText(point.date, grain, locale, 'long');
              return {
                key: point.date,
                label: bucketText(point.date, grain, locale),
                long: grain === 'week' ? words.weekOf(long) : long,
              };
            })}
            series={[
              {
                key: 'leads',
                label: leads,
                values: data.series.points.map((point) => point.leads),
                texts: data.series.points.map((point) => countText(point.leads, locale)),
              },
            ]}
          />
        )}
      </ReportCard>
      <ReportCard
        title={t`By session source`}
        note={<Trans>An opportunity is under the session source of its primary contact.</Trans>}
      >
        {rows.length === 0 ? (
          <ChartEmpty />
        ) : (
          <DataTable
            tall
            label={t`Results by session source`}
            columns={columns}
            rows={rows}
            initialSort={{ column: 1, direction: 'desc' }}
          />
        )}
      </ReportCard>
    </>
  );
}

const includes = (texts: readonly (string | null)[], search: string): boolean => {
  const wanted = search.trim().toLowerCase();
  return wanted === '' || texts.some((text) => text?.toLowerCase().includes(wanted) === true);
};

function Sources({
  data,
  slug,
  locale,
  words,
}: {
  readonly data: AttributionReport;
  readonly slug: string;
  readonly locale: string;
  readonly words: ReportWords;
}): ReactElement {
  const { t } = useLingui();
  const [campaignSearch, setCampaignSearch] = useState('');
  const [touchSearch, setTouchSearch] = useState('');
  const unset = t`Not set`;
  const unnamed = t`Unnamed contact`;
  const campaignColumns = useFunnelColumns([
    { key: 'utmSource', label: t`UTM source`, numeric: false },
    { key: 'utmCampaign', label: t`UTM campaign`, numeric: false },
  ]);
  const campaigns: TableRow[] = data.campaigns
    .filter((row) => row.other || includes([row.utmSource, row.utmCampaign], campaignSearch))
    .map((row, index) => {
      const source = row.other ? words.other : (row.utmSource ?? unset);
      const campaign = row.other ? NOTHING : (row.utmCampaign ?? unset);
      const numbers = funnelCells(row, locale);
      return {
        key: `${String(index)}:${row.utmSource ?? ''}:${row.utmCampaign ?? ''}`,
        other: row.other,
        cells: [[source], [campaign], ...numbers.cells],
        order: [source.toLowerCase(), campaign.toLowerCase(), ...numbers.order],
      };
    });
  const referrers: TableRow[] = data.referrers.map((row, index) => {
    const name = row.other ? words.other : (row.referrerDomain ?? t`No referrer`);
    return {
      key: `${String(index)}:${row.referrerDomain ?? ''}`,
      other: row.other,
      cells: [[name], [countText(row.leads, locale)]],
      order: [name.toLowerCase(), row.leads],
    };
  });
  const shownTouches = data.touches.filter((touch) =>
    includes(
      [
        touch.contact.name ?? unnamed,
        touch.utmSource,
        touch.utmMedium,
        touch.utmCampaign,
        touch.utmContent,
        touch.referrerDomain,
        touch.landingUrl,
        words.sessionSource(touch.sessionSource),
        words.medium(touch.medium),
      ],
      touchSearch,
    ),
  );
  const contactIds = new Map<string, string>();
  const touches: TableRow[] = shownTouches.map((touch, index) => {
    const key = `${String(index)}:${touch.touchedAt}`;
    contactIds.set(key, touch.contact.id);
    const texts = [
      momentText(touch.touchedAt, data.timeZone, locale),
      touch.contact.name ?? unnamed,
      touch.first ? t`First` : t`Later`,
      words.medium(touch.medium),
      words.sessionSource(touch.sessionSource),
      touch.utmSource ?? NOTHING,
      touch.utmMedium ?? NOTHING,
      touch.utmCampaign ?? NOTHING,
      touch.utmContent ?? NOTHING,
      touch.referrerDomain ?? NOTHING,
      touch.landingUrl ?? NOTHING,
    ];
    return {
      key,
      other: false,
      cells: texts.map((text) => [text]),
      order: [touch.touchedAt, ...texts.slice(1).map((text) => text.toLowerCase())],
    };
  });
  const touchColumns: TableColumn[] = [
    { key: 'touchedAt', label: t`When`, numeric: false },
    { key: 'contact', label: t`Contact`, numeric: false },
    { key: 'first', label: t`Touch`, numeric: false },
    { key: 'medium', label: t`Medium`, numeric: false },
    { key: 'sessionSource', label: t`Session source`, numeric: false },
    { key: 'utmSource', label: t`UTM source`, numeric: false },
    { key: 'utmMedium', label: t`UTM medium`, numeric: false },
    { key: 'utmCampaign', label: t`UTM campaign`, numeric: false },
    { key: 'utmContent', label: t`UTM content`, numeric: false },
    { key: 'referrer', label: t`Referrer`, numeric: false },
    { key: 'landing', label: t`Landing page`, numeric: false },
  ];
  return (
    <>
      <ReportCard
        title={t`Campaigns`}
        note={
          <Trans>
            By UTM source and campaign: the 50 with the most leads, and the rest added up.
          </Trans>
        }
        aside={
          <SearchBox
            label={t`Search campaigns`}
            value={campaignSearch}
            onChange={setCampaignSearch}
          />
        }
      >
        {data.campaigns.length === 0 ? (
          <ChartEmpty />
        ) : campaigns.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            <Trans>No campaigns match.</Trans>
          </p>
        ) : (
          <DataTable
            label={t`Results by campaign`}
            columns={campaignColumns}
            rows={campaigns}
            initialSort={{ column: 2, direction: 'desc' }}
          />
        )}
      </ReportCard>
      <ReportCard
        title={t`Referrers`}
        note={<Trans>Leads by the site they came from: the top 20, and the rest added up.</Trans>}
      >
        {referrers.length === 0 ? (
          <ChartEmpty />
        ) : (
          <DataTable
            label={t`Leads by referrer`}
            columns={[
              { key: 'referrer', label: t`Referrer`, numeric: false },
              { key: 'leads', label: t`Leads`, numeric: true },
            ]}
            rows={referrers}
            initialSort={{ column: 1, direction: 'desc' }}
          />
        )}
      </ReportCard>
      <ReportCard
        title={t`Latest touches`}
        note={<Trans>The 100 newest touches of these dates.</Trans>}
        aside={
          <SearchBox label={t`Search touches`} value={touchSearch} onChange={setTouchSearch} />
        }
      >
        {data.touches.length === 0 ? (
          <ChartEmpty>
            <Trans>No touches were recorded in these dates.</Trans>
          </ChartEmpty>
        ) : touches.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            <Trans>No touches match.</Trans>
          </p>
        ) : (
          <DataTable
            label={t`Latest touches`}
            columns={touchColumns}
            rows={touches}
            renderCell={(row, column) => {
              const contactId = contactIds.get(row.key);
              return column === 1 && contactId !== undefined ? (
                <Link
                  to="/b/$slug/contacts/$contactId"
                  params={{ slug, contactId }}
                  className="text-link underline"
                >
                  {row.cells[1]?.[0]}
                </Link>
              ) : undefined;
            }}
          />
        )}
      </ReportCard>
    </>
  );
}
