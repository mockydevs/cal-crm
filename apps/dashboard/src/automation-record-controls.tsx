// The small controls the record forms share (automation-record-fields.tsx and
// automation-contact-fields.tsx): a list of fields under their headings, a value typed for
// a field's kind, text that takes merge fields, and the buttons of a row. The lists are the
// browser's own, so a long one scrolls and reads as a list on a phone, and its headings
// (Contact, Opportunity) are real groups to a screen reader.
import { Trans, useLingui } from '@lingui/react/macro';
import { Input } from '@repo/ui/components/input';
import { Textarea } from '@repo/ui/components/textarea';
import { Plus, Trash2 } from 'lucide-react';
import { useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { grouped, isDated, isNumeric, tokenOf, type FieldChoice } from './automation-record-rules';

export const selectClassName =
  'min-h-11 w-full min-w-0 rounded-control border border-input bg-card px-2.5 text-md text-foreground aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-9';
export const rowClassName =
  'flex min-w-0 flex-col gap-2 rounded-xl border border-input bg-card p-3';
export const noteClassName = 'text-sm text-muted-foreground';

/** A control under its name, small and grey above it. */
export function Labelled({
  label,
  children,
  className = '',
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/** What a row has wrong with it, under the row. */
export function RowProblem({ children }: { readonly children: ReactNode }): ReactElement | null {
  return children === undefined || children === null || children === '' ? null : (
    <p className="text-sm font-medium text-destructive wrap-anywhere">{children}</p>
  );
}

export function RemoveButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="flex size-11 shrink-0 items-center justify-center rounded-control text-body hover:bg-secondary hover:text-foreground lg:size-9"
      onClick={onClick}
    >
      <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
    </button>
  );
}

/** "+ Add field": a button that adds the next row. */
export function AddButton({
  children,
  disabled = false,
  onClick,
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-control px-2 text-sm font-medium text-link hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-8"
      onClick={onClick}
    >
      <Plus aria-hidden className="size-4" strokeWidth={2} />
      {children}
    </button>
  );
}

export interface AddChoice {
  readonly value: string;
  readonly label: string;
}

/** "+ Add": a list of what can still be added; choosing one adds it. */
export function AddSelect({
  label,
  choices,
  control = false,
  onAdd,
}: {
  /** What it adds, such as "Add filter": the list's name and its first line. */
  readonly label: string;
  readonly choices: readonly AddChoice[];
  /** Whether the keyboard starts here when the panel opens, or comes back to fix it. */
  readonly control?: boolean;
  readonly onAdd: (value: string) => void;
}): ReactElement | null {
  if (choices.length === 0) return null;
  return (
    <select
      aria-label={label}
      {...(control ? { 'data-field-control': true } : {})}
      className="min-h-11 max-w-full self-start rounded-control border border-transparent bg-transparent px-1 text-sm font-medium text-link hover:bg-muted lg:min-h-8"
      value=""
      onChange={(event) => {
        if (event.target.value !== '') onAdd(event.target.value);
      }}
    >
      <option value="">{`+ ${label}`}</option>
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}

/** One of a list of fields, under their headings. A path the list lacks stays in sight. */
export function FieldSelect({
  label,
  value,
  fields,
  blank,
  invalid = false,
  control = false,
  onChange,
}: {
  readonly label: string;
  /** The field chosen, as the list names it; a path the list lacks; or empty for none. */
  readonly value: string;
  readonly fields: readonly FieldChoice[];
  /** What the list says before a field is chosen; without it there is always one chosen. */
  readonly blank?: string | undefined;
  readonly invalid?: boolean;
  /** Whether the keyboard starts here when the panel opens, or comes back to fix it. */
  readonly control?: boolean;
  readonly onChange: (path: string) => void;
}): ReactElement {
  const { t } = useLingui();
  const known = fields.some((field) => field.path === value);
  return (
    <select
      aria-label={label}
      aria-invalid={invalid}
      className={selectClassName}
      {...(control ? { 'data-field-control': true } : {})}
      value={value}
      onChange={(event) => {
        if (event.target.value !== '') onChange(event.target.value);
      }}
    >
      {blank === undefined ? null : <option value="">{blank}</option>}
      {known || value === '' ? null : <option value={value}>{t`${value} (not found)`}</option>}
      {grouped(fields).map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.fields.map((field) => (
            <option key={field.path} value={field.path}>
              {field.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** A value typed as the field's kind asks: text, a number, a date, a choice, yes or no. */
export function TypedValue({
  label,
  field,
  value,
  invalid = false,
  onChange,
}: {
  readonly label: string;
  readonly field: FieldChoice | undefined;
  readonly value: string | number | boolean;
  readonly invalid?: boolean;
  readonly onChange: (value: string | number | boolean) => void;
}): ReactElement {
  const { t } = useLingui();
  const type = field?.type;
  const common = { 'aria-label': label, 'aria-invalid': invalid };
  if (type === 'boolean')
    return (
      <select
        {...common}
        className={selectClassName}
        value={String(value === true || value === 'true')}
        onChange={(event) => {
          onChange(event.target.value === 'true');
        }}
      >
        <option value="true">{t`Yes`}</option>
        <option value="false">{t`No`}</option>
      </select>
    );
  if (type === 'single_choice' && field !== undefined && field.options.length > 0) {
    const given = typeof value === 'string' ? value : String(value);
    const current =
      field.options.find((option) => option.key === given) ??
      field.options.find((option) => option.label.toLowerCase() === given.toLowerCase());
    return (
      <select
        {...common}
        className={selectClassName}
        value={current?.key ?? given}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {current === undefined ? (
          <option value={given}>
            {given === '' ? t`Choose a value` : t`${given} (not found)`}
          </option>
        ) : null}
        {field.options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  // A number field that holds text, as an older draft may: shown as it is, so nothing is
  // hidden, and the checks say what a number field needs.
  if (isNumeric(type) && (typeof value !== 'string' || value === ''))
    return (
      <Input
        {...common}
        type="number"
        inputMode="decimal"
        step="any"
        value={typeof value === 'number' ? value : ''}
        onChange={(event) => {
          const typed = event.target.valueAsNumber;
          // An emptied box keeps what a number field can hold; the checks ask for a number.
          onChange(Number.isNaN(typed) ? '' : typed);
        }}
      />
    );
  if (isDated(type))
    return (
      <Input
        {...common}
        type="date"
        value={typeof value === 'string' ? value.slice(0, 10) : ''}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    );
  if (type === 'long_text')
    return (
      <Textarea
        {...common}
        maxLength={1000}
        value={String(value)}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    );
  return (
    <Input
      {...common}
      maxLength={1000}
      value={String(value)}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  );
}

/** Text with a merge field put in where the keyboard was: the text, and where it now is. */
export function insertedAt(
  text: string,
  token: string,
  start: number | null,
  end: number | null,
): { readonly text: string; readonly caret: number } {
  const from = Math.min(Math.max(start ?? text.length, 0), text.length);
  const to = Math.min(Math.max(end ?? from, from), text.length);
  return { text: `${text.slice(0, from)}${token}${text.slice(to)}`, caret: from + token.length };
}

/** The list that puts a merge field into text: "Insert a field". */
export function MergeFieldSelect({
  label,
  fields,
  onInsert,
}: {
  readonly label: string;
  readonly fields: readonly FieldChoice[];
  /** Given the merge field as text holds it, such as {{contact.firstName}}. */
  readonly onInsert: (token: string) => void;
}): ReactElement {
  const { t } = useLingui();
  return (
    <select
      aria-label={label}
      className="min-h-11 max-w-full self-start rounded-control border border-transparent bg-transparent px-1 text-sm font-medium text-link hover:bg-muted lg:min-h-8"
      value=""
      onChange={(event) => {
        if (event.target.value !== '') onInsert(tokenOf(event.target.value));
      }}
    >
      <option value="">{t`+ Insert a field`}</option>
      {grouped(fields).map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.fields.map((field) => (
            <option key={field.path} value={field.path}>
              {field.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** A line of text that takes merge fields, with the list that inserts one at the caret. */
export function MergeText({
  label,
  value,
  fields,
  invalid = false,
  maxLength = 1000,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly fields: readonly FieldChoice[];
  readonly invalid?: boolean;
  readonly maxLength?: number;
  readonly onChange: (text: string) => void;
}): ReactElement {
  const { t } = useLingui();
  const boxRef = useRef<HTMLInputElement>(null);
  // Where the keyboard goes once the text with the new field in it is drawn.
  const caretRef = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const caret = caretRef.current;
    if (caret === undefined) return;
    caretRef.current = undefined;
    boxRef.current?.focus();
    boxRef.current?.setSelectionRange(caret, caret);
  }, [value]);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Input
        ref={boxRef}
        aria-label={label}
        aria-invalid={invalid}
        maxLength={maxLength}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <MergeFieldSelect
        label={t`Insert a field into: ${label}`}
        fields={fields}
        onInsert={(token) => {
          const box = boxRef.current;
          const next = insertedAt(
            value,
            token,
            box?.selectionStart ?? null,
            box?.selectionEnd ?? null,
          );
          caretRef.current = next.caret;
          onChange(next.text);
        }}
      />
    </div>
  );
}

/** Said in a row whose value rows can't hold: it is kept, and edited as JSON. */
export function KeptAsWritten(): ReactElement {
  return (
    <p className={noteClassName}>
      <Trans>This value is kept as it is written. Edit it in the JSON view.</Trans>
    </p>
  );
}
