// "Update contact" as rows (docs/AUTOMATIONS.md section 3, "Values a step works out"): a
// field, and what it is set to: a value typed for the field's kind, another field's value,
// text with merge fields, now, a date moved by days, or a sum. Each row may write only when
// the field is empty. The rows are the step's own `fields`, read and written by
// automation-record-rules.ts; a value rows can't hold is kept as written. What the checks
// say of a field is shown under its row.
import { Trans, useLingui } from '@lingui/react/macro';
import type { AutomationSetup } from '@repo/contracts';
import { Input } from '@repo/ui/components/input';
import { useMemo, useState, type ReactElement } from 'react';
import {
  AddButton,
  FieldSelect,
  KeptAsWritten,
  Labelled,
  MergeText,
  noteClassName,
  RemoveButton,
  rowClassName,
  RowProblem,
  selectClassName,
  TypedValue,
} from './automation-record-controls';
import {
  choiceAt,
  isDated,
  isNumeric,
  mathOperatorSigns,
  modesFor,
  nextWriteRow,
  sourceFields,
  today,
  tokenOf,
  withMode,
  withOnlyIfEmpty,
  withWriteField,
  writableFields,
  writeRowsOf,
  writtenFields,
  type FieldChoice,
  type MathOperator,
  type WriteMode,
  type WriteRow,
  type Written,
} from './automation-record-rules';

const NUMBER = '#';

/** One side of a sum: a number typed here, or a number field read when the step runs. */
function Operand({
  label,
  value,
  fields,
  onChange,
}: {
  readonly label: string;
  readonly value: number | string | undefined;
  readonly fields: readonly FieldChoice[];
  readonly onChange: (value: number | string | undefined) => void;
}): ReactElement {
  const { t } = useLingui();
  const typed = typeof value !== 'string';
  const known = typed || fields.some((field) => field.path === value);
  return (
    <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
      <select
        aria-label={label}
        className={selectClassName}
        value={typed ? NUMBER : value}
        onChange={(event) => {
          onChange(event.target.value === NUMBER ? 0 : event.target.value);
        }}
      >
        <option value={NUMBER}>{t`A number`}</option>
        {known ? null : <option value={value}>{t`${value} (not found)`}</option>}
        {fields.map((field) => (
          <option key={field.path} value={field.path}>
            {field.label}
          </option>
        ))}
      </select>
      {typed ? (
        <Input
          aria-label={t`${label}: the number`}
          type="number"
          inputMode="decimal"
          step="any"
          value={value ?? ''}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            onChange(Number.isNaN(next) ? undefined : next);
          }}
        />
      ) : null}
    </div>
  );
}

export function ContactFieldChanges({
  value,
  setup,
  problems = {},
  onChange,
}: {
  readonly value: unknown;
  readonly setup: AutomationSetup;
  /** What the checks found wrong, by the path of the field each is about. */
  readonly problems?: Readonly<Record<string, string>>;
  readonly onChange: (value: Readonly<Record<string, unknown>>) => void;
}): ReactElement {
  const { t } = useLingui();
  // Text that holds no merge field yet reads as a plain value: the rows a person turned to
  // "Text with merge fields" are remembered here until one is put in.
  const [asText, setAsText] = useState<readonly string[]>([]);
  const fields = useMemo(() => writableFields(setup), [setup]);
  const sources = useMemo(() => sourceFields(setup), [setup]);
  const textSources = useMemo(() => sourceFields(setup, true), [setup]);
  const rows = writeRowsOf(value);
  if (rows === undefined)
    return (
      <p role="alert">
        <Trans>This saved setting is unavailable. Its value will be kept.</Trans>
      </p>
    );
  const modeNames: Readonly<Record<WriteMode, string>> = {
    value: t`A value`,
    copy: t`Copy from another field`,
    text: t`Text with merge fields`,
    now: t`Now`,
    date_add: t`Date plus days`,
    math: t`Calculate`,
    clear: t`Empty the field`,
    other: t`Kept as written`,
  };
  const signNames: Readonly<Record<MathOperator, string>> = {
    '+': t`plus`,
    '-': t`minus`,
    '*': t`times`,
    '/': t`divided by`,
  };
  const replace = (index: number, next: WriteRow): void => {
    onChange(writtenFields(rows.map((row, place) => (place === index ? next : row))));
  };
  const next = nextWriteRow(rows, fields);
  const numbers = sources.filter(
    (source) => isNumeric(source.type) && source.group !== 'opportunity',
  );
  const dates = sources.filter((source) => isDated(source.type) && source.group !== 'opportunity');

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      {rows.length === 0 ? (
        <p className={noteClassName}>
          <Trans>No field is set yet. Add the first one.</Trans>
        </p>
      ) : (
        <ol aria-label={t`Fields to set`} className="flex min-w-0 list-none flex-col gap-2.5">
          {rows.map((row, index) => {
            const number = index + 1;
            const field = choiceAt(fields, row.field, setup);
            const { written } = row;
            // What the row holds as text, when it holds text: one merge field alone is text
            // too, and is what "Copy from another field" writes.
            const textual =
              written.mode === 'text'
                ? written.text
                : written.mode === 'copy'
                  ? tokenOf(written.from)
                  : written.mode === 'value' && typeof written.value === 'string'
                    ? written.value
                    : undefined;
            const mode: WriteMode =
              textual !== undefined && (written.mode === 'text' || asText.includes(row.field))
                ? 'text'
                : written.mode;
            const problem = problems[row.field];
            const countedFrom = written.mode === 'date_add' ? written.from : '';
            const set = (to: Written): void => {
              replace(index, { ...row, written: to });
            };
            // Each field is written once: a row offers its own and those no other row has.
            const offered = fields.filter(
              (each) =>
                each.path === (field?.path ?? row.field) ||
                !rows.some((other) => choiceAt(fields, other.field, setup)?.path === each.path),
            );
            const modes = modesFor(field);
            return (
              <li key={row.field} className={rowClassName}>
                <div className="flex min-w-0 items-end gap-2">
                  <Labelled label={<Trans>Field</Trans>} className="flex-1">
                    <FieldSelect
                      label={t`Field ${number}`}
                      value={field?.path ?? row.field}
                      fields={offered}
                      control={index === 0}
                      invalid={problem !== undefined}
                      onChange={(path) => {
                        const chosen = fields.find((each) => each.path === path);
                        if (chosen !== undefined) replace(index, withWriteField(row, chosen));
                      }}
                    />
                  </Labelled>
                  <RemoveButton
                    label={t`Remove field ${number}`}
                    onClick={() => {
                      onChange(writtenFields(rows.filter((_, place) => place !== index)));
                    }}
                  />
                </div>
                <Labelled label={<Trans>Set to</Trans>}>
                  <select
                    aria-label={t`Set to, field ${number}`}
                    className={selectClassName}
                    value={mode}
                    onChange={(event) => {
                      const chosen = modes.find((each) => each === event.target.value);
                      if (chosen === undefined) return;
                      setAsText((current) =>
                        chosen === 'text'
                          ? [...current.filter((each) => each !== row.field), row.field]
                          : current.filter((each) => each !== row.field),
                      );
                      // Text stays what it is when the row turns to text with fields.
                      if (chosen !== 'text' || textual === undefined)
                        replace(index, withMode(row, chosen, field, sources));
                    }}
                  >
                    {modes.includes(mode) ? null : <option value={mode}>{modeNames[mode]}</option>}
                    {modes.map((each) => (
                      <option key={each} value={each}>
                        {modeNames[each]}
                      </option>
                    ))}
                  </select>
                </Labelled>
                {mode === 'text' ? (
                  <MergeText
                    label={t`Text, field ${number}`}
                    value={textual ?? ''}
                    fields={textSources}
                    invalid={problem !== undefined}
                    onChange={(text) => {
                      set({ mode: 'value', value: text });
                    }}
                  />
                ) : written.mode === 'value' ? (
                  <TypedValue
                    label={t`Value, field ${number}`}
                    field={field}
                    value={written.value}
                    invalid={problem !== undefined}
                    onChange={(typed) => {
                      set({ mode: 'value', value: typed });
                    }}
                  />
                ) : null}
                {mode === 'copy' && written.mode === 'copy' ? (
                  <FieldSelect
                    label={t`Copy from, field ${number}`}
                    value={choiceAt(sources, written.from, setup)?.path ?? written.from}
                    fields={sources.filter((source) => source.path !== (field?.path ?? row.field))}
                    invalid={problem !== undefined}
                    onChange={(from) => {
                      set({ mode: 'copy', from });
                    }}
                  />
                ) : null}
                {written.mode === 'now' ? (
                  <p className={noteClassName}>
                    <Trans>The moment the action runs, in the workflow's time zone.</Trans>
                  </p>
                ) : null}
                {written.mode === 'date_add' ? (
                  <div className="flex min-w-0 flex-wrap items-end gap-2">
                    <Labelled label={<Trans>Count from</Trans>} className="flex-1 basis-40">
                      <select
                        aria-label={t`Count from, field ${number}`}
                        className={selectClassName}
                        value={written.base === 'field' ? written.from : written.base}
                        onChange={(event) => {
                          const base = event.target.value;
                          set(
                            base === 'now'
                              ? { ...written, base: 'now', from: '' }
                              : base === 'date'
                                ? { ...written, base: 'date', from: today() }
                                : { ...written, base: 'field', from: base },
                          );
                        }}
                      >
                        <option value="now">{t`Now`}</option>
                        <option value="date">{t`A date`}</option>
                        {written.base === 'field' &&
                        !dates.some((each) => each.path === written.from) ? (
                          <option value={countedFrom}>{t`${countedFrom} (not found)`}</option>
                        ) : null}
                        {dates.map((each) => (
                          <option key={each.path} value={each.path}>
                            {each.label}
                          </option>
                        ))}
                      </select>
                    </Labelled>
                    {written.base === 'date' ? (
                      <Labelled label={<Trans>Date</Trans>} className="flex-1 basis-36">
                        <Input
                          aria-label={t`Date, field ${number}`}
                          type="date"
                          value={written.from.slice(0, 10)}
                          onChange={(event) => {
                            if (event.target.value !== '')
                              set({ ...written, from: event.target.value });
                          }}
                        />
                      </Labelled>
                    ) : null}
                    <Labelled label={<Trans>Days to add</Trans>} className="w-28">
                      <Input
                        aria-label={t`Days to add, field ${number}`}
                        type="number"
                        inputMode="numeric"
                        step={1}
                        value={written.days ?? ''}
                        onChange={(event) => {
                          const days = event.target.valueAsNumber;
                          set({
                            ...written,
                            days: Number.isNaN(days) ? undefined : Math.trunc(days),
                          });
                        }}
                      />
                    </Labelled>
                    <p className={`${noteClassName} basis-full`}>
                      <Trans>A negative number goes back.</Trans>
                    </p>
                  </div>
                ) : null}
                {written.mode === 'math' ? (
                  <div className="flex min-w-0 flex-wrap items-start gap-2">
                    <Operand
                      label={t`First number, field ${number}`}
                      value={written.left}
                      fields={numbers}
                      onChange={(left) => {
                        set({ ...written, left });
                      }}
                    />
                    <select
                      aria-label={t`Operation, field ${number}`}
                      className={`${selectClassName} w-auto`}
                      value={written.operator}
                      onChange={(event) => {
                        const operator = mathOperatorSigns.find(
                          (sign) => sign === event.target.value,
                        );
                        if (operator !== undefined) set({ ...written, operator });
                      }}
                    >
                      {mathOperatorSigns.map((sign) => (
                        <option key={sign} value={sign}>
                          {signNames[sign]}
                        </option>
                      ))}
                    </select>
                    <Operand
                      label={t`Second number, field ${number}`}
                      value={written.right}
                      fields={numbers}
                      onChange={(right) => {
                        set({ ...written, right });
                      }}
                    />
                  </div>
                ) : null}
                {written.mode === 'other' ? <KeptAsWritten /> : null}
                {written.mode === 'clear' ? null : (
                  <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 self-start text-sm lg:min-h-8">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-primary"
                      aria-label={t`Only if empty, field ${number}`}
                      checked={row.onlyIfEmpty === true}
                      onChange={(event) => {
                        replace(index, withOnlyIfEmpty(row, event.target.checked));
                      }}
                    />
                    <Trans>Only if empty</Trans>
                  </label>
                )}
                <RowProblem>{problem}</RowProblem>
              </li>
            );
          })}
        </ol>
      )}
      <AddButton
        disabled={next === undefined}
        onClick={() => {
          if (next !== undefined) onChange(writtenFields([...rows, next]));
        }}
      >
        <Trans>Add field</Trans>
      </AddButton>
      {next === undefined && rows.length > 0 ? (
        <p className={noteClassName}>
          <Trans>Every field the action can set has a row.</Trans>
        </p>
      ) : null}
    </div>
  );
}
