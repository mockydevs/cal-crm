// The geometry of Reporting's charts: scales with round ticks, the points and paths of a
// line and its area, the bands bars stand in, the arcs of a donut and the steps of a
// funnel. Numbers in, numbers and path strings out: nothing here knows about React, colours
// or words, so the same functions can draw a PDF's charts later. The share of a track a bar
// fills is the one the Dashboard's widgets use (chart-numbers.ts).
import { barShare } from '../chart-numbers';

export { barShare };

/** A number to two decimal places, without a trailing zero: what a path is written with. */
export const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface Scale {
  /** The top of the axis: the first round number at or above the largest value. */
  readonly max: number;
  /** The values the axis marks, from 0 to `max`. */
  readonly ticks: readonly number[];
}

const STEPS = [1, 2, 2.5, 5, 10] as const;

/**
 * An axis from 0 that holds `most`, marked at about `wanted` round steps. Whole numbers
 * are never marked at fractions: an axis of counts steps by at least 1.
 */
export function niceScale(most: number, wanted = 4, whole = true): Scale {
  if (!(most > 0)) return { max: 1, ticks: [0, 1] };
  const rough = most / Math.max(1, wanted);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  let step = magnitude * 10;
  for (const each of STEPS) {
    // 2.5 is not a step between whole numbers.
    if (whole && magnitude === 1 && each === 2.5) continue;
    if (each * magnitude >= rough) {
      step = each * magnitude;
      break;
    }
  }
  if (whole) step = Math.max(1, Math.round(step));
  const count = Math.ceil(round2(most / step));
  const ticks = Array.from({ length: count + 1 }, (_, index) => round2(index * step));
  return { max: round2(count * step), ticks };
}

/** How far up a plot of this height a value stands, measured from the top. */
export function yOf(value: number, max: number, height: number): number {
  if (!(max > 0)) return height;
  return round2(height - (Math.min(Math.max(value, 0), max) / max) * height);
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Where each value of a series stands: spread over the width, the only one in its middle. */
export function linePoints(
  values: readonly number[],
  width: number,
  height: number,
  max: number,
): Point[] {
  const gap = values.length > 1 ? width / (values.length - 1) : 0;
  return values.map((value, index) => ({
    x: round2(values.length > 1 ? index * gap : width / 2),
    y: yOf(value, max, height),
  }));
}

/** The parts of a path, written out with a space between them. */
const SEPARATOR = ' ';
const path = (...parts: readonly (string | number)[]): string => parts.join(SEPARATOR);

/** The path through the points, in order. Empty for none. */
export function linePath(points: readonly Point[]): string {
  return path(...points.flatMap((point, index) => [index === 0 ? 'M' : 'L', point.x, point.y]));
}

/** The area between the points and the foot of a plot of this height. Empty for none. */
export function areaPath(points: readonly Point[], height: number): string {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) return '';
  return path(linePath(points), 'L', last.x, height, 'L', first.x, height, 'Z');
}

export interface Band {
  /** Where the band starts along the axis. */
  readonly start: number;
  readonly size: number;
  readonly middle: number;
}

/** `count` equal bands along `extent`, each with `gap` of its share left empty around it. */
export function bands(count: number, extent: number, gap = 0.2): Band[] {
  if (count <= 0) return [];
  const step = extent / count;
  const size = step * (1 - Math.min(Math.max(gap, 0), 0.9));
  return Array.from({ length: count }, (_, index) => {
    const start = index * step + (step - size) / 2;
    return { start: round2(start), size: round2(size), middle: round2(start + size / 2) };
  });
}

export interface Bar {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The bars of one category: one for each series, side by side in the category's band.
 * A value that is not zero is at least one unit tall, so it is seen.
 */
export function barsIn(band: Band, values: readonly number[], max: number, height: number): Bar[] {
  const inner = bands(values.length, band.size, values.length > 1 ? 0.1 : 0);
  return values.map((value, index) => {
    const slot = inner[index] ?? { start: 0, size: band.size, middle: 0 };
    const top = yOf(value, max, height);
    const tall = value > 0 ? Math.max(height - top, 1) : 0;
    return {
      x: round2(band.start + slot.start),
      y: round2(height - tall),
      width: slot.size,
      height: round2(tall),
    };
  });
}

/**
 * Which of `count` labels an axis with room for `room` shows: every one when they fit,
 * else every nth, always the first.
 */
export function shownLabels(count: number, room: number): number[] {
  if (count <= 0) return [];
  const every = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(room))));
  const shown: number[] = [];
  for (let index = 0; index < count; index += every) shown.push(index);
  return shown;
}

const point = (cx: number, cy: number, radius: number, angle: number): string =>
  path(round2(cx + radius * Math.sin(angle)), round2(cy - radius * Math.cos(angle)));

/** A ring's slice between two angles, clockwise from the top, in radians. */
export function arcPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  from: number,
  to: number,
): string {
  // A whole ring cannot be one arc (it would start where it ends): stop just short.
  const end = Math.min(to, from + Math.PI * 2 - 0.001);
  const large = end - from > Math.PI ? 1 : 0;
  return path(
    'M',
    point(cx, cy, outer, from),
    'A',
    outer,
    outer,
    0,
    large,
    1,
    point(cx, cy, outer, end),
    'L',
    point(cx, cy, inner, end),
    'A',
    inner,
    inner,
    0,
    large,
    0,
    point(cx, cy, inner, from),
    'Z',
  );
}

export interface Slice {
  /** The value's part of the whole, from 0 to 1. */
  readonly share: number;
  readonly from: number;
  readonly to: number;
  /** Empty for a value of nothing. */
  readonly path: string;
}

/** A donut's slices, clockwise from the top, each its value's share of the sum. */
export function donutSlices(values: readonly number[], size: number, thickness: number): Slice[] {
  const total = values.reduce((sum, value) => sum + Math.max(value, 0), 0);
  const radius = size / 2;
  let angle = 0;
  return values.map((value) => {
    const share = total > 0 ? Math.max(value, 0) / total : 0;
    const from = angle;
    angle += share * Math.PI * 2;
    return {
      share,
      from,
      to: angle,
      path: share > 0 ? arcPath(radius, radius, radius, radius - thickness, from, angle) : '',
    };
  });
}

export interface FunnelStep {
  /** How much of the width the step fills, from 0 to 100, against the largest step. */
  readonly share: number;
  /** The step against the one before it, from 0 to 1. None for the first, or after nothing. */
  readonly kept: number | null;
}

/** A funnel's steps: each one's width against the largest, and what it kept of the last. */
export function funnelSteps(values: readonly number[]): FunnelStep[] {
  const longest = Math.max(0, ...values);
  return values.map((value, index) => {
    const before = index === 0 ? undefined : values[index - 1];
    return {
      share: barShare(value, longest),
      kept: before === undefined || !(before > 0) ? null : Math.max(value, 0) / before,
    };
  });
}

/** A share from 0 to 1 as a whole percentage, with one decimal place under ten. */
export function shareText(share: number): string {
  const percent = share * 100;
  return `${percent > 0 && percent < 10 ? String(Math.round(percent * 10) / 10) : String(Math.round(percent))}%`;
}
