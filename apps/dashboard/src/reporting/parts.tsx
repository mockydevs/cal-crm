// What Reporting's pages share on screen, with nothing heavy behind it: the line that says
// which days and which time zone the numbers are of, a card with its heading, a number with
// its small grey label above it, a two- or three-way switch, a search box, and what a person
// without the permission sees. The date range control, which brings the themed select, is
// in range-control.tsx.
import { Trans, useLingui } from '@lingui/react/macro';
import { getReportCatalog, type ReportCatalog, type ReportResolvedRange } from '@repo/contracts';
import { EmptyState } from '@repo/ui/components/empty-state';
import { Input } from '@repo/ui/components/input';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Lock, Search } from 'lucide-react';
import { useId, type ReactElement, type ReactNode } from 'react';
import { apiIn } from '../api';
import { rangeText } from './format';
import { reportingKeys, retryFaults } from './keys';

/** The catalogue: what a report can ask, the presets, the limits, and whether you may make reports. */
export function useCatalog(businessId: string): UseQueryResult<ReportCatalog> {
  return useQuery({
    queryKey: reportingKeys.catalog(businessId),
    queryFn: () => apiIn(businessId).request(getReportCatalog, {}),
    staleTime: 5 * 60_000,
    retry: (failures, error) => retryFaults(failures, error),
  });
}

/** What someone without the permission to view reports sees: one plain statement. */
export function NoAccess(): ReactElement {
  return (
    <EmptyState
      icon={<Lock strokeWidth={1.8} />}
      title={<Trans>You don't have access to Reporting</Trans>}
      description={
        <Trans>
          Viewing reports needs a permission your role doesn't have. An owner or an admin of this
          business can give it to you in Settings, under Users.
        </Trans>
      }
    />
  );
}

/** Which days the numbers are of, and in which time zone: as the server resolved them. */
export function ResolvedRange({
  range,
  timeZone,
}: {
  readonly range: Pick<ReportResolvedRange, 'from' | 'to'>;
  readonly timeZone: string;
}): ReactElement {
  const { i18n } = useLingui();
  const days = rangeText(range, i18n.locale);
  return (
    <p className="text-xs text-muted-foreground" data-testid="resolved-range">
      <Trans>
        {days}, in the business's time zone ({timeZone})
      </Trans>
    </p>
  );
}

/** A card with its heading, and whatever sits at the heading's right. */
export function ReportCard({
  title,
  aside,
  note,
  className,
  children,
}: {
  readonly title: string;
  readonly aside?: ReactNode;
  /** One quiet line under the heading: what the numbers are. */
  readonly note?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={`flex min-w-0 flex-col gap-3 rounded-card border bg-card p-4 ${className ?? ''}`}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={headingId} className="text-md font-medium break-words text-foreground">
            {title}
          </h2>
          {note === undefined ? null : <p className="text-xs text-muted-foreground">{note}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** One number of a report: its name small and grey above it, a quiet line under it. */
export function NumberCard({
  label,
  lines,
  note,
}: {
  readonly label: string;
  /** The number as written: one line for each currency of money. */
  readonly lines: readonly string[];
  readonly note?: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-card border bg-card px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-col">
        {lines.map((line) => (
          <span
            key={line}
            // A long amount, or one for each of several currencies, is set smaller so that
            // it stays on its line in a narrow card.
            className={`font-medium break-words text-foreground tabular-nums ${
              lines.length > 1 || line.length > 9 ? 'text-lg leading-7' : 'text-2xl leading-8'
            }`}
          >
            {line}
          </span>
        ))}
        {note === undefined ? null : <span className="text-xs text-muted-foreground">{note}</span>}
      </dd>
    </div>
  );
}

/** What a place says while its numbers are on their way. */
export function Loading(): ReactElement {
  return (
    <p role="status" className="py-8 text-center text-sm text-muted-foreground">
      <Trans>Loading…</Trans>
    </p>
  );
}

/** Two or three views of one page, as a segmented switch: the one showing is pressed. */
export function Switch<View extends string>({
  label,
  views,
  value,
  onChange,
}: {
  readonly label: string;
  readonly views: readonly { readonly value: View; readonly label: ReactNode }[];
  readonly value: View;
  readonly onChange: (view: View) => void;
}): ReactElement {
  return (
    <div role="group" aria-label={label} className="inline-flex max-w-full rounded-lg bg-muted p-1">
      {views.map((view) => (
        <button
          key={view.value}
          type="button"
          aria-pressed={view.value === value}
          className="inline-flex min-h-11 min-w-0 items-center gap-1.5 rounded-control px-3 text-[13px] font-medium text-body -outline-offset-2 hover:text-foreground aria-pressed:bg-card aria-pressed:text-link aria-pressed:shadow-[0_1px_2px_rgb(16_24_40/0.05)] lg:min-h-7"
          onClick={() => {
            onChange(view.value);
          }}
        >
          {view.label}
        </button>
      ))}
    </div>
  );
}

/** A search box over a table: its label is its placeholder too. */
export function SearchBox({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const id = useId();
  return (
    <form
      role="search"
      aria-label={label}
      className="relative min-w-0 flex-1 basis-48 sm:max-w-64"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        strokeWidth={1.8}
      />
      <Input
        id={id}
        type="search"
        autoComplete="off"
        maxLength={200}
        placeholder={label}
        value={value}
        className="pl-9"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </form>
  );
}
