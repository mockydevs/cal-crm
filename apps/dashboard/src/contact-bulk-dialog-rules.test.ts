import { describe, expect, it } from 'vitest';

import {
  deliveryDefaults,
  deliveryOf,
  dripMinutes,
  selectionOf,
  type DeliveryForm,
} from './contact-bulk-dialog-rules';

const form = (change: Partial<DeliveryForm>): DeliveryForm => ({ ...deliveryDefaults, ...change });

describe('when an action runs', () => {
  it('sends nothing for now', () => {
    expect(deliveryOf(form({ mode: 'now', startAt: '2026-10-20T09:00' }))).toEqual({});
  });

  it('needs a start time for later, read in the reader’s own time', () => {
    expect(deliveryOf(form({ mode: 'later' }))).toEqual({ problem: 'start_required' });
    expect(deliveryOf(form({ mode: 'later', startAt: 'soon' }))).toEqual({
      problem: 'start_invalid',
    });
    expect(deliveryOf(form({ mode: 'later', startAt: '2026-10-20T09:00' }))).toEqual({
      delivery: { startAt: new Date('2026-10-20T09:00').toISOString() },
    });
  });

  it('drips a batch every interval, in minutes, hours or days, from an optional start', () => {
    expect(deliveryOf(form({ mode: 'drip', batchSize: '50', every: '2', unit: 'hours' }))).toEqual({
      delivery: { drip: { batchSize: 50, intervalMinutes: 120 } },
    });
    expect(
      deliveryOf(
        form({
          mode: 'drip',
          batchSize: '10000',
          every: '30',
          unit: 'days',
          startAt: '2026-10-20T09:00',
        }),
      ),
    ).toEqual({
      delivery: {
        startAt: new Date('2026-10-20T09:00').toISOString(),
        drip: { batchSize: 10_000, intervalMinutes: 43_200 },
      },
    });
    for (const batchSize of ['0', '10001', '', '1.5', 'ten'])
      expect(deliveryOf(form({ mode: 'drip', batchSize }))).toEqual({ problem: 'batch' });
    for (const [every, unit] of [
      ['0', 'minutes'],
      ['31', 'days'],
      ['', 'hours'],
    ] as const)
      expect(deliveryOf(form({ mode: 'drip', every, unit }))).toEqual({ problem: 'interval' });
  });

  it('reckons a drip from its first batch to its last', () => {
    expect(dripMinutes(250, 100, 60)).toBe(120);
    expect(dripMinutes(100, 100, 60)).toBe(0);
    expect(dripMinutes(0, 100, 60)).toBe(0);
  });
});

describe('which contacts an action is for', () => {
  it('names the ticked ones, or every one the list holds with its search and filters', () => {
    expect(selectionOf({ kind: 'ids', ids: ['con_1', 'con_2'] })).toEqual({
      ids: ['con_1', 'con_2'],
    });
    expect(
      selectionOf({
        kind: 'all',
        list: { q: '', createdFrom: undefined },
        except: [],
      }),
    ).toEqual({ all: true });
    expect(
      selectionOf({
        kind: 'all',
        list: {
          q: 'ada',
          createdFrom: '2026-10-01T00:00:00.000Z',
          fieldId: 'fld_1',
          fieldOperator: 'equals',
          fieldValue: 'Austin',
          sortField: 'fld_2',
        },
        except: ['con_3'],
      }),
    ).toEqual({
      all: true,
      q: 'ada',
      createdFrom: '2026-10-01T00:00:00.000Z',
      fieldId: 'fld_1',
      fieldOperator: 'equals',
      fieldValue: 'Austin',
      except: ['con_3'],
    });
  });

  it("keeps the Filters panel's conditions for every contact the list holds", () => {
    const filter = {
      match: 'all' as const,
      groups: [
        {
          match: 'all' as const,
          conditions: [
            { field: 'emailVerification', operator: 'any_of' as const, values: ['invalid'] },
          ],
        },
      ],
    };
    expect(
      selectionOf({ kind: 'all', list: { q: '', createdFrom: undefined, filter }, except: [] }),
    ).toEqual({ all: true, filter });
  });
});
