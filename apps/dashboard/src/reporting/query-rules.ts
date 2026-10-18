// What Reporting works out about a query before the server is asked: the range an address
// names, what a source of the catalogue lets a widget ask (its measures, its dimensions,
// the operators each takes, the limits), the shape each kind of widget draws, and where the
// sentences of a refusal belong. Nothing is counted here, and nothing is offered that the
// catalogue does not list.
import {
  contactFilterOperands,
  MAX_CONTACT_FILTER_CONDITIONS,
  MAX_CONTACT_FILTER_GROUPS,
  MAX_CONTACT_FILTER_VALUES,
  reportDefinition,
  reportQuery,
  reportRangeInput,
  updateReportInput,
  type ContactFilterOperand,
  type ReportCatalog,
  type ReportCompareMode,
  type ReportDefinition,
  type ReportFilter,
  type ReportFilterCondition,
  type ReportQuery,
  type ReportRangeInput,
  type ReportWidget,
  type ReportWidgetKind,
  type ReportWidgetQuery,
} from '@repo/contracts';
import {
  DEFAULT_RANGE,
  rangeSearchOf,
  type RangeChoice,
  type RangePresetName,
  type RangeSearch,
} from '../reporting-search';

// Ranges -------------------------------------------------------------------------------

/** The range an address names: what to ask the server for, or why it cannot be asked. */
export type RangeState =
  | { readonly ok: true; readonly input: ReportRangeInput; readonly choice: RangeChoice }
  | {
      readonly ok: false;
      readonly reason: 'incomplete' | 'order' | 'too_long';
      readonly choice: 'custom';
    };

export function rangeOfSearch(search: RangeSearch): RangeState {
  if (search.range !== 'custom') {
    const preset: RangePresetName = search.range ?? DEFAULT_RANGE;
    return { ok: true, input: { preset }, choice: preset };
  }
  if (search.from === undefined || search.to === undefined)
    return { ok: false, reason: 'incomplete', choice: 'custom' };
  const parsed = reportRangeInput.safeParse({ from: search.from, to: search.to });
  if (parsed.success) return { ok: true, input: parsed.data, choice: 'custom' };
  const long = parsed.error.issues.some(
    (issue) => 'params' in issue && issue.params?.['code'] === 'range_too_long',
  );
  return { ok: false, reason: long ? 'too_long' : 'order', choice: 'custom' };
}

/** The address after a range is chosen by name. Custom starts as the days that were shown. */
export function withRangeChoice(
  choice: RangeChoice,
  shown: { readonly from: string; readonly to: string } | undefined,
): RangeSearch {
  if (choice === 'custom')
    return rangeSearchOf({ range: 'custom', from: shown?.from, to: shown?.to });
  return choice === DEFAULT_RANGE ? {} : { range: choice };
}

export function withCustomDays(from: string, to: string): RangeSearch {
  return rangeSearchOf({ range: 'custom', from, to });
}

/** An address with another range in place of its own; the rest of it stays. */
export function replaceRange<S extends RangeSearch>(
  search: S,
  range: RangeSearch,
): Omit<S, 'range' | 'from' | 'to'> & RangeSearch {
  return { ...withoutKeys(search, 'range', 'from', 'to'), ...range };
}

/** What a range a report keeps is called in the range control. */
export function choiceOfRange(range: ReportRangeInput): RangeChoice {
  return 'preset' in range ? range.preset : 'custom';
}

/** The first and last day a range control shows for a range a report keeps. */
export function daysOfRange(
  range: ReportRangeInput,
  shown: { readonly from: string; readonly to: string } | undefined,
): { readonly from: string; readonly to: string } {
  if ('preset' in range) return shown ?? { from: '', to: '' };
  return range;
}

// The catalogue ------------------------------------------------------------------------

export type CatalogSource = ReportCatalog['sources'][number];
export type CatalogDimension = CatalogSource['dimensions'][number];

export function sourceOf(catalog: ReportCatalog, key: string): CatalogSource | undefined {
  return catalog.sources.find((source) => source.key === key);
}

/** The sources a person may build from: the ones their role reads. */
export function allowedSources(catalog: ReportCatalog): CatalogSource[] {
  return catalog.sources.filter((source) => source.allowed);
}

export interface FilterField {
  readonly key: string;
  readonly label: string;
  readonly kind: CatalogDimension['kind'] | 'number';
  readonly operators: readonly string[];
  readonly choices?: readonly string[];
  readonly reference?: CatalogDimension['reference'];
}

/** The fields a condition can name: the dimensions that take an operator, then the numbers. */
export function filterFields(source: CatalogSource): FilterField[] {
  return [
    ...source.dimensions
      .filter((dimension) => dimension.operators.length > 0)
      .map((dimension) => ({
        key: dimension.key,
        label: dimension.label,
        kind: dimension.kind,
        operators: dimension.operators,
        ...(dimension.choices === undefined ? {} : { choices: dimension.choices }),
        ...(dimension.reference === undefined ? {} : { reference: dimension.reference }),
      })),
    ...source.numberFilters.map((field) => ({
      key: field.key,
      label: field.label,
      kind: 'number' as const,
      operators: field.operators,
    })),
  ];
}

const isOperator = (operator: string): operator is ReportFilterCondition['operator'] =>
  Object.hasOwn(contactFilterOperands, operator);

/** What an operator needs beside the field. Nothing for one this dashboard does not know. */
export function operandOf(operator: string): ContactFilterOperand {
  return isOperator(operator) ? contactFilterOperands[operator] : 'none';
}

/** A condition on a field, as it starts: the field's first operator, and nothing given. */
export function newCondition(field: FilterField): ReportFilterCondition {
  const operator = field.operators.find(isOperator) ?? 'is_empty';
  return withOperator({ field: field.key, operator }, operator);
}

/** The condition under another operator: what it had is kept where the new one takes it. */
export function withOperator(
  condition: ReportFilterCondition,
  operator: string,
): ReportFilterCondition {
  if (!isOperator(operator)) return condition;
  const operand = contactFilterOperands[operator];
  const base = { field: condition.field, operator };
  if (operand === 'value' || operand === 'days')
    return { ...base, value: condition.value ?? condition.values?.[0] ?? '' };
  if (operand === 'values')
    return {
      ...base,
      values: condition.values ?? (condition.value === undefined ? [] : [condition.value]),
    };
  if (operand === 'range') return { ...base, from: condition.from ?? '', to: condition.to ?? '' };
  return base;
}

/** Values typed as one line, split at commas: what "is any of" on a text field takes. */
export function valuesOfText(text: string): string[] {
  return [...new Set(text.split(',').map((value) => value.trim()))]
    .filter((value) => value !== '')
    .slice(0, MAX_CONTACT_FILTER_VALUES);
}

export const conditionCount = (filters: ReportFilter | undefined): number =>
  (filters?.groups ?? []).reduce((sum, group) => sum + group.conditions.length, 0);

export const canAddCondition = (filters: ReportFilter | undefined): boolean =>
  conditionCount(filters) < MAX_CONTACT_FILTER_CONDITIONS;

export const canAddGroup = (filters: ReportFilter | undefined): boolean =>
  canAddCondition(filters) && (filters?.groups.length ?? 0) < MAX_CONTACT_FILTER_GROUPS;

/**
 * A new group with one condition. Groups are alternatives (OR) and the conditions of a
 * group all hold (AND), as GoHighLevel's conditions are; `setMatch` changes either.
 */
export function addGroup(filters: ReportFilter | undefined, field: FilterField): ReportFilter {
  const group = { match: 'all' as const, conditions: [newCondition(field)] };
  if (filters === undefined) return { match: 'any', groups: [group] };
  return canAddGroup(filters) ? { ...filters, groups: [...filters.groups, group] } : filters;
}

export function addCondition(
  filters: ReportFilter,
  groupIndex: number,
  field: FilterField,
): ReportFilter {
  if (!canAddCondition(filters)) return filters;
  return {
    ...filters,
    groups: filters.groups.map((group, index) =>
      index === groupIndex
        ? { ...group, conditions: [...group.conditions, newCondition(field)] }
        : group,
    ),
  };
}

export function setCondition(
  filters: ReportFilter,
  groupIndex: number,
  conditionIndex: number,
  condition: ReportFilterCondition,
): ReportFilter {
  return {
    ...filters,
    groups: filters.groups.map((group, index) =>
      index === groupIndex
        ? {
            ...group,
            conditions: group.conditions.map((each, place) =>
              place === conditionIndex ? condition : each,
            ),
          }
        : group,
    ),
  };
}

/** Without one condition; a group left empty goes too, and so does a filter left empty. */
export function removeCondition(
  filters: ReportFilter,
  groupIndex: number,
  conditionIndex: number,
): ReportFilter | undefined {
  const groups = filters.groups
    .map((group, index) =>
      index === groupIndex
        ? { ...group, conditions: group.conditions.filter((_, place) => place !== conditionIndex) }
        : group,
    )
    .filter((group) => group.conditions.length > 0);
  return groups.length === 0 ? undefined : { ...filters, groups };
}

/** Whether all or any must hold: of the groups, or inside one group. */
export function setMatch(
  filters: ReportFilter,
  match: 'all' | 'any',
  groupIndex?: number,
): ReportFilter {
  if (groupIndex === undefined) return { ...filters, match };
  return {
    ...filters,
    groups: filters.groups.map((group, index) =>
      index === groupIndex ? { ...group, match } : group,
    ),
  };
}

// The shape each kind of widget draws ---------------------------------------------------

export type ChartKind = Exclude<ReportWidgetKind, 'text'>;

export interface KindShape {
  /** Whether it is drawn over days, weeks or months. */
  readonly time: 'required' | 'optional' | 'never';
  /** The fewest and the most dimensions it is grouped by. */
  readonly groups: readonly [number, number];
  readonly measures: number;
}

export function kindShape(kind: ChartKind, limits: ReportCatalog['limits']): KindShape {
  switch (kind) {
    case 'stat':
      return { time: 'never', groups: [0, 0], measures: limits.measures };
    case 'line':
    case 'area':
      return { time: 'required', groups: [0, 1], measures: limits.measures };
    case 'bar':
    case 'hbar':
      return { time: 'optional', groups: [0, limits.groupBy], measures: limits.measures };
    case 'donut':
    case 'funnel':
      return { time: 'never', groups: [1, 1], measures: 1 };
    case 'table':
      return { time: 'optional', groups: [0, limits.groupBy], measures: limits.measures };
  }
}

/** The dimension a new chart is grouped by: the first one a row is in only once. */
function firstGroup(source: CatalogSource, taken: readonly string[] = []): string | undefined {
  return (
    source.dimensions.find((dimension) => !dimension.multiple && !taken.includes(dimension.key)) ??
    source.dimensions.find((dimension) => !taken.includes(dimension.key))
  )?.key;
}

/** An object without some of its keys: how an address or a query loses a part. */
export function withoutKeys<T extends object, K extends keyof T>(
  value: T,
  ...keys: K[]
): Omit<T, K> {
  const dropped: readonly PropertyKey[] = keys;
  // Only the keys named are left out, so what remains is the object without them.
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !dropped.includes(key)),
  ) as Omit<T, K>;
}

/** The order kept only while it names a measure the query still has. */
function tidyOrder(query: ReportWidgetQuery): ReportWidgetQuery {
  if (query.order === undefined) return query;
  return query.order.by === 'group' || query.measures.includes(query.order.by)
    ? query
    : withoutKeys(query, 'order');
}

/**
 * The query made to fit a kind of widget: measures and groups cut to what it draws, a
 * grain given to a chart over time and taken from one that has none, a group given to one
 * that needs it. What already fits is left as it is.
 */
export function fitQuery(
  kind: ChartKind,
  query: ReportWidgetQuery,
  source: CatalogSource,
  limits: ReportCatalog['limits'],
): ReportWidgetQuery {
  const shape = kindShape(kind, limits);
  let next: ReportWidgetQuery = {
    ...query,
    measures: query.measures.slice(0, shape.measures),
    groupBy: query.groupBy.slice(0, shape.groups[1]),
  };
  const grain = next.time?.grain;
  if (shape.time === 'never' && grain !== undefined) {
    const time = withoutKeys(next.time ?? {}, 'grain');
    next = Object.keys(time).length === 0 ? withoutKeys(next, 'time') : { ...next, time };
  }
  if (shape.time === 'required' && grain === undefined)
    next = { ...next, time: { ...next.time, grain: 'day' } };
  if (next.groupBy.length < shape.groups[0]) {
    const group = firstGroup(source);
    if (group !== undefined) next = { ...next, groupBy: [group] };
  }
  // A bar chart or a table of one total says nothing: it starts grouped.
  if (
    (kind === 'bar' || kind === 'hbar') &&
    next.groupBy.length === 0 &&
    next.time?.grain === undefined
  ) {
    const group = firstGroup(source);
    if (group !== undefined) next = { ...next, groupBy: [group] };
  }
  return tidyOrder(next);
}

/** The query a new widget of a kind starts with, on a source. */
export function defaultQuery(
  kind: ChartKind,
  source: CatalogSource,
  limits: ReportCatalog['limits'],
): ReportWidgetQuery {
  const measure = source.measures[0]?.key ?? 'count';
  const start: ReportWidgetQuery = { source: source.key, measures: [measure], groupBy: [] };
  return fitQuery(kind === 'table' ? 'bar' : kind, start, source, limits);
}

/** The query with a measure added or taken away. The last measure stays, and so does the limit. */
export function toggleMeasure(
  query: ReportWidgetQuery,
  measure: string,
  most: number,
): ReportWidgetQuery {
  const has = query.measures.includes(measure);
  if (has && query.measures.length === 1) return query;
  if (!has && query.measures.length >= most) return query;
  return tidyOrder({
    ...query,
    measures: has
      ? query.measures.filter((each) => each !== measure)
      : [...query.measures, measure],
  });
}

/** The query grouped by this dimension at this place; none takes the place away. */
export function setGroup(
  query: ReportWidgetQuery,
  place: number,
  dimension: string | undefined,
): ReportWidgetQuery {
  const groupBy = [...query.groupBy];
  if (dimension === undefined) groupBy.splice(place, 1);
  else groupBy[place] = dimension;
  return { ...query, groupBy: [...new Set(groupBy)] };
}

/** The query over days, weeks or months, or over none. */
export function setGrain(
  query: ReportWidgetQuery,
  grain: 'day' | 'week' | 'month' | undefined,
): ReportWidgetQuery {
  const time = {
    ...withoutKeys(query.time ?? {}, 'grain'),
    ...(grain === undefined ? {} : { grain }),
  };
  return Object.keys(time).length === 0 ? withoutKeys(query, 'time') : { ...query, time };
}

/** The query read by another of the source's dates; the source's own default is left out. */
export function setDateProperty(
  query: ReportWidgetQuery,
  property: string,
  source: CatalogSource,
): ReportWidgetQuery {
  const time = {
    ...withoutKeys(query.time ?? {}, 'property'),
    ...(property === source.defaultDate ? {} : { property }),
  };
  return Object.keys(time).length === 0 ? withoutKeys(query, 'time') : { ...query, time };
}

/** Whether the query reads a contact's attribution: only then does first or latest matter. */
export function usesAttribution(query: ReportWidgetQuery, source: CatalogSource): boolean {
  if (source.key === 'attribution') return true;
  const touched = new Set(
    source.dimensions.filter((dimension) => dimension.attribution).map((d) => d.key),
  );
  return (
    query.groupBy.some((dimension) => touched.has(dimension)) ||
    (query.filters?.groups ?? []).some((group) =>
      group.conditions.some((condition) => touched.has(condition.field)),
    )
  );
}

// Running and saving -------------------------------------------------------------------

/** What a widget is run with: its own range and comparison, or the report's. */
export function queryOfWidget(
  widget: Pick<ReportWidget, 'query' | 'range' | 'compare'>,
  report: { readonly range: ReportRangeInput; readonly compare: ReportCompareMode | null },
): unknown {
  const compare = widget.compare === undefined ? report.compare : widget.compare;
  return {
    ...widget.query,
    range: widget.range ?? report.range,
    ...(compare === null ? {} : { compare }),
  };
}

export type Runnable =
  | { readonly ok: true; readonly query: ReportQuery }
  | { readonly ok: false; readonly messages: readonly string[] };

/** The query a widget sends, checked against the contract first: or what is wrong with it. */
export function runnableOf(
  widget: Pick<ReportWidget, 'query' | 'range' | 'compare'>,
  report: { readonly range: ReportRangeInput; readonly compare: ReportCompareMode | null },
): Runnable {
  const parsed = reportQuery.safeParse(queryOfWidget(widget, report));
  if (parsed.success) return { ok: true, query: parsed.data };
  return { ok: false, messages: [...new Set(parsed.error.issues.map((issue) => issue.message))] };
}

export interface PlacedIssue {
  readonly path: string;
  readonly message: string;
}

export interface PlacedIssues {
  /** What is wrong with each widget, by its id. */
  readonly widgets: Readonly<Record<string, readonly string[]>>;
  /** What is wrong with a page itself, by its place. */
  readonly pages: Readonly<Record<number, readonly string[]>>;
  /** What is wrong with the name. */
  readonly name: string | undefined;
  /** Everything else. */
  readonly form: readonly string[];
}

export const noIssues: PlacedIssues = { widgets: {}, pages: {}, name: undefined, form: [] };

/**
 * A refusal's sentences, each put where it points: at a widget, a page, the name, or the
 * report as a whole. Paths are JSON pointers into what was sent ({name, definition}) or
 * into the definition itself.
 */
export function placeIssues(
  definition: ReportDefinition,
  issues: readonly PlacedIssue[],
): PlacedIssues {
  const widgets: Record<string, string[]> = {};
  const pages: Record<number, string[]> = {};
  const form: string[] = [];
  let name: string | undefined;
  for (const issue of issues) {
    const parts = issue.path.split('/').filter((part) => part !== '');
    if (parts[0] === 'definition') parts.shift();
    if (parts[0] === 'name') {
      name ??= issue.message;
      continue;
    }
    const pageIndex = parts[0] === 'pages' ? Number(parts[1]) : Number.NaN;
    const page = Number.isInteger(pageIndex) ? definition.pages[pageIndex] : undefined;
    if (page === undefined) {
      form.push(issue.message);
      continue;
    }
    const widget = parts[2] === 'widgets' ? page.widgets[Number(parts[3])] : undefined;
    if (widget === undefined) (pages[pageIndex] ??= []).push(issue.message);
    else if (!(widgets[widget.id] ??= []).includes(issue.message))
      widgets[widget.id]?.push(issue.message);
  }
  return { widgets, pages, name, form };
}

/** What the contract finds wrong with a report before it is sent. None: it can be saved. */
export function definitionIssues(name: string, definition: ReportDefinition): PlacedIssue[] {
  const issues: PlacedIssue[] = [];
  // The name is checked by the contract's own rule, so the sentence is the server's.
  const named = updateReportInput.shape.name.safeParse(name);
  const unnamed = named.success ? undefined : named.error.issues[0];
  if (unnamed !== undefined) issues.push({ path: '/name', message: unnamed.message });
  const parsed = reportDefinition.safeParse(definition);
  if (!parsed.success)
    for (const issue of parsed.error.issues)
      issues.push({ path: `/${issue.path.map(String).join('/')}`, message: issue.message });
  return issues;
}

export type RefusalKind =
  'forbidden' | 'not_found' | 'timeout' | 'rate_limited' | 'invalid' | 'conflict' | 'fault';

export interface Refusal {
  readonly kind: RefusalKind;
  /** The server's own sentences, when it gave any. */
  readonly messages: readonly string[];
}

/** What a failed request was refused for, from its problem details. A fault for none. */
export function refusalOf(
  problem:
    | {
        readonly status: number;
        readonly detail?: string | undefined;
        readonly errors?:
          readonly { readonly code?: string | undefined; readonly message: string }[] | undefined;
      }
    | undefined,
): Refusal {
  if (problem === undefined) return { kind: 'fault', messages: [] };
  const errors = problem.errors ?? [];
  const messages = errors.length > 0 ? errors.map((each) => each.message) : [];
  const said =
    messages.length > 0 ? messages : problem.detail === undefined ? [] : [problem.detail];
  if (problem.status === 403) return { kind: 'forbidden', messages: said };
  if (problem.status === 404) return { kind: 'not_found', messages: said };
  if (problem.status === 409) return { kind: 'conflict', messages: said };
  if (problem.status === 429 || errors.some((each) => each.code === 'rate_limited'))
    return { kind: 'rate_limited', messages: said };
  if (errors.some((each) => each.code === 'query_timeout'))
    return { kind: 'timeout', messages: said };
  if (problem.status === 422 || problem.status === 400) return { kind: 'invalid', messages: said };
  return { kind: 'fault', messages: [] };
}
