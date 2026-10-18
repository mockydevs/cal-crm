import { reportPresets } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  appointmentSearchOf,
  attributionSearchOf,
  DEFAULT_RANGE,
  rangePresetNames,
  rangeSearchOf,
  reportSearchOf,
} from './reporting-search';

describe('presets', () => {
  it('are the contract’s own, in its order', () => {
    expect([...rangePresetNames]).toEqual([...reportPresets]);
    expect(DEFAULT_RANGE).toBe('last_30_days');
  });
});

describe('rangeSearchOf', () => {
  it('keeps a preset, and leaves the default out', () => {
    expect(rangeSearchOf({ range: 'this_quarter' })).toEqual({ range: 'this_quarter' });
    expect(rangeSearchOf({ range: 'last_30_days' })).toEqual({});
    expect(rangeSearchOf({})).toEqual({});
  });

  it('drops what is not a range', () => {
    expect(rangeSearchOf({ range: 'forever' })).toEqual({});
    expect(rangeSearchOf({ range: 7 })).toEqual({});
    // Days mean nothing beside a preset.
    expect(rangeSearchOf({ range: 'today', from: '2026-10-01' })).toEqual({ range: 'today' });
  });

  it('keeps the days of a custom range that are days', () => {
    expect(rangeSearchOf({ range: 'custom', from: '2026-10-01', to: '2026-10-12' })).toEqual({
      range: 'custom',
      from: '2026-10-01',
      to: '2026-10-12',
    });
    expect(rangeSearchOf({ range: 'custom', from: 'soon', to: 20261012 })).toEqual({
      range: 'custom',
    });
    expect(rangeSearchOf({ range: 'custom', to: '2026-10-12' })).toEqual({
      range: 'custom',
      to: '2026-10-12',
    });
  });
});

describe('attributionSearchOf', () => {
  it('keeps the latest touch and the source view, and leaves the defaults out', () => {
    expect(attributionSearchOf({ attribution: 'latest', view: 'source', range: 'today' })).toEqual({
      range: 'today',
      attribution: 'latest',
      view: 'source',
    });
    expect(attributionSearchOf({ attribution: 'first', view: 'conversion' })).toEqual({});
    expect(attributionSearchOf({ attribution: 'all', view: 7 })).toEqual({});
  });
});

describe('appointmentSearchOf', () => {
  it('keeps the booking date, a calendar and the latest touch', () => {
    expect(
      appointmentSearchOf({
        by: 'created',
        calendar: 'cal_01h455vb4pex5vsknk084sn02q',
        attribution: 'latest',
        range: 'custom',
        from: '2026-10-01',
        to: '2026-10-02',
      }),
    ).toEqual({
      range: 'custom',
      from: '2026-10-01',
      to: '2026-10-02',
      by: 'created',
      calendar: 'cal_01h455vb4pex5vsknk084sn02q',
      attribution: 'latest',
    });
  });

  it('drops what it does not know', () => {
    expect(appointmentSearchOf({ by: 'starts', attribution: 'first' })).toEqual({});
    expect(appointmentSearchOf({ calendar: 'con_01h455vb4pex5vsknk084sn02q' })).toEqual({});
    expect(appointmentSearchOf({ calendar: 'cal_<script>' })).toEqual({});
    expect(appointmentSearchOf({ calendar: 12 })).toEqual({});
  });
});

describe('reportSearchOf', () => {
  it('keeps a page after the first, and whether the report is being changed', () => {
    expect(reportSearchOf({ page: 2, edit: true })).toEqual({ page: 2, edit: true });
    expect(reportSearchOf({ page: '3', edit: 'true' })).toEqual({ page: 3, edit: true });
    expect(reportSearchOf({ edit: 1 })).toEqual({ edit: true });
  });

  it('leaves the first page and reading out, and drops nonsense', () => {
    expect(reportSearchOf({ page: 1, edit: false })).toEqual({});
    expect(reportSearchOf({ page: 21 })).toEqual({});
    expect(reportSearchOf({ page: 2.5 })).toEqual({});
    expect(reportSearchOf({ page: 'two', edit: 'yes' })).toEqual({});
    expect(reportSearchOf({})).toEqual({});
  });
});
