// The two controls that read how a lead arrived: the lead sources a trigger starts for, as
// the built-in names to tick with room for one of the business's own, and where an
// opportunity step takes its source from: how the lead arrived, text with merge fields, or
// none. Fetched with the record steps' own controls (automation-record-fields.tsx).
//
// Its words are in the builder's own catalog (lingui.config.ts, automation-words.ts).
import { Trans, useLingui } from '@lingui/react/macro';
import { MAX_TRIGGER_SOURCES, type AutomationSetup } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useMemo, useState, type ReactElement } from 'react';
import { dealSourceMode } from './automation-attribution-words';
import {
  customSources,
  leadSourceNames,
  sourcesOf,
  toggledSource,
} from './automation-lead-sources';
import {
  KeptAsWritten,
  MergeText,
  noteClassName,
  selectClassName,
} from './automation-record-controls';
import { sourceFields } from './automation-record-rules';

interface ControlProps {
  readonly id: string;
  readonly 'aria-invalid'?: boolean | undefined;
  readonly 'aria-describedby'?: string | undefined;
}

/** "Lead source is any of": the built-in names to tick, and any other the business uses. */
export function LeadSourcesSetting({
  label,
  value,
  onChange,
  ...control
}: ControlProps & {
  readonly label: string;
  readonly value: unknown;
  /** The sources chosen; nothing when none is, which starts the trigger for every lead. */
  readonly onChange: (next: string[] | undefined) => void;
}): ReactElement {
  const { t } = useLingui();
  const [other, setOther] = useState('');
  const otherId = `${control.id}-other`;
  const chosen = sourcesOf(value);
  const own = customSources(chosen);
  const has = (name: string): boolean =>
    chosen.some((each) => each.toLowerCase() === name.toLowerCase());
  const full = chosen.length >= MAX_TRIGGER_SOURCES;
  const typed = other.trim();
  const add = (): void => {
    if (typed === '' || full) return;
    onChange(toggledSource(chosen, typed, true));
    setOther('');
  };
  const box = (name: string, first: boolean, mine: boolean): ReactElement => {
    const checked = has(name);
    return (
      <label key={name} className="flex min-h-9 min-w-0 items-center gap-2.5 text-md">
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-primary"
          checked={checked}
          disabled={!checked && full}
          {...(first ? { 'data-field-control': true } : {})}
          onChange={() => {
            onChange(toggledSource(chosen, name, !checked));
          }}
        />
        <span className="min-w-0 wrap-anywhere">{mine ? t`${name} (your own)` : name}</span>
      </label>
    );
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        id={control.id}
        role="group"
        aria-label={label}
        aria-describedby={control['aria-describedby']}
        className="grid min-w-0 grid-cols-1 gap-x-4 sm:grid-cols-2"
      >
        {leadSourceNames.map((name, index) => box(name, index === 0, false))}
        {own.map((name) => box(name, false, true))}
      </div>
      <div className="flex min-w-0 items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={otherId} className="text-xs font-medium text-muted-foreground">
            <Trans>Another lead source</Trans>
          </label>
          <Input
            id={otherId}
            maxLength={200}
            value={other}
            disabled={full}
            placeholder={t`Such as a name you put in source=`}
            onChange={(event) => {
              setOther(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              add();
            }}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={typed === '' || full}
          onClick={add}
        >
          <Trans>Add</Trans>
        </Button>
      </div>
      {full ? (
        <p className={noteClassName}>
          <Trans>That is the most a trigger can list.</Trans>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Where an opportunity's source comes from. A Create opportunity step that names none takes
 * it from how the lead arrived, so the list shows that; an Update opportunity row is there
 * only when it sets something.
 */
export function DealSourceControl({
  label,
  value,
  setup,
  invalid = false,
  updating = false,
  onChange,
  ...control
}: Partial<ControlProps> & {
  readonly label: string;
  readonly value: unknown;
  readonly setup: AutomationSetup;
  readonly invalid?: boolean;
  /** An Update opportunity row: "none" removes the source the opportunity has. */
  readonly updating?: boolean;
  readonly onChange: (next: unknown) => void;
}): ReactElement {
  const { t } = useLingui();
  const fields = useMemo(() => sourceFields(setup, true), [setup]);
  const mode = dealSourceMode(value);
  // "Text I write" with nothing typed yet holds nothing: the box stays to be typed into.
  const [typing, setTyping] = useState(mode === 'text');
  if (mode === 'other') return <KeptAsWritten />;
  const shown = mode === 'none' ? 'none' : mode === 'text' || typing ? 'text' : 'arrival';
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <select
        id={control.id}
        aria-label={label}
        aria-describedby={control['aria-describedby']}
        className={selectClassName}
        {...(control.id === undefined ? {} : { 'data-field-control': true })}
        value={shown}
        onChange={(event) => {
          const next = event.target.value;
          setTyping(next === 'text');
          onChange(next === 'arrival' ? { from: 'arrival' } : next === 'none' ? null : '');
        }}
      >
        <option value="arrival">{t`From how they arrived (recommended)`}</option>
        <option value="text">{t`Text I write`}</option>
        <option value="none">{updating ? t`No source (remove it)` : t`No source`}</option>
      </select>
      {shown === 'text' ? (
        <MergeText
          label={t`${label}, the text`}
          value={typeof value === 'string' ? value : ''}
          fields={fields}
          maxLength={200}
          invalid={invalid}
          onChange={onChange}
        />
      ) : null}
    </div>
  );
}
