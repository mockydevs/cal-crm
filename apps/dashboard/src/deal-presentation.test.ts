import type { Deal, Pipeline } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  accentTint,
  amountOf,
  probabilityOf,
  STAGE_PALETTE,
  stageAccentOf,
  stageMarkOf,
  stageTotals,
} from './deal-presentation';

const stages: Pipeline['stages'] = [
  {
    id: 'stage_01m4bd188ff82s0add91b7pz63',
    name: 'New lead',
    description: '',
    archived: false,
    color: '#12b76a',
    probability: 20,
  },
  {
    id: 'stage_01m4bd9fteedat3be9bqgx2047',
    name: 'Proposal sent',
    description: '',
    archived: false,
    color: null,
    probability: null,
  },
];
const [green, plain] = stages.map((stage) => stage.id) as [string, string];

describe('stageAccentOf', () => {
  it('uses the stage’s own colour, else the palette by the stage’s place', () => {
    expect(stageAccentOf({ stages }, green)).toBe('#12b76a');
    expect(stageAccentOf({ stages }, plain)).toBe(STAGE_PALETTE[1]);
    expect(stageAccentOf({ stages }, 'stage_unknown')).toBe(STAGE_PALETTE[0]);
    expect(accentTint('#12b76a', 8)).toBe('color-mix(in srgb, #12b76a 8%, transparent)');
  });
});

describe('stageMarkOf', () => {
  it('draws nothing unless the pipeline draws colours and the stage has one', () => {
    expect(stageMarkOf({ stages }, green)).toEqual({});
    expect(stageMarkOf({ colorStyle: 'none', stages }, green)).toEqual({});
    expect(stageMarkOf({ colorStyle: 'dot', stages }, plain)).toEqual({});
    expect(stageMarkOf({ colorStyle: 'tint', stages }, 'stage_01m4bd188ff82s0add91b7pz69')).toEqual(
      {},
    );
    expect(stageMarkOf(undefined, green)).toEqual({});
  });

  it('draws the colour as a dot, or thinned to a tint that text stays readable on', () => {
    expect(stageMarkOf({ colorStyle: 'dot', stages }, green)).toEqual({ dot: '#12b76a' });
    expect(stageMarkOf({ colorStyle: 'tint', stages }, green)).toEqual({
      tint: 'color-mix(in srgb, #12b76a 16%, transparent)',
    });
  });
});

describe('probabilityOf', () => {
  it('is the stage probability unless the pipeline says opportunities carry their own', () => {
    expect(probabilityOf({ stages }, { stageId: green, probability: 75 })).toBe(20);
    expect(probabilityOf({ dealProbability: false, stages }, { stageId: plain })).toBeUndefined();
  });

  it('is the opportunity probability where the pipeline says so, and nothing when unset', () => {
    const pipeline = { dealProbability: true, stages };
    expect(probabilityOf(pipeline, { stageId: green, probability: 75 })).toBe(75);
    expect(probabilityOf(pipeline, { stageId: green, probability: 0 })).toBe(0);
    expect(probabilityOf(pipeline, { stageId: green, probability: null })).toBeUndefined();
    expect(probabilityOf(pipeline, { stageId: green })).toBeUndefined();
  });
});

const priced = (amount: string | null, currency = 'KES'): Pick<Deal, 'amount' | 'currency'> => ({
  amount,
  currency,
});

describe('amountOf', () => {
  it('groups the whole part and keeps every decimal place', () => {
    expect(amountOf(priced('123456789.1234'))).toBe('KES 123,456,789.1234');
    expect(amountOf(priced('11000'))).toBe('KES 11,000');
  });

  it('shows a dash for an opportunity with no value', () => {
    expect(amountOf(priced(null))).toBe('—');
  });
});

describe('stageTotals', () => {
  it('adds the values of a stage exactly, beyond what a floating-point number holds', () => {
    expect(stageTotals([priced('9007199254740993.1250'), priced('0.0001')])).toEqual([
      'KES 9,007,199,254,740,993.1251',
    ]);
  });

  it('keeps as many decimal places as the values have', () => {
    expect(stageTotals([priced('11000'), priced('500')])).toEqual(['KES 11,500']);
    expect(stageTotals([priced('11000.50'), priced('0.5')])).toEqual(['KES 11,001.00']);
    expect(stageTotals([priced('0.0500'), priced('1')])).toEqual(['KES 1.0500']);
  });

  it('leaves out opportunities with no value, and says nothing when none has one', () => {
    expect(stageTotals([priced(null), priced('20')])).toEqual(['KES 20']);
    expect(stageTotals([priced(null)])).toEqual([]);
    expect(stageTotals([])).toEqual([]);
  });

  it('gives one total for each currency, in the order of their codes', () => {
    expect(stageTotals([priced('5', 'USD'), priced('7', 'KES'), priced('1.5', 'USD')])).toEqual([
      'KES 7',
      'USD 6.5',
    ]);
  });
});
