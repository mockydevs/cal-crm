// Saved reports against real Postgres: made blank, from a template and from a definition;
// listed, found and paged; saved under a revision; copied; deleted; and kept to the
// business and to the people whose role allows it.
import {
  BLANK_REPORT_DEFINITION,
  report,
  reportList,
  reportQuery,
  type Report,
  type ReportTemplate,
} from '@repo/contracts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { beforeAll, expect, it } from 'vitest';

import { REPORT_LIMIT } from './reports.js';
import { refusalOf, reportingSuite, type Seeded } from '../test/reporting-fixtures.js';

const suite = reportingSuite();
let one: Seeded;
let other: Seeded;
let pipeline: { id: string; stages: string[] };

beforeAll(async () => {
  one = await suite.business();
  other = await suite.business('Africa/Nairobi', one.agencyId);
  pipeline = await suite.pipeline(one, 'Sales', ['New', 'Won']);
});

const create = async (body: unknown, seeded = one, invocation = seeded.manager): Promise<Report> =>
  report.parse(await suite.api(seeded, 'createReport', { body }, invocation));
const list = async (query: unknown = {}, seeded = one, invocation = seeded.manager) =>
  reportList.parse(await suite.api(seeded, 'listReports', { query }, invocation));

it('makes a blank report, and one from a definition', async () => {
  const blank = await create({});
  expect(blank).toMatchObject({
    name: 'Untitled report',
    templateKey: null,
    createdBy: { kind: 'user' },
    scheduleFrequency: null,
    revision: 1,
    definition: BLANK_REPORT_DEFINITION,
    canManage: true,
  });
  expect(blank.createdBy.name).toMatch(/^User /);
  const definition = {
    ...BLANK_REPORT_DEFINITION,
    pages: [
      {
        name: 'Leads',
        widgets: [
          { id: 'note', kind: 'text', title: 'About', text: 'Leads by source.', w: 12, h: 1 },
          {
            id: 'leads',
            kind: 'donut',
            title: 'Leads',
            query: { source: 'contacts', measures: ['count'], groupBy: ['sessionSource'] },
            range: { preset: 'this_month' },
            compare: null,
            w: 6,
            h: 4,
          },
        ],
      },
    ],
  };
  const made = await create({ name: 'Leads', definition });
  expect(made.definition.pages[0]?.widgets.map((widget) => widget.id)).toEqual(['note', 'leads']);
  const read = report.parse(await suite.api(one, 'getReport', { params: { id: made.id } }));
  expect(read).toEqual(made);
});

it('makes a report from the Template Library, with the funnel on the business’s first pipeline', async () => {
  const { items } = (await suite.api(one, 'listReportTemplates')) as { items: ReportTemplate[] };
  expect(items.map((item) => [item.key, item.version, item.name])).toEqual([
    ['pipeline_attribution', 1, 'Pipeline & Attribution Report'],
  ]);
  const made = await create({ templateKey: 'pipeline_attribution' });
  expect(made).toMatchObject({
    name: 'Pipeline & Attribution Report',
    templateKey: 'pipeline_attribution',
    createdBy: { kind: 'template_library', name: 'Template Library' },
  });
  const funnel = made.definition.pages[0]?.widgets.find((widget) => widget.id === 'funnel');
  expect(funnel?.query?.filters?.groups[0]?.conditions[0]).toEqual({
    field: 'pipeline',
    operator: 'any_of',
    values: [toPublicId('pipeline', pipeline.id)],
  });
  // Every widget of it runs as it is, with the report's own range and comparison.
  for (const page of made.definition.pages)
    for (const widget of page.widgets) {
      const query = reportQuery.parse({
        ...widget.query,
        range: widget.range ?? made.definition.range,
        ...(made.definition.compare === null ? {} : { compare: made.definition.compare }),
      });
      await expect(
        suite.api(one, 'runReportQuery', { body: query }),
        widget.id,
      ).resolves.toBeDefined();
    }
  // A business without a pipeline gets the funnel of every stage; a name can be given.
  const bare = await create({ templateKey: 'pipeline_attribution', name: 'Mine' }, other);
  expect(bare.name).toBe('Mine');
  expect(
    bare.definition.pages[0]?.widgets.find((widget) => widget.id === 'funnel')?.query?.filters,
  ).toBeUndefined();
  const refused = await refusalOf(() => create({ templateKey: 'nothing' }), ValidationError);
  expect(refused.issues[0]).toMatchObject({ path: '/templateKey', code: 'unknown_template' });
});

it('lists the newest first, finds by name and pages', async () => {
  const fresh = await suite.business();
  const names = ['Weekly leads', 'Monthly 100% review', 'Weekly sales'];
  const made: Report[] = [];
  for (const name of names) made.push(await create({ name }, fresh));
  const all = await list({}, fresh);
  expect(all.items.map((item) => item.name)).toEqual([...names].reverse());
  expect(all).toMatchObject({ nextCursor: null, canManage: true });
  expect(all.items[0]).not.toHaveProperty('definition');
  expect((await list({ q: 'WEEKLY' }, fresh)).items).toHaveLength(2);
  // A wildcard is text to find, not a pattern.
  expect((await list({ q: '100%' }, fresh)).items.map((item) => item.name)).toEqual([
    'Monthly 100% review',
  ]);
  expect((await list({ q: '%' }, fresh)).items).toHaveLength(1);
  const first = await list({ limit: 2 }, fresh);
  expect(first.items).toHaveLength(2);
  expect(first.nextCursor).toBe(made[1]?.id);
  const second = await list({ limit: 2, after: first.nextCursor }, fresh);
  expect(second.items.map((item) => item.name)).toEqual(['Weekly leads']);
  expect(second.nextCursor).toBeNull();
});

it('saves under the revision it read, and refuses a stale one', async () => {
  const made = await create({ name: 'Draft' });
  const saved = report.parse(
    await suite.api(one, 'updateReport', {
      params: { id: made.id },
      body: {
        name: 'Final',
        definition: { ...made.definition, compare: 'previous_year' },
        revision: made.revision,
      },
    }),
  );
  expect(saved).toMatchObject({
    name: 'Final',
    revision: 2,
    definition: { compare: 'previous_year' },
  });
  expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(Date.parse(made.updatedAt));
  const stale = await refusalOf(
    () =>
      suite.api(one, 'updateReport', {
        params: { id: made.id },
        body: { name: 'Mine', definition: made.definition, revision: made.revision },
      }),
    ConflictError,
  );
  expect(stale.message).toMatch(/changed/);
  await refusalOf(
    () =>
      suite.api(one, 'deleteReport', {
        params: { id: made.id },
        body: { revision: made.revision },
      }),
    ConflictError,
  );
  const invalid = await refusalOf(
    () =>
      suite.api(one, 'updateReport', {
        params: { id: made.id },
        body: {
          name: 'Final',
          definition: { ...made.definition, pages: [] },
          revision: saved.revision,
        },
      }),
    ValidationError,
  );
  expect(invalid.issues[0].path).toBe('/definition/pages');
});

it('copies and deletes', async () => {
  const made = await create({ templateKey: 'pipeline_attribution' });
  const copy = report.parse(
    await suite.api(one, 'cloneReport', { params: { id: made.id }, body: {} }),
  );
  expect(copy).toMatchObject({
    name: 'Copy of Pipeline & Attribution Report',
    templateKey: null,
    createdBy: { kind: 'user' },
    revision: 1,
    definition: made.definition,
  });
  expect(copy.id).not.toBe(made.id);
  // No body at all is a copy under the usual name.
  const plain = report.parse(await suite.api(one, 'cloneReport', { params: { id: made.id } }));
  expect(plain.name).toBe('Copy of Pipeline & Attribution Report');
  const named = report.parse(
    await suite.api(one, 'cloneReport', {
      params: { id: made.id },
      body: { name: 'For the board' },
    }),
  );
  expect(named.name).toBe('For the board');

  expect(
    await suite.api(one, 'deleteReport', { params: { id: copy.id }, body: { revision: 1 } }),
  ).toBeUndefined();
  await refusalOf(() => suite.api(one, 'getReport', { params: { id: copy.id } }), NotFoundError);
  await refusalOf(
    () => suite.api(one, 'cloneReport', { params: { id: copy.id }, body: {} }),
    NotFoundError,
  );
  expect((await list({ limit: 100 })).items.map((item) => item.id)).not.toContain(copy.id);
  // The row stays, out of the list.
  const kept = await suite.database.as('crm_owner', (sql) =>
    sql.one<{ deleted: boolean }>(
      'select deleted_at is not null as deleted from reporting.reports where id = $1',
      [parsePublicId('report', copy.id)],
    ),
  );
  expect(kept.deleted).toBe(true);
});

it('keeps a report to its business and to those whose role allows it', async () => {
  const made = await create({ name: 'Ours' });
  // Another business of the same agency neither reads, lists, saves nor deletes it.
  await refusalOf(() => suite.api(other, 'getReport', { params: { id: made.id } }), NotFoundError);
  await refusalOf(
    () =>
      suite.api(other, 'updateReport', {
        params: { id: made.id },
        body: { name: 'Theirs', definition: made.definition, revision: 1 },
      }),
    NotFoundError,
  );
  await refusalOf(
    () => suite.api(other, 'deleteReport', { params: { id: made.id }, body: { revision: 1 } }),
    NotFoundError,
  );
  expect((await list({ limit: 100 }, other)).items.map((item) => item.id)).not.toContain(made.id);
  await refusalOf(
    () => suite.api(one, 'getReport', { params: { id: 'rpt_nothing' } }),
    ValidationError,
  );

  // A reader reads and may not change; someone with neither permission reads nothing.
  const reader = one.withPermissions('reports.view');
  const read = report.parse(await suite.api(one, 'getReport', { params: { id: made.id } }, reader));
  expect(read.canManage).toBe(false);
  expect((await list({}, one, reader)).canManage).toBe(false);
  const nobody = one.withPermissions('contacts.manage');
  expect(
    (
      await refusalOf(
        () => suite.api(one, 'getReport', { params: { id: made.id } }, nobody),
        ForbiddenError,
      )
    ).permission,
  ).toBe('reports.view');

  // A report an API key made names nobody.
  const key = {
    ...one.manager,
    context: { ...one.manager.context, actorKind: 'api_key' as const, actorId: one.userId },
  };
  const { userId: _userId, ...keyContext } = key.context;
  const byKey = await create({ name: 'By key' }, one, { ...key, context: keyContext });
  expect(byKey.createdBy).toEqual({ kind: 'other', name: null });
});

it('holds a business to so many reports', async () => {
  const full = await suite.business();
  await suite.database.as('crm_owner', (sql) =>
    sql.query(
      `insert into reporting.reports (business_id, name, definition, definition_version, created_by_kind)
       select $1, 'Report ' || n, $2::jsonb, 1, 'system' from generate_series(1, $3::integer) n`,
      [full.businessId, JSON.stringify(BLANK_REPORT_DEFINITION), REPORT_LIMIT],
    ),
  );
  const refused = await refusalOf(() => create({}, full), ValidationError);
  expect(refused.issues[0].code).toBe('report_limit');
});
