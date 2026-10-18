// The settings of three record steps, as controls instead of JSON (rules:
// automation-record-rules.ts). Assign owner: the team members who take the contacts, one or
// several in turn, and whether a contact that has an owner keeps them. Find opportunity:
// filter rows, each added once. Update opportunity: a row for each thing to change. One
// component for all three, so the step's panel fetches this code once; it brings no popup
// code of its own, only the browser's lists.
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { MAX_ASSIGN_USERS, MAX_CONTACT_FOLLOWERS, type AutomationSetup } from '@repo/contracts';
import { Input } from '@repo/ui/components/input';
import { X } from 'lucide-react';
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import {
  currentReference,
  DEAL_CHANGE_KEYS,
  DEAL_FILTER_KEYS,
  durationOf,
  durationParts,
  referenceOptions,
  type FieldInput,
} from './automation-fields';
import type { ControlProps } from './automation-flow-fields';
import {
  AddSelect,
  FieldSelect,
  KeptAsWritten,
  MergeText,
  noteClassName,
  RemoveButton,
  rowClassName,
  RowProblem,
  selectClassName,
  TypedValue,
} from './automation-record-controls';
import {
  addableFilters,
  choiceAt,
  dealChangeKinds,
  dealChangeMembers,
  dealChangesOf,
  dealCustomFields,
  dealFieldsOf,
  dealFiltersOf,
  isNumeric,
  membersOf,
  membersWritten,
  sourceFields,
  starterChange,
  starterFilter,
  starterValue,
  today,
  type DealChangeKind,
  type DealFilterKind,
} from './automation-record-rules';
import { DealSourceControl, LeadSourcesSetting } from './automation-source-fields';
import { Switch } from './automation-switch';

type Config = Readonly<Record<string, unknown>>;
type Problems = Readonly<Record<string, string>>;

interface SettingProps extends ControlProps {
  /** The settings of the step the control is part of. */
  readonly config: Config;
  readonly setup: AutomationSetup;
  /** What the checks found wrong, by the member of the settings each is about. */
  readonly problems: Problems;
  /** Sets one member of the step's settings; nothing takes it away. */
  readonly onSet: (key: string, value: unknown) => void;
}

/** What is wrong with a member of the settings, or with something inside it. */
const problemOf = (problems: Problems, key: string): string | undefined =>
  problems[key] ?? Object.entries(problems).find(([place]) => place.startsWith(`${key}/`))?.[1];

/** A row: what it is about, how it compares or is set, its control, and the way to remove it. */
function Row({
  name,
  verb,
  children,
  problem,
  removeLabel,
  onRemove,
}: {
  readonly name: ReactNode;
  readonly verb?: ReactNode;
  readonly children?: ReactNode;
  readonly problem: string | undefined;
  readonly removeLabel: string;
  readonly onRemove: () => void;
}): ReactElement {
  return (
    <li className={rowClassName}>
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm">
            <span className="font-medium text-foreground">{name}</span>
            {verb === undefined ? null : <span className="text-muted-foreground">{verb}</span>}
          </span>
          {children}
        </div>
        <RemoveButton label={removeLabel} onClick={onRemove} />
      </div>
      <RowProblem>{problem}</RowProblem>
    </li>
  );
}

/**
 * Team members to choose from a list that can be searched, kept in the order they were
 * ticked. Owner and follower steps both choose people with it.
 */
function TeamPicker({
  chosen,
  setup,
  max,
  numbered,
  status,
  onChoose,
  ...control
}: ControlProps & {
  readonly chosen: readonly string[];
  readonly setup: AutomationSetup;
  /** The most that can be chosen. */
  readonly max: number;
  /** Whether the order counts, as the turns of an owner step do. */
  readonly numbered: boolean;
  /** What the choice comes to, said under the list. */
  readonly status: ReactNode;
  readonly onChoose: (next: readonly string[]) => void;
}): ReactElement {
  const { t } = useLingui();
  const [search, setSearch] = useState('');
  const full = chosen.length >= max;
  const nameOf = (id: string): string =>
    setup.users.find((user) => user.id === id)?.name ?? t`${id} (not found)`;
  const wanted = search.trim().toLowerCase();
  const shown = setup.users.filter((user) => user.name.toLowerCase().includes(wanted));
  const invalid = control['aria-invalid'];
  return (
    <div
      role="group"
      aria-label={t`Team members`}
      aria-describedby={control['aria-describedby']}
      className={`flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card p-2 ${invalid ? 'border-destructive' : 'border-input'}`}
    >
      {chosen.length === 0 ? null : (
        <ul aria-label={t`Chosen team members`} className="flex min-w-0 flex-wrap gap-1.5">
          {chosen.map((id, index) => {
            const name = nameOf(id);
            const turn = index + 1;
            return (
              <li
                key={id}
                className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-secondary py-0.5 pr-0.5 pl-2.5 text-sm text-secondary-foreground"
              >
                <span className="min-w-0 truncate">
                  {numbered && chosen.length > 1 ? `${String(turn)}. ${name}` : name}
                </span>
                <button
                  type="button"
                  aria-label={t`Remove ${name}`}
                  className="flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-muted lg:size-6"
                  onClick={() => {
                    onChoose(chosen.filter((each) => each !== id));
                  }}
                >
                  <X aria-hidden className="size-3.5" strokeWidth={2} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Input
        id={control.id}
        type="search"
        autoComplete="off"
        data-field-control
        // A group can't be marked as wrong; the box the keyboard returns to is.
        aria-invalid={invalid}
        aria-label={t`Search team members`}
        placeholder={t`Search team members`}
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
        }}
      />
      <ul className="flex max-h-56 min-w-0 flex-col overflow-y-auto overscroll-contain">
        {shown.map((user) => {
          const ticked = chosen.includes(user.id);
          return (
            <li key={user.id}>
              <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2.5 rounded-control px-2 py-1.5 text-md hover:bg-muted has-disabled:cursor-not-allowed has-disabled:opacity-50 lg:min-h-9">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-primary"
                  checked={ticked}
                  disabled={full && !ticked}
                  onChange={() => {
                    // Kept in the order they were ticked: the order they take turns in.
                    onChoose(
                      ticked ? chosen.filter((each) => each !== user.id) : [...chosen, user.id],
                    );
                  }}
                />
                <span className="min-w-0 wrap-anywhere">{user.name}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {setup.users.length === 0 ? (
        <p className={noteClassName}>
          <Trans>This business has no team members yet.</Trans>
        </p>
      ) : shown.length === 0 ? (
        <p className={noteClassName}>
          <Trans>No team member matches.</Trans>
        </p>
      ) : null}
      <p role="status" className={noteClassName}>
        {status}
      </p>
    </div>
  );
}

export function MembersSetting({
  config,
  setup,
  problems,
  onSet,
  ...control
}: SettingProps): ReactElement {
  const { t } = useLingui();
  const { ids, unknown } = membersOf(config, setup.users);
  const all = [...ids, ...unknown];
  const count = all.length;
  const choose = (next: readonly string[]): void => {
    const written = membersWritten(next);
    onSet('user', written.user);
    onSet('users', written.users);
  };
  const problem = problemOf(problems, 'user') ?? problemOf(problems, 'users');
  const only = config['onlyIfUnassigned'] === true;
  const onlyId = `${control.id}-only`;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <TeamPicker
        {...control}
        chosen={all}
        setup={setup}
        max={MAX_ASSIGN_USERS}
        numbered
        onChoose={choose}
        status={
          count >= MAX_ASSIGN_USERS ? (
            <Trans>
              You have chosen {MAX_ASSIGN_USERS}, the most one action can share contacts between.
            </Trans>
          ) : (
            <Plural
              value={count}
              _0="Nobody chosen yet."
              one="# chosen: every contact goes to them."
              other="# chosen: each contact goes to the next of them in turn."
            />
          )
        }
      />
      <RowProblem>{problem}</RowProblem>
      <div className="flex min-w-0 items-start gap-3">
        <Switch
          id={onlyId}
          aria-label={t`Only apply to unassigned contacts`}
          aria-describedby={`${onlyId}-hint`}
          checked={only}
          onChange={(on) => {
            onSet('onlyIfUnassigned', on ? true : undefined);
          }}
        />
        <span className="flex min-w-0 flex-col gap-0.5 pt-2.5 lg:pt-2">
          <span aria-hidden className="text-sm font-medium">
            <Trans>Only apply to unassigned contacts</Trans>
          </span>
          <span id={`${onlyId}-hint`} className={noteClassName}>
            {only ? (
              <Trans>A contact that already has an owner keeps them.</Trans>
            ) : (
              <Trans>A contact that already has an owner gets the new one.</Trans>
            )}
          </span>
        </span>
      </div>
      <RowProblem>{problemOf(problems, 'onlyIfUnassigned')}</RowProblem>
    </div>
  );
}

/**
 * Who an Add or Remove Contact Followers step names: team members, kept as `users`. A
 * removal can instead take every follower off (`all`), as GoHighLevel's toggle does.
 */
export function FollowersSetting({
  config,
  setup,
  problems,
  onSet,
  removal,
  ...control
}: SettingProps & { readonly removal: boolean }): ReactElement {
  const { t } = useLingui();
  const given: readonly unknown[] = Array.isArray(config['users'])
    ? (config['users'] as readonly unknown[])
    : [];
  const { ids, unknown } = membersOf({ users: given }, setup.users);
  const chosen = [...ids, ...unknown];
  const everyone = removal && config['all'] === true;
  const allId = `${control.id}-all`;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {removal ? (
        <div className="flex min-w-0 items-start gap-3">
          <Switch
            id={allId}
            aria-label={t`Remove all followers`}
            aria-describedby={`${allId}-hint`}
            checked={everyone}
            onChange={(on) => {
              onSet('all', on ? true : undefined);
              if (on) onSet('users', undefined);
            }}
          />
          <span className="flex min-w-0 flex-col gap-0.5 pt-2.5 lg:pt-2">
            <span aria-hidden className="text-sm font-medium">
              <Trans>Remove all followers</Trans>
            </span>
            <span id={`${allId}-hint`} className={noteClassName}>
              {everyone ? (
                <Trans>Every follower of the contact is removed.</Trans>
              ) : (
                <Trans>Only the team members chosen below are removed.</Trans>
              )}
            </span>
          </span>
        </div>
      ) : null}
      {everyone ? null : (
        <TeamPicker
          {...control}
          chosen={chosen}
          setup={setup}
          max={MAX_CONTACT_FOLLOWERS}
          numbered={false}
          onChoose={(next) => {
            onSet('users', next.length === 0 ? undefined : [...next]);
          }}
          status={
            chosen.length >= MAX_CONTACT_FOLLOWERS ? (
              <Trans>You have chosen {MAX_CONTACT_FOLLOWERS}, the most a contact can have.</Trans>
            ) : (
              <Plural value={chosen.length} _0="Nobody chosen yet." other="# chosen." />
            )
          }
        />
      )}
      <RowProblem>{problemOf(problems, 'users') ?? problemOf(problems, 'all')}</RowProblem>
    </div>
  );
}

/** Problems about members that no row is showing, so nothing found is left unsaid. */
function Unshown({
  problems,
  members,
  shown,
}: {
  readonly problems: Problems;
  readonly members: readonly string[];
  readonly shown: readonly string[];
}): ReactElement | null {
  const said = members.flatMap((member) => {
    const problem = shown.includes(member) ? undefined : problemOf(problems, member);
    return problem === undefined ? [] : [problem];
  });
  return said.length === 0 ? null : <RowProblem>{[...new Set(said)].join(' ')}</RowProblem>;
}

export function DealFilters({
  config,
  setup,
  problems,
  onSet,
  ...control
}: SettingProps): ReactElement {
  const { t } = useLingui();
  // A filter whose text is still to be typed holds nothing yet: it is shown all the same.
  const [added, setAdded] = useState<readonly DealFilterKind[]>([]);
  const present = dealFiltersOf(config);
  const shown = DEAL_FILTER_KEYS.filter((kind) => present.includes(kind) || added.includes(kind));
  const customFields = useMemo(() => dealCustomFields(setup), [setup]);
  const names: Readonly<Record<DealFilterKind, string>> = {
    pipeline: t`Pipeline`,
    stage: t`Pipeline stage`,
    status: t`Status`,
    nameContains: t`Opportunity name`,
    value: t`Opportunity value`,
    customField: t`Custom field`,
  };
  const remove = (kind: DealFilterKind): void => {
    setAdded((current) => current.filter((each) => each !== kind));
    onSet(kind, undefined);
  };
  const reference = (kind: 'pipeline' | 'stage'): ReactElement => {
    const options = referenceOptions(kind === 'pipeline' ? 'pipelines' : 'stages', setup, config);
    const given = typeof config[kind] === 'string' ? config[kind] : '';
    const current = currentReference(options, given);
    return (
      <select
        aria-label={kind === 'pipeline' ? t`Pipeline is` : t`Pipeline stage is`}
        aria-invalid={problemOf(problems, kind) !== undefined}
        className={selectClassName}
        value={current ?? given}
        onChange={(event) => {
          onSet(kind, event.target.value);
        }}
      >
        {current === undefined ? (
          <option value={given}>{given === '' ? t`Choose one` : t`${given} (not found)`}</option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  };
  const value = config['value'];
  const amount =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Config)
      : undefined;
  const customField = config['customField'];
  const custom =
    typeof customField === 'object' && customField !== null && !Array.isArray(customField)
      ? (customField as Config)
      : undefined;
  const customPath = typeof custom?.['field'] === 'string' ? custom['field'] : '';
  const customChoice = choiceAt(customFields, customPath, setup);
  const equals = custom?.['equals'];

  return (
    <div className="flex min-w-0 flex-col gap-2.5" aria-describedby={control['aria-describedby']}>
      {shown.length === 0 ? (
        <p className={noteClassName}>
          <Trans>No filter: any of the contact's opportunities can be found.</Trans>
        </p>
      ) : (
        <ul aria-label={t`Filters`} className="flex min-w-0 flex-col gap-2.5">
          {shown.map((kind) => {
            const name = names[kind];
            return (
              <Row
                key={kind}
                name={name}
                verb={
                  kind === 'nameContains' ? (
                    <Trans>contains</Trans>
                  ) : kind === 'value' ? undefined : kind === 'customField' ? (
                    <Trans>equals</Trans>
                  ) : (
                    <Trans>is</Trans>
                  )
                }
                problem={problemOf(problems, kind)}
                removeLabel={t`Remove the filter: ${name}`}
                onRemove={() => {
                  remove(kind);
                }}
              >
                {kind === 'pipeline' || kind === 'stage' ? reference(kind) : null}
                {kind === 'status' ? (
                  <select
                    aria-label={t`Status is`}
                    className={selectClassName}
                    value={typeof config['status'] === 'string' ? config['status'] : 'any'}
                    onChange={(event) => {
                      onSet('status', event.target.value);
                    }}
                  >
                    <option value="open">{t`Open`}</option>
                    <option value="won">{t`Won`}</option>
                    <option value="lost">{t`Lost`}</option>
                    <option value="any">{t`Any`}</option>
                  </select>
                ) : null}
                {kind === 'nameContains' ? (
                  <Input
                    aria-label={t`Opportunity name contains`}
                    aria-invalid={problemOf(problems, kind) !== undefined}
                    maxLength={200}
                    value={typeof config['nameContains'] === 'string' ? config['nameContains'] : ''}
                    onChange={(event) => {
                      onSet('nameContains', event.target.value);
                    }}
                  />
                ) : null}
                {kind === 'value' ? (
                  amount === undefined ? (
                    <KeptAsWritten />
                  ) : (
                    <div className="grid min-w-0 grid-cols-2 gap-2">
                      <select
                        aria-label={t`Opportunity value comparison`}
                        className={selectClassName}
                        value={
                          typeof amount['operator'] === 'string' ? amount['operator'] : 'equals'
                        }
                        onChange={(event) => {
                          onSet('value', { ...amount, operator: event.target.value });
                        }}
                      >
                        <option value="equals">{t`Equals`}</option>
                        <option value="greater_than">{t`Greater than`}</option>
                        <option value="less_than">{t`Less than`}</option>
                      </select>
                      <Input
                        aria-label={t`Opportunity value to compare with`}
                        aria-invalid={problemOf(problems, kind) !== undefined}
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="any"
                        value={typeof amount['value'] === 'number' ? amount['value'] : ''}
                        onChange={(event) => {
                          const typed = event.target.valueAsNumber;
                          const { value: _old, ...rest } = amount;
                          onSet('value', Number.isNaN(typed) ? rest : { ...rest, value: typed });
                        }}
                      />
                    </div>
                  )
                ) : null}
                {kind === 'customField' ? (
                  custom === undefined ? (
                    <KeptAsWritten />
                  ) : (
                    <div className="grid min-w-0 grid-cols-2 gap-2">
                      <FieldSelect
                        label={t`Custom field to compare`}
                        value={customChoice?.path ?? customPath}
                        fields={customFields}
                        blank={customPath === '' ? t`Choose a field` : undefined}
                        invalid={problemOf(problems, kind) !== undefined}
                        onChange={(path) => {
                          onSet('customField', {
                            field: path,
                            equals: starterValue(customFields.find((each) => each.path === path)),
                          });
                        }}
                      />
                      <TypedValue
                        label={t`Custom field equals`}
                        field={customChoice}
                        value={
                          typeof equals === 'string' ||
                          typeof equals === 'number' ||
                          typeof equals === 'boolean'
                            ? equals
                            : ''
                        }
                        onChange={(typed) => {
                          onSet('customField', { ...custom, equals: typed });
                        }}
                      />
                    </div>
                  )
                ) : null}
              </Row>
            );
          })}
        </ul>
      )}
      <Unshown problems={problems} members={DEAL_FILTER_KEYS} shown={shown} />
      <AddSelect
        control
        label={t`Add filter`}
        choices={addableFilters(shown, setup).map((kind) => ({ value: kind, label: names[kind] }))}
        onAdd={(chosen) => {
          const kind = DEAL_FILTER_KEYS.find((each) => each === chosen);
          if (kind === undefined) return;
          setAdded((current) => [...current, kind]);
          const starter = starterFilter(kind, setup, config);
          if (starter !== undefined) onSet(kind, starter);
        }}
      />
    </div>
  );
}

const FIELD = 'field:';
type Amount = 'number' | 'field' | 'none';
type CloseDate = 'date' | 'in' | 'none';

export function DealChanges({
  config,
  setup,
  problems,
  onSet,
  ...control
}: SettingProps): ReactElement {
  const { t } = useLingui();
  // A row whose text is still to be typed holds nothing yet: it is shown all the same.
  const [added, setAdded] = useState<readonly DealChangeKind[]>([]);
  const present = dealChangesOf(config);
  const shown = dealChangeKinds.filter((kind) => present.includes(kind) || added.includes(kind));
  const customFields = useMemo(() => dealCustomFields(setup), [setup]);
  const sources = useMemo(() => sourceFields(setup, true), [setup]);
  const numbers = useMemo(
    () =>
      sourceFields(setup).filter((each) => isNumeric(each.type) && each.group !== 'opportunity'),
    [setup],
  );
  const written = dealFieldsOf(config);
  const names: Readonly<Record<DealChangeKind, string>> = {
    name: t`Opportunity name`,
    value: t`Opportunity value`,
    owner: t`Owner`,
    expectedCloseDate: t`Expected close date`,
    source: t`Source`,
    status: t`Status`,
  };
  const remove = (kind: DealChangeKind): void => {
    setAdded((current) => current.filter((each) => each !== kind));
    for (const member of dealChangeMembers[kind]) onSet(member, undefined);
  };
  const problemFor = (kind: DealChangeKind): string | undefined =>
    dealChangeMembers[kind]
      .map((member) => problemOf(problems, member))
      .find((each) => each !== undefined);
  const setFields = (next: Readonly<Record<string, unknown>>): void => {
    onSet('fields', Object.keys(next).length === 0 ? undefined : next);
  };
  const text = (kind: 'name'): ReactElement => (
    <MergeText
      label={t`Opportunity name is set to`}
      value={typeof config[kind] === 'string' ? config[kind] : ''}
      fields={sources}
      maxLength={200}
      invalid={problemFor(kind) !== undefined}
      onChange={(next) => {
        onSet(kind, next);
      }}
    />
  );
  const amountMode: Amount =
    typeof config['amountFrom'] === 'string'
      ? 'field'
      : config['amount'] === null
        ? 'none'
        : 'number';
  const close = config['expectedCloseDate'];
  const closeIn =
    typeof close === 'object' && close !== null && !Array.isArray(close)
      ? durationParts((close as Config)['in'])
      : undefined;
  const closeMode: CloseDate | undefined =
    close === null
      ? 'none'
      : typeof close === 'string'
        ? 'date'
        : closeIn !== undefined && (closeIn.unit === 'days' || closeIn.unit === 'weeks')
          ? 'in'
          : undefined;
  const owners = referenceOptions('users', setup, config);
  const owner = typeof config['owner'] === 'string' ? config['owner'] : '';
  const currentOwner = currentReference(owners, owner);
  const unused = customFields.filter(
    (each) =>
      written === undefined ||
      !Object.keys(written).some((path) => choiceAt(customFields, path, setup)?.path === each.path),
  );

  return (
    <div className="flex min-w-0 flex-col gap-2.5" aria-describedby={control['aria-describedby']}>
      {shown.length === 0 && (written === undefined || Object.keys(written).length === 0) ? (
        <p className={noteClassName}>
          <Trans>Nothing is changed yet. Add the first field.</Trans>
        </p>
      ) : (
        <ul aria-label={t`Fields to change`} className="flex min-w-0 flex-col gap-2.5">
          {shown.map((kind) => {
            const name = names[kind];
            return (
              <Row
                key={kind}
                name={name}
                verb={kind === 'status' ? undefined : <Trans>is set to</Trans>}
                problem={problemFor(kind)}
                removeLabel={t`Remove the change: ${name}`}
                onRemove={() => {
                  remove(kind);
                }}
              >
                {kind === 'name' ? config[kind] === null ? <KeptAsWritten /> : text(kind) : null}
                {kind === 'source' ? (
                  <DealSourceControl
                    label={t`Source is set to`}
                    value={config['source']}
                    setup={setup}
                    invalid={problemFor(kind) !== undefined}
                    updating
                    onChange={(next) => {
                      onSet('source', next);
                    }}
                  />
                ) : null}
                {kind === 'value' ? (
                  <div className="flex min-w-0 flex-wrap gap-2">
                    <select
                      aria-label={t`Opportunity value is set to`}
                      className={`${selectClassName} flex-1 basis-44`}
                      value={amountMode}
                      onChange={(event) => {
                        const mode = event.target.value;
                        onSet('amount', mode === 'number' ? 0 : mode === 'none' ? null : undefined);
                        onSet(
                          'amountFrom',
                          mode === 'field' ? (numbers[0]?.path ?? '') : undefined,
                        );
                      }}
                    >
                      <option value="number">{t`A number`}</option>
                      <option value="field" disabled={numbers.length === 0}>
                        {t`From a contact number field`}
                      </option>
                      <option value="none">{t`No value (remove it)`}</option>
                    </select>
                    {amountMode === 'number' ? (
                      <Input
                        aria-label={t`Opportunity value, the number`}
                        aria-invalid={problemFor(kind) !== undefined}
                        className="flex-1 basis-28"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="any"
                        value={typeof config['amount'] === 'number' ? config['amount'] : ''}
                        onChange={(event) => {
                          const typed = event.target.valueAsNumber;
                          // An emptied box holds nothing; the row stays to be typed into.
                          if (Number.isNaN(typed))
                            setAdded((current) =>
                              current.includes('value') ? current : [...current, 'value'],
                            );
                          onSet('amount', Number.isNaN(typed) ? undefined : typed);
                        }}
                      />
                    ) : null}
                    {amountMode === 'field' ? (
                      <div className="min-w-0 flex-1 basis-40">
                        <FieldSelect
                          label={t`Opportunity value, the contact field`}
                          value={
                            choiceAt(numbers, String(config['amountFrom']), setup)?.path ??
                            String(config['amountFrom'])
                          }
                          fields={numbers}
                          invalid={problemFor(kind) !== undefined}
                          onChange={(path) => {
                            onSet('amountFrom', path);
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {kind === 'owner' ? (
                  <select
                    aria-label={t`Owner is set to`}
                    aria-invalid={problemFor(kind) !== undefined}
                    className={selectClassName}
                    value={config['owner'] === null ? '' : (currentOwner ?? owner)}
                    onChange={(event) => {
                      onSet('owner', event.target.value === '' ? null : event.target.value);
                    }}
                  >
                    <option value="">{t`No owner`}</option>
                    {owner !== '' && currentOwner === undefined ? (
                      <option value={owner}>{t`${owner} (not found)`}</option>
                    ) : null}
                    {owners.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : null}
                {kind === 'expectedCloseDate' ? (
                  closeMode === undefined ? (
                    <KeptAsWritten />
                  ) : (
                    <div className="flex min-w-0 flex-wrap gap-2">
                      <select
                        aria-label={t`Expected close date is set to`}
                        className={`${selectClassName} flex-1 basis-44`}
                        value={closeMode}
                        onChange={(event) => {
                          const mode = event.target.value;
                          onSet(
                            'expectedCloseDate',
                            mode === 'date' ? today() : mode === 'in' ? { in: 'P30D' } : null,
                          );
                        }}
                      >
                        <option value="in">{t`This long from when it runs`}</option>
                        <option value="date">{t`A date`}</option>
                        <option value="none">{t`No date (remove it)`}</option>
                      </select>
                      {closeMode === 'date' && typeof close === 'string' ? (
                        <Input
                          aria-label={t`Expected close date, the date`}
                          aria-invalid={problemFor(kind) !== undefined}
                          className="flex-1 basis-36"
                          type="date"
                          value={close}
                          onChange={(event) => {
                            if (event.target.value !== '')
                              onSet('expectedCloseDate', event.target.value);
                          }}
                        />
                      ) : null}
                      {closeMode === 'in' && closeIn !== undefined ? (
                        <div className="grid min-w-0 flex-1 basis-44 grid-cols-2 gap-2">
                          <Input
                            aria-label={t`Expected close date, how many`}
                            aria-invalid={problemFor(kind) !== undefined}
                            type="number"
                            inputMode="numeric"
                            min={1}
                            step={1}
                            value={closeIn.amount}
                            onChange={(event) => {
                              const typed = event.target.valueAsNumber;
                              if (!Number.isNaN(typed) && typed >= 1)
                                onSet('expectedCloseDate', { in: durationOf(typed, closeIn.unit) });
                            }}
                          />
                          <select
                            aria-label={t`Expected close date, days or weeks`}
                            className={selectClassName}
                            value={closeIn.unit}
                            onChange={(event) => {
                              onSet('expectedCloseDate', {
                                in: durationOf(
                                  closeIn.amount,
                                  event.target.value === 'weeks' ? 'weeks' : 'days',
                                ),
                              });
                            }}
                          >
                            <option value="days">{t`Days`}</option>
                            <option value="weeks">{t`Weeks`}</option>
                          </select>
                        </div>
                      ) : null}
                    </div>
                  )
                ) : null}
                {kind === 'status' ? (
                  <p className={noteClassName}>
                    <Trans>
                      Reopen: an opportunity that was won or lost becomes open again. To close one,
                      use Close opportunity.
                    </Trans>
                  </p>
                ) : null}
              </Row>
            );
          })}
          {written === undefined ? (
            <li className={rowClassName}>
              <KeptAsWritten />
            </li>
          ) : (
            Object.entries(written).map(([path, value]) => {
              const field = choiceAt(customFields, path, setup);
              const name = field?.label ?? path;
              const scalar =
                typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean';
              return (
                <Row
                  key={path}
                  name={name}
                  verb={value === null ? <Trans>is emptied</Trans> : <Trans>is set to</Trans>}
                  problem={problemOf(problems, `fields/${path}`)}
                  removeLabel={t`Remove the change: ${name}`}
                  onRemove={() => {
                    const { [path]: _gone, ...rest } = written;
                    setFields(rest);
                  }}
                >
                  {scalar ? (
                    <TypedValue
                      label={t`${name} is set to`}
                      field={field}
                      value={value}
                      invalid={problemOf(problems, `fields/${path}`) !== undefined}
                      onChange={(typed) => {
                        setFields({ ...written, [path]: typed });
                      }}
                    />
                  ) : value === null ? null : (
                    <KeptAsWritten />
                  )}
                  <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 self-start text-sm lg:min-h-8">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-primary"
                      aria-label={t`Empty it: ${name}`}
                      checked={value === null}
                      onChange={(event) => {
                        setFields({
                          ...written,
                          [path]: event.target.checked ? null : starterValue(field),
                        });
                      }}
                    />
                    <Trans>Empty it</Trans>
                  </label>
                </Row>
              );
            })
          )}
        </ul>
      )}
      <Unshown
        problems={problems}
        members={DEAL_CHANGE_KEYS.filter((member) => member !== 'fields')}
        shown={shown.flatMap((kind) => dealChangeMembers[kind])}
      />
      <RowProblem>{problems['fields']}</RowProblem>
      <AddSelect
        control
        label={t`Add field`}
        choices={[
          ...dealChangeKinds
            .filter((kind) => !shown.includes(kind))
            .map((kind) => ({
              value: kind,
              label: kind === 'status' ? t`Status: reopen` : names[kind],
            })),
          ...unused.map((field) => ({ value: `${FIELD}${field.path}`, label: field.label })),
        ]}
        onAdd={(chosen) => {
          if (chosen.startsWith(FIELD)) {
            const path = chosen.slice(FIELD.length);
            setFields({
              ...written,
              [path]: starterValue(customFields.find((each) => each.path === path)),
            });
            return;
          }
          const kind = dealChangeKinds.find((each) => each === chosen);
          if (kind === undefined) return;
          setAdded((current) => [...current, kind]);
          const starter = starterChange(kind, setup);
          if (starter !== undefined) onSet(starter[0], starter[1]);
        }}
      />
    </div>
  );
}

/**
 * The control a record step's setting has, by what the setting is: the one component the
 * step's panel fetches for them.
 */
export default function RecordSetting({
  input,
  label = '',
  ...props
}: SettingProps & {
  readonly input: FieldInput;
  /** What the setting is called, for a control that is one named group or list. */
  readonly label?: string;
}): ReactElement | null {
  if (input.kind === 'lead_sources')
    return (
      <LeadSourcesSetting
        id={props.id}
        aria-describedby={props['aria-describedby']}
        label={label}
        value={props.config['sources']}
        onChange={(next) => {
          props.onSet('sources', next);
        }}
      />
    );
  if (input.kind === 'deal_source')
    return (
      <DealSourceControl
        id={props.id}
        aria-describedby={props['aria-describedby']}
        label={label}
        value={props.config['source']}
        setup={props.setup}
        invalid={props.problems['source'] !== undefined}
        onChange={(next) => {
          props.onSet('source', next);
        }}
      />
    );
  if (input.kind === 'members')
    return input.followers === undefined ? (
      <MembersSetting {...props} />
    ) : (
      <FollowersSetting {...props} removal={input.followers === 'remove'} />
    );
  if (input.kind === 'deal_filters') return <DealFilters {...props} />;
  return input.kind === 'deal_changes' ? <DealChanges {...props} /> : null;
}
