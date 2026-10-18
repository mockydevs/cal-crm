// The settings of the flow-control steps: an If / else's own branches, tried in the order
// shown, with the None branch always last; the action a Go To jumps to, chosen by what its
// card says; and the events that meet a goal, each with the filters its trigger has. Part
// of the chunk the step panel fetches for the settings that need more than a box
// (automation-target-fields.tsx).
import { Trans, useLingui } from '@lingui/react/macro';
import {
  automationGoalEvents,
  MAX_CONDITION_BRANCHES,
  MAX_GOAL_EVENTS,
  type AutomationSetup,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';
import {
  currentReference,
  referenceOptions,
  type FieldInput,
  type FieldSpec,
} from './automation-fields';
import { FilterEditor } from './automation-filter-editor';
import { conditionOf, filterFields, rowProblems, rowsOf } from './automation-filters';
import {
  branchesOf,
  canAddBranch,
  canAddGoalEvent,
  goalEventFields,
  goalEventsOf,
  movedBranch,
  namedFrom,
  nextGoalEvent,
  withBranch,
  withGoalFilter,
  writtenBranches,
  type Branch,
  type GoalEvent,
} from './automation-flow-rules';
import { triggerLabel } from './automation-summary';

type Config = Readonly<Record<string, unknown>>;

/** What the step's panel gives every control of a setting. */
export interface ControlProps {
  readonly id: string;
  readonly 'aria-invalid': boolean;
  readonly 'aria-describedby'?: string;
  readonly 'data-field-control': true;
}

const noteClassName = 'text-sm text-muted-foreground';
const cardClassName = 'flex min-w-0 flex-col gap-2.5 rounded-xl border border-input bg-card p-3';
const iconButtonClassName = 'px-2.5';

export function BranchesEditor({
  config,
  setup,
  onSet,
  ...control
}: ControlProps & {
  /** The step's settings: its branches, or the one condition it has in their place. */
  readonly config: Config;
  readonly setup: AutomationSetup;
  /** Sets one member of the step's settings; nothing takes it away. */
  readonly onSet: (key: string, value: unknown) => void;
}): ReactElement {
  const { t } = useLingui();
  const invalid = control['aria-invalid'];
  if (config['branches'] === undefined)
    return (
      <div className="flex min-w-0 flex-col items-start gap-2">
        <p className={noteClassName}>
          <Trans>
            This If / else has two: yes, when the conditions above hold, and no. It can have
            branches you name instead, tried in order, with a None branch for when none holds. The
            yes path becomes the first branch and the no path becomes None.
          </Trans>
        </p>
        <Button
          type="button"
          variant="secondary"
          size="small"
          onClick={() => {
            onSet('branches', writtenBranches(namedFrom(config['if'])));
            onSet('if', undefined);
          }}
        >
          <Trans>Use branches I name</Trans>
        </Button>
      </div>
    );

  const branches = branchesOf(config);
  const change = (next: readonly Branch[]): void => {
    onSet('branches', writtenBranches(next));
  };
  const fields = filterFields(setup);
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <p className={noteClassName}>
        <Trans>
          Branches are tried from the top. The contact takes the first whose conditions all hold.
        </Trans>
      </p>
      <ol className="flex min-w-0 list-none flex-col gap-2.5">
        {branches.map((branch, index) => {
          const number = index + 1;
          const title = branch.label ?? branch.name;
          const rows = rowsOf(branch.if);
          return (
            <li key={branch.name}>
              <div
                role="group"
                aria-label={t`Branch ${number}: ${title}`}
                className={cardClassName}
              >
                <div className="flex min-w-0 flex-wrap items-end gap-2">
                  <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-sm font-medium">
                    <Trans>Name of branch {number}</Trans>
                    <Input
                      maxLength={80}
                      value={branch.label ?? ''}
                      placeholder={branch.name}
                      {...(index === 0
                        ? { ...control, 'aria-invalid': invalid }
                        : { 'aria-invalid': false })}
                      onChange={(event) => {
                        change(
                          branches.map((each) =>
                            each.name === branch.name
                              ? { ...each, label: event.target.value }
                              : each,
                          ),
                        );
                      }}
                    />
                  </label>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      className={iconButtonClassName}
                      aria-label={t`Move branch ${number} up: ${title}`}
                      disabled={index === 0}
                      onClick={() => {
                        change(movedBranch(branches, index, -1));
                      }}
                    >
                      <ArrowUp aria-hidden className="size-4" strokeWidth={1.8} />
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      className={iconButtonClassName}
                      aria-label={t`Move branch ${number} down: ${title}`}
                      disabled={index === branches.length - 1}
                      onClick={() => {
                        change(movedBranch(branches, index, 1));
                      }}
                    >
                      <ArrowDown aria-hidden className="size-4" strokeWidth={1.8} />
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      className={iconButtonClassName}
                      aria-label={t`Delete branch ${number}: ${title}`}
                      disabled={branches.length === 1}
                      onClick={() => {
                        change(branches.filter((each) => each.name !== branch.name));
                      }}
                    >
                      <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                    </Button>
                  </div>
                </div>
                {rows === undefined ? (
                  <p className={noteClassName}>
                    <Trans>This branch's conditions are edited in the JSON view.</Trans>
                  </p>
                ) : (
                  <FilterEditor
                    rows={rows}
                    setup={setup}
                    problems={invalid ? rowProblems(rows, fields, setup) : []}
                    noun="condition"
                    onChange={(next) => {
                      change(
                        branches.map((each) =>
                          each.name === branch.name ? { ...each, if: conditionOf(next) } : each,
                        ),
                      );
                    }}
                  />
                )}
                {invalid && rows?.length === 0 ? (
                  <p className="text-sm font-medium text-destructive">
                    <Trans>Add at least one condition.</Trans>
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
        <li>
          <div
            role="group"
            aria-label={t`Branch None`}
            className={`${cardClassName} border-dashed`}
          >
            <span className="text-sm font-medium">
              <Trans>None</Trans>
            </span>
            <p className={noteClassName}>
              <Trans>
                Taken when none of the branches above holds. It has no conditions and can't be
                removed.
              </Trans>
            </p>
          </div>
        </li>
      </ol>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={!canAddBranch(branches)}
          onClick={() => {
            change(withBranch(branches));
          }}
        >
          <Trans>Add branch</Trans>
        </Button>
        {canAddBranch(branches) ? null : (
          <span role="status" className={noteClassName}>
            <Trans>{MAX_CONDITION_BRANCHES} branches is the most an If / else can have.</Trans>
          </span>
        )}
      </div>
    </div>
  );
}

function GoalFilter({
  field,
  event,
  number,
  setup,
  invalid,
  onChange,
}: {
  readonly field: FieldSpec;
  readonly event: GoalEvent;
  readonly number: number;
  readonly setup: AutomationSetup;
  readonly invalid: boolean;
  readonly onChange: (value: unknown) => void;
}): ReactElement | null {
  const { t, i18n } = useLingui();
  const label = i18n._(field.label);
  const name = t`${label} of event ${number}`;
  const value = event.config[field.key];
  const { input } = field;
  const empty = value === undefined || value === '';
  const wrong = invalid && field.required && empty;
  const said = wrong ? (
    <span className="text-sm font-medium text-destructive">
      <Trans>Fill this in.</Trans>
    </span>
  ) : null;
  if (input.kind === 'text')
    return (
      <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
        {label}
        <Input
          aria-label={name}
          aria-invalid={wrong}
          placeholder={input.placeholder}
          value={typeof value === 'string' ? value : ''}
          onChange={(change) => {
            onChange(change.target.value);
          }}
        />
        {said}
      </label>
    );
  if (input.kind !== 'reference' && input.kind !== 'choice') return null;
  const options =
    input.kind === 'choice'
      ? input.options.map((option) => ({ value: option.value, label: i18n._(option.label) }))
      : referenceOptions(input.list, setup, event.config);
  const given = typeof value === 'string' ? value : undefined;
  const current = input.kind === 'choice' ? given : currentReference(options, given);
  const unknown = given !== undefined && given !== '' && current === undefined;
  const blank =
    field.unset === undefined ? (field.required ? t`Choose one` : t`Any`) : i18n._(field.unset);
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm font-medium">
      <span aria-hidden>{label}</span>
      <Select
        aria-label={name}
        aria-invalid={wrong}
        value={unknown ? given : (current ?? '')}
        onValueChange={onChange}
      >
        <option value="">{blank}</option>
        {unknown ? <option value={given}>{t`${given} (not found)`}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      {said}
    </div>
  );
}

export function GoalEvents({
  value,
  setup,
  onChange,
  ...control
}: ControlProps & {
  readonly value: unknown;
  readonly setup: AutomationSetup;
  readonly onChange: (next: readonly Record<string, unknown>[]) => void;
}): ReactElement {
  const { t } = useLingui();
  const invalid = control['aria-invalid'];
  const events = goalEventsOf(value);
  const change = (next: readonly GoalEvent[]): void => {
    onChange(next.map((each) => ({ type: each.type, config: { ...each.config } })));
  };
  const known: readonly string[] = automationGoalEvents;
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <ol className="flex min-w-0 list-none flex-col gap-2.5">
        {events.map((event, index) => {
          const number = index + 1;
          const written = event.type;
          const replace = (next: GoalEvent): void => {
            change(events.map((each, place) => (place === index ? next : each)));
          };
          return (
            // Rows are told apart by their place: two can ask for the same event.
            <li key={number}>
              <div role="group" aria-label={t`Event ${number}`} className={cardClassName}>
                <div className="flex min-w-0 items-end gap-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium">
                    <span aria-hidden>
                      <Trans>Event {number}</Trans>
                    </span>
                    <Select
                      aria-label={t`What happens, event ${number}`}
                      {...(index === 0
                        ? { ...control, 'aria-invalid': invalid }
                        : { 'aria-invalid': false })}
                      value={event.type}
                      onValueChange={(type) => {
                        replace({ type, config: {} });
                      }}
                    >
                      {known.includes(event.type) ? null : (
                        <option value={written}>{t`${written} (not found)`}</option>
                      )}
                      {automationGoalEvents.map((type) => (
                        <option key={type} value={type}>
                          {triggerLabel(type) ?? type}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    className={iconButtonClassName}
                    aria-label={t`Remove event ${number}`}
                    disabled={events.length === 1}
                    onClick={() => {
                      change(events.filter((_, place) => place !== index));
                    }}
                  >
                    <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                  </Button>
                </div>
                {goalEventFields(event.type).map((field) => (
                  <GoalFilter
                    key={field.key}
                    field={field}
                    event={event}
                    number={number}
                    setup={setup}
                    invalid={invalid}
                    onChange={(next) => {
                      replace(withGoalFilter(event, field.key, next));
                    }}
                  />
                ))}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={!canAddGoalEvent(events)}
          onClick={() => {
            change([...events, nextGoalEvent(events)]);
          }}
        >
          <Trans>Add event</Trans>
        </Button>
        {canAddGoalEvent(events) ? null : (
          <span role="status" className={noteClassName}>
            <Trans>{MAX_GOAL_EVENTS} events is the most a goal can list.</Trans>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The control an If / else's branches and a goal's events have: the one component the
 * step's panel fetches for them, with the row editor they need.
 */
export default function FlowSetting({
  input,
  value,
  config,
  setup,
  onChange,
  onSet,
  ...control
}: ControlProps & {
  readonly input: FieldInput;
  readonly value: unknown;
  /** The settings of the step the setting is one of. */
  readonly config: Config;
  readonly setup: AutomationSetup;
  readonly onChange: (next: unknown) => void;
  /** Sets another member of the same settings, for a control that holds more than its own. */
  readonly onSet: (key: string, value: unknown) => void;
}): ReactElement | null {
  if (input.kind === 'branches')
    return <BranchesEditor {...control} config={config} setup={setup} onSet={onSet} />;
  return input.kind === 'goal_events' ? (
    <GoalEvents {...control} value={value} setup={setup} onChange={onChange} />
  ) : null;
}
