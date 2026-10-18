// What holds the pure parts together: the limiter, the templates against the contract, and
// the catalogue against the SQL behind it, key for key.
import {
  REPORT_LIMITS,
  reportDefinition,
  reportQuery,
  reportSourceKeys,
  reportSources,
  reportTemplate,
  type ReportSourceSpec,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { choiceLabel, granted, missingForSource } from './engine.js';
import { createQueryLimiter } from './rate-limit.js';
import { sourceShapes, touchColumns } from './sources.js';
import { buildTemplate, reportTemplates } from './templates/index.js';

const PIPELINE = 'pipe_01h455vb4pex5vsknk084sn02q';

describe('the query limiter', () => {
  it('admits so many a minute for each person, and again once the minute is over', () => {
    let now = 1_000_000;
    const limiter = createQueryLimiter(2, () => now);
    expect([limiter.admit('a'), limiter.admit('a'), limiter.admit('a')]).toEqual([
      true,
      true,
      false,
    ]);
    expect(limiter.admit('b')).toBe(true);
    now += 59_999;
    expect(limiter.admit('a')).toBe(false);
    now += 1;
    expect([limiter.admit('a'), limiter.admit('a'), limiter.admit('a')]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('forgets the people whose minute is over when it remembers too many', () => {
    let now = 0;
    const limiter = createQueryLimiter(1, () => now, 2);
    limiter.admit('a');
    now += 30_000;
    limiter.admit('b');
    now += 40_000;
    // a's minute is over and b's is not: a third person makes room by forgetting a alone.
    expect(limiter.admit('c')).toBe(true);
    expect(limiter.admit('b')).toBe(false);
    expect(limiter.admit('a')).toBe(true);
  });

  it('uses the clock when given none', () => {
    expect(createQueryLimiter(1).admit('a')).toBe(true);
  });
});

describe('the Template Library', () => {
  it('lists templates the contract accepts, each with a key of its own', () => {
    expect(reportTemplates.map((template) => template.key)).toEqual(['pipeline_attribution']);
    for (const template of reportTemplates) {
      expect(reportTemplate.parse(template)).toEqual(template);
      expect(template.key).toMatch(/^[a-z][a-z0-9_]{0,59}$/);
    }
  });

  it('builds a definition whose every widget is a query the contract accepts', () => {
    for (const binding of [{}, { pipelineId: PIPELINE }]) {
      const built = buildTemplate('pipeline_attribution', binding);
      expect(built?.name).toBe('Pipeline & Attribution Report');
      const definition = reportDefinition.parse(built?.definition);
      const widgets = definition.pages.flatMap((page) => page.widgets);
      expect(widgets.length).toBeLessThanOrEqual(REPORT_LIMITS.widgetsPerPage * 2);
      for (const widget of widgets)
        expect(
          reportQuery.safeParse({ ...widget.query, range: definition.range }).success,
          widget.id,
        ).toBe(true);
    }
  });

  it('puts the funnel on the pipeline it is given, and on every stage without one', () => {
    const funnel = (pipelineId?: string) =>
      buildTemplate('pipeline_attribution', { pipelineId })?.definition.pages[0]?.widgets.find(
        (widget) => widget.id === 'funnel',
      )?.query;
    expect(funnel(PIPELINE)?.filters?.groups[0]?.conditions[0]?.values).toEqual([PIPELINE]);
    expect(funnel()?.filters).toBeUndefined();
    expect(funnel()).toMatchObject({ groupBy: ['stage'], order: { by: 'group' } });
  });

  it('knows no other key', () => {
    expect(buildTemplate('nothing', {})).toBeUndefined();
  });
});

describe('the catalogue and the SQL behind it', () => {
  it.each(reportSourceKeys)('name the same things for %s', (key) => {
    const spec: ReportSourceSpec = reportSources[key];
    const shape = sourceShapes[key];
    expect(Object.keys(shape.dates).sort()).toEqual(Object.keys(spec.dateProperties).sort());
    expect(Object.keys(shape.numbers).sort()).toEqual([...spec.numberFilters].sort());
    expect(spec.dateProperties).toHaveProperty(spec.defaultDate);
    for (const [dimension, each] of Object.entries(spec.dimensions)) {
      const column = each.attribution === true ? touchColumns[dimension] : shape.columns[dimension];
      // A weekday is worked out from the query's date, and has no column of its own.
      expect(column === undefined, `${key}.${dimension}`).toBe(each.kind === 'weekday');
      expect(each.kind === 'choice', `${key}.${dimension}`).toBe(each.choices !== undefined);
      expect(each.kind === 'reference', `${key}.${dimension}`).toBe(each.reference !== undefined);
    }
    for (const dimension of Object.keys(shape.columns))
      expect(spec.dimensions, `${key}.${dimension}`).toHaveProperty(dimension);
    // Money only where the SQL has an amount to add up.
    const money = Object.values(spec.measures).some((measure) => measure.kind === 'money');
    expect(shape.money !== null).toBe(money);
    expect((shape.touch === null) === (key === 'attribution')).toBe(true);
  });
});

describe('what a role allows', () => {
  const reader = { context: { agencyId: 'a', actorKind: 'user', correlationId: 'c' } } as const;
  it('is everything for the system, and what was granted for anyone else', () => {
    expect(granted({ ...reader, permissions: 'all' }, 'reports.manage')).toBe(true);
    const some = { ...reader, permissions: new Set(['reports.view'] as const) };
    expect(granted(some, 'reports.view')).toBe(true);
    expect(granted(some, 'reports.manage')).toBe(false);
  });

  it('names what a source asks beside reports.view, when the role lacks it', () => {
    const some = { ...reader, permissions: new Set(['reports.view'] as const) };
    expect(missingForSource(some, { permission: null })).toBeUndefined();
    expect(missingForSource(some, { permission: 'payments.read' })).toBe('payments.read');
    expect(
      missingForSource({ ...reader, permissions: 'all' }, { permission: 'payments.read' }),
    ).toBeUndefined();
    const paid = { ...reader, permissions: new Set(['reports.view', 'payments.read'] as const) };
    expect(missingForSource(paid, { permission: 'payments.read' })).toBeUndefined();
  });

  it('words a choice', () => {
    expect([choiceLabel('paid_search'), choiceLabel('crm_ui'), choiceLabel('completed')]).toEqual([
      'Paid search',
      'CRM UI',
      'Showed',
    ]);
  });
});
