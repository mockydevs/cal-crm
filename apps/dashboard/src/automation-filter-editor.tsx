// A trigger's filters, and an If / else's conditions, as rows to fill in: a field, how it is
// compared, and with what (automation-filters.ts). Every row must hold for the filter to
// match. Each control is named by its row, so a screen reader and a test tell them apart.
import { Trans, useLingui } from '@lingui/react/macro';
import type { AutomationSetup } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Plus, Trash2 } from 'lucide-react';
import { useId, useMemo, type ReactElement } from 'react';
import { durationOf, durationParts, type DurationUnit } from './automation-fields';
import { suggestionsFor } from './automation-lead-sources';
import {
  emptyRow,
  fieldAt,
  filterFields,
  operatorName,
  operatorsFor,
  valueKind,
  withField,
  withOperator,
  type FilterField,
  type FilterOperator,
  type FilterRow,
} from './automation-filters';

export interface FilterEditorProps {
  readonly rows: readonly FilterRow[];
  readonly setup: AutomationSetup;
  /** What each row still lacks, once a save was tried; nothing before that. */
  readonly problems: readonly (string | undefined)[];
  readonly onChange: (rows: FilterRow[]) => void;
  /** What the rows are called: filters on a trigger, conditions on an If / else. */
  readonly noun: 'filter' | 'condition';
  /** False where something else adds the rows: a trigger's "Add filters" menu. */
  readonly adding?: boolean;
}

const units: readonly DurationUnit[] = ['minutes', 'hours', 'days', 'weeks'];

function ValueControl({
  row,
  field,
  label,
  invalid,
  onChange,
}: {
  readonly row: FilterRow;
  readonly field: FilterField | undefined;
  readonly label: string;
  readonly invalid: boolean;
  readonly onChange: (value: FilterRow['value']) => void;
}): ReactElement | null {
  const { t } = useLingui();
  const id = useId();
  const kind = valueKind(field, row.operator);
  const common = { 'aria-label': label, 'aria-invalid': invalid, 'data-field-control': true };
  if (kind === 'none') return null;
  if (kind === 'yes_no')
    return (
      <Select
        {...common}
        value={row.value === undefined ? '' : String(row.value)}
        onValueChange={(next) => {
          onChange(next === '' ? undefined : next === 'true');
        }}
      >
        <option value="">{t`Choose one`}</option>
        <option value="true">{t`Yes`}</option>
        <option value="false">{t`No`}</option>
      </Select>
    );
  if (kind === 'choice') {
    const options = field?.options ?? [];
    const given = typeof row.value === 'string' ? row.value : '';
    // A draft may name an option by what people read; the document keeps its key.
    const current =
      options.find((option) => option.key === given) ??
      options.find((option) => option.label.toLowerCase() === given.toLowerCase());
    return (
      <Select
        {...common}
        value={current?.key ?? given}
        onValueChange={(next) => {
          onChange(next === '' ? undefined : next);
        }}
      >
        <option value="">{t`Choose one`}</option>
        {current === undefined && given !== '' ? (
          <option value={given}>{t`${given} (not found)`}</option>
        ) : null}
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </Select>
    );
  }
  if (kind === 'duration') {
    const parts = durationParts(row.value);
    const unit = parts?.unit ?? 'days';
    const unitNames: Readonly<Record<DurationUnit, string>> = {
      seconds: t`Seconds`,
      minutes: t`Minutes`,
      hours: t`Hours`,
      days: t`Days`,
      weeks: t`Weeks`,
    };
    return (
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <Input
          {...common}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={parts?.amount ?? ''}
          onChange={(event) => {
            const typed = event.target.valueAsNumber;
            onChange(Number.isNaN(typed) ? undefined : durationOf(typed, unit));
          }}
        />
        <Select
          aria-label={t`Unit for: ${label}`}
          value={unit}
          onValueChange={(next) => {
            const chosen = units.find((each) => each === next) ?? unit;
            onChange(durationOf(parts?.amount ?? 1, chosen));
          }}
        >
          {units.map((each) => (
            <option key={each} value={each}>
              {unitNames[each]}
            </option>
          ))}
        </Select>
      </div>
    );
  }
  if (kind === 'number')
    return (
      <Input
        {...common}
        type="number"
        inputMode="decimal"
        step="any"
        value={typeof row.value === 'number' ? row.value : ''}
        onChange={(event) => {
          const typed = event.target.valueAsNumber;
          onChange(Number.isNaN(typed) ? undefined : typed);
        }}
      />
    );
  // A lead source is usually one of the built-in names: they are offered while typing,
  // and anything else can still be typed (a name an address carried in source=).
  const suggestions = kind === 'text' ? suggestionsFor(row.field) : undefined;
  const listId = `${id}-suggestions`;
  return (
    <>
      <Input
        {...common}
        type={kind === 'date' ? 'date' : 'text'}
        maxLength={1000}
        {...(suggestions === undefined ? {} : { list: listId })}
        value={typeof row.value === 'string' ? row.value.slice(0, kind === 'date' ? 10 : 1000) : ''}
        onChange={(event) => {
          onChange(event.target.value === '' ? undefined : event.target.value);
        }}
      />
      {suggestions === undefined ? null : (
        <datalist id={listId}>
          {suggestions.map((each) => (
            <option key={each} value={each} />
          ))}
        </datalist>
      )}
    </>
  );
}

export function FilterEditor({
  rows,
  setup,
  problems,
  onChange,
  noun,
  adding = true,
}: FilterEditorProps): ReactElement {
  const { t } = useLingui();
  const fields = useMemo(() => filterFields(setup), [setup]);
  const change = (index: number, next: FilterRow): void => {
    onChange(rows.map((row, position) => (position === index ? next : row)));
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {rows.length === 0 ? null : (
        <ul
          aria-label={noun === 'filter' ? t`Filters` : t`Conditions`}
          data-filter-rows
          className="flex min-w-0 flex-col gap-3"
        >
          {rows.map((row, index) => {
            const number = index + 1;
            const field = fieldAt(fields, row.field, setup);
            const problem = problems[index];
            const operators = field === undefined ? [row.operator] : operatorsFor(field.type);
            const { field: path } = row;
            const named =
              noun === 'filter'
                ? {
                    field: t`Field of filter ${number}`,
                    operator: t`Comparison of filter ${number}`,
                    value: t`Value of filter ${number}`,
                    remove: t`Remove filter ${number}`,
                  }
                : {
                    field: t`Field of condition ${number}`,
                    operator: t`Comparison of condition ${number}`,
                    value: t`Value of condition ${number}`,
                    remove: t`Remove condition ${number}`,
                  };
            return (
              <li key={number} className="flex min-w-0 flex-col gap-1.5">
                {index === 0 ? null : (
                  <span className="self-start rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground">
                    <Trans>AND</Trans>
                  </span>
                )}
                <div
                  className={`flex min-w-0 items-start gap-2 rounded-xl border p-3 ${
                    problem === undefined ? 'border-border' : 'border-destructive'
                  }`}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Select
                      aria-label={named.field}
                      aria-invalid={problem !== undefined && row.field === ''}
                      data-field-control
                      value={field?.path ?? path}
                      onValueChange={(next) => {
                        const chosen = fields.find((each) => each.path === next);
                        if (chosen !== undefined) change(index, withField(row, chosen));
                      }}
                    >
                      <option value="">{t`Select a field`}</option>
                      {field === undefined && path !== '' ? (
                        <option value={path}>{t`${path} (not found)`}</option>
                      ) : null}
                      {fields.flatMap((each, place) => [
                        // A contact's custom fields come folder by folder, and the
                        // opportunity's last, each under what it is read from.
                        ...(each.heading !== undefined &&
                        fields[place - 1]?.heading !== each.heading
                          ? [
                              <option key={`heading:${String(place)}`} value="heading:" disabled>
                                {each.heading}
                              </option>,
                            ]
                          : []),
                        <option key={each.path} value={each.path}>
                          {each.label}
                        </option>,
                      ])}
                    </Select>
                    <Select
                      aria-label={named.operator}
                      value={row.operator}
                      onValueChange={(next) => {
                        const chosen = operators.find((each) => each === next);
                        if (chosen !== undefined) change(index, withOperator(row, chosen, field));
                      }}
                    >
                      {operators.map((each: FilterOperator) => (
                        <option key={each} value={each}>
                          {operatorName(each, field?.type)}
                        </option>
                      ))}
                    </Select>
                    <ValueControl
                      row={row}
                      field={field}
                      label={named.value}
                      invalid={problem !== undefined && row.field !== ''}
                      onChange={(value) => {
                        change(index, { ...row, value });
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    aria-label={named.remove}
                    className="flex size-11 shrink-0 items-center justify-center rounded-control text-body hover:bg-secondary hover:text-foreground lg:size-9"
                    onClick={() => {
                      onChange(rows.filter((_, position) => position !== index));
                    }}
                  >
                    <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                  </button>
                </div>
                {problem === undefined ? null : (
                  <p className="text-sm font-medium text-destructive">{problem}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <Button
          type="button"
          variant="quiet"
          size="small"
          className="self-start text-link hover:text-link"
          onClick={() => {
            onChange([...rows, emptyRow]);
          }}
        >
          <Plus aria-hidden className="size-4" strokeWidth={2} />
          {noun === 'filter' ? <Trans>Add filters</Trans> : <Trans>Add condition</Trans>}
        </Button>
      ) : null}
    </div>
  );
}
