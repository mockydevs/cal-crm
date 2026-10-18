// The one query engine. A query document is checked
// against the catalogue by its contract; here it is compiled to SQL, run inside the
// request's tenant transaction as the person who asked, and folded into an answer.
//
// What keeps it safe:
// - nobody writes SQL: every table and column comes from sources.ts, picked by a key the
//   catalogue lists, and every value a query carries is a parameter;
// - the rows are whatever row-level security lets the transaction see, and the business is
//   named in every statement as well;
// - a reader needs reports.view, and whatever the source asks beside it;
// - a query is bounded: its range, its dimensions, the groups read, the rows answered, and
//   the time a statement may take (routes.ts sets the timeout for the transaction).
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  contactFilterKinds,
  REPORT_LIMITS,
  reportSource,
  reportWeekdays,
  type ContactFilterOperator,
  type Permission,
  type ReportDimensionSpec,
  type ReportFilterCondition,
  type ReportQuery,
  type ReportReference,
  type ReportResult,
  type ReportSourceKey,
  type ReportSourceSpec,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ForbiddenError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type Issue,
  type PublicIdKind,
  type TenantContext,
} from '@repo/kernel';
import { sql, type SqlBool, type RawBuilder } from 'kysely';

import { foldRows, totalsOf, type MeasureRead, type RawRow } from './fold.js';
import { bucketsOf, compareDays, resolveDays, type DayRange } from './range.js';
import { sourceShapes, touchColumns, type SourceShape, type Sql } from './sources.js';

type Test = RawBuilder<SqlBool>;

/** What the engine needs of the modules that own the team. */
export interface ReportingOptions {
  readonly members: {
    /** The user a membership id (or "me") names, when they are on this team; else null. */
    readonly resolve: (
      trx: DatabaseTransaction,
      context: TenantContext,
      selection: string | null,
    ) => Promise<string | null>;
    /** The membership ids of users, as public ids, for those still on the team. */
    readonly memberships: (
      trx: DatabaseTransaction,
      context: TenantContext,
      userIds: readonly string[],
    ) => Promise<ReadonlyMap<string, string>>;
  };
  readonly people: {
    readonly names: (
      trx: DatabaseTransaction,
      ids: readonly string[],
    ) => Promise<ReadonlyMap<string, string>>;
  };
  /** Left out, the contract's limits (REPORT_LIMITS). Tests pass smaller ones. */
  readonly limits?: {
    readonly statementTimeoutMs?: number;
    readonly queriesPerMinute?: number;
    readonly groupsRead?: number;
  };
}

/** Whether a role allows something. The system's "all" allows everything. */
export const granted = (invocation: Invocation, permission: Permission): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has(permission);

/** Refuses whoever may not read reports, naming the permission their role lacks. */
export function requireReader(invocation: Invocation): void {
  if (!granted(invocation, 'reports.view'))
    throw new ForbiddenError('You need permission to read reports.', 'reports.view');
}

/** What a reader lacks for a source, beside reports.view; undefined when nothing. */
export const missingForSource = (
  invocation: Invocation,
  spec: Pick<ReportSourceSpec, 'permission'>,
): Permission | undefined =>
  spec.permission !== null && !granted(invocation, spec.permission) ? spec.permission : undefined;

// Conditions -----------------------------------------------------------------------------

class ConditionProblem extends Error {
  constructor(
    readonly member: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const refuse = (member: string, code: string, message: string): never => {
  throw new ConditionProblem(member, code, message);
};

/** A LIKE pattern that finds the text anywhere, with the text's own wildcards escaped. */
const anywhere = (text: string): string =>
  `%${text.toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
const lowered = (values: readonly string[]): string[] =>
  values.map((value) => value.trim().toLowerCase());
const one = (condition: ReportFilterCondition): string => condition.value ?? '';
const many = (condition: ReportFilterCondition): readonly string[] => condition.values ?? [];

function operatorFor<Operator extends ContactFilterOperator>(
  operators: readonly Operator[],
  condition: ReportFilterCondition,
): Operator {
  const operator = operators.find((candidate) => candidate === condition.operator);
  // The contract refuses it first; this holds for a caller that skipped the contract.
  if (operator === undefined)
    return refuse('operator', 'invalid_operator', 'This field cannot be compared this way.');
  return operator;
}

/** As the contact list's text conditions (crm: contacts/filters.ts): a negative holds for no text. */
function textTest(column: Sql, condition: ReportFilterCondition): Test {
  const text = sql`lower(${column})`;
  switch (operatorFor(contactFilterKinds.text, condition)) {
    case 'is':
      return sql`${text} = ${one(condition).trim().toLowerCase()}`;
    case 'is_not':
      return sql`(${column} is null or ${text} <> ${one(condition).trim().toLowerCase()})`;
    case 'contains':
      return sql`${text} like ${anywhere(one(condition))}`;
    case 'not_contains':
      return sql`(${column} is null or ${text} not like ${anywhere(one(condition))})`;
    case 'any_of':
      return sql`${text} = any(${lowered(many(condition))}::text[])`;
    case 'none_of':
      return sql`(${column} is null or ${text} <> all(${lowered(many(condition))}::text[]))`;
    case 'is_empty':
      return sql`${column} is null`;
    case 'is_not_empty':
      return sql`${column} is not null`;
  }
}

function amount(member: string, value: string): string {
  if (!/^-?\d{1,15}(\.\d{1,6})?$/.test(value.trim()))
    refuse(member, 'invalid_number', 'Give a number in digits, such as 12.5.');
  return value.trim();
}

function numberTest(column: Sql, condition: ReportFilterCondition): Test {
  const value = () => sql`${amount('value', one(condition))}::numeric`;
  switch (operatorFor(contactFilterKinds.number, condition)) {
    case 'is':
      return sql`${column} = ${value()}`;
    case 'is_not':
      return sql`${column} is distinct from ${value()}`;
    case 'gt':
      return sql`${column} > ${value()}`;
    case 'gte':
      return sql`${column} >= ${value()}`;
    case 'lt':
      return sql`${column} < ${value()}`;
    case 'lte':
      return sql`${column} <= ${value()}`;
    case 'between':
      return sql`(${column} >= ${amount('from', condition.from ?? '')}::numeric and ${column} <= ${amount('to', condition.to ?? '')}::numeric)`;
    case 'is_empty':
      return sql`${column} is null`;
    case 'is_not_empty':
      return sql`${column} is not null`;
  }
}

/** A test of a column that holds one of a list: choice keys as text, or ids as uuids. */
function listTest(
  column: Sql,
  condition: ReportFilterCondition,
  values: readonly string[],
  type: 'text' | 'uuid',
): Test {
  const list = type === 'uuid' ? sql`${[...values]}::uuid[]` : sql`${[...values]}::text[]`;
  switch (operatorFor(contactFilterKinds.choice, condition)) {
    case 'any_of':
      return sql`${column} = any(${list})`;
    case 'none_of':
      return sql`(${column} is null or ${column} <> all(${list}))`;
    case 'is_empty':
      return sql`${column} is null`;
    case 'is_not_empty':
      return sql`${column} is not null`;
  }
}

const idKinds: Readonly<Record<Exclude<ReportReference, 'member'>, PublicIdKind>> = {
  tag: 'tag',
  pipeline: 'pipeline',
  stage: 'stage',
  lost_reason: 'lost_reason',
  calendar: 'calendar',
};

interface Run {
  readonly trx: DatabaseTransaction;
  readonly context: TenantContext;
  readonly businessId: string;
  readonly options: ReportingOptions;
}

/** The uuids a condition's values name. One that names nothing of its kind is refused. */
async function referenceIds(
  run: Run,
  reference: ReportReference,
  values: readonly string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, value] of values.entries()) {
    const id =
      reference === 'member'
        ? await run.options.members.resolve(run.trx, run.context, value).catch((error: unknown) => {
            if (error instanceof ValidationError) return null;
            throw error;
          })
        : (parsePublicId(idKinds[reference], value) ?? null);
    ids.push(
      id ??
        refuse(
          `values/${String(index)}`,
          'unknown_reference',
          reference === 'member'
            ? 'Choose someone on this team.'
            : `Give the id of a ${reference.replace('_', ' ')}.`,
        ),
    );
  }
  return ids;
}

async function testOf(
  run: Run,
  source: ReportSourceKey,
  condition: ReportFilterCondition,
): Promise<Test> {
  const spec = reportSource(source);
  const shape = sourceShapes[source];
  const number = shape.numbers[condition.field];
  if (number !== undefined) return numberTest(number, condition);
  const dimension = spec.dimensions[condition.field];
  const column = touchColumns[condition.field] ?? shape.columns[condition.field];
  if (dimension === undefined || column === undefined || dimension.kind === 'weekday')
    return refuse('field', 'unknown_field', 'Choose a field this source can be filtered by.');
  if (dimension.kind === 'text') return textTest(column, condition);
  if (dimension.kind === 'choice') return listTest(column, condition, many(condition), 'text');
  const reference = dimension.reference ?? 'member';
  const ids = await referenceIds(run, reference, many(condition));
  if (reference !== 'tag') return listTest(column, condition, ids, 'uuid');
  // A contact has several tags: a condition asks whether any of them is one of these.
  const tagged = (test: Test): Test =>
    sql`exists (select 1 from crm.record_tags t
      where t.business_id = c.business_id and t.record_id = c.id and ${test})`;
  switch (operatorFor(contactFilterKinds.choice, condition)) {
    case 'any_of':
      return tagged(sql`t.tag_id = any(${ids}::uuid[])`);
    case 'none_of':
      return sql`not ${tagged(sql`t.tag_id = any(${ids}::uuid[])`)}`;
    case 'is_empty':
      return sql`not ${tagged(sql`true`)}`;
    case 'is_not_empty':
      return tagged(sql`true`);
  }
}

/** The query's conditions as one test, or every problem with them, pointing into `filters`. */
async function filterOf(run: Run, query: ReportQuery): Promise<Test> {
  if (query.filters === undefined) return sql`true`;
  const issues: Issue[] = [];
  const groups: Test[] = [];
  for (const [groupIndex, group] of query.filters.groups.entries()) {
    const tests: Test[] = [];
    for (const [index, condition] of group.conditions.entries()) {
      try {
        tests.push(await testOf(run, query.source, condition));
      } catch (error) {
        if (!(error instanceof ConditionProblem)) throw error;
        issues.push({
          path: `/filters/groups/${String(groupIndex)}/conditions/${String(index)}/${error.member}`,
          code: error.code,
          message: error.message,
        });
      }
    }
    groups.push(sql`(${sql.join(tests, group.match === 'all' ? sql` and ` : sql` or `)})`);
  }
  const [first, ...rest] = issues;
  if (first !== undefined) throw new ValidationError([first, ...rest]);
  return sql`(${sql.join(groups, query.filters.match === 'all' ? sql` and ` : sql` or `)})`;
}

// The range ------------------------------------------------------------------------------

interface Period {
  readonly days: DayRange;
  readonly fromInstant: string;
  readonly toInstant: string;
}

/** The business's time zone and today's date there, by the database's clock. */
export async function businessDay(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<{ timeZone: string; today: string }> {
  const {
    rows: [row],
  } = await sql<{ time_zone: string; today: string }>`
    select b.timezone as time_zone,
           to_char((now() at time zone b.timezone)::date, 'YYYY-MM-DD') as today
    from tenancy.businesses b where b.id = ${businessId}
  `.execute(trx);
  if (row === undefined) throw new Error('The business of this request is not there.');
  return { timeZone: row.time_zone, today: row.today };
}

/**
 * The instants a range of days starts and ends at in a time zone, worked out by PostgreSQL:
 * the first day's midnight there, and the midnight after the last day. A day a clock change
 * makes 23 or 25 hours long is as long as it is.
 */
async function periodOf(
  trx: DatabaseTransaction,
  days: DayRange,
  timeZone: string,
): Promise<Period> {
  const {
    rows: [row],
  } = await sql<{ starts: Date; ends: Date }>`
    select (${days.from}::date::timestamp at time zone ${timeZone}::text) as starts,
           ((${days.to}::date + 1)::timestamp at time zone ${timeZone}::text) as ends
  `.execute(trx);
  if (row === undefined) throw new Error('A select without a table gave no row.');
  return { days, fromInstant: row.starts.toISOString(), toInstant: row.ends.toISOString() };
}

// The statement --------------------------------------------------------------------------

interface Compiled {
  readonly source: ReportSourceKey;
  readonly shape: SourceShape;
  readonly date: Sql;
  readonly timeZone: string;
  readonly filter: Test;
  /** The test of which touch `ca` is: the first, the latest, or any. */
  readonly touch: Sql;
  /** Whether a dimension or a condition reads the contact's touch. */
  readonly touched: boolean;
  /**
   * Whether the touch must be joined to count without the dimensions: a condition reads it,
   * or the touch is any of several (so the join can repeat a row). The first or the latest
   * touch is at most one row (a unique index each, 0086), and a left join to at most one row
   * that nothing reads changes no count, so the totals leave it out.
   */
  readonly touchedWithoutDimensions: boolean;
  readonly money: boolean;
  readonly people: boolean;
}

interface Counted {
  bucket: string | null;
  k0: string | null;
  k1: string | null;
  currency: string | null;
  n: number;
  valued: number;
  amount: string;
  people: number;
}

/**
 * Counts one period, grouped by buckets of time (their first days, in order; null for none)
 * and by dimensions, at most `cap` groups.
 *
 * What makes it fast enough at a large business's size:
 * - a row's bucket is found by `width_bucket` among the instants the buckets start at,
 *   worked out once for the statement as the range's own edges are (periodOf), rather than
 *   by converting every row's instant to the business's clock and formatting it: the number
 *   is grouped, and the bucket's day looked up here;
 * - the totals join the contact's touch only when they need it (touchedWithoutDimensions);
 * - distinct people in groups are counted in two steps, each person's rows of a group first
 *   (in the person's order, which the touches' index gives presorted), then the groups,
 *   rather than as count(distinct) over rows sorted by group and person.
 */
async function count(
  run: Run,
  compiled: Compiled,
  period: Period,
  buckets: readonly string[] | null,
  dimensions: readonly string[],
  cap: number,
): Promise<RawRow[]> {
  const { shape, date, timeZone } = compiled;
  const local = sql`(${date} at time zone ${timeZone}::text)`;
  const key = (dimension: string | undefined): Sql => {
    if (dimension === undefined) return sql`null::text`;
    if (dimension === 'weekday') return sql`extract(isodow from ${local})::integer::text`;
    // Both are there for a dimension the contract let through (catalog.test.ts holds them equal).
    return sql`(${touchColumns[dimension] ?? shape.columns[dimension] ?? sql`null`})::text`;
  };
  const selects: readonly [Sql, Sql, Sql, Sql] = [
    buckets === null
      ? sql`null::text`
      : sql`width_bucket(${date}, array(
          select (b.day::date::timestamp at time zone ${timeZone}::text)
          from unnest(${[...buckets]}::text[]) with ordinality as b (day, place) order by b.place
        ))::text`,
    key(dimensions[0]),
    key(dimensions[1]),
    compiled.money && shape.money !== null ? sql`${shape.money.currency}::text` : sql`null::text`,
  ];
  const grouped = [buckets !== null, dimensions.length > 0, dimensions.length > 1, compiled.money]
    .flatMap((used, index) => (used ? [String(index + 1)] : []))
    .join(', ');
  const joins: Sql[] = [];
  const touched =
    buckets === null && dimensions.length === 0
      ? compiled.touchedWithoutDimensions
      : compiled.touched;
  if (shape.touch !== null && touched) joins.push(shape.touch(compiled.touch));
  if (dimensions.includes('tag'))
    joins.push(
      sql`left join crm.record_tags rt on rt.business_id = c.business_id and rt.record_id = c.id`,
    );
  const money = shape.money !== null && compiled.money ? shape.money : null;
  const from = sql`
    from ${shape.from} ${sql.join(joins, sql` `)}
    where ${shape.business} = ${run.businessId} and ${shape.fixed}
      and ${shape.touch === null ? compiled.touch : sql`true`}
      and ${date} >= ${period.fromInstant}::timestamptz and ${date} < ${period.toInstant}::timestamptz
      and ${compiled.filter}`;
  const keys = sql`${selects[0]} as bucket, ${selects[1]} as k0, ${selects[2]} as k1, ${selects[3]} as currency`;
  const byGroup = grouped === '' ? sql`` : sql`group by ${sql.raw(grouped)}`;
  const { rows } =
    compiled.people && grouped !== ''
      ? await sql<Counted>`
    select bucket, k0, k1, currency, sum(n)::integer as n, sum(valued)::integer as valued,
           ${money === null ? sql`'0'` : sql`coalesce(sum(amount), 0)::numeric(38, 4)::text`} as amount,
           count(person)::integer as people
    from (
      select ${keys}, ca.contact_id as person, count(*) as n,
             ${money === null ? sql`0` : sql`count(${money.amount})`} as valued,
             ${money === null ? sql`0` : sql`sum(${money.amount})`} as amount
      ${from}
      group by 5, ${sql.raw(grouped)}
      order by 5, ${sql.raw(grouped)}
    ) as each_person
    -- The keys a query does not group by are null in every row: grouping by them changes nothing.
    group by bucket, k0, k1, currency
    order by 5 desc
    limit ${cap}
  `.execute(run.trx)
      : await sql<Counted>`
    select ${keys},
           count(*)::integer as n,
           ${money === null ? sql`0` : sql`count(${money.amount})::integer`} as valued,
           ${money === null ? sql`'0'` : sql`coalesce(sum(${money.amount}), 0)::numeric(38, 4)::text`} as amount,
           ${compiled.people ? sql`count(distinct ca.contact_id)::integer` : sql`0`} as people
    ${from}
    ${byGroup}
    order by 5 desc
    limit ${cap}
  `.execute(run.trx);
  return rows.map((row) => ({
    // width_bucket counts from 1, and every row is on or after the first bucket's start.
    bucket:
      buckets === null || row.bucket === null ? null : (buckets[Number(row.bucket) - 1] ?? null),
    keys: [row.k0, row.k1].slice(0, dimensions.length),
    currency: row.currency,
    n: row.n,
    valued: row.valued,
    amount: row.amount,
    people: row.people,
  }));
}

// Labels ---------------------------------------------------------------------------------

interface Named {
  /** What the answer gives as the group's key. */
  readonly key: string | null;
  readonly label: string;
  /** The group's place in its dimension's own order. */
  readonly rank: string | number;
}

const CHOICE_LABELS: Readonly<Record<string, string>> = {
  crm_ui: 'CRM UI',
  third_party: 'Third-party',
  direct: 'Direct traffic',
  no_show: 'No show',
  completed: 'Showed',
  ai_agent: 'AI agent',
  api: 'API',
  sms: 'SMS',
};

/** A choice's key in words: paid_search is "Paid search". */
export const choiceLabel = (key: string): string =>
  CHOICE_LABELS[key] ?? `${key.charAt(0).toUpperCase()}${key.slice(1).replaceAll('_', ' ')}`;

/** What each raw key of a dimension is called, and where it sorts. */
async function namesOf(
  run: Run,
  dimension: ReportDimensionSpec,
  keys: readonly string[],
): Promise<Map<string, Named>> {
  const named = new Map<string, Named>();
  if (dimension.kind === 'text')
    for (const key of keys) named.set(key, { key, label: key, rank: key.toLowerCase() });
  else if (dimension.kind === 'choice')
    for (const key of keys)
      named.set(key, {
        key,
        label: choiceLabel(key),
        rank: dimension.choices?.indexOf(key) ?? 0,
      });
  else if (dimension.kind === 'weekday')
    for (const key of keys)
      named.set(key, { key, label: reportWeekdays[Number(key) - 1] ?? key, rank: Number(key) });
  if (dimension.kind !== 'reference' || dimension.reference === undefined || keys.length === 0)
    return named;

  const { trx, businessId } = run;
  const ids = [...keys];
  if (dimension.reference === 'member') {
    const names = await run.options.people.names(trx, ids);
    const memberships = await run.options.members.memberships(trx, run.context, ids);
    for (const id of ids) {
      const label = names.get(id) ?? '';
      // Null for someone no longer on the team: their name stays, their membership is gone.
      named.set(id, { key: memberships.get(id) ?? null, label, rank: label.toLowerCase() });
    }
    return named;
  }
  const rows =
    dimension.reference === 'tag'
      ? await trx
          .selectFrom('crm.tags')
          .select(['id', 'name as label', sql<number>`0`.as('place')])
          .where('business_id', '=', businessId)
          .where('id', 'in', ids)
          .execute()
      : dimension.reference === 'pipeline'
        ? await trx
            .selectFrom('crm.pipelines')
            .select(['id', 'name as label', 'position as place'])
            .where('business_id', '=', businessId)
            .where('id', 'in', ids)
            .execute()
        : dimension.reference === 'stage'
          ? await trx
              .selectFrom('crm.pipeline_stages as s')
              .innerJoin('crm.pipelines as p', (join) =>
                join
                  .onRef('p.business_id', '=', 's.business_id')
                  .onRef('p.id', '=', 's.pipeline_id'),
              )
              .select([
                's.id',
                's.name as label',
                // A stage sorts by its pipeline's place, then its own.
                sql<number>`p.position * 100000 + s.position`.as('place'),
              ])
              .where('s.business_id', '=', businessId)
              .where('s.id', 'in', ids)
              .execute()
          : dimension.reference === 'lost_reason'
            ? await trx
                .selectFrom('crm.lost_reasons')
                .select(['id', 'label', 'position as place'])
                .where('business_id', '=', businessId)
                .where('id', 'in', ids)
                .execute()
            : await trx
                .selectFrom('calendar.calendars')
                .select(['id', 'name as label', sql<number>`0`.as('place')])
                .where('business_id', '=', businessId)
                .where('id', 'in', ids)
                .execute();
  const reference = dimension.reference;
  for (const row of rows)
    named.set(row.id, {
      key: toPublicId(idKinds[reference], row.id),
      label: row.label,
      rank:
        dimension.reference === 'tag' || dimension.reference === 'calendar'
          ? row.label.toLowerCase()
          : row.place,
    });
  return named;
}

// The engine -----------------------------------------------------------------------------

const READS: Readonly<Record<string, MeasureRead>> = {
  count: 'rows',
  touches: 'rows',
  contacts: 'people',
  value: 'sum',
  averageValue: 'average',
};

/**
 * Runs one query in the request's tenant transaction. The caller has parsed the query with
 * its contract. `today` is for tests of presets; left out, the database's clock decides.
 */
export async function runQuery(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: ReportQuery,
  options: ReportingOptions,
  today?: string,
): Promise<ReportResult> {
  requireReader(invocation);
  const businessId = requireBusiness(invocation.context);
  const spec = reportSource(query.source);
  const lacking = missingForSource(invocation, spec);
  if (lacking !== undefined)
    throw new ForbiddenError(`You need permission to read ${spec.label.toLowerCase()}.`, lacking);
  const run: Run = { trx, context: invocation.context, businessId, options };
  const shape = sourceShapes[query.source];

  const clock = await businessDay(trx, businessId);
  const days = resolveDays(query.range, today ?? clock.today);
  const period = await periodOf(trx, days, clock.timeZone);
  const compareMode = query.compare;
  const compared =
    compareMode === undefined
      ? undefined
      : await periodOf(trx, compareDays(days, compareMode), clock.timeZone);

  const grain = query.time?.grain;
  const buckets = grain === undefined ? null : bucketsOf(days, grain);
  const dimensions = query.groupBy;
  const groupLimit =
    query.limit ??
    (buckets === null ? REPORT_LIMITS.defaultGroups : REPORT_LIMITS.defaultSeriesGroups);
  // The most rows the answer can have: refused before anything is counted.
  const most =
    (buckets?.length ?? 1) *
    (dimensions.length === 0 ? 1 : Math.min(groupLimit, REPORT_LIMITS.rows) + 1);
  if (most > REPORT_LIMITS.rows && (buckets?.length ?? 0) > 0)
    throw new ValidationError([
      {
        path: dimensions.length === 0 ? '/time/grain' : '/limit',
        code: 'too_many_rows',
        message: `This would be more than ${String(REPORT_LIMITS.rows)} rows. Use a coarser grain, a shorter range or a smaller limit.`,
      },
    ]);

  const property = query.time?.property ?? spec.defaultDate;
  const attribution = query.attribution ?? spec.attribution[0] ?? 'first';
  const reads = query.measures.map((measure) => READS[measure] ?? 'rows');
  const conditionFields =
    query.filters?.groups.flatMap((group) => group.conditions.map((each) => each.field)) ?? [];
  const readsTouch = (field: string): boolean => spec.dimensions[field]?.attribution === true;
  const compiled: Compiled = {
    source: query.source,
    shape,
    date: shape.dates[property] ?? sql`null::timestamptz`,
    timeZone: clock.timeZone,
    filter: await filterOf(run, query),
    touch:
      attribution === 'first'
        ? sql`ca.is_first`
        : attribution === 'latest'
          ? sql`ca.is_latest`
          : sql`true`,
    touched: [...dimensions, ...conditionFields].some(readsTouch),
    touchedWithoutDimensions: conditionFields.some(readsTouch) || attribution === 'all',
    money: reads.includes('sum') || reads.includes('average'),
    people: reads.includes('people'),
  };

  const groupsRead = options.limits?.groupsRead ?? REPORT_LIMITS.groupsRead;
  // Every currency of a group is a row; the cap is of rows read, so it is a little generous.
  const cap = groupsRead * Math.max(buckets?.length ?? 1, 1) + 1;
  const rows = await count(run, compiled, period, buckets, dimensions, cap);
  const totals = await count(run, compiled, period, null, [], cap);
  const comparedBuckets =
    compared === undefined || grain === undefined ? null : bucketsOf(compared.days, grain);
  const before =
    compared === undefined
      ? undefined
      : {
          rows: await count(run, compiled, compared, comparedBuckets, dimensions, cap),
          totals: await count(run, compiled, compared, null, [], cap),
          buckets: comparedBuckets,
        };

  // What every group is called and where it sorts, one lookup for each dimension.
  const names: Map<string, Named>[] = [];
  for (const [index, dimension] of dimensions.entries()) {
    const keys = new Set<string>();
    for (const row of rows) {
      const key = row.keys[index];
      if (key !== null && key !== undefined) keys.add(key);
    }
    // The contract checked every dimension against this same catalogue.
    const dimensionSpec = spec.dimensions[dimension] ?? { label: dimension, kind: 'text' };
    names.push(await namesOf(run, dimensionSpec, [...keys]));
  }
  const nameOf = (index: number, key: string | null): Named | undefined =>
    key === null ? undefined : names[index]?.get(key);

  const orderBy =
    query.order === undefined || query.order.by === 'group'
      ? query.order === undefined
        ? 0
        : ('group' as const)
      : Math.max(query.measures.indexOf(query.order.by), 0);
  const folded = foldRows({
    reads,
    dimensions: dimensions.length,
    buckets,
    rows,
    ...(before === undefined ? {} : { compare: { rows: before.rows, buckets: before.buckets } }),
    orderBy,
    direction: query.order?.direction ?? (orderBy === 'group' ? 'asc' : 'desc'),
    limit: groupLimit,
    // Rows without a value come last in their dimension's own order.
    rank: (keys) =>
      keys.flatMap((key, index) => {
        const named = nameOf(index, key);
        return named === undefined ? [1, ''] : [0, named.rank];
      }),
  });

  const resolved = (each: Period, preset: boolean) => ({
    preset: preset && 'preset' in query.range ? query.range.preset : null,
    from: each.days.from,
    to: each.days.to,
    fromInstant: each.fromInstant,
    toInstant: each.toInstant,
  });
  return {
    source: query.source,
    range: resolved(period, true),
    timeZone: clock.timeZone,
    dateProperty: property,
    attribution,
    columns: [
      ...(grain === undefined
        ? []
        : [
            {
              key: 'time',
              role: 'time' as const,
              label: spec.dateProperties[property]?.label ?? property,
              kind: grain,
            },
          ]),
      ...dimensions.map((dimension) => ({
        key: dimension,
        role: 'group' as const,
        label: spec.dimensions[dimension]?.label ?? dimension,
        kind: spec.dimensions[dimension]?.kind ?? ('text' as const),
      })),
      ...query.measures.map((measure) => ({
        key: measure,
        role: 'measure' as const,
        label: spec.measures[measure]?.label ?? measure,
        kind: spec.measures[measure]?.kind ?? ('count' as const),
      })),
    ],
    rows: folded.rows.map((row) => ({
      group: [
        ...(row.bucket === null ? [] : [{ key: row.bucket, label: row.bucket }]),
        ...dimensions.map((_dimension, index) => {
          if (row.keys === null) return { key: null, label: 'Other' };
          const named = nameOf(index, row.keys[index] ?? null);
          return { key: named?.key ?? null, label: named?.label ?? '' };
        }),
      ],
      other: row.keys === null,
      values: row.values,
      ...(row.compare === undefined ? {} : { compare: row.compare }),
    })),
    totals: totalsOf(reads, totals),
    ...(before === undefined || compared === undefined || compareMode === undefined
      ? {}
      : {
          compare: {
            mode: compareMode,
            range: resolved(compared, false),
            totals: totalsOf(reads, before.totals),
          },
        }),
    truncated: {
      other: folded.other,
      incomplete: rows.length >= cap,
      limit: groupLimit,
    },
  };
}
