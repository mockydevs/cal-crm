// The settings that name other automations (automation-targets.ts), and the choice of what
// "Remove from automations" takes the contact out of. One automation is chosen from a box
// to type into; several from a list that ticks each, under a box that narrows it. Both show
// every other automation of
// the business with its status, read from the workflows list: until that answers, and if
// it doesn't, they are listed by name alone and can still be chosen. Fetched when a step
// that needs them is first opened, since the box to type into brings its own code.
import type { MessageDescriptor } from '@lingui/core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { listAutomations, MAX_REMOVE_AUTOMATIONS, type AutomationSetup } from '@repo/contracts';
import { Combobox } from '@repo/ui/components/combobox';
import { Input } from '@repo/ui/components/input';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { choiceDetails } from './automation-choice-details';
import type { ChoiceOption, FieldInput } from './automation-fields';
import type { ControlProps } from './automation-flow-fields';
import {
  atTheMost,
  chosenTargets,
  inactiveNote,
  statusWords,
  targetLabel,
  targetsOf,
} from './automation-targets';
import { useBusiness } from './workspace';

const noteClassName = 'text-sm text-muted-foreground';

export function AutomationTargets({
  many,
  value,
  automations,
  self,
  label,
  onChange,
  ...control
}: ControlProps & {
  /** Several automations, as a list of references, or one. */
  readonly many: boolean;
  /** What the setting is called: the name of the list that ticks several. */
  readonly label: string;
  readonly value: unknown;
  /** The business's automations, as the catalog's setup names them. */
  readonly automations: readonly { readonly id: string; readonly name: string }[];
  /** The automation being edited: it is not one of the others. */
  readonly self: string | undefined;
  /** One id, a list of them, or nothing once none is chosen. */
  readonly onChange: (next: string | string[] | undefined) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const [search, setSearch] = useState('');
  const listed = useQuery({
    // Under the list's own key, so publishing or pausing here reads the statuses again.
    queryKey: ['b', business.id, 'automations', 'targets'],
    queryFn: () => apiIn(business.id).request(listAutomations, { query: {} }),
    staleTime: 30_000,
  });
  const statuses = listed.data?.items;
  const targets = useMemo(() => {
    const named = (Array.isArray(value) ? (value as readonly unknown[]) : [value]).filter(
      (each) => typeof each === 'string',
    );
    return targetsOf(automations, statuses, self, named);
  }, [automations, statuses, self, value]);
  const { ids, unknown } = chosenTargets(targets, value);
  const invalid = control['aria-invalid'];
  const none =
    targets.length === 0 ? (
      <p className={noteClassName}>
        <Trans>This business has no other automations yet.</Trans>
      </p>
    ) : null;

  if (!many) {
    const [chosen] = ids;
    const [missing] = unknown;
    const note = inactiveNote(targets.find((each) => each.id === chosen));
    return (
      <>
        <Combobox
          id={control.id}
          // The box takes these two as the panel's other controls do: it is where the
          // keyboard starts, and where it returns when the setting has something to fix.
          ref={(box) => {
            box?.setAttribute('data-field-control', '');
            box?.setAttribute('aria-invalid', String(invalid));
          }}
          {...(control['aria-describedby'] === undefined
            ? {}
            : { 'aria-describedby': control['aria-describedby'] })}
          className={invalid ? 'border-destructive' : ''}
          options={[
            ...(missing === undefined
              ? []
              : [{ value: missing, label: t`${missing} (not found)` }]),
            ...targets.map((target) => {
              const status = statusWords(target.status);
              return {
                value: target.id,
                label: target.name,
                ...(status === undefined ? {} : { detail: status }),
              };
            }),
          ]}
          value={chosen ?? missing ?? null}
          onValueChange={(next) => {
            onChange(next ?? undefined);
          }}
          placeholder={t`Search automations`}
          empty={t`No automation matches.`}
          clearLabel={t`Clear the automation`}
        />
        {none}
        {note === undefined ? null : (
          <p role="status" className="text-sm font-medium text-attention-foreground">
            {note}
          </p>
        )}
      </>
    );
  }

  const all = [...ids, ...unknown];
  const full = atTheMost(all);
  const wanted = search.trim().toLowerCase();
  const rows = [
    ...unknown.map((each) => ({ value: each, name: t`${each} (not found)` })),
    ...targets.map((target) => ({ value: target.id, name: targetLabel(target) })),
  ];
  const shown = rows.filter((row) => row.name.toLowerCase().includes(wanted));
  const count = all.length;
  return (
    <div
      role="group"
      aria-label={label}
      aria-describedby={control['aria-describedby']}
      className={`flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card p-2 ${invalid ? 'border-destructive' : 'border-input'}`}
    >
      <Input
        id={control.id}
        type="search"
        autoComplete="off"
        data-field-control
        // A group can't be marked as wrong; the box the keyboard returns to is.
        aria-invalid={invalid}
        aria-label={t`Search automations`}
        placeholder={t`Search automations`}
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
        }}
      />
      <ul className="flex max-h-56 min-w-0 flex-col overflow-y-auto overscroll-contain">
        {shown.map((row) => {
          const ticked = all.includes(row.value);
          return (
            <li key={row.value}>
              <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2.5 rounded-control px-2 py-1.5 text-md hover:bg-muted has-disabled:cursor-not-allowed has-disabled:opacity-50 lg:min-h-9">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-primary"
                  checked={ticked}
                  disabled={full && !ticked}
                  onChange={() => {
                    // Kept in the order they were ticked.
                    const next = ticked
                      ? all.filter((each) => each !== row.value)
                      : [...all, row.value];
                    onChange(next.length === 0 ? undefined : next);
                  }}
                />
                <span className="min-w-0 wrap-anywhere">{row.name}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {none}
      {rows.length > 0 && shown.length === 0 ? (
        <p className={noteClassName}>
          <Trans>No automation matches.</Trans>
        </p>
      ) : null}
      <p role="status" className={noteClassName}>
        {full ? (
          <Trans>
            You have chosen {MAX_REMOVE_AUTOMATIONS}, the most one setting can list. Take one off to
            choose another.
          </Trans>
        ) : (
          <Plural value={count} _0="None chosen." one="# chosen." other="# chosen." />
        )}
      </p>
    </div>
  );
}

/**
 * A choice among a few, each with a sentence that says what it does, so every choice and
 * its sentence is read before one is taken: radio buttons for one, or boxes to tick for
 * several, where none ticked leaves the setting out.
 */
export function ChoiceRadios({
  label,
  options,
  details = {},
  value,
  several = false,
  onChange,
  ...control
}: ControlProps & {
  /** What the choice is of: the group's name. */
  readonly label: string;
  readonly options: readonly ChoiceOption[];
  /** What each choice does, in a sentence, by its value. */
  readonly details?: Readonly<Record<string, MessageDescriptor>> | undefined;
  readonly value: unknown;
  /** Any number of them, as a list in the options' own order. */
  readonly several?: boolean;
  readonly onChange: (next: string | string[] | undefined) => void;
}): ReactElement {
  const { i18n } = useLingui();
  const taken = (Array.isArray(value) ? (value as readonly unknown[]) : [value]).filter((each) =>
    options.some((option) => option.value === each),
  );
  return (
    <div
      role={several ? 'group' : 'radiogroup'}
      aria-label={label}
      // A set of radio buttons can be marked as wrong; a plain group can't.
      {...(several ? {} : { 'aria-invalid': control['aria-invalid'] })}
      aria-describedby={control['aria-describedby']}
      className="flex min-w-0 flex-col gap-1.5"
    >
      {options.map((option, index) => {
        const detailId = `${control.id}-${option.value}`;
        const detail = details[option.value];
        const checked = taken.includes(option.value);
        return (
          <label
            key={option.value}
            className="flex min-h-11 min-w-0 cursor-pointer items-start gap-2.5 rounded-xl border border-input bg-card px-3 py-2.5 has-checked:border-primary has-checked:bg-accent"
          >
            <input
              type={several ? 'checkbox' : 'radio'}
              name={control.id}
              value={option.value}
              checked={checked}
              className="mt-0.5 size-4 shrink-0 accent-primary"
              aria-describedby={detail === undefined ? undefined : detailId}
              // The keyboard starts on the choice that is taken, as arrow keys expect; on
              // the first where there is none, or where several can be.
              {...((several ? index === 0 : checked || (taken.length === 0 && index === 0))
                ? { 'data-field-control': true }
                : {})}
              onChange={() => {
                if (!several) {
                  onChange(option.value);
                  return;
                }
                const next = options
                  .map((each) => each.value)
                  .filter((each) => (each === option.value ? !checked : taken.includes(each)));
                onChange(next.length === 0 ? undefined : next);
              }}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">{i18n._(option.label)}</span>
              {detail === undefined ? null : (
                <span id={detailId} className="text-sm text-muted-foreground">
                  {i18n._(detail)}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export interface StepChoice {
  readonly id: string;
  /** What its card says. */
  readonly name: string;
}

export function StepPicker({
  value,
  steps,
  onChange,
  ...control
}: ControlProps & {
  readonly value: unknown;
  /** The automation's other actions, in the order a contact meets them. */
  readonly steps: readonly StepChoice[];
  readonly onChange: (next: string | undefined) => void;
}): ReactElement {
  const { t } = useLingui();
  const invalid = control['aria-invalid'];
  const given = typeof value === 'string' && value !== '' ? value : undefined;
  const missing = given !== undefined && !steps.some((step) => step.id === given);
  return (
    <>
      <Combobox
        id={control.id}
        // As the panel's other controls: where the keyboard starts, and returns to fix.
        ref={(box) => {
          box?.setAttribute('data-field-control', '');
          box?.setAttribute('aria-invalid', String(invalid));
        }}
        {...(control['aria-describedby'] === undefined
          ? {}
          : { 'aria-describedby': control['aria-describedby'] })}
        className={invalid ? 'border-destructive' : ''}
        options={[
          ...(missing ? [{ value: given, label: t`${given} (not found)` }] : []),
          ...steps.map((step) => ({ value: step.id, label: step.name, keywords: [step.id] })),
        ]}
        matches={(option, typed) => {
          const wanted = typed.trim().toLowerCase();
          return [option.label, ...(option.keywords ?? [])].some((words) =>
            words.toLowerCase().includes(wanted),
          );
        }}
        value={given ?? null}
        onValueChange={(next) => {
          onChange(next ?? undefined);
        }}
        placeholder={t`Search actions`}
        empty={t`No action matches.`}
        clearLabel={t`Clear the action`}
      />
      {steps.length === 0 ? (
        <p className={noteClassName}>
          <Trans>This workflow has no other action to go to yet.</Trans>
        </p>
      ) : null}
    </>
  );
}

/**
 * The control a setting has, by what the setting is. The step's panel fetches this one
 * component, so it waits for this code once: a choice that reveals another of these
 * controls shows it at once, without the panel going away while its code is asked for.
 */
export default function TargetSetting({
  input,
  name,
  label,
  value,
  setup,
  self,
  steps,
  onChange,
  ...control
}: ControlProps & {
  readonly input: FieldInput;
  /** The setting's key in the step's or the trigger's settings. */
  readonly name: string;
  /** What the setting is called. */
  readonly label: string;
  readonly value: unknown;
  readonly setup: AutomationSetup;
  /** The automation being edited. */
  readonly self: string | undefined;
  /** The automation's other actions, for a setting that names one. */
  readonly steps: readonly StepChoice[];
  readonly onChange: (next: unknown) => void;
}): ReactElement | null {
  if (input.kind === 'automations')
    return (
      <AutomationTargets
        {...control}
        many={input.many}
        label={label}
        value={value}
        automations={setup.automations}
        self={input.own === true ? undefined : self}
        onChange={onChange}
      />
    );
  if (input.kind === 'choice' || input.kind === 'choices')
    return (
      <ChoiceRadios
        {...control}
        several={input.kind === 'choices'}
        label={label}
        options={input.options}
        details={Object.hasOwn(choiceDetails, name) ? choiceDetails[name] : undefined}
        value={value}
        onChange={onChange}
      />
    );
  return input.kind === 'step' ? (
    <StepPicker {...control} value={value} steps={steps} onChange={onChange} />
  ) : null;
}
