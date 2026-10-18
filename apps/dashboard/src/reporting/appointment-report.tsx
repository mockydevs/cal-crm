// Reporting → Appointment report, laid out as GoHighLevel's: a card for each status, donuts
// for the channel an appointment was booked through and the session source of its contact,
// then the most booked calendars, the people with the most appointments, the most popular
// days and the calendars with the most cancellations. Every number is the server's (GET
// /reports/appointment-overview), counted over the business's own calendar days.
// Reschedules are not counted by the server yet, so nothing is drawn.
import { Trans, useLingui } from '@lingui/react/macro';
import { getAppointmentOverview, listCalendars, type AppointmentOverview } from '@repo/contracts';
import { Select } from '@repo/ui/components/select';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { apiIn } from '../api';
import { ListProblem } from '../list-table';
import { Page } from '../shell/page';
import { useBusiness } from '../workspace';
import { shareText } from './chart-geometry';
import {
  BarChart,
  ChartEmpty,
  DonutChart,
  HorizontalBarChart,
  type ChartSeries,
  type DonutSegment,
} from './charts';
import { axisText, countText, weekdayText } from './format';
import { isForbidden, reportingKeys, retryFaults } from './keys';
import {
  Loading,
  NoAccess,
  NumberCard,
  ReportCard,
  ResolvedRange,
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
import { useReportWords } from './words';

const route = getRouteApi('/_app/b/$slug/reports/appointments');

const ALL_CALENDARS = 'all';

export function AppointmentReportPage(): ReactElement {
  const { t, i18n } = useLingui();
  const words = useReportWords();
  const business = useBusiness();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const api = apiIn(business.id);
  const catalog = useCatalog(business.id);
  const range = rangeOfSearch(search);
  const dateProperty: 'created' | 'starts' = search.by === 'created' ? 'created' : 'starts';
  const attribution: 'first' | 'latest' = search.attribution === 'latest' ? 'latest' : 'first';
  const query = range.ok
    ? {
        ...range.input,
        dateProperty,
        attribution,
        ...(search.calendar === undefined ? {} : { calendarId: search.calendar }),
      }
    : undefined;
  const overview = useQuery({
    queryKey: reportingKeys.appointments(business.id, query),
    queryFn: () => api.request(getAppointmentOverview, { query: query ?? {} }),
    enabled: query !== undefined,
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const calendars = useQuery({
    queryKey: reportingKeys.calendars(business.id),
    queryFn: () => api.request(listCalendars, { query: { limit: 50 } }),
    staleTime: 60_000,
    retry: retryFaults,
  });
  const set = (next: typeof search): void => {
    void navigate({ search: next, replace: true });
  };
  const data = overview.data;
  const shownDays =
    search.range === 'custom'
      ? { from: search.from ?? '', to: search.to ?? '' }
      : { from: data?.range.from ?? '', to: data?.range.to ?? '' };

  if (isForbidden(overview.error) || isForbidden(catalog.error))
    return (
      <Page title={t`Appointment report`}>
        <NoAccess />
      </Page>
    );

  return (
    <Page title={t`Appointment report`}>
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
            label={t`Which date an appointment is counted by`}
            value={dateProperty}
            onChange={(value) => {
              set(value === 'created' ? { ...search, by: 'created' } : withoutKeys(search, 'by'));
            }}
            views={[
              { value: 'starts', label: t`By start date` },
              { value: 'created', label: t`By booking date` },
            ]}
          />
          <div className="w-full sm:w-56">
            <Select
              aria-label={t`Calendar`}
              value={search.calendar ?? ALL_CALENDARS}
              onValueChange={(value) => {
                set(
                  value === ALL_CALENDARS
                    ? withoutKeys(search, 'calendar')
                    : { ...search, calendar: value },
                );
              }}
            >
              <option value={ALL_CALENDARS}>{t`All calendars`}</option>
              {(calendars.data?.items ?? []).map((calendar) => (
                <option key={calendar.id} value={calendar.id}>
                  {calendar.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {data === undefined ? null : <ResolvedRange range={data.range} timeZone={data.timeZone} />}
      </div>
      {overview.isError ? (
        <ListProblem
          onRetry={() => {
            void overview.refetch();
          }}
        >
          <Trans>The appointment report couldn't be loaded.</Trans>
        </ListProblem>
      ) : null}
      {data === undefined ? (
        range.ok && !overview.isError ? (
          <Loading />
        ) : null
      ) : (
        <Overview
          data={data}
          busy={overview.isPlaceholderData}
          onAttribution={(value) => {
            set(
              value === 'latest'
                ? { ...search, attribution: 'latest' }
                : withoutKeys(search, 'attribution'),
            );
          }}
          locale={i18n.locale}
          words={words}
        />
      )}
    </Page>
  );
}

function Overview({
  data,
  busy,
  onAttribution,
  locale,
  words,
}: {
  readonly data: AppointmentOverview;
  readonly busy: boolean;
  readonly onAttribution: (value: 'first' | 'latest') => void;
  readonly locale: string;
  readonly words: ReturnType<typeof useReportWords>;
}): ReactElement {
  const { t } = useLingui();
  const countOf = (status: AppointmentOverview['statuses'][number]['status']): number =>
    data.statuses.find((each) => each.status === status)?.count ?? 0;
  const invalid = countOf('invalid');
  const invalidText = countText(invalid, locale);
  const of = (count: number): string | undefined =>
    data.total === 0 ? undefined : shareText(count / data.total);
  const cards = [
    { key: 'booked', label: words.appointmentStatus('booked'), count: countOf('booked') },
    { key: 'confirmed', label: words.appointmentStatus('confirmed'), count: countOf('confirmed') },
    { key: 'completed', label: words.appointmentStatus('completed'), count: countOf('completed') },
    { key: 'no_show', label: words.appointmentStatus('no_show'), count: countOf('no_show') },
    // As GoHighLevel counts them: an invalid appointment is a cancelled one.
    {
      key: 'cancelled',
      label: words.appointmentStatus('cancelled'),
      count: countOf('cancelled') + invalid,
    },
  ];
  const segments = (
    rows: readonly { readonly key: string; readonly label: string; readonly count: number }[],
  ): DonutSegment[] =>
    rows
      .filter((row) => row.count > 0)
      .map((row) => ({
        key: row.key,
        label: row.label,
        value: row.count,
        text: countText(row.count, locale),
      }));
  const channels = segments(
    data.channels.map((row) => ({
      key: row.channel,
      label: words.channel(row.channel),
      count: row.count,
    })),
  );
  const sources = segments(
    data.sources.map((row) => ({
      key: row.sessionSource ?? 'none',
      label: words.sessionSource(row.sessionSource),
      count: row.count,
    })),
  );
  const bars = (
    rows: readonly { readonly key: string; readonly label: string; readonly count: number }[],
    label: string,
  ): {
    categories: { key: string; label: string; long: string }[];
    series: ChartSeries[];
  } => ({
    categories: rows.map((row) => ({ key: row.key, label: row.label, long: row.label })),
    series: [
      {
        key: 'count',
        label,
        values: rows.map((row) => row.count),
        texts: rows.map((row) => countText(row.count, locale)),
      },
    ],
  });
  const appointments = t`Appointments`;
  const calendarRows = (rows: AppointmentOverview['calendars']) =>
    rows.map((row, index) => ({
      key: row.calendar.id ?? `gone-${String(index)}`,
      label: row.calendar.name,
      count: row.count,
    }));
  const topCalendars = bars(calendarRows(data.calendars), appointments);
  const cancellations = bars(calendarRows(data.cancellations), t`Cancelled`);
  const people = bars(
    data.teamMembers.map((row, index) => ({
      key: row.assignee?.membershipId ?? `none-${String(index)}`,
      label: row.assignee === null ? t`Unassigned` : row.assignee.name,
      count: row.count,
    })),
    appointments,
  );
  const days = {
    categories: data.weekdays.map((row) => ({
      key: String(row.weekday),
      label: weekdayText(row.weekday, locale, 'short'),
      long: weekdayText(row.weekday, locale, 'long'),
    })),
    series: [
      {
        key: 'count',
        label: appointments,
        values: data.weekdays.map((row) => row.count),
        texts: data.weekdays.map((row) => countText(row.count, locale)),
      },
    ],
  };
  const nothing = data.total === 0;
  const total = countText(data.total, locale);
  return (
    <div className="flex min-w-0 flex-col gap-4" aria-busy={busy}>
      <dl
        aria-label={t`Appointments by status`}
        className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      >
        {cards.map((card) => (
          <NumberCard
            key={card.key}
            label={card.label}
            lines={[countText(card.count, locale)]}
            note={
              card.key === 'cancelled' && invalid > 0 ? (
                <Trans>{invalidText} of them invalid</Trans>
              ) : (
                of(card.count)
              )
            }
          />
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        {data.dateProperty === 'created' ? (
          <Trans>{total} appointments booked in these dates, as they stand now.</Trans>
        ) : (
          <Trans>{total} appointments taking place in these dates, as they stand now.</Trans>
        )}
      </p>
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <ReportCard title={t`Channel`} note={<Trans>How each appointment was booked.</Trans>}>
          {channels.length === 0 ? (
            <ChartEmpty />
          ) : (
            <DonutChart label={t`Appointments by channel`} segments={channels} centre={total} />
          )}
        </ReportCard>
        <ReportCard
          title={t`Source`}
          note={<Trans>The session source of each appointment's contact.</Trans>}
          aside={
            <Switch
              label={t`Which touch the source is read from`}
              value={data.attribution}
              onChange={onAttribution}
              views={[
                { value: 'first', label: t`First` },
                { value: 'latest', label: t`Latest` },
              ]}
            />
          }
        >
          {sources.length === 0 ? (
            <ChartEmpty />
          ) : (
            <DonutChart label={t`Appointments by source`} segments={sources} centre={total} />
          )}
        </ReportCard>
        <ReportCard title={t`Top 5 most booked calendars`}>
          {topCalendars.categories.length === 0 ? (
            <ChartEmpty />
          ) : (
            <HorizontalBarChart label={t`Top 5 most booked calendars`} {...topCalendars} />
          )}
        </ReportCard>
        <ReportCard title={t`Top 5 users with appointments`}>
          {people.categories.length === 0 ? (
            <ChartEmpty />
          ) : (
            <HorizontalBarChart label={t`Top 5 users with appointments`} {...people} />
          )}
        </ReportCard>
        <ReportCard
          title={t`Most popular days`}
          note={
            data.dateProperty === 'created' ? (
              <Trans>By the day of the week each was booked on.</Trans>
            ) : (
              <Trans>By the day of the week each takes place on.</Trans>
            )
          }
        >
          {nothing ? (
            <ChartEmpty />
          ) : (
            <BarChart
              label={t`Appointments by day of the week`}
              categoryLabel={t`Day of the week`}
              tickText={(value) => axisText(value, locale)}
              height={200}
              {...days}
            />
          )}
        </ReportCard>
        <ReportCard
          title={t`Top 5 calendars with cancellations`}
          note={<Trans>Cancelled and invalid appointments.</Trans>}
        >
          {cancellations.categories.length === 0 ? (
            <ChartEmpty>
              <Trans>No cancellations in these dates.</Trans>
            </ChartEmpty>
          ) : (
            <HorizontalBarChart label={t`Top 5 calendars with cancellations`} {...cancellations} />
          )}
        </ReportCard>
      </div>
    </div>
  );
}
