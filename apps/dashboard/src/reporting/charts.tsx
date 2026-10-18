// Reporting's charts: line, area, bar, horizontal bar, donut, funnel, a number card and a
// table, drawn as SVG from the pure geometry in chart-geometry.ts, with no chart library.
// Each says what it shows without sight or colour: a line or bar chart has every value in a
// table for screen readers and each point reachable with the arrow keys and read out; a
// horizontal bar, a donut and a funnel write every value beside its mark; series differ by
// pattern or dash as well as colour. Colours are the design system's tokens, so an agency's
// accent carries through.
import { Trans, useLingui } from '@lingui/react/macro';
import { Badge } from '@repo/ui/components/badge';
import {
  ArrowDown,
  ArrowUp,
  ChartNoAxesColumn,
  Minus,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  cellClassName,
  headerCellClassName,
  tableClassName,
  tableRegionClassName,
} from '../list-table';
import {
  areaPath,
  bands,
  barShare,
  barsIn,
  donutSlices,
  funnelSteps,
  linePath,
  linePoints,
  niceScale,
  shareText,
  shownLabels,
  yOf,
} from './chart-geometry';
import { changeSign, changeSize, type Compared } from './format';
import { nextSort, sortedRows, type Sort, type TableColumn, type TableRow } from './result-model';

export interface ChartCategory {
  readonly key: string;
  /** Short, for the axis. */
  readonly label: string;
  /** Whole, for what is read out. */
  readonly long: string;
}

export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  readonly values: readonly number[];
  readonly texts: readonly string[];
  /** True for the comparison period: drawn lighter and dashed. */
  readonly compare?: boolean;
}

// Six tokens that stand apart on a white card (each 4.5:1 or better), then five patterns:
// thirty series before a pair repeats, and no two neighbours share a pattern.
const TONES = [
  'text-primary',
  'text-success',
  'text-attention-foreground',
  'text-destructive',
  'text-body',
  'text-muted-foreground',
] as const;
const DASHES = ['', '6 3', '2 3', '8 3 2 3', '1 4'] as const;
const PATTERNS = 5;

const toneOf = (index: number): string => TONES[index % TONES.length] ?? TONES[0];
const dashOf = (index: number): string => DASHES[index % DASHES.length] ?? '';

/** The fills of a chart's series: a colour, and from the second on a pattern over it. */
function SeriesFills({ id, count }: { readonly id: string; readonly count: number }): ReactElement {
  return (
    <defs>
      {Array.from({ length: count }, (_, index) => {
        const pattern = index % PATTERNS;
        return (
          <pattern
            key={index}
            id={`${id}-${String(index)}`}
            patternUnits="userSpaceOnUse"
            width="6"
            height="6"
            className={toneOf(index)}
          >
            <rect width="6" height="6" fill="currentColor" />
            {pattern === 1 ? (
              <path d="M-1 1l2-2M0 6l6-6M5 7l2-2" className="stroke-card" strokeWidth="1.2" />
            ) : pattern === 2 ? (
              <circle cx="3" cy="3" r="1.1" className="fill-card" />
            ) : pattern === 3 ? (
              <path d="M0 3h6M3 0v6" className="stroke-card" strokeWidth="1" />
            ) : pattern === 4 ? (
              <path d="M0 3h6" className="stroke-card" strokeWidth="1.2" />
            ) : null}
          </pattern>
        );
      })}
    </defs>
  );
}

const fillOf = (id: string, index: number): string => `url(#${id}-${String(index)})`;

/** The width a chart has to draw in. 640 until it is measured, and where nothing measures. */
function useWidth(): [(element: HTMLDivElement | null) => void, number] {
  const [width, setWidth] = useState(640);
  const observerRef = useRef<ResizeObserver | null>(null);
  const attach = useCallback((element: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    observerRef.current = observer;
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);
  return [attach, width];
}

/**
 * One stop for the Tab key in a chart, and the arrow keys between its points: the point
 * the keyboard or the pointer is on is the one whose values show above the plot.
 */
function useRoving(count: number): {
  readonly shown: number | null;
  readonly propsOf: (index: number) => {
    readonly ref: (element: SVGGElement | null) => void;
    readonly tabIndex: number;
    readonly onFocus: () => void;
    readonly onBlur: () => void;
    readonly onMouseEnter: () => void;
    readonly onMouseLeave: () => void;
    readonly onKeyDown: (event: KeyboardEvent<SVGGElement>) => void;
  };
} {
  const [stop, setStop] = useState(0);
  const [shown, setShown] = useState<number | null>(null);
  const elementsRef = useRef<(SVGGElement | null)[]>([]);
  const tabStop = Math.min(stop, Math.max(count - 1, 0));
  const move = (to: number): void => {
    const next = Math.min(Math.max(to, 0), count - 1);
    setStop(next);
    elementsRef.current[next]?.focus();
  };
  return {
    shown: shown !== null && shown < count ? shown : null,
    propsOf: (index) => ({
      ref: (element) => {
        elementsRef.current[index] = element;
      },
      tabIndex: index === tabStop ? 0 : -1,
      onFocus: () => {
        setStop(index);
        setShown(index);
      },
      onBlur: () => {
        setShown(null);
      },
      onMouseEnter: () => {
        setShown(index);
      },
      onMouseLeave: () => {
        setShown(null);
      },
      onKeyDown: (event) => {
        const to =
          event.key === 'ArrowRight' || event.key === 'ArrowDown'
            ? index + 1
            : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
              ? index - 1
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? count - 1
                  : undefined;
        if (to === undefined) return;
        event.preventDefault();
        move(to);
      },
    }),
  };
}

/** What a point says: its category, then each series' value. */
function pointWords(
  category: ChartCategory,
  series: readonly ChartSeries[],
  index: number,
): string {
  const values = series.map((each) =>
    series.length === 1 ? (each.texts[index] ?? '') : `${each.label} ${each.texts[index] ?? ''}`,
  );
  return `${category.long}: ${values.join('; ')}`;
}

/** Every value of a chart as a table, for screen readers: what the drawing shows to eyes. */
function ValuesTable({
  label,
  categoryLabel,
  categories,
  series,
}: {
  readonly label: string;
  readonly categoryLabel: string;
  readonly categories: readonly ChartCategory[];
  readonly series: readonly ChartSeries[];
}): ReactElement {
  return (
    // A table is as wide as what it holds, whatever width it is given: the frame is what
    // is hidden from sight, so the page is no wider for it.
    <div className="sr-only">
      <table>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{categoryLabel}</th>
            {series.map((each) => (
              <th key={each.key} scope="col">
                {each.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {categories.map((category, index) => (
            <tr key={category.key}>
              <th scope="row">{category.long}</th>
              {series.map((each) => (
                <td key={each.key}>{each.texts[index]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Legend({
  id,
  series,
  line,
}: {
  readonly id: string;
  readonly series: readonly ChartSeries[];
  /** True where a series is a line: its sample is a stroke with its dash. */
  readonly line: boolean;
}): ReactElement | null {
  if (series.length < 2) return null;
  return (
    <ul className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-body">
      {series.map((each, index) => (
        <li key={each.key} className="flex min-w-0 items-center gap-1.5">
          <svg aria-hidden width="18" height="10" className={`shrink-0 ${toneOf(index)}`}>
            {line ? (
              <path
                d="M0 5h18"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray={each.compare === true ? '3 3' : dashOf(index)}
                opacity={each.compare === true ? 0.7 : 1}
              />
            ) : (
              <rect width="18" height="10" rx="2" fill={fillOf(id, index)} />
            )}
          </svg>
          <span className="min-w-0 break-words">{each.label}</span>
        </li>
      ))}
    </ul>
  );
}

interface PlotProps {
  /** What the chart shows, as its heading says it. */
  readonly label: string;
  /** What the categories are, for the table's first column: "Day", "Session source". */
  readonly categoryLabel: string;
  readonly categories: readonly ChartCategory[];
  readonly series: readonly ChartSeries[];
  /** A number as the axis marks it. */
  readonly tickText: (value: number) => string;
  /** False for money: its axis may step by fractions. */
  readonly whole?: boolean;
  readonly height?: number;
}

interface Frame {
  readonly left: number;
  readonly top: number;
  readonly plotWidth: number;
  readonly plotHeight: number;
  readonly max: number;
  readonly ticks: readonly number[];
}

const CHARACTER = 6.5;

function frameOf(
  width: number,
  height: number,
  series: readonly ChartSeries[],
  tickText: (value: number) => string,
  whole: boolean,
): Frame {
  const most = Math.max(0, ...series.flatMap((each) => each.values));
  const scale = niceScale(most, height < 180 ? 3 : 4, whole);
  const widest = Math.max(...scale.ticks.map((tick) => tickText(tick).length));
  const left = Math.round(widest * CHARACTER + 10);
  return {
    left,
    top: 8,
    plotWidth: Math.max(width - left - 12, 40),
    plotHeight: Math.max(height - 8 - 24, 40),
    max: scale.max,
    ticks: scale.ticks,
  };
}

function Axis({
  frame,
  tickText,
}: {
  readonly frame: Frame;
  readonly tickText: (value: number) => string;
}): ReactElement {
  return (
    <g aria-hidden>
      {frame.ticks.map((tick) => {
        const y = frame.top + yOf(tick, frame.max, frame.plotHeight);
        return (
          <g key={tick}>
            <line
              x1={frame.left}
              x2={frame.left + frame.plotWidth}
              y1={y}
              y2={y}
              className={tick === 0 ? 'stroke-input' : 'stroke-border'}
            />
            <text
              x={frame.left - 6}
              y={y}
              dy="0.32em"
              textAnchor="end"
              className="fill-muted-foreground text-[11px] tabular-nums"
            >
              {tickText(tick)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

const clip = (text: string, room: number): string => {
  const most = Math.max(Math.floor(room / CHARACTER), 3);
  return text.length <= most ? text : `${text.slice(0, most - 1)}…`;
};

/** What the keyboard or the pointer is on, written above the plot. Empty keeps its height. */
function Readout({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <p aria-hidden className="min-h-5 truncate text-xs text-body tabular-nums">
      {children}
    </p>
  );
}

/** A line for each series over the categories; with `area`, filled down to the axis. */
export function LineChart({
  label,
  categoryLabel,
  categories,
  series,
  tickText,
  whole = true,
  height = 220,
  area = false,
}: PlotProps & { readonly area?: boolean }): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const [attach, width] = useWidth();
  const frame = frameOf(width, height, series, tickText, whole);
  const roving = useRoving(categories.length);
  const lines = series.map((each) =>
    linePoints(each.values, frame.plotWidth, frame.plotHeight, frame.max),
  );
  const xs = lines[0]?.map((point) => point.x) ?? [];
  const step = categories.length > 1 ? frame.plotWidth / (categories.length - 1) : frame.plotWidth;
  const labelled = new Set(shownLabels(categories.length, frame.plotWidth / 64));
  const shown = roving.shown === null ? undefined : categories[roving.shown];
  return (
    <div ref={attach} className="flex min-w-0 flex-col gap-1">
      <Legend id={id} series={series} line />
      <Readout>
        {shown === undefined || roving.shown === null
          ? null
          : pointWords(shown, series, roving.shown)}
      </Readout>
      <svg
        role="group"
        aria-label={label}
        width={width}
        height={height}
        className="block max-w-full"
      >
        <Axis frame={frame} tickText={tickText} />
        <g aria-hidden transform={`translate(${String(frame.left)} ${String(frame.top)})`}>
          {series.map((each, index) => {
            const points = lines[index] ?? [];
            return (
              <g key={each.key} className={toneOf(index)}>
                {area && each.compare !== true ? (
                  <path d={areaPath(points, frame.plotHeight)} fill="currentColor" opacity="0.12" />
                ) : null}
                <path
                  d={linePath(points)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  strokeDasharray={each.compare === true ? '3 3' : dashOf(index)}
                  opacity={each.compare === true ? 0.7 : 1}
                />
                {points.length <= 31 || roving.shown !== null
                  ? points.map((point, place) =>
                      points.length <= 31 || place === roving.shown ? (
                        <circle
                          // A point is its place along the line.
                          // eslint-disable-next-line @eslint-react/no-array-index-key
                          key={place}
                          cx={point.x}
                          cy={point.y}
                          r={place === roving.shown ? 4 : 2.5}
                          fill="currentColor"
                          className="stroke-card"
                          strokeWidth="1"
                        />
                      ) : null,
                    )
                  : null}
              </g>
            );
          })}
          {categories.map((category, index) =>
            labelled.has(index) ? (
              <text
                key={category.key}
                x={xs[index] ?? 0}
                y={frame.plotHeight + 16}
                textAnchor={
                  index === 0 ? 'start' : index === categories.length - 1 ? 'end' : 'middle'
                }
                className="fill-muted-foreground text-[11px]"
              >
                {category.label}
              </text>
            ) : null,
          )}
        </g>
        <g
          role="list"
          aria-label={t`Values of ${label}. Use the arrow keys to move between them.`}
          transform={`translate(${String(frame.left)} ${String(frame.top)})`}
        >
          {categories.map((category, index) => (
            <g
              key={category.key}
              role="listitem"
              aria-label={pointWords(category, series, index)}
              className="outline-offset-0"
              {...roving.propsOf(index)}
            >
              <rect
                x={(xs[index] ?? 0) - step / 2}
                y={0}
                width={Math.max(step, 1)}
                height={frame.plotHeight}
                fill="transparent"
              />
              {roving.shown === index ? (
                <line
                  x1={xs[index] ?? 0}
                  x2={xs[index] ?? 0}
                  y1={0}
                  y2={frame.plotHeight}
                  className="stroke-input"
                  strokeDasharray="2 2"
                />
              ) : null}
            </g>
          ))}
        </g>
      </svg>
      <ValuesTable
        label={label}
        categoryLabel={categoryLabel}
        categories={categories}
        series={series}
      />
    </div>
  );
}

/** Upright bars: one group for each category, one bar in it for each series. */
export function BarChart({
  label,
  categoryLabel,
  categories,
  series,
  tickText,
  whole = true,
  height = 220,
}: PlotProps): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const [attach, width] = useWidth();
  const frame = frameOf(width, height, series, tickText, whole);
  const roving = useRoving(categories.length);
  const slots = bands(categories.length, frame.plotWidth, 0.25);
  const step = categories.length > 0 ? frame.plotWidth / categories.length : frame.plotWidth;
  const labelled = new Set(shownLabels(categories.length, frame.plotWidth / 48));
  const every =
    labelled.size === categories.length ? 1 : Math.ceil(categories.length / labelled.size);
  const shown = roving.shown === null ? undefined : categories[roving.shown];
  return (
    <div ref={attach} className="flex min-w-0 flex-col gap-1">
      <Legend id={id} series={series} line={false} />
      <Readout>
        {shown === undefined || roving.shown === null
          ? null
          : pointWords(shown, series, roving.shown)}
      </Readout>
      <svg
        role="group"
        aria-label={label}
        width={width}
        height={height}
        className="block max-w-full"
      >
        <SeriesFills id={id} count={series.length} />
        <Axis frame={frame} tickText={tickText} />
        <g
          role="list"
          aria-label={t`Values of ${label}. Use the arrow keys to move between them.`}
          transform={`translate(${String(frame.left)} ${String(frame.top)})`}
        >
          {categories.map((category, index) => {
            const slot = slots[index];
            if (slot === undefined) return null;
            const bars = barsIn(
              slot,
              series.map((each) => each.values[index] ?? 0),
              frame.max,
              frame.plotHeight,
            );
            return (
              <g
                key={category.key}
                role="listitem"
                aria-label={pointWords(category, series, index)}
                className="outline-offset-0"
                {...roving.propsOf(index)}
              >
                <rect
                  x={index * step}
                  y={0}
                  width={step}
                  height={frame.plotHeight}
                  fill="transparent"
                  className={roving.shown === index ? 'fill-muted' : undefined}
                />
                {series.map((each, place) => {
                  const bar = bars[place];
                  return bar === undefined ? null : (
                    <rect
                      key={each.key}
                      x={bar.x}
                      y={bar.y}
                      width={bar.width}
                      height={bar.height}
                      rx={Math.min(2, bar.width / 2)}
                      fill={fillOf(id, place)}
                      opacity={each.compare === true ? 0.55 : 1}
                    />
                  );
                })}
                {labelled.has(index) ? (
                  <text
                    aria-hidden
                    x={slot.middle}
                    y={frame.plotHeight + 16}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[11px]"
                  >
                    {clip(category.label, step * every - 4)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
      <ValuesTable
        label={label}
        categoryLabel={categoryLabel}
        categories={categories}
        series={series}
      />
    </div>
  );
}

/**
 * Bars lying down, one row for each category: its name and its value written out, and a
 * bar against the largest. With several series, a labelled bar for each under the name.
 */
export function HorizontalBarChart({
  label,
  categories,
  series,
}: Pick<PlotProps, 'label' | 'categories' | 'series'>): ReactElement {
  const id = useId();
  const longest = Math.max(0, ...series.flatMap((each) => each.values));
  const single = series.length === 1;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <svg aria-hidden width="0" height="0" className="absolute">
        <SeriesFills id={id} count={series.length} />
      </svg>
      <ul aria-label={label} className="flex min-w-0 flex-col gap-2.5 text-sm">
        {categories.map((category, index) => (
          <li key={category.key} className="flex min-w-0 flex-col gap-1">
            {single ? null : (
              <span className="font-medium break-words text-foreground">{category.long}</span>
            )}
            {series.map((each, place) => (
              <div key={each.key} className="flex min-w-0 flex-col gap-1">
                <div className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className="min-w-0 break-words text-body">
                    {single ? category.long : each.label}
                  </span>
                  <span className="shrink-0 font-medium text-foreground tabular-nums">
                    {each.texts[index]}
                  </span>
                </div>
                <svg
                  aria-hidden
                  viewBox="0 0 100 4"
                  preserveAspectRatio="none"
                  className="block h-2 w-full overflow-hidden rounded-full bg-muted"
                >
                  <rect
                    width={barShare(each.values[index] ?? 0, longest)}
                    height="4"
                    fill={fillOf(id, place)}
                    opacity={each.compare === true ? 0.55 : 1}
                  />
                </svg>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface DonutSegment {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly text: string;
}

/**
 * A ring cut by share, with every segment written beside it: its pattern, its name, its
 * value and its share. The ring itself is for eyes only; the list says all of it.
 */
export function DonutChart({
  label,
  segments,
  centre,
}: {
  readonly label: string;
  readonly segments: readonly DonutSegment[];
  /** What stands in the middle of the ring: the total, as written. */
  readonly centre?: string;
}): ReactElement {
  const id = useId();
  const size = 132;
  const slices = donutSlices(
    segments.map((segment) => segment.value),
    size,
    22,
  );
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-3">
      <div className="relative mx-auto size-[132px] shrink-0 sm:mx-0">
        <svg aria-hidden viewBox={`0 0 ${String(size)} ${String(size)}`} className="size-full">
          <SeriesFills id={id} count={segments.length} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={size / 2 - 11}
            className="fill-none stroke-muted"
            strokeWidth="22"
          />
          {segments.map((segment, index) => {
            const drawn = slices[index]?.path ?? '';
            return drawn === '' ? null : (
              <path
                key={segment.key}
                d={drawn}
                fill={fillOf(id, index)}
                className="stroke-card"
                strokeWidth="1.5"
              />
            );
          })}
        </svg>
        {centre === undefined ? null : (
          <p
            aria-hidden
            className="absolute inset-0 flex items-center justify-center px-6 text-center text-lg font-medium break-words text-foreground tabular-nums"
          >
            {centre}
          </p>
        )}
      </div>
      <ul aria-label={label} className="flex min-w-40 flex-1 flex-col gap-1.5 text-sm">
        {segments.map((segment, index) => (
          <li key={segment.key} className="flex min-w-0 items-center gap-2">
            <svg aria-hidden width="12" height="12" className="shrink-0">
              <rect width="12" height="12" rx="2" fill={fillOf(id, index)} />
            </svg>
            <span className="min-w-0 flex-1 break-words text-body">{segment.label}</span>
            <span className="shrink-0 font-medium text-foreground tabular-nums">
              {segment.text}
            </span>
            <span className="w-11 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {shareText(slices[index]?.share ?? 0)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Steps that narrow: each one's value, and how much it kept of the step before. */
export function FunnelChart({
  label,
  steps,
}: {
  readonly label: string;
  readonly steps: readonly DonutSegment[];
}): ReactElement {
  const shapes = funnelSteps(steps.map((step) => step.value));
  return (
    <ol aria-label={label} className="flex min-w-0 flex-col gap-2 text-sm">
      {steps.map((step, index) => {
        const shape = shapes[index];
        const kept = shape?.kept ?? null;
        const share = shape?.share ?? 0;
        const keptText = kept === null ? '' : shareText(Math.min(kept, 1));
        return (
          <li key={step.key} className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-baseline justify-between gap-3">
              <span className="min-w-0 break-words text-body">{step.label}</span>
              <span className="shrink-0 text-right">
                <span className="font-medium text-foreground tabular-nums">{step.text}</span>
                {kept === null ? null : (
                  <span className="ml-2 text-xs text-muted-foreground">
                    <Trans>{keptText} of the step before</Trans>
                  </span>
                )}
              </span>
            </div>
            <svg
              aria-hidden
              viewBox="0 0 100 10"
              preserveAspectRatio="none"
              className="block h-6 w-full rounded-control bg-muted"
            >
              <rect x={(100 - share) / 2} width={share} height="10" className="fill-primary" />
            </svg>
          </li>
        );
      })}
    </ol>
  );
}

/** How a number stands against the period before: an arrow, a sign and words, never colour alone. */
export function ChangeLine({ amount }: { readonly amount: Compared }): ReactElement | null {
  const { i18n } = useLingui();
  const { change, before } = amount;
  if (change === undefined || before === undefined) return null;
  const size = `${changeSign(change)}${changeSize(change, i18n.locale)}`;
  const earlier = before.text;
  const Icon =
    change.direction === 'up' ? TrendingUp : change.direction === 'down' ? TrendingDown : Minus;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-body">
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
      {change.direction === 'same' ? (
        <Trans>No change from {earlier}</Trans>
      ) : change.direction === 'up' ? (
        <>
          <span className="font-medium tabular-nums">{size}</span>
          <Trans>up from {earlier}</Trans>
        </>
      ) : (
        <>
          <span className="font-medium tabular-nums">{size}</span>
          <Trans>down from {earlier}</Trans>
        </>
      )}
    </p>
  );
}

export interface StatValue {
  readonly key: string;
  /** Small and grey, above the number. */
  readonly label: string;
  /** One for each currency; one for a count. */
  readonly amounts: readonly Compared[];
}

/** Numbers with their names above them, and how each stands against the period before. */
export function StatNumbers({ values }: { readonly values: readonly StatValue[] }): ReactElement {
  return (
    <dl className="flex min-w-0 flex-wrap gap-x-8 gap-y-3">
      {values.map((value) => (
        <div key={value.key} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">{value.label}</dt>
          {value.amounts.length === 0 ? (
            <dd className="text-2xl font-medium text-foreground tabular-nums">
              <span aria-hidden>—</span>
              <span className="sr-only">
                <Trans>No value</Trans>
              </span>
            </dd>
          ) : (
            value.amounts.map((amount) => (
              <dd key={amount.currency ?? 'count'} className="flex min-w-0 flex-col gap-0.5">
                <span className="text-2xl leading-8 font-medium break-words text-foreground tabular-nums">
                  {amount.text}
                </span>
                <ChangeLine amount={amount} />
              </dd>
            ))
          )}
        </div>
      ))}
    </dl>
  );
}

/**
 * A table whose columns sort when their headings are pressed. The row that adds up what is
 * past the limit is marked "Other" and stays last. It scrolls inside its frame, which the
 * keyboard can reach.
 */
export function DataTable({
  label,
  columns,
  rows,
  renderCell,
  initialSort,
  tall = false,
}: {
  readonly label: string;
  readonly columns: readonly TableColumn[];
  readonly rows: readonly TableRow[];
  /** A cell drawn another way, such as a link; undefined leaves the cell as its text. */
  readonly renderCell?: (row: TableRow, column: number) => ReactNode;
  readonly initialSort?: Sort;
  /** True where the table may be as tall as it is long. */
  readonly tall?: boolean;
}): ReactElement {
  const { t } = useLingui();
  const [sort, setSort] = useState<Sort | undefined>(initialSort);
  const ordered = sortedRows(rows, sort);
  return (
    <div
      role="region"
      // Not the name of the card or the widget the table is in: each landmark has its own.
      aria-label={t`${label}, table`}
      // The frame scrolls, so the keyboard must be able to stand on it (WCAG 2.1.1).
      // eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex
      tabIndex={0}
      className={`${tableRegionClassName} ${tall ? '' : 'max-h-96 overflow-y-auto'}`}
    >
      <table className={tableClassName}>
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr>
            {columns.map((column, index) => {
              const sorted = sort?.column === index ? sort.direction : undefined;
              const Arrow = sorted === 'asc' ? ArrowUp : ArrowDown;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={
                    sorted === undefined ? undefined : sorted === 'asc' ? 'ascending' : 'descending'
                  }
                  className={`${headerCellClassName} sticky top-0 z-10 ${column.numeric ? 'text-right' : ''}`}
                >
                  <button
                    type="button"
                    className={`inline-flex min-h-10 items-center gap-1 rounded-control font-medium -outline-offset-2 hover:text-foreground ${column.numeric ? 'flex-row-reverse' : ''}`}
                    onClick={() => {
                      setSort(nextSort(sort, index, column.numeric));
                    }}
                  >
                    {column.label}
                    {sorted === undefined ? (
                      <span className="sr-only">{t`Sort`}</span>
                    ) : (
                      <Arrow aria-hidden className="size-3.5" strokeWidth={2} />
                    )}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ordered.map((row) => (
            <tr key={row.key} className="hover:bg-muted">
              {columns.map((column, index) => {
                const custom = renderCell?.(row, index);
                const lines = row.cells[index] ?? [];
                const content =
                  custom ??
                  lines.map((line) => (
                    <span key={line} className="block">
                      {line}
                    </span>
                  ));
                return index === 0 ? (
                  <th
                    key={column.key}
                    scope="row"
                    className={`${cellClassName} h-10 text-left font-medium break-words text-foreground`}
                  >
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      {content}
                      {row.other ? (
                        <Badge variant="neutral" className="px-2 py-0 text-xs">
                          <Trans>The rest, added up</Trans>
                        </Badge>
                      ) : null}
                    </span>
                  </th>
                ) : (
                  <td
                    key={column.key}
                    className={`${cellClassName} h-10 break-words ${column.numeric ? 'text-right tabular-nums' : ''}`}
                  >
                    {content}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What a chart's place says while its numbers load, and when there are none. */
export function ChartLoading(): ReactElement {
  return (
    <p role="status" className="py-8 text-center text-sm text-muted-foreground">
      <Trans>Loading…</Trans>
    </p>
  );
}

export function ChartEmpty({ children }: { readonly children?: ReactNode }): ReactElement {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
      <span
        aria-hidden
        className="flex size-10 items-center justify-center rounded-full bg-secondary text-secondary-foreground"
      >
        <ChartNoAxesColumn className="size-5" />
      </span>
      <p>{children ?? <Trans>No data found for these dates.</Trans>}</p>
    </div>
  );
}
