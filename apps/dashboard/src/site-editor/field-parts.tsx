// The small controls the editor's panel is made of, on the dashboard's own components:
// a text box, a number, a choice, a switch, a colour, an address, four edges, a length.
// Each takes a value and hands back a value the page document accepts: an address or a
// colour that is still being typed is kept in the box, with what is wrong said under it,
// and reaches the page only once it is one the contract takes. Nothing here knows the
// canvas.
import { Trans, useLingui } from '@lingui/react/macro';
import { Field, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { Switch } from '../automation-switch';
import { isLinkAddress, isMediaAddress } from '../site-media-rules';

export { isLinkAddress, isMediaAddress };

export const smallLabelClassName = 'text-xs font-medium text-body';
const hintClassName = 'text-xs leading-normal text-muted-foreground';

/**
 * A box of text. With `accepts`, what is typed stays in the box and reaches the page only
 * once it is something the page document takes (a button's label is never empty, a
 * stylesheet holds no "<"); until then `refusal` says under the box what is wrong.
 */
export function TextBox({
  label,
  value,
  onChange,
  maxLength,
  multiline = false,
  mono = false,
  hint,
  accepts,
  refusal,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly maxLength?: number;
  readonly multiline?: boolean;
  readonly mono?: boolean;
  readonly hint?: ReactNode;
  readonly accepts?: (text: string) => boolean;
  /** Why what is in the box is not taken: shown while it is not. */
  readonly refusal?: ReactNode;
}): ReactElement {
  const [draft, setDraft] = useState<string>();
  const change = (text: string): void => {
    if (accepts === undefined || accepts(text)) {
      setDraft(undefined);
      onChange(text);
    } else setDraft(text);
  };
  return (
    <Field invalid={draft !== undefined} className="min-w-0 gap-1">
      <FieldLabel className={smallLabelClassName}>{label}</FieldLabel>
      {multiline ? (
        <Textarea
          rows={mono ? 6 : 3}
          maxLength={maxLength}
          {...(mono ? { className: 'font-mono text-xs' } : {})}
          value={draft ?? value}
          onChange={(event) => {
            change(event.target.value);
          }}
        />
      ) : (
        <Input
          maxLength={maxLength}
          autoComplete="off"
          value={draft ?? value}
          onChange={(event) => {
            change(event.target.value);
          }}
        />
      )}
      {hint === undefined ? null : <p className={hintClassName}>{hint}</p>}
      {draft === undefined || refusal === undefined ? null : (
        <FieldError match>{refusal}</FieldError>
      )}
    </Field>
  );
}

/** A number within bounds, or nothing: an empty box is "not set". */
export function NumberBox({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  required = false,
}: {
  readonly label: string;
  readonly value: number | undefined;
  readonly onChange: (value: number | undefined) => void;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  /** A number that must always be there: an empty box changes nothing. */
  readonly required?: boolean;
}): ReactElement {
  // What is typed is shown as typed; the page gets it once it is a number within bounds.
  const [draft, setDraft] = useState<string>();
  const shown = draft ?? (value === undefined ? '' : String(value));
  const outside = draft !== undefined && draft !== '';
  return (
    <Field invalid={outside} className="min-w-0 gap-1">
      <FieldLabel className={smallLabelClassName}>{label}</FieldLabel>
      <Input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(event) => {
          const text = event.target.value;
          const typed = event.target.valueAsNumber;
          if (text === '') {
            setDraft(required ? '' : undefined);
            if (!required) onChange(undefined);
          } else if (Number.isFinite(typed) && typed >= min && typed <= max) {
            setDraft(undefined);
            onChange(typed);
          } else setDraft(text);
        }}
        onBlur={() => {
          if (draft === '') setDraft(undefined);
        }}
      />
      {outside ? (
        <FieldError match>
          <Trans>
            Use a number from {min} to {max}.
          </Trans>
        </FieldError>
      ) : null}
    </Field>
  );
}

export interface ChoiceOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
}

/** One of a few values, by name. */
export function Choice<Value extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  readonly label: string;
  readonly value: Value;
  readonly options: readonly ChoiceOption<Value>[];
  readonly onChange: (value: Value) => void;
  readonly hint?: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className={`flex min-w-0 flex-col gap-1 ${smallLabelClassName}`}>
        {label}
        <Select
          aria-label={label}
          value={value}
          onValueChange={(next) => {
            const chosen = options.find((option) => option.value === next);
            if (chosen !== undefined) onChange(chosen.value);
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </label>
      {hint === undefined ? null : <p className={hintClassName}>{hint}</p>}
    </div>
  );
}

export function SwitchRow({
  label,
  checked,
  onChange,
  hint,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly hint?: ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span id={id} className={smallLabelClassName}>
          {label}
        </span>
        <Switch checked={checked} onChange={onChange} aria-labelledby={id} />
      </div>
      {hint === undefined ? null : <p className={hintClassName}>{hint}</p>}
    </div>
  );
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** A colour as the browser's own picker takes one: six digits, no transparency. */
function pickerValue(value: string | undefined): string {
  if (value === undefined || !HEX.test(value)) return '#000000';
  const digits = value.slice(1);
  const six =
    digits.length <= 4
      ? digits.slice(0, 3).replace(/./g, (digit) => digit + digit)
      : digits.slice(0, 6);
  return `#${six.toLowerCase()}`;
}

/** A colour: a hex value such as #1f2937, "transparent", or nothing. */
export function ColorBox({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly onChange: (value: string | undefined) => void;
}): ReactElement {
  const { t } = useLingui();
  const [draft, setDraft] = useState<string>();
  const shown = draft ?? value ?? '';
  return (
    <Field invalid={draft !== undefined} className="min-w-0 gap-1">
      <FieldLabel className={smallLabelClassName}>{label}</FieldLabel>
      <div className="flex min-w-0 items-center gap-2">
        <input
          type="color"
          aria-label={t`${label}: pick a colour`}
          className="size-11 shrink-0 cursor-pointer rounded-control border border-input bg-card p-1 lg:size-9"
          value={pickerValue(value)}
          onChange={(event) => {
            setDraft(undefined);
            onChange(event.target.value);
          }}
        />
        <Input
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={11}
          value={shown}
          onChange={(event) => {
            const text = event.target.value.trim();
            if (text === '') {
              setDraft(undefined);
              onChange(undefined);
            } else if (HEX.test(text) || text === 'transparent') {
              setDraft(undefined);
              onChange(text);
            } else setDraft(event.target.value);
          }}
        />
      </div>
      {draft === undefined ? null : (
        <FieldError match>
          <Trans>Use a hex colour such as #1f2937, or transparent.</Trans>
        </FieldError>
      )}
    </Field>
  );
}

/**
 * An address: of a picture or a video (`media`), or of where a link goes (`link`). What is
 * typed stays in the box; the page gets it once it is an address the contract takes, and
 * gets "none" when the box is emptied.
 */
export function AddressBox({
  label,
  kind,
  value,
  onChange,
  hint,
}: {
  readonly label: string;
  readonly kind: 'media' | 'link';
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
  readonly hint?: ReactNode;
}): ReactElement {
  const [draft, setDraft] = useState<string>();
  const accepts = kind === 'media' ? isMediaAddress : isLinkAddress;
  return (
    <Field invalid={draft !== undefined} className="min-w-0 gap-1">
      <FieldLabel className={smallLabelClassName}>{label}</FieldLabel>
      <Input
        inputMode="url"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={2000}
        value={draft ?? value ?? ''}
        onChange={(event) => {
          const text = event.target.value.trim();
          if (text === '') {
            setDraft(undefined);
            onChange(null);
          } else if (accepts(text)) {
            setDraft(undefined);
            onChange(text);
          } else setDraft(event.target.value);
        }}
      />
      {hint === undefined ? null : <p className={hintClassName}>{hint}</p>}
      {draft === undefined ? null : (
        <FieldError match>
          {kind === 'media' ? (
            <Trans>
              Use a secure web address starting with https://, or a path on this site such as
              /picture.png.
            </Trans>
          ) : (
            <Trans>
              Use a web address, a mailto: or tel: address, a path such as /thanks, or an anchor
              such as #top.
            </Trans>
          )}
        </FieldError>
      )}
    </Field>
  );
}

export interface Edges {
  readonly top?: number | undefined;
  readonly right?: number | undefined;
  readonly bottom?: number | undefined;
  readonly left?: number | undefined;
}
const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/** Four distances in pixels, each set or not. All unset is "not set" as a whole. */
export function EdgesBox({
  label,
  value,
  onChange,
  min,
}: {
  readonly label: string;
  readonly value: Edges | undefined;
  readonly onChange: (value: Edges | undefined) => void;
  /** 0 for padding, which cannot pull; -1000 for a margin, which can. */
  readonly min: number;
}): ReactElement {
  const { t } = useLingui();
  const sideNames = { top: t`Top`, right: t`Right`, bottom: t`Bottom`, left: t`Left` };
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className={smallLabelClassName}>{label}</legend>
      <div className="grid min-w-0 grid-cols-4 gap-1.5">
        {SIDES.map((side) => {
          const sideName = sideNames[side];
          return (
            <Input
              key={side}
              type="number"
              inputMode="numeric"
              min={min}
              max={1000}
              aria-label={t`${label}, ${sideName}`}
              title={sideName}
              placeholder={sideName}
              className="px-2"
              value={value?.[side] ?? ''}
              onChange={(event) => {
                const typed = event.target.valueAsNumber;
                const next: Record<string, number> = {};
                for (const each of SIDES) {
                  const kept = each === side ? undefined : value?.[each];
                  if (kept !== undefined) next[each] = kept;
                }
                if (Number.isFinite(typed)) next[side] = Math.min(1000, Math.max(min, typed));
                onChange(Object.keys(next).length === 0 ? undefined : next);
              }}
            />
          );
        })}
      </div>
    </fieldset>
  );
}

export interface Length {
  readonly value: number;
  readonly unit: 'px' | '%' | 'vw' | 'vh';
}
const UNITS = ['px', '%', 'vw', 'vh'] as const;

/** A length with its unit, or nothing. */
export function LengthBox({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: Length | undefined;
  readonly onChange: (value: Length | undefined) => void;
}): ReactElement {
  const { t } = useLingui();
  const unit = value?.unit ?? 'px';
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className={smallLabelClassName}>{label}</legend>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_88px] gap-1.5">
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          max={10000}
          aria-label={t`${label}, amount`}
          value={value?.value ?? ''}
          onChange={(event) => {
            const typed = event.target.valueAsNumber;
            onChange(
              Number.isFinite(typed)
                ? { value: Math.min(10_000, Math.max(0, typed)), unit }
                : undefined,
            );
          }}
        />
        <Select
          aria-label={t`${label}, unit`}
          value={unit}
          disabled={value === undefined}
          onValueChange={(next) => {
            const chosen = UNITS.find((each) => each === next);
            if (chosen !== undefined && value !== undefined) onChange({ ...value, unit: chosen });
          }}
        >
          {UNITS.map((each) => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </Select>
      </div>
    </fieldset>
  );
}

/** A group of fields that opens and shuts, so a long panel stays short. */
export function Group({
  title,
  open = false,
  children,
}: {
  readonly title: ReactNode;
  readonly open?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <details open={open} className="group min-w-0 border-t border-border">
      <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 px-3 text-sm font-medium text-foreground -outline-offset-2 select-none lg:min-h-9">
        {title}
      </summary>
      <div className="flex min-w-0 flex-col gap-3 px-3 pb-3">{children}</div>
    </details>
  );
}
