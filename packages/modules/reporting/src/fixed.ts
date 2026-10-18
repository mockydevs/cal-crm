// The two fixed reports of the Reporting page: the Appointment report
// and the Attribution report. Every number is asked of the engine (engine.ts) as a query a
// custom report could send too, and put together here. The one thing that is not a count is
// the Attribution report's list of touches, which is read as rows.
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  appointmentSources,
  appointmentStatuses,
  attributionMediums,
  reportQuery,
  sessionSources,
  type AppointmentOverview,
  type appointmentOverviewQuery,
  type AttributionReport,
  type attributionReportQuery,
  type ReportCell,
  type ReportFilter,
  type ReportGrain,
  type ReportPreset,
  type ReportQuery,
  type ReportRangeInput,
  type ReportResult,
  type ReportRow,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import * as z from 'zod';

import { runQuery, type ReportingOptions } from './engine.js';
import { fromUnits, toUnits } from './fold.js';
import { daysIn } from './range.js';

/** The range a fixed report's query names; the last 30 days when it names none. */
const rangeOf = (query: {
  readonly preset?: ReportPreset | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): ReportRangeInput =>
  query.from !== undefined && query.to !== undefined
    ? { from: query.from, to: query.to }
    : { preset: query.preset ?? 'last_30_days' };

const number = (cell: ReportCell | undefined): number => (typeof cell === 'number' ? cell : 0);
const NONE = { key: null, label: '' } as const;
const groupOf = (
  row: ReportRow,
  index = 0,
): { readonly key: string | null; readonly label: string } => row.group[index] ?? NONE;
const keyOf = (row: ReportRow, index = 0): string | null => groupOf(row, index).key;

const only = (field: string, values: string[]): ReportFilter => ({
  match: 'all',
  groups: [{ match: 'all', conditions: [{ field, operator: 'any_of', values }] }],
});

type Ask = (query: z.input<typeof reportQuery>) => Promise<ReportResult>;

const asker =
  (
    trx: DatabaseTransaction,
    invocation: Invocation,
    options: ReportingOptions,
    today: string | undefined,
  ): Ask =>
  (query) =>
    // Parsed as any caller's query is: a fixed report can ask nothing a custom one cannot.
    runQuery(trx, invocation, reportQuery.parse(query), options, today);

// The Appointment report -----------------------------------------------------------------

const channel = z.enum(appointmentSources);
const sessionSource = z.enum(sessionSources);

export async function readAppointmentOverview(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof appointmentOverviewQuery>,
  options: ReportingOptions,
  today?: string,
): Promise<AppointmentOverview> {
  const ask = asker(trx, invocation, options, today);
  const calendar = query.calendarId === undefined ? [] : [query.calendarId];
  const base = (
    groupBy: string,
    extra?: { limit?: number; cancelled?: true },
  ): z.input<typeof reportQuery> => {
    const conditions = [
      ...(calendar.length === 0
        ? []
        : [{ field: 'calendar', operator: 'any_of' as const, values: calendar }]),
      ...(extra?.cancelled === true
        ? [{ field: 'status', operator: 'any_of' as const, values: ['cancelled', 'invalid'] }]
        : []),
    ];
    return {
      source: 'appointments',
      measures: ['count'],
      groupBy: [groupBy],
      time: { property: query.dateProperty },
      attribution: query.attribution,
      range: rangeOf(query),
      ...(conditions.length === 0
        ? {}
        : { filters: { match: 'all', groups: [{ match: 'all', conditions }] } }),
      ...(extra?.limit === undefined ? {} : { limit: extra.limit }),
    };
  };
  const byStatus = await ask(base('status'));
  const byChannel = await ask(base('bookingSource'));
  const bySource = await ask(base('sessionSource'));
  const byCalendar = await ask(base('calendar', { limit: 5 }));
  const byMember = await ask(base('assignee', { limit: 5 }));
  const byWeekday = await ask(base('weekday'));
  const cancelled = await ask(base('calendar', { limit: 5, cancelled: true }));

  const counted = (result: ReportResult) => new Map(result.rows.map((row) => [keyOf(row), row]));
  const statuses = counted(byStatus);
  const weekdays = counted(byWeekday);
  const calendars = (result: ReportResult) =>
    result.rows
      .filter((row) => !row.other)
      .map((row) => ({
        // A calendar deleted since has no id and no name left to give.
        calendar: { id: keyOf(row), name: groupOf(row).label },
        count: number(row.values[0]),
      }));
  return {
    range: byStatus.range,
    timeZone: byStatus.timeZone,
    dateProperty: query.dateProperty,
    attribution: query.attribution,
    total: number(byStatus.totals[0]),
    statuses: appointmentStatuses.map((each) => ({
      status: each,
      count: number(statuses.get(each)?.values[0]),
    })),
    channels: byChannel.rows.flatMap((row) => {
      const parsed = channel.safeParse(keyOf(row));
      return parsed.success ? [{ channel: parsed.data, count: number(row.values[0]) }] : [];
    }),
    sources: bySource.rows.map((row) => ({
      sessionSource: sessionSource.nullable().catch(null).parse(keyOf(row)),
      count: number(row.values[0]),
    })),
    calendars: calendars(byCalendar),
    teamMembers: byMember.rows
      .filter((row) => !row.other)
      .map((row) => {
        const { label } = groupOf(row);
        return {
          // Nobody: no membership and no name.
          assignee:
            keyOf(row) === null && label === '' ? null : { membershipId: keyOf(row), name: label },
          count: number(row.values[0]),
        };
      }),
    weekdays: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      count: number(weekdays.get(String(weekday))?.values[0]),
    })),
    cancellations: calendars(cancelled),
    reschedules: null,
  };
}

// The Attribution report -----------------------------------------------------------------

interface Funnel {
  leads: number;
  appointments: number;
  opportunities: number;
  won: number;
  wonValue: ReportCell;
}

/** Money cells added, currency by currency. */
function addMoney(left: ReportCell, right: ReportCell | undefined): ReportCell {
  const sums = new Map<string, bigint>();
  for (const cell of [left, right])
    if (Array.isArray(cell))
      for (const { currency, amount } of cell)
        sums.set(currency, (sums.get(currency) ?? 0n) + toUnits(amount));
  return [...sums.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([currency, units]) => ({ currency, amount: fromUnits(units) }));
}

const empty = (): Funnel => ({ leads: 0, appointments: 0, opportunities: 0, won: 0, wonValue: [] });

/** The grain of the leads series: days while they fit a chart, then weeks, then months. */
export const seriesGrain = (days: number): ReportGrain =>
  days <= 92 ? 'day' : days <= 731 ? 'week' : 'month';

const medium = z.enum(attributionMediums);

export async function readAttributionReport(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof attributionReportQuery>,
  options: ReportingOptions,
  today?: string,
): Promise<AttributionReport> {
  const businessId = requireBusiness(invocation.context);
  const ask = asker(trx, invocation, options, today);
  const range = rangeOf(query);
  const shared = { range, attribution: query.attribution } as const;
  /** The four numbers of the funnel, grouped the same way. */
  const funnel = async (groupBy: string[], limit: number | null) => {
    const part = (source: ReportQuery['source'], property: string, extra: object = {}) =>
      ask({
        source,
        measures: ['count'],
        groupBy,
        time: { property },
        limit: 500,
        ...shared,
        ...extra,
      });
    const leads = await part('contacts', 'created');
    const appointments = await part('appointments', 'created');
    const opportunities = await part('opportunities', 'created');
    // Won by the day it was closed, with what it was worth.
    const won = await part('opportunities', 'closed', {
      measures: ['count', 'value'],
      filters: only('status', ['won']),
    });
    const id = (row: ReportRow): string =>
      row.other ? 'other' : JSON.stringify(row.group.map((each) => each.key));
    // Every group that has anything, or the ones with the most leads and the rest as one.
    const shown = new Set(
      (limit === null
        ? [leads, appointments, opportunities, won].flatMap((result) => result.rows)
        : leads.rows.slice(0, limit)
      )
        .filter((row) => !row.other)
        .map(id),
    );
    const groups = new Map<string, { keys: (string | null)[]; other: boolean } & Funnel>();
    const into = (row: ReportRow) => {
      const key = shown.has(id(row)) ? id(row) : 'other';
      const held = groups.get(key) ?? {
        keys: key === 'other' ? groupBy.map(() => null) : row.group.map((each) => each.key),
        other: key === 'other',
        ...empty(),
      };
      groups.set(key, held);
      return held;
    };
    for (const row of leads.rows) into(row).leads += number(row.values[0]);
    for (const row of appointments.rows) into(row).appointments += number(row.values[0]);
    for (const row of opportunities.rows) into(row).opportunities += number(row.values[0]);
    for (const row of won.rows) {
      const held = into(row);
      held.won += number(row.values[0]);
      held.wonValue = addMoney(held.wonValue, row.values[1]);
    }
    const rows = [...groups.values()].sort(
      (left, right) => Number(left.other) - Number(right.other) || right.leads - left.leads,
    );
    const totals: Funnel = {
      leads: number(leads.totals[0]),
      appointments: number(appointments.totals[0]),
      opportunities: number(opportunities.totals[0]),
      won: number(won.totals[0]),
      wonValue: addMoney([], won.totals[1]),
    };
    return { rows, totals, resolved: leads };
  };

  const bySource = await funnel(['sessionSource'], null);
  const byCampaign = await funnel(['utmSource', 'utmCampaign'], 50);
  const referrers = await ask({
    source: 'contacts',
    measures: ['count'],
    groupBy: ['referrerDomain'],
    limit: 20,
    ...shared,
  });
  const { resolved } = bySource;
  const grain = seriesGrain(daysIn(resolved.range));
  const series = await ask({ source: 'contacts', measures: ['count'], time: { grain }, ...shared });

  // The touches themselves, newest first: rows, so not a query of the engine. Read in the
  // same transaction, under the same row-level security, for the same instants.
  const touches = await trx
    .selectFrom('crm.contact_attributions as t')
    .innerJoin('crm.contacts as c', (join) =>
      join.onRef('c.business_id', '=', 't.business_id').onRef('c.id', '=', 't.contact_id'),
    )
    .select([
      't.touched_at',
      't.contact_id',
      'c.display_name',
      't.is_first',
      't.medium',
      't.session_source',
      't.utm_source',
      't.utm_medium',
      't.utm_campaign',
      't.utm_content',
      't.referrer_domain',
      't.landing_url',
    ])
    .where('t.business_id', '=', businessId)
    .where('c.deleted_at', 'is', null)
    .where('t.touched_at', '>=', new Date(resolved.range.fromInstant))
    .where('t.touched_at', '<', new Date(resolved.range.toInstant))
    .orderBy('t.touched_at', 'desc')
    .orderBy('t.id', 'desc')
    .limit(100)
    .execute();

  // A fresh object each time: the contract's loose objects take one, and not a named shape.
  const numbers = ({ leads, appointments, opportunities, won, wonValue }: Funnel) => ({
    leads,
    appointments,
    opportunities,
    won,
    wonValue,
  });
  return {
    range: resolved.range,
    timeZone: resolved.timeZone,
    attribution: query.attribution,
    totals: numbers(bySource.totals),
    sources: bySource.rows.map((row) => ({
      sessionSource: sessionSource
        .nullable()
        .catch(null)
        .parse(row.keys[0] ?? null),
      ...numbers(row),
    })),
    campaigns: byCampaign.rows.map((row) => ({
      utmSource: row.keys.at(0) ?? null,
      utmCampaign: row.keys.at(1) ?? null,
      other: row.other,
      ...numbers(row),
    })),
    referrers: referrers.rows.map((row) => ({
      referrerDomain: keyOf(row),
      other: row.other,
      leads: number(row.values[0]),
    })),
    series: {
      grain,
      points: series.rows.map((row) => ({ date: keyOf(row) ?? '', leads: number(row.values[0]) })),
    },
    touches: touches.map((row) => ({
      touchedAt: row.touched_at.toISOString(),
      contact: { id: toPublicId('contact', row.contact_id), name: row.display_name },
      first: row.is_first,
      // The table's own constraints allow nothing else.
      medium: medium.parse(row.medium),
      sessionSource: sessionSource.parse(row.session_source),
      utmSource: row.utm_source,
      utmMedium: row.utm_medium,
      utmCampaign: row.utm_campaign,
      utmContent: row.utm_content,
      referrerDomain: row.referrer_domain,
      landingUrl: row.landing_url,
    })),
  };
}
