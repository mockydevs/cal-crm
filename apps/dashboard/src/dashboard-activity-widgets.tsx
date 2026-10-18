// The Dashboard's email and booking numbers, over the same dates as the opportunity
// widgets. Each number is counted by the server (GET /reports/email and
// /reports/appointments); this file only lays them out. Opens and clicks are not tracked,
// and an email's delivery is not recorded, so neither is shown.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getAppointmentReport,
  getEmailReport,
  type AppointmentReport,
  type EmailReport,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useId, type ReactElement, type ReactNode } from 'react';
import { apiIn } from './api';
import { dayBars, reasonKey, topRows } from './dashboard-activity-rules';

interface Range {
  readonly from: string;
  readonly to: string;
}

function Frame({
  title,
  note,
  report,
  children,
}: {
  readonly title: string;
  readonly note?: string;
  readonly report: Pick<UseQueryResult, 'isPending' | 'isError' | 'refetch'>;
  readonly children: ReactNode;
}): ReactElement {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-4 rounded-card border bg-card p-4 lg:col-span-3"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 id={headingId} className="text-md font-medium text-foreground">
          {title}
        </h2>
        {note === undefined ? null : <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      {report.isPending ? (
        <p role="status" className="py-10 text-center text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : report.isError ? (
        <div role="alert" className="flex flex-col items-center gap-2 py-8 text-center text-sm">
          <p>
            <Trans>The numbers couldn't be loaded.</Trans>
          </p>
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void report.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : (
        children
      )}
    </section>
  );
}

/** A number with its name under it; the first of a row stands out. */
function Tiles({
  items,
}: {
  readonly items: readonly {
    readonly label: string;
    readonly value: number;
    readonly tone?: string;
  }[];
}): ReactElement {
  return (
    <dl className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
      {items.map((item) => (
        <div key={item.label} className="flex min-w-0 flex-col rounded-lg bg-secondary px-3 py-2">
          <dd className={`text-xl leading-tight font-semibold tabular-nums ${item.tone ?? ''}`}>
            {item.value}
          </dd>
          <dt className="text-xs wrap-anywhere text-muted-foreground">{item.label}</dt>
        </div>
      ))}
    </dl>
  );
}

/** One bar a day, the tallest day full. */
function DayChart({ values }: { readonly values: readonly number[] }): ReactElement | null {
  const bars = dayBars(values);
  if (bars.length === 0) return null;
  return (
    <svg
      // For the eye only, as every drawing on the Dashboard: the numbers above are what is read.
      aria-hidden="true"
      viewBox={`0 0 ${String(bars.length * 6)} 40`}
      preserveAspectRatio="none"
      className="h-14 w-full"
    >
      {bars.map((height, index) => (
        <rect
          // The days never reorder.
          // eslint-disable-next-line @eslint-react/no-array-index-key
          key={index}
          x={index * 6 + 1}
          y={40 - height}
          width={4}
          height={height}
          rx={1}
          className={height <= 1 ? 'fill-border' : 'fill-primary'}
        />
      ))}
    </svg>
  );
}

function Rows({
  title,
  rows,
  empty,
}: {
  readonly title: string;
  readonly rows: readonly { readonly name: string; readonly count: number }[];
  readonly empty: string;
}): ReactElement {
  const headingId = useId();
  return (
    <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
      <h3 id={headingId} className="text-xs font-medium text-muted-foreground">
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul aria-labelledby={headingId} className="flex list-none flex-col p-0 text-sm">
          {rows.map((row) => (
            <li key={row.name} className="flex min-w-0 items-baseline justify-between gap-3 py-0.5">
              <span className="min-w-0 wrap-anywhere">{row.name}</span>
              <span className="font-medium tabular-nums">{row.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function EmailWidget({
  businessId,
  range,
}: {
  readonly businessId: string;
  readonly range: Range;
}): ReactElement {
  const { t } = useLingui();
  const report = useQuery({
    queryKey: ['b', businessId, 'email-report', range.from, range.to],
    queryFn: () =>
      apiIn(businessId).request(getEmailReport, { query: { from: range.from, to: range.to } }),
  });
  const reasons: Readonly<Record<string, string>> = {
    consent_required: t`No consent to email`,
    consent_withdrawn: t`Unsubscribed`,
    suppressed: t`Address blocked after a bounce`,
    do_not_contact: t`Do not contact`,
    recipient_changed: t`The address changed`,
    delivery_rejected: t`The mail server refused it`,
    mailbox_unavailable: t`The mailbox was not working`,
    mailbox_use_disabled: t`The mailbox was switched off for this`,
    unsubscribe_unavailable: t`No unsubscribe link could be made`,
    quiet_hours: t`Quiet hours`,
    daily_limit: t`Daily limit reached`,
    unknown: t`No reason recorded`,
  };
  const senders: Readonly<Record<EmailReport['senders'][number]['sender'], string>> = {
    workflow: t`Workflows`,
    person: t`People on the team`,
    assistant: t`The assistant`,
    other: t`Other (bookings, API)`,
  };
  const data = report.data;
  return (
    <Frame title={t`Email`} report={report} note={t`Opens and clicks are not tracked.`}>
      {data === undefined ? null : (
        <>
          <Tiles
            items={[
              { label: t`Sent`, value: data.totals.sent },
              { label: t`Replies`, value: data.totals.replies },
              {
                label: t`Not sent`,
                value: data.totals.notSent,
                ...(data.totals.notSent > 0 ? { tone: 'text-attention-foreground' } : {}),
              },
              {
                label: t`Bounced`,
                value: data.totals.bounced,
                ...(data.totals.bounced > 0 ? { tone: 'text-destructive' } : {}),
              },
              { label: t`Unsubscribed`, value: data.totals.unsubscribed },
            ]}
          />
          <DayChart values={data.days.map((day) => day.sent)} />
          <div className="flex min-w-0 flex-wrap gap-x-6 gap-y-3">
            <Rows
              title={t`Sent by`}
              empty={t`Nothing was sent in these days.`}
              rows={data.senders
                .filter((each) => each.count > 0)
                .map((each) => ({ name: senders[each.sender], count: each.count }))}
            />
            <Rows
              title={t`Why emails were not sent`}
              empty={t`Every email went out.`}
              rows={topRows(
                data.notSentReasons.map((each) => ({
                  name: reasons[each.reason] ?? reasonKey(each.reason),
                  count: each.count,
                })),
                5,
                t`Other reasons`,
              )}
            />
          </div>
        </>
      )}
    </Frame>
  );
}

export function BookingsWidget({
  businessId,
  range,
}: {
  readonly businessId: string;
  readonly range: Range;
}): ReactElement {
  const { t } = useLingui();
  const report = useQuery({
    queryKey: ['b', businessId, 'appointment-report', range.from, range.to],
    queryFn: () =>
      apiIn(businessId).request(getAppointmentReport, {
        query: { from: range.from, to: range.to, dateProperty: 'starts' },
      }),
  });
  const data = report.data;
  const of = (status: AppointmentReport['statuses'][number]['status']): number =>
    data?.statuses.find((each) => each.status === status)?.count ?? 0;
  const upcoming = String(data?.upcoming.count ?? 0);
  return (
    <Frame
      title={t`Bookings`}
      report={report}
      note={t`Appointments that start in these days. ${upcoming} more are booked for the next 7 days.`}
    >
      {data === undefined ? null : (
        <>
          <Tiles
            items={[
              { label: t`Appointments`, value: data.count },
              { label: t`Booked or confirmed`, value: of('booked') + of('confirmed') },
              { label: t`Showed`, value: of('completed') },
              {
                label: t`No-show`,
                value: of('no_show'),
                ...(of('no_show') > 0 ? { tone: 'text-destructive' } : {}),
              },
              { label: t`Cancelled`, value: of('cancelled') },
            ]}
          />
          <DayChart values={data.days.map((day) => day.count)} />
          <div className="flex min-w-0 flex-wrap gap-x-6 gap-y-3">
            <Rows
              title={t`By calendar`}
              empty={t`No appointments in these days.`}
              rows={topRows(
                data.calendars.map((each) => ({ name: each.calendar.name, count: each.count })),
                5,
                t`Other calendars`,
              )}
            />
            <Rows
              title={t`By team member`}
              empty={t`No appointments in these days.`}
              rows={topRows(
                data.teamMembers.map((each) => ({
                  name:
                    each.assignee === null
                      ? t`Nobody assigned`
                      : each.assignee.name === ''
                        ? t`Former team member`
                        : each.assignee.name,
                  count: each.count,
                })),
                5,
                t`Other people`,
              )}
            />
          </div>
        </>
      )}
    </Frame>
  );
}
