import { Select } from '@repo/ui/components/select';
import { Trans, useLingui } from '@lingui/react/macro';
import { confirmRecordField, setRecordField, type RecordField } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Check, Pencil } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { apiIn } from './api';
import { useBusiness } from './workspace';

interface Props {
  readonly recordId: string;
  readonly field: RecordField;
  readonly canConfirm: boolean;
  readonly saved: (value: RecordField) => Promise<void>;
  /** Small icon buttons beside the value, where the row has no room for worded ones. */
  readonly compact?: boolean;
}
const iconButtonClassName =
  'flex size-11 shrink-0 items-center justify-center rounded-control text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 lg:size-7';
const selectClassName =
  'min-h-11 w-full min-w-0 rounded-xl border border-input bg-card px-3.5 text-md text-foreground disabled:opacity-50';

export function RecordFieldActions({
  recordId,
  field,
  canConfirm,
  saved,
  compact = false,
}: Props): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const editRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  useEffect(() => {
    if (!editing && !busy && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      editRef.current?.focus();
    }
  }, [editing, busy]);
  const close = () => {
    restoreFocusRef.current = true;
    setEditing(false);
  };
  const label = field.definition.label;
  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await saved(
        await apiIn(business.id).request(confirmRecordField, {
          params: { id: recordId, fieldId: field.definition.id },
          body: { revision: field.revision },
        }),
      );
      restoreFocusRef.current = true;
    } catch (problem: unknown) {
      setError(
        problem instanceof ApiError ? problem.message : t`The value wasn't confirmed. Try again.`,
      );
    } finally {
      setBusy(false);
    }
  };
  if (editing)
    return <FieldValueForm recordId={recordId} initial={field} saved={saved} close={close} />;
  const mayConfirm = canConfirm && field.source?.kind === 'ai_agent' && field.confirmedAt === null;
  if (compact)
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-0.5">
          {mayConfirm ? (
            <button
              type="button"
              className={iconButtonClassName}
              aria-label={t`Confirm ${label}`}
              title={t`Confirm ${label}`}
              disabled={busy}
              onClick={() => {
                if (!busy) void confirm();
              }}
            >
              <Check aria-hidden className="size-4" strokeWidth={2} />
            </button>
          ) : null}
          <button
            ref={editRef}
            type="button"
            className={iconButtonClassName}
            aria-label={t`Edit ${label}`}
            title={t`Edit ${label}`}
            disabled={busy}
            onClick={() => {
              setError(undefined);
              setEditing(true);
            }}
          >
            <Pencil aria-hidden className="size-4" strokeWidth={1.8} />
          </button>
        </div>
        {error === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  return (
    <div className="flex w-full flex-col items-start gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          ref={editRef}
          variant="secondary"
          size="small"
          aria-label={t`Edit ${label}`}
          disabled={busy}
          onClick={() => {
            setError(undefined);
            setEditing(true);
          }}
        >
          <Trans>Edit value</Trans>
        </Button>
        {mayConfirm ? (
          <Button
            variant="secondary"
            size="small"
            aria-label={t`Confirm ${label}`}
            disabled={busy}
            onClick={() => {
              if (!busy) void confirm();
            }}
          >
            <Trans>Confirm</Trans>
          </Button>
        ) : null}
      </div>
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function FieldValueForm({
  recordId,
  initial,
  saved,
  close,
}: {
  readonly recordId: string;
  readonly initial: RecordField;
  readonly saved: (value: RecordField) => Promise<void>;
  readonly close: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  // The opening snapshot and revision stay with the draft during background refreshes.
  // https://react.dev/learn/preserving-and-resetting-state
  const [opening] = useState(initial);
  const [draft, setDraft] = useState<RecordField['value']>(initial.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const controlId = useId();
  const errorId = useId();
  const hintId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>('[data-field-control]')?.focus();
  }, [error]);
  const definition = opening.definition;
  const label = definition.label;
  const save = async (value: RecordField['value']) => {
    setBusy(true);
    setError(undefined);
    try {
      await saved(
        await apiIn(business.id).request(setRecordField, {
          params: { id: recordId, fieldId: definition.id },
          body: { value, revision: opening.revision },
        }),
      );
      close();
    } catch (problem: unknown) {
      setError(
        problem instanceof ApiError
          ? (problem.problem.errors?.find((issue) => issue.path === '/value')?.message ??
              problem.message)
          : t`The value wasn't saved. Check your connection and try again.`,
      );
    } finally {
      setBusy(false);
    }
  };
  const type = definition.valueType;
  const describedBy = error === undefined ? hintId : `${hintId} ${errorId}`;
  const common = {
    id: controlId,
    'data-field-control': true,
    'aria-describedby': describedBy,
    'aria-invalid': error !== undefined,
    disabled: busy,
  };
  // A text box list, a radio select and a checkbox field are several controls: named and
  // described as one group, by its legend, rather than by their first control.
  const grouped =
    type === 'text_list' ||
    (type === 'single_choice' && definition.display === 'radio') ||
    (type === 'multi_choice' && definition.display === 'checkbox');
  /** What each control of a group has: the first is the one focus starts on. */
  const member = (index: number) => ({
    disabled: busy,
    ...(index === 0 ? { 'data-field-control': true } : {}),
  });
  const group = (children: ReactNode) => (
    <fieldset
      aria-describedby={describedBy}
      aria-invalid={error !== undefined}
      className="flex min-w-0 flex-col gap-2"
    >
      <legend className="mb-1 text-sm font-medium">{definition.label}</legend>
      {children}
    </fieldset>
  );
  let control: ReactElement;
  if (type === 'boolean')
    control = (
      <Select
        {...common}
        className={selectClassName}
        value={draft === null ? '' : draft === true ? 'true' : 'false'}
        onValueChange={(selectedValue) => {
          setDraft(selectedValue === '' ? null : selectedValue === 'true');
        }}
      >
        <option value="">{t`Not set`}</option>
        <option value="true">{t`Yes`}</option>
        <option value="false">{t`No`}</option>
      </Select>
    );
  else if (type === 'text_list') {
    // One text box for each of the field's boxes; a retired box only where it holds text.
    const boxes = draft !== null && typeof draft === 'object' && !Array.isArray(draft) ? draft : {};
    control = group(
      <div className="flex flex-col gap-2">
        {definition.options
          .filter((option) => !option.archived || boxes[option.key] !== undefined)
          .map((option, index) => {
            const name = option.label;
            return (
              <label key={option.key} className="flex flex-col gap-1 text-sm">
                {option.archived ? t`${name} (archived)` : name}
                <Input
                  {...member(index)}
                  maxLength={1000}
                  value={boxes[option.key] ?? ''}
                  onValueChange={(value) => {
                    setDraft({ ...boxes, [option.key]: value });
                  }}
                />
              </label>
            );
          })}
      </div>,
    );
  } else if (
    (type === 'single_choice' && definition.display === 'radio') ||
    (type === 'multi_choice' && definition.display === 'checkbox')
  ) {
    // GoHighLevel's Radio select and Checkbox: every choice in sight, picked by its button.
    const selected = Array.isArray(draft) ? draft : typeof draft === 'string' ? [draft] : [];
    const many = type === 'multi_choice';
    control = group(
      <div className="flex flex-col gap-1">
        {definition.options
          .filter((option) => !option.archived || selected.includes(option.key))
          .map((option, index) => {
            const name = option.label;
            const checked = selected.includes(option.key);
            return (
              <label
                key={option.key}
                className="flex min-h-11 items-center gap-2 text-sm lg:min-h-9"
              >
                <input
                  {...member(index)}
                  type={many ? 'checkbox' : 'radio'}
                  name={`${controlId}-choice`}
                  className="size-[18px] accent-primary"
                  checked={checked}
                  onChange={(event) => {
                    if (!many) {
                      setDraft(option.key);
                      return;
                    }
                    const next = event.target.checked
                      ? [...selected, option.key]
                      : selected.filter((key) => key !== option.key);
                    setDraft(next.length === 0 ? null : next);
                  }}
                />
                {option.archived ? t`${name} (archived)` : name}
              </label>
            );
          })}
      </div>,
    );
  } else if (type === 'single_choice' || type === 'multi_choice') {
    const selected = Array.isArray(draft) ? draft : typeof draft === 'string' ? [draft] : [];
    const options = definition.options.filter(
      (option) => !option.archived || selected.includes(option.key),
    );
    const choices = options.map((option) => {
      const label = option.label;
      return (
        <option key={option.key} value={option.key}>
          {option.archived ? t`${label} (archived)` : label}
        </option>
      );
    });
    control =
      type === 'multi_choice' ? (
        <Select
          {...common}
          multiple
          value={selected}
          onValueChange={(values) => {
            setDraft(values.length === 0 ? null : values);
          }}
        >
          {choices}
        </Select>
      ) : (
        <Select
          {...common}
          value={typeof draft === 'string' ? draft : ''}
          onValueChange={(value) => {
            setDraft(value === '' ? null : value);
          }}
        >
          <option value="">{t`Not set`}</option>
          {choices}
        </Select>
      );
  } else if (type === 'long_text')
    control = (
      <textarea
        {...common}
        className={`${selectClassName} min-h-32 py-2`}
        maxLength={100000}
        value={typeof draft === 'string' ? draft : ''}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
      />
    );
  else
    control = (
      <Input
        {...common}
        value={typeof draft === 'string' ? draft : ''}
        type={
          type === 'date'
            ? 'date'
            : type === 'email'
              ? 'email'
              : type === 'phone'
                ? 'tel'
                : type === 'url'
                  ? 'url'
                  : 'text'
        }
        inputMode={type === 'number' || type === 'money' ? 'decimal' : undefined}
        maxLength={type === 'url' ? 2000 : type === 'email' ? 320 : type === 'phone' ? 40 : 1000}
        onValueChange={(value) => {
          setDraft(value === '' && type !== 'text' ? null : value);
        }}
      />
    );
  return (
    <form
      ref={formRef}
      aria-label={t`Edit ${label}`}
      noValidate
      className="flex w-full min-w-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void save(draft);
      }}
    >
      {grouped ? null : (
        <label htmlFor={controlId} className="text-sm font-medium">
          {definition.label}
        </label>
      )}
      {control}
      <p id={hintId} className="text-sm text-muted-foreground">
        {type === 'datetime'
          ? t`Include the timezone, for example 2026-10-31T23:30:00+03:00.`
          : type === 'multi_choice'
            ? t`Select one or more choices. Use Clear value to unset them all.`
            : type === 'text_list'
              ? t`Fill in any of the boxes. An empty box is left out.`
              : definition.description}
      </p>
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="small" disabled={busy}>
          <Trans>Save value</Trans>
        </Button>
        <Button variant="secondary" size="small" disabled={busy} onClick={close}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          variant="quiet"
          size="small"
          disabled={busy}
          onClick={() => {
            if (!busy) void save(null);
          }}
        >
          <Trans>Clear value</Trans>
        </Button>
      </div>
    </form>
  );
}
