import { describe, expect, it } from 'vitest';
import {
  arcPath,
  areaPath,
  bands,
  barsIn,
  donutSlices,
  funnelSteps,
  linePath,
  linePoints,
  niceScale,
  round2,
  shareText,
  shownLabels,
  yOf,
} from './chart-geometry';

describe('niceScale', () => {
  it('marks an empty chart from 0 to 1', () => {
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(-3)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(Number.NaN)).toEqual({ max: 1, ticks: [0, 1] });
  });

  it('never marks whole numbers at fractions', () => {
    expect(niceScale(1)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(3)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    expect(niceScale(4)).toEqual({ max: 4, ticks: [0, 1, 2, 3, 4] });
    expect(niceScale(7)).toEqual({ max: 8, ticks: [0, 2, 4, 6, 8] });
    // 2.5 is not a step between whole numbers: 9 over 4 steps goes by 5.
    expect(niceScale(9)).toEqual({ max: 10, ticks: [0, 5, 10] });
  });

  it('rounds up to a round step for large values', () => {
    expect(niceScale(87)).toEqual({ max: 100, ticks: [0, 25, 50, 75, 100] });
    expect(niceScale(1234)).toEqual({ max: 1500, ticks: [0, 500, 1000, 1500] });
    expect(niceScale(125000, 4, false)).toEqual({
      max: 150000,
      ticks: [0, 50000, 100000, 150000],
    });
  });

  it('steps by fractions for money under one unit', () => {
    expect(niceScale(0.9, 4, false)).toEqual({ max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
    expect(niceScale(2.4, 4, false).ticks).toEqual([0, 1, 2, 3]);
  });

  it('takes as few steps as asked for', () => {
    expect(niceScale(10, 2)).toEqual({ max: 10, ticks: [0, 5, 10] });
    expect(niceScale(10, 0)).toEqual({ max: 10, ticks: [0, 10] });
    // A step past every listed one falls to the next power of ten.
    expect(niceScale(95, 1)).toEqual({ max: 100, ticks: [0, 100] });
  });
});

describe('yOf', () => {
  it('measures from the top, and keeps a value inside the plot', () => {
    expect(yOf(0, 10, 200)).toBe(200);
    expect(yOf(10, 10, 200)).toBe(0);
    expect(yOf(2.5, 10, 200)).toBe(150);
    expect(yOf(25, 10, 200)).toBe(0);
    expect(yOf(-5, 10, 200)).toBe(200);
    expect(yOf(5, 0, 200)).toBe(200);
  });
});

describe('lines and areas', () => {
  it('spreads points over the width', () => {
    expect(linePoints([0, 5, 10], 100, 50, 10)).toEqual([
      { x: 0, y: 50 },
      { x: 50, y: 25 },
      { x: 100, y: 0 },
    ]);
  });

  it('puts the only point in the middle', () => {
    expect(linePoints([4], 100, 50, 8)).toEqual([{ x: 50, y: 25 }]);
    expect(linePoints([], 100, 50, 8)).toEqual([]);
  });

  it('writes the path through the points', () => {
    const points = linePoints([0, 5, 10], 100, 50, 10);
    expect(linePath(points)).toBe('M 0 50 L 50 25 L 100 0');
    expect(linePath([])).toBe('');
  });

  it('closes an area down to the foot of the plot', () => {
    const points = linePoints([0, 10], 100, 50, 10);
    expect(areaPath(points, 50)).toBe('M 0 50 L 100 0 L 100 50 L 0 50 Z');
    expect(areaPath([], 50)).toBe('');
  });
});

describe('bands and bars', () => {
  it('cuts the extent into equal bands with room around each', () => {
    expect(bands(2, 100, 0.2)).toEqual([
      { start: 5, size: 40, middle: 25 },
      { start: 55, size: 40, middle: 75 },
    ]);
    expect(bands(0, 100)).toEqual([]);
    expect(bands(-1, 100)).toEqual([]);
  });

  it('keeps the gap between nothing and nearly all', () => {
    expect(bands(1, 100, -1)).toEqual([{ start: 0, size: 100, middle: 50 }]);
    expect(bands(1, 100, 5)[0]?.size).toBe(10);
    expect(bands(1, 100)[0]).toEqual({ start: 10, size: 80, middle: 50 });
  });

  it('stands one bar for each series in a band', () => {
    const [band] = bands(1, 100, 0);
    if (band === undefined) throw new Error('no band');
    expect(barsIn(band, [10], 10, 200)).toEqual([{ x: 0, y: 0, width: 100, height: 200 }]);
    const pair = barsIn(band, [5, 0], 10, 200);
    expect(pair).toEqual([
      { x: 2.5, y: 100, width: 45, height: 100 },
      { x: 52.5, y: 200, width: 45, height: 0 },
    ]);
  });

  it('shows a value that is not zero as at least a sliver', () => {
    const [band] = bands(1, 100, 0);
    if (band === undefined) throw new Error('no band');
    expect(barsIn(band, [1], 10_000, 200)[0]).toMatchObject({ height: 1, y: 199 });
  });
});

describe('shownLabels', () => {
  it('shows every label that fits, else every nth from the first', () => {
    expect(shownLabels(5, 10)).toEqual([0, 1, 2, 3, 4]);
    expect(shownLabels(10, 5)).toEqual([0, 2, 4, 6, 8]);
    expect(shownLabels(30, 4.9)).toEqual([0, 8, 16, 24]);
    expect(shownLabels(3, 0)).toEqual([0]);
    expect(shownLabels(0, 5)).toEqual([]);
  });
});

describe('donut', () => {
  it('cuts the ring by share, clockwise from the top', () => {
    const slices = donutSlices([1, 1, 2], 100, 20);
    expect(slices.map((slice) => slice.share)).toEqual([0.25, 0.25, 0.5]);
    expect(slices[0]?.from).toBe(0);
    expect(slices[0]?.to).toBeCloseTo(Math.PI / 2);
    expect(slices[2]?.to).toBeCloseTo(Math.PI * 2);
    // A quarter from the top: out to the right edge, back along the inner ring.
    expect(slices[0]?.path).toBe('M 50 0 A 50 50 0 0 1 100 50 L 80 50 A 30 30 0 0 0 50 20 Z');
  });

  it('draws nothing for nothing', () => {
    expect(donutSlices([0, 0], 100, 20)).toEqual([
      { share: 0, from: 0, to: 0, path: '' },
      { share: 0, from: 0, to: 0, path: '' },
    ]);
    expect(donutSlices([], 100, 20)).toEqual([]);
    expect(donutSlices([-4, 4], 100, 20).map((slice) => slice.share)).toEqual([0, 1]);
  });

  it('draws a whole ring as one slice that stops just short of where it starts', () => {
    const [whole] = donutSlices([7], 100, 20);
    expect(whole?.share).toBe(1);
    expect(whole?.path.startsWith('M 50 0 A 50 50 0 1 1 49.95 0')).toBe(true);
  });

  it('takes the long way round for more than half', () => {
    expect(arcPath(50, 50, 50, 30, 0, Math.PI * 1.5)).toBe(
      'M 50 0 A 50 50 0 1 1 0 50 L 20 50 A 30 30 0 1 0 50 20 Z',
    );
  });
});

describe('funnelSteps', () => {
  it('measures each step against the largest and against the one before', () => {
    expect(funnelSteps([200, 100, 25])).toEqual([
      { share: 100, kept: null },
      { share: 50, kept: 0.5 },
      { share: 12.5, kept: 0.25 },
    ]);
  });

  it('has nothing to keep after nothing', () => {
    expect(funnelSteps([0, 4])).toEqual([
      { share: 0, kept: null },
      { share: 100, kept: null },
    ]);
    expect(funnelSteps([])).toEqual([]);
    expect(funnelSteps([4, -1])[1]).toEqual({ share: 0, kept: 0 });
  });
});

describe('text', () => {
  it('rounds to two places', () => {
    expect(round2(1.005)).toBe(1);
    expect(round2(33.33333)).toBe(33.33);
  });

  it('writes a share as a percentage, with a decimal under ten', () => {
    expect(shareText(0.5)).toBe('50%');
    expect(shareText(0.0349)).toBe('3.5%');
    expect(shareText(0)).toBe('0%');
    expect(shareText(1)).toBe('100%');
    expect(shareText(0.999)).toBe('100%');
  });
});
