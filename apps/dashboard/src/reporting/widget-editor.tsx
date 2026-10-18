// The builder's settings for one widget ("Configure" and "Conditions"): its kind and title,
// the source it reads, its measures, what it is grouped by, its date and grain, which touch
// attribution is read from, its conditions as groups, its order and limit, its own dates,
// and its size. Everything offered comes from the catalogue (GET /reports/catalog): the
// builder names nothing the server does not list. Each change shows at once in the preview,
// which runs the query a moment after typing stops. Fetched when a widget is first opened
// (report-page.tsx).
import { Trans, useLingui } from '@lingui/react/macro';
import {
  reportGrains,
  type ReportCatalog,
  type ReportCompareMode,
  type ReportFilter,
  type ReportFilterCondition,
  type ReportGrain,
  type ReportWidget,
  type ReportWidgetQuery,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { Plus, Trash2, X } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { rangePresetNames, type RangePresetName } from '../reporting-search';
import { iconButtonClassName, returnTo } from './keys';
import {
  addCondition,
  addGroup,
  allowedSources,
  canAddCondition,
  canAddGroup,
  defaultQuery,
  filterFields,
  fitQuery,
  kindShape,
  newCondition,
  operandOf,
  removeCondition,
  setCondition,
  setDateProperty,
  setGrain,
  setGroup,
  setMatch,
  sourceOf,
  toggleMeasure,
  usesAttribution,
  valuesOfText,
  withOperator,
  withoutKeys,
  type CatalogSource,
  type ChartKind,
  type FilterField,
} from './query-rules';
import type { ReportDates } from './widget';
import { LazyWidgetBody } from './widget-lazy';
import type { Reference } from './widget-references';
import { useReportWords, type ReportWords } from './words';

export interface WidgetEditorProps {
  readonly businessId: string;
  readonly catalog: ReportCatalog;
  readonly widget: ReportWidget;
  /** The report's own dates, for the preview of a widget that has none of its own. */
  readonly dates: ReportDates;
  /** What the last save found wrong with this widget. */
  readonly problems: readonly string[];
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onChange: (widget: ReportWidget) => void;
  readonly onClose: () => void;
}

const chartKinds: readonly ChartKind[] = [
  'stat',
  'line',
  'area',
  'bar',
  'hbar',
  'donut',
  'table',
  'funnel',
];
const isChartKind = (kind: string): kind is ChartKind =>
  (chartKinds as readonly string[]).includes(kind);
const isGrain = (value: string): value is ReportGrain =>
  (reportGrains as readonly string[]).includes(value);
const isPreset = (value: string): value is RangePresetName =>
  (rangePresetNames as readonly string[]).includes(value);

const NONE = 'none';
const REPORTS = 'report';
/** A widget's own two days, set outside this panel: shown, and kept unless changed. */
const OWN_DAYS = 'own';
const DEFAULT_ORDER = 'default';

/** A value a moment after it stops changing, so a preview is not asked for at every key. */
function useLater(value: ReportWidget, delay = 400): ReportWidget {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);
  return settled;
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 border-t border-border pt-4">
      <legend className="float-left mb-2 w-full text-sm font-medium text-foreground">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function Labelled({
  label,
  children,
}: {
  readonly label: string;
  readonly children: (id: string) => ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

interface Option {
  readonly value: string;
  readonly label: string;
}

// The lists a condition's values are chosen from, fetched when a condition first names one.
const ReferenceValues = lazy(() => import('./widget-references'));

/** The kinds of thing a condition's values can be chosen from a list of. */
const isListed = (reference: string | undefined): reference is Reference =>
  reference === 'member' ||
  reference === 'tag' ||
  reference === 'pipeline' ||
  reference === 'stage' ||
  reference === 'calendar';

/**
 * The operators a field offers here. Something of the business that has no list to choose
 * from (a lost reason) is offered only the operators that need no value.
 */
function operatorsOf(field: FilterField): string[] {
  const unlisted = field.kind === 'reference' && !isListed(field.reference);
  return field.operators.filter((operator) => !(unlisted && operandOf(operator) !== 'none'));
}

function ConditionRow({
  businessId,
  source,
  field,
  fields,
  condition,
  words,
  place,
  onChange,
  onRemove,
}: {
  readonly businessId: string;
  readonly source: CatalogSource;
  readonly field: FilterField | undefined;
  readonly fields: readonly FilterField[];
  readonly condition: ReportFilterCondition;
  readonly words: ReportWords;
  /** "Condition 2 of group 1", for the names of its controls. */
  readonly place: string;
  readonly onChange: (condition: ReportFilterCondition) => void;
  readonly onRemove: () => void;
}): ReactElement {
  const { t } = useLingui();
  const operand = operandOf(condition.operator);
  const operators = field === undefined ? [condition.operator] : operatorsOf(field);
  const choices: readonly Option[] | undefined = field?.choices?.map((choice) => ({
    value: choice,
    label: words.choice(field.key, choice, source.key),
  }));
  const reference = field?.reference;
  const chosen = condition.values ?? [];
  // A choice the catalogue no longer lists still shows, by its key.
  const listed = [
    ...(choices ?? []),
    ...chosen
      .filter((value) => choices?.some((choice) => choice.value === value) !== true)
      .map((value) => ({ value, label: value })),
  ];
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <Select
            aria-label={t`Field of ${place}`}
            value={condition.field}
            onValueChange={(key) => {
              const next = fields.find((each) => each.key === key);
              if (next !== undefined) onChange(newCondition(next));
            }}
          >
            {fields.map((each) => (
              <option key={each.key} value={each.key}>
                {each.label}
              </option>
            ))}
          </Select>
        </div>
        <button
          type="button"
          className={iconButtonClassName}
          aria-label={t`Remove ${place}`}
          onClick={onRemove}
        >
          <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
        </button>
      </div>
      <Select
        aria-label={t`Operator of ${place}`}
        value={condition.operator}
        onValueChange={(operator) => {
          onChange(withOperator(condition, operator));
        }}
      >
        {operators.map((operator) => (
          <option key={operator} value={operator}>
            {words.operator(operator)}
          </option>
        ))}
      </Select>
      {operand === 'values' && choices !== undefined ? (
        <Select
          multiple
          aria-label={t`Values of ${place}`}
          value={chosen}
          onValueChange={(values) => {
            onChange({ ...condition, values });
          }}
        >
          {listed.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Select>
      ) : operand === 'values' && isListed(reference) ? (
        <Suspense
          fallback={
            <p role="status" className="text-xs text-muted-foreground">
              <Trans>Loading the choices…</Trans>
            </p>
          }
        >
          <ReferenceValues
            businessId={businessId}
            reference={reference}
            label={t`Values of ${place}`}
            values={chosen}
            onChange={(values) => {
              onChange({ ...condition, values });
            }}
          />
        </Suspense>
      ) : operand === 'values' ? (
        <Input
          // Another field or operator starts with nothing typed.
          key={`${condition.field}:${condition.operator}`}
          aria-label={t`Values of ${place}, separated by commas`}
          placeholder={t`One or more, separated by commas`}
          defaultValue={chosen.join(', ')}
          onChange={(event) => {
            onChange({ ...condition, values: valuesOfText(event.target.value) });
          }}
        />
      ) : operand === 'range' ? (
        <div className="flex min-w-0 gap-2">
          <Input
            aria-label={t`From, of ${place}`}
            placeholder={t`From`}
            inputMode="decimal"
            value={condition.from ?? ''}
            onChange={(event) => {
              onChange({ ...condition, from: event.target.value });
            }}
          />
          <Input
            aria-label={t`To, of ${place}`}
            placeholder={t`To`}
            inputMode="decimal"
            value={condition.to ?? ''}
            onChange={(event) => {
              onChange({ ...condition, to: event.target.value });
            }}
          />
        </div>
      ) : operand === 'none' ? null : (
        <Input
          aria-label={t`Value of ${place}`}
          placeholder={t`Value`}
          inputMode={field?.kind === 'number' ? 'decimal' : 'text'}
          maxLength={1000}
          value={condition.value ?? ''}
          onChange={(event) => {
            onChange({ ...condition, value: event.target.value });
          }}
        />
      )}
    </div>
  );
}

function Conditions({
  businessId,
  source,
  filters,
  words,
  onChange,
}: {
  readonly businessId: string;
  readonly source: CatalogSource;
  readonly filters: ReportFilter | undefined;
  readonly words: ReportWords;
  readonly onChange: (filters: ReportFilter | undefined) => void;
}): ReactElement {
  const { t } = useLingui();
  const fields = filterFields(source);
  const first = fields[0];
  const matchWords = (value: 'all' | 'any'): string =>
    value === 'all' ? t`All of these` : t`Any of these`;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {filters === undefined ? (
        <p className="text-xs text-muted-foreground">
          <Trans>No conditions: everything in the dates is counted.</Trans>
        </p>
      ) : (
        <>
          {filters.groups.length > 1 ? (
            <Labelled label={t`Between the groups`}>
              {(id) => (
                <Select
                  id={id}
                  value={filters.match}
                  onValueChange={(value) => {
                    onChange(setMatch(filters, value === 'all' ? 'all' : 'any'));
                  }}
                >
                  <option value="any">{t`Any group may hold (OR)`}</option>
                  <option value="all">{t`Every group must hold (AND)`}</option>
                </Select>
              )}
            </Labelled>
          ) : null}
          {filters.groups.map((group, groupIndex) => {
            const groupNumber = groupIndex + 1;
            return (
              <div
                // A group is known only by its place among the groups.
                // eslint-disable-next-line @eslint-react/no-array-index-key
                key={groupIndex}
                role="group"
                aria-label={t`Condition group ${groupNumber}`}
                className="flex min-w-0 flex-col gap-2 rounded-lg bg-muted p-2.5"
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="text-xs font-medium text-body">
                    <Trans>Group {groupNumber}</Trans>
                  </span>
                  {group.conditions.length > 1 ? (
                    <div className="w-40">
                      <Select
                        aria-label={t`How group ${groupNumber} matches`}
                        value={group.match}
                        onValueChange={(value) => {
                          onChange(setMatch(filters, value === 'any' ? 'any' : 'all', groupIndex));
                        }}
                      >
                        <option value="all">{matchWords('all')}</option>
                        <option value="any">{matchWords('any')}</option>
                      </Select>
                    </div>
                  ) : null}
                </div>
                {group.conditions.map((condition, index) => {
                  const field = fields.find((each) => each.key === condition.field);
                  const number = index + 1;
                  return (
                    // A condition is known only by its place in its group.
                    // eslint-disable-next-line @eslint-react/no-array-index-key
                    <div key={index} className="rounded-lg bg-card">
                      <ConditionRow
                        businessId={businessId}
                        source={source}
                        field={field}
                        fields={fields}
                        condition={condition}
                        words={words}
                        place={t`condition ${number} of group ${groupNumber}`}
                        onChange={(next) => {
                          onChange(setCondition(filters, groupIndex, index, next));
                        }}
                        onRemove={() => {
                          onChange(removeCondition(filters, groupIndex, index));
                        }}
                      />
                    </div>
                  );
                })}
                {first === undefined ? null : (
                  <Button
                    variant="quiet"
                    size="small"
                    className="self-start"
                    disabled={!canAddCondition(filters)}
                    onClick={() => {
                      onChange(addCondition(filters, groupIndex, first));
                    }}
                  >
                    <Plus aria-hidden className="size-4" strokeWidth={2} />
                    <Trans>Add condition to group {groupNumber}</Trans>
                  </Button>
                )}
              </div>
            );
          })}
        </>
      )}
      {first === undefined ? null : (
        <Button
          variant="secondary"
          size="small"
          className="self-start"
          disabled={!canAddGroup(filters)}
          onClick={() => {
            onChange(addGroup(filters, first));
          }}
        >
          <Plus aria-hidden className="size-4" strokeWidth={2} />
          {filters === undefined ? (
            <Trans>Add condition</Trans>
          ) : (
            <Trans>Add condition group</Trans>
          )}
        </Button>
      )}
    </div>
  );
}

export default function WidgetEditor({
  businessId,
  catalog,
  widget,
  dates,
  problems,
  returnFocus,
  onChange,
  onClose,
}: WidgetEditorProps): ReactElement {
  const { t } = useLingui();
  const words = useReportWords();
  const previewed = useLater(widget);
  const query = widget.query;
  const source = query === undefined ? undefined : sourceOf(catalog, query.source);
  const kind = widget.kind;
  const limits = catalog.limits;
  const shape = isChartKind(kind) ? kindShape(kind, limits) : undefined;
  const setQuery = (next: ReportWidgetQuery): void => {
    onChange({ ...widget, query: next });
  };
  const name = widget.title === '' ? words.kind(kind) : widget.title;
  const ownRange = widget.range;
  const ownCompare = widget.compare;

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40" />
        <Dialog.Popup
          className="fixed inset-y-0 right-0 z-60 flex w-[min(480px,100%)] flex-col bg-card text-card-foreground shadow-xl outline-none"
          finalFocus={returnTo(returnFocus)}
        >
          <div className="flex min-w-0 items-center justify-between gap-3 border-b px-4 py-3">
            <Dialog.Title className="min-w-0 text-base font-medium break-words">
              <Trans>Widget settings</Trans>
            </Dialog.Title>
            <Dialog.Close
              render={
                <Button variant="quiet" size="small" className="px-2.5" aria-label={t`Close`} />
              }
            >
              <X aria-hidden className="size-5" strokeWidth={1.8} />
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            {problems.length > 0 ? (
              <ul role="alert" className="list-disc pl-5 text-sm font-medium text-destructive">
                {problems.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            ) : null}
            <section
              aria-label={t`Preview of ${name}`}
              className="flex min-w-0 flex-col gap-2 rounded-card border bg-card p-3"
            >
              <p className="text-xs text-muted-foreground">
                <Trans>Preview</Trans>
              </p>
              <p className="text-md font-medium break-words text-foreground">{name}</p>
              <LazyWidgetBody businessId={businessId} widget={previewed} dates={dates} />
            </section>

            <Labelled label={t`Title`}>
              {(id) => (
                <Input
                  id={id}
                  maxLength={120}
                  autoComplete="off"
                  value={widget.title}
                  onChange={(event) => {
                    onChange({ ...widget, title: event.target.value });
                  }}
                />
              )}
            </Labelled>

            {kind === 'text' ? (
              <Labelled label={t`Text`}>
                {(id) => (
                  <Textarea
                    id={id}
                    rows={5}
                    maxLength={4000}
                    value={widget.text ?? ''}
                    onChange={(event) => {
                      onChange({ ...widget, text: event.target.value });
                    }}
                  />
                )}
              </Labelled>
            ) : null}

            {query === undefined || source === undefined || shape === undefined ? null : (
              <>
                <div className="flex min-w-0 flex-wrap gap-2">
                  <Labelled label={t`Chart type`}>
                    {(id) => (
                      <Select
                        id={id}
                        value={kind}
                        onValueChange={(value) => {
                          if (!isChartKind(value)) return;
                          onChange({
                            ...widget,
                            kind: value,
                            query: fitQuery(value, query, source, limits),
                          });
                        }}
                      >
                        {chartKinds.map((each) => (
                          <option key={each} value={each}>
                            {words.kind(each)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Labelled>
                  <Labelled label={t`Source`}>
                    {(id) => (
                      <Select
                        id={id}
                        value={source.key}
                        onValueChange={(value) => {
                          const next = sourceOf(catalog, value);
                          if (next === undefined || !isChartKind(kind)) return;
                          setQuery(defaultQuery(kind, next, limits));
                        }}
                      >
                        {allowedSources(catalog).map((each) => (
                          <option key={each.key} value={each.key}>
                            {each.label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Labelled>
                </div>
                <p className="text-xs text-muted-foreground">{source.description}</p>

                <Section title={t`Metrics`}>
                  {source.measures.map((measure) => {
                    const on = query.measures.includes(measure.key);
                    return (
                      <label
                        key={measure.key}
                        className="grid min-h-11 min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 py-1 lg:min-h-8"
                      >
                        <input
                          type="checkbox"
                          className="row-span-2 mt-1 size-4 shrink-0 accent-primary"
                          checked={on}
                          disabled={
                            (on && query.measures.length === 1) ||
                            (!on && query.measures.length >= shape.measures)
                          }
                          onChange={() => {
                            setQuery(toggleMeasure(query, measure.key, shape.measures));
                          }}
                        />
                        <span className="text-sm text-foreground">{measure.label}</span>
                        <span className="col-start-2 text-xs text-muted-foreground">
                          {measure.description}
                        </span>
                      </label>
                    );
                  })}
                </Section>

                {shape.groups[1] > 0 ? (
                  <Section title={t`Group`}>
                    <div className="flex min-w-0 flex-wrap gap-2">
                      {Array.from(
                        { length: Math.min(query.groupBy.length + 1, shape.groups[1]) },
                        (_, place) => {
                          const required = place < shape.groups[0];
                          return (
                            <Labelled key={place} label={place === 0 ? t`Group by` : t`Then by`}>
                              {(id) => (
                                <Select
                                  id={id}
                                  value={query.groupBy[place] ?? NONE}
                                  onValueChange={(value) => {
                                    setQuery(
                                      setGroup(query, place, value === NONE ? undefined : value),
                                    );
                                  }}
                                >
                                  {required ? null : <option value={NONE}>{t`Nothing`}</option>}
                                  {source.dimensions
                                    .filter(
                                      (dimension) =>
                                        dimension.key === query.groupBy[place] ||
                                        !query.groupBy.includes(dimension.key),
                                    )
                                    .map((dimension) => (
                                      <option key={dimension.key} value={dimension.key}>
                                        {dimension.label}
                                      </option>
                                    ))}
                                </Select>
                              )}
                            </Labelled>
                          );
                        },
                      )}
                    </div>
                  </Section>
                ) : null}

                <Section title={t`Dates`}>
                  <div className="flex min-w-0 flex-wrap gap-2">
                    <Labelled label={t`Date property`}>
                      {(id) => (
                        <Select
                          id={id}
                          value={query.time?.property ?? source.defaultDate}
                          onValueChange={(value) => {
                            setQuery(setDateProperty(query, value, source));
                          }}
                        >
                          {source.dateProperties.map((property) => (
                            <option key={property.key} value={property.key}>
                              {property.label}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Labelled>
                    {shape.time === 'never' ? null : (
                      <Labelled label={t`Breakdown`}>
                        {(id) => (
                          <Select
                            id={id}
                            value={query.time?.grain ?? NONE}
                            onValueChange={(value) => {
                              setQuery(setGrain(query, isGrain(value) ? value : undefined));
                            }}
                          >
                            {shape.time === 'required' ? null : (
                              <option value={NONE}>{t`No breakdown`}</option>
                            )}
                            <option value="day">{t`Daily`}</option>
                            <option value="week">{t`Weekly`}</option>
                            <option value="month">{t`Monthly`}</option>
                          </Select>
                        )}
                      </Labelled>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-wrap gap-2">
                    <Labelled label={t`Date range`}>
                      {(id) => (
                        <Select
                          id={id}
                          value={
                            ownRange === undefined
                              ? REPORTS
                              : 'preset' in ownRange
                                ? ownRange.preset
                                : OWN_DAYS
                          }
                          onValueChange={(value) => {
                            if (value === OWN_DAYS) return;
                            onChange(
                              isPreset(value)
                                ? { ...widget, range: { preset: value } }
                                : withoutKeys(widget, 'range'),
                            );
                          }}
                        >
                          <option value={REPORTS}>{t`The report's dates`}</option>
                          {ownRange === undefined || 'preset' in ownRange ? null : (
                            <option value={OWN_DAYS}>{`${ownRange.from} – ${ownRange.to}`}</option>
                          )}
                          {catalog.presets.map((preset) => (
                            <option key={preset} value={preset}>
                              {words.preset(preset)}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Labelled>
                    <Labelled label={t`Comparison`}>
                      {(id) => (
                        <Select
                          id={id}
                          value={ownCompare === undefined ? REPORTS : (ownCompare ?? NONE)}
                          onValueChange={(value) => {
                            const compare: ReportCompareMode | null | undefined =
                              value === 'previous_period' || value === 'previous_year'
                                ? value
                                : value === NONE
                                  ? null
                                  : undefined;
                            onChange(
                              compare === undefined
                                ? withoutKeys(widget, 'compare')
                                : { ...widget, compare },
                            );
                          }}
                        >
                          <option value={REPORTS}>{t`The report's comparison`}</option>
                          <option value={NONE}>{t`No comparison`}</option>
                          <option value="previous_period">{t`Period before`}</option>
                          <option value="previous_year">{t`Year before`}</option>
                        </Select>
                      )}
                    </Labelled>
                  </div>
                </Section>

                {usesAttribution(query, source) && source.attribution.length > 1 ? (
                  <Section title={t`Attribution`}>
                    <Labelled label={t`Read from`}>
                      {(id) => (
                        <Select
                          id={id}
                          value={query.attribution ?? source.attribution[0] ?? 'first'}
                          onValueChange={(value) => {
                            if (value === 'first' || value === 'latest' || value === 'all')
                              setQuery({ ...query, attribution: value });
                          }}
                        >
                          {source.attribution.map((each) => (
                            <option key={each} value={each}>
                              {each === 'first'
                                ? t`First attribution`
                                : each === 'latest'
                                  ? t`Latest attribution`
                                  : t`Every touch`}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Labelled>
                  </Section>
                ) : null}

                <Section title={t`Conditions`}>
                  <Conditions
                    businessId={businessId}
                    source={source}
                    filters={query.filters}
                    words={words}
                    onChange={(filters) => {
                      setQuery(
                        filters === undefined
                          ? withoutKeys(query, 'filters')
                          : { ...query, filters },
                      );
                    }}
                  />
                </Section>

                {kind === 'stat' ? null : (
                  <Section title={t`Order and limit`}>
                    <div className="flex min-w-0 flex-wrap gap-2">
                      <Labelled label={t`Order by`}>
                        {(id) => (
                          <Select
                            id={id}
                            value={query.order?.by ?? DEFAULT_ORDER}
                            onValueChange={(value) => {
                              setQuery(
                                value === DEFAULT_ORDER
                                  ? withoutKeys(query, 'order')
                                  : {
                                      ...query,
                                      order: {
                                        by: value,
                                        ...(query.order?.direction === undefined
                                          ? {}
                                          : { direction: query.order.direction }),
                                      },
                                    },
                              );
                            }}
                          >
                            <option value={DEFAULT_ORDER}>{t`Largest first`}</option>
                            <option value="group">{t`The groups' own order`}</option>
                            {query.measures.map((key) => (
                              <option key={key} value={key}>
                                {source.measures.find((measure) => measure.key === key)?.label ??
                                  key}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Labelled>
                      {query.order === undefined ? null : (
                        <Labelled label={t`Direction`}>
                          {(id) => (
                            <Select
                              id={id}
                              value={query.order?.direction ?? DEFAULT_ORDER}
                              onValueChange={(value) => {
                                const by = query.order?.by ?? 'group';
                                setQuery({
                                  ...query,
                                  order:
                                    value === 'asc' || value === 'desc'
                                      ? { by, direction: value }
                                      : { by },
                                });
                              }}
                            >
                              <option value={DEFAULT_ORDER}>{t`As usual`}</option>
                              <option value="asc">{t`Ascending`}</option>
                              <option value="desc">{t`Descending`}</option>
                            </Select>
                          )}
                        </Labelled>
                      )}
                      <Labelled label={t`Limit`}>
                        {(id) => (
                          <Input
                            id={id}
                            type="number"
                            min={1}
                            max={limits.rows}
                            placeholder={t`All`}
                            value={query.limit === undefined ? '' : String(query.limit)}
                            onChange={(event) => {
                              const limit = Math.round(Number(event.target.value));
                              setQuery(
                                event.target.value === '' || !(limit >= 1)
                                  ? withoutKeys(query, 'limit')
                                  : { ...query, limit: Math.min(limit, limits.rows) },
                              );
                            }}
                          />
                        )}
                      </Labelled>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <Trans>Groups past the limit are added up in one row, Other.</Trans>
                    </p>
                  </Section>
                )}
              </>
            )}

            <Section title={t`Size`}>
              <div className="flex min-w-0 gap-2">
                <Labelled label={t`Width, in columns of 12`}>
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      min={1}
                      max={12}
                      value={String(widget.w)}
                      onChange={(event) => {
                        const w = Math.round(Number(event.target.value));
                        if (w >= 1 && w <= 12) onChange({ ...widget, w });
                      }}
                    />
                  )}
                </Labelled>
                <Labelled label={t`Height, in rows`}>
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      min={1}
                      max={12}
                      value={String(widget.h)}
                      onChange={(event) => {
                        const h = Math.round(Number(event.target.value));
                        if (h >= 1 && h <= 12) onChange({ ...widget, h });
                      }}
                    />
                  )}
                </Labelled>
              </div>
            </Section>
          </div>
          <div className="flex justify-end border-t px-4 py-3">
            <Button onClick={onClose}>
              <Trans>Done</Trans>
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
