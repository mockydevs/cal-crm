// The right-hand panel that adds or changes one action or trigger: choose what it is, then
// fill in its settings. The choices come from the catalog, under GoHighLevel's category
// names; a step whose channel or AI isn't set up is listed apart as not available, never as
// a choice. The form is built from the type's settings (automation-fields.ts), with a name
// for an action and filters for a trigger, and what it holds is checked by the contract
// before it's kept. Leaving it with changes asks first.
import { Trans, useLingui } from '@lingui/react/macro';
import type { EndpointOutput, getAutomationCatalog } from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { ArrowLeft, ChevronDown, ChevronUp, Minus, Plus } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { AutomationDialog, INITIAL_FOCUS } from './automation-dialog';
import {
  cleanConfig,
  configProblems,
  currentReference,
  durationOf,
  durationParts,
  resumeWindowParts,
  fieldsOf,
  missingFields,
  referenceOptions,
  settingWords,
  shownFields,
  starterConfig,
  type DurationUnit,
  type FieldOwner,
  type FieldSpec,
} from './automation-fields';
import {
  conditionOf,
  filterFields,
  rowProblems,
  rowsOf,
  type FilterRow,
} from './automation-filters';
import { needsWords } from './automation-setup-words';
import type { EmailStepContext } from './email-step/panel';
import { withEmailWords } from './email-words';
import { answerFields, submissionScope, type BuilderSetup } from './automation-submission';
import { availableTriggers, stepPicker } from './automation-availability';

import {
  conditionWords,
  stepLabel,
  stepSummary,
  triggerLabel,
  triggerSummary,
} from './automation-summary';

// The weekdays and hours a wait may go on in: only the wait steps have it.
const ResumeWindow = lazy(async () => {
  const controls = await import('./automation-resume-window');
  return { default: controls.ResumeWindow };
});

const Picker = lazy(async () => {
  const picker = await import('./automation-picker');
  return { default: picker.Picker };
});

const ContactFieldChanges = lazy(async () => {
  const controls = await import('./automation-contact-fields');
  return { default: controls.ContactFieldChanges };
});

const FilterEditor = lazy(async () => {
  const filters = await import('./automation-filter-editor');
  return { default: filters.FilterEditor };
});

// A trigger's filters, compact: what is set, and a menu of what can be added. And the form
// a "Form submitted" trigger names, as a list that can be searched.
const TriggerFilters = lazy(() => import('./automation-trigger-filters-panel'));
const FormChoice = lazy(async () => {
  const panel = await import('./automation-trigger-filters-panel');
  return { default: panel.FormChoice };
});

// A Send email action's whole panel, its Statistics tab, and the words of both: fetched
// when such an action is first opened.
const EmailPanel = lazy(() => withEmailWords(import('./email-step/panel')));
const EmailStatistics = lazy(() => withEmailWords(import('./email-step/statistics')));
const EmailTabs = lazy(() => withEmailWords(import('./email-step/tabs')));

// The icons are the canvas's and the picker's too: fetched once, whichever asks first.
const Tile = lazy(async () => {
  const tile = await import('./automation-tile');
  return { default: tile.Tile };
});

// Who an Assign owner step names, a Find opportunity's filters and an Update opportunity's
// rows: one component, so the panel waits for that code once.
const RecordSetting = lazy(() => import('./automation-record-fields'));

// The list that puts a merge field into a message's text.
const MergeInsert = lazy(() => import('./automation-merge-insert'));

// Naming other automations brings a list to search with it, and reads their statuses. One
// component for both of its controls, so the panel waits for that code once.
const TargetSetting = lazy(() => import('./automation-target-fields'));

// An If / else's own branches and a goal's events, with the row editor they are made of.
const FlowSetting = lazy(() => import('./automation-flow-fields'));

export type AutomationCatalogData = EndpointOutput<typeof getAutomationCatalog>;

type Config = Readonly<Record<string, unknown>>;

/** What a panel saves beside the settings: an action's own name, a trigger's filters. */
export interface SettingsExtras {
  readonly label: string | undefined;
  readonly condition: unknown;
}

export interface SettingsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly owner: FieldOwner;
  /** The step or trigger being changed; nothing when adding one. */
  readonly editing?:
    | {
        /** Which one it is, so the form starts again when another is opened in its place. */
        readonly key: string;
        readonly type: string;
        readonly config: Config;
        readonly label?: string | undefined;
        readonly condition?: unknown;
        /** What the checks last found wrong with its settings, by the setting. */
        readonly problems?: Readonly<Record<string, string>> | undefined;
      }
    | undefined;
  /**
   * When adding: the type already chosen, such as a step dragged from the canvas's library,
   * so the panel opens on its settings. The person can still choose another.
   */
  readonly presetType?: string | undefined;
  readonly catalog: AutomationCatalogData;
  /** The business's setup; in a workflow a form starts, with that form's answers. */
  readonly setup: BuilderSetup;
  /** The forms this workflow's "Form submitted" triggers name, one a trigger; none, any form. */
  readonly submissionForms?: readonly unknown[] | undefined;
  /** The business's API, for a panel that reads more than the setup holds. */
  readonly client?: Client | undefined;
  /** The automation being edited, which a step can't choose as another one. */
  readonly automationId?: string | undefined;
  /** For a Send email action: the draft it is part of, and what can be done to it there. */
  readonly email?: EmailStepContext | undefined;
  /** Its other actions, by what their cards say, for an action that names one. */
  readonly steps?: readonly { readonly id: string; readonly name: string }[] | undefined;
  /** Step types the workflow already has its one of, such as a goal. */
  readonly taken?: readonly string[] | undefined;
  readonly onSubmit: (
    type: string,
    config: Record<string, unknown>,
    extras: SettingsExtras,
  ) => void | Promise<void>;
  /** Opens the JSON view at this step or trigger, for a setting no form here edits. */
  readonly onEditInJson?: (() => void) | undefined;
  /** Removes the saved step or trigger this panel is on; the builder asks first. */
  readonly onDelete?: (() => void) | undefined;
  /** Opens the action before this one in the flow, and the one after. */
  readonly onPrevious?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly finalFocus?: () => HTMLElement | null;
}

/** The steps that act on the opportunity the run has in hand. */
const DEAL_IN_HAND_STEPS: readonly string[] = ['deal.move', 'deal.close', 'deal.update'];

const labelOf = (owner: FieldOwner, type: string): string =>
  (owner === 'step' ? stepLabel(type) : triggerLabel(type)) ?? type;

type Leaving = 'close' | 'back' | 'previous' | 'next';

/** In a setting with something to fix: the control that is wrong, else its first one. */
const FIRST_TO_FIX = '[data-field-control][aria-invalid="true"], [data-field-control]';

export function SettingsDialog(props: SettingsDialogProps): ReactElement {
  const { t } = useLingui();
  const { open, onOpenChange, owner, editing, catalog, setup } = props;
  const [chosen, setChosen] = useState<string>();
  // Going back from a preset type to the list of choices drops the preset for this opening.
  const [presetDropped, setPresetDropped] = useState(false);
  // A trigger being changed can be given another type: the panel then shows that type's form.
  const [retyped, setRetyped] = useState<{ readonly key: string; readonly type: string }>();
  const [dirty, setDirty] = useState(false);
  const savingRef = useRef(false);
  const [asking, setAsking] = useState<Leaving>();
  const swapped = editing !== undefined && retyped?.key === editing.key ? retyped.type : undefined;
  const asked =
    swapped ?? editing?.type ?? chosen ?? (presetDropped ? undefined : props.presetType);
  // A dialog that is closing keeps showing what it showed. Saving an edit clears the editing
  // and the open state together, and without this the closing dialog would turn into the
  // picker of actions, a lazy module whose first fetch suspends the page behind the dialog.
  const [shown, setShown] = useState(asked);
  if (open && shown !== asked) setShown(asked);
  const type = open ? asked : shown;
  const reset = (): void => {
    setChosen(undefined);
    setPresetDropped(false);
    setRetyped(undefined);
    setDirty(false);
    setAsking(undefined);
  };
  const leave = (how: Leaving): void => {
    setDirty(false);
    setAsking(undefined);
    if (how === 'back') {
      setChosen(undefined);
      setPresetDropped(true);
    } else if (how === 'previous') props.onPrevious?.();
    else if (how === 'next') props.onNext?.();
    else {
      reset();
      onOpenChange(false);
    }
  };
  /** Leaves at once when nothing was changed, and asks first when something was. */
  const attempt = (how: Leaving): void => {
    if (savingRef.current) return;
    if (dirty) setAsking(how);
    else leave(how);
  };
  const picking = type === undefined;
  const description =
    type === undefined
      ? undefined
      : (owner === 'step' ? catalog.steps : catalog.triggers).find((each) => each.type === type)
          ?.description;
  const offeredTriggers = availableTriggers(catalog.triggers, setup).filter(
    (trigger) => fieldsOf('trigger', trigger.type) !== undefined,
  );
  const picker = stepPicker(
    catalog.steps.filter((step) => fieldsOf('step', step.type) !== undefined),
    catalog.stepGroups,
    setup,
    props.taken,
  );
  const named = (item: { type: string; description: string }) => ({
    type: item.type,
    name: labelOf(owner, item.type),
    description: item.description,
  });

  return (
    <AutomationDialog
      open={open}
      side
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else attempt('close');
      }}
      title={picking ? (owner === 'step' ? t`Actions` : t`Add trigger`) : labelOf(owner, type)}
      description={
        picking ? (
          owner === 'step' ? (
            <Trans>Choose what happens at this point.</Trans>
          ) : (
            <Trans>Choose what sets the workflow off.</Trans>
          )
        ) : undefined
      }
      {...(props.finalFocus === undefined ? {} : { finalFocus: props.finalFocus })}
    >
      {asking === undefined ? null : (
        <div
          role="alertdialog"
          aria-label={t`Leave without saving?`}
          className="flex min-w-0 flex-col gap-3 rounded-xl border border-input bg-card p-4"
        >
          <p className="text-md font-medium">
            <Trans>You have changes here that aren't saved. Leave without them?</Trans>
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                setAsking(undefined);
              }}
            >
              <Trans>Keep editing</Trans>
            </Button>
            <Button
              size="small"
              onClick={() => {
                leave(asking);
              }}
            >
              <Trans>Discard changes</Trans>
            </Button>
          </div>
        </div>
      )}
      {picking ? (
        <Picker
          owner={owner}
          items={
            owner === 'trigger'
              ? offeredTriggers.map(named)
              : picker.groups.flatMap((group) => group.steps).map(named)
          }
          unavailable={
            owner === 'trigger'
              ? []
              : picker.unavailable.map(({ step, missing }) => ({
                  item: named(step),
                  needs: needsWords(missing),
                }))
          }
          onChoose={setChosen}
        />
      ) : (
        <SettingsForm
          key={`${editing?.key ?? 'new'}:${type}`}
          {...props}
          type={type}
          description={description}
          retyped={swapped !== undefined}
          triggerTypes={offeredTriggers.map((trigger) => trigger.type)}
          onType={(next) => {
            if (editing === undefined) setChosen(next);
            else setRetyped({ key: editing.key, type: next });
            setDirty(true);
          }}
          onDirty={() => {
            setDirty(true);
          }}
          onBack={
            editing === undefined
              ? () => {
                  attempt('back');
                }
              : undefined
          }
          onStep={(how) => {
            attempt(how);
          }}
          onCancel={() => {
            attempt('close');
          }}
          onDone={() => {
            reset();
            onOpenChange(false);
          }}
          onSaving={(saving) => {
            savingRef.current = saving;
          }}
        />
      )}
    </AutomationDialog>
  );
}

function SettingsForm({
  owner,
  type,
  description,
  retyped,
  triggerTypes,
  editing,
  setup: given,
  submissionForms,
  client,
  automationId,
  email,
  steps = [],
  onSubmit,
  onEditInJson,
  onDelete,
  onPrevious,
  onNext,
  onType,
  onDirty,
  onBack,
  onStep,
  onCancel,
  onDone,
  onSaving,
}: SettingsDialogProps & {
  readonly type: string;
  readonly description: string | undefined;
  /** Whether a saved trigger was given another type here, so its old settings don't apply. */
  readonly retyped: boolean;
  readonly triggerTypes: readonly string[];
  readonly onType: (type: string) => void;
  readonly onDirty: () => void;
  readonly onBack: (() => void) | undefined;
  readonly onStep: (how: 'previous' | 'next') => void;
  readonly onCancel: () => void;
  readonly onDone: () => void;
  readonly onSaving: (saving: boolean) => void;
}): ReactElement {
  const { t } = useLingui();
  const formId = useId();
  const nameId = useId();
  const typeId = useId();
  const filtersId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [config, setConfig] = useState<Record<string, unknown>>(() =>
    editing === undefined || retyped ? starterConfig(owner, type) : { ...editing.config },
  );
  const [label, setLabel] = useState(editing?.label ?? '');
  // The rows of a trigger's filters, or of an If / else's condition. Nothing when the
  // condition is written in a way rows can't hold: it is then shown as it reads.
  const written = owner === 'trigger' ? editing?.condition : config['if'];
  const [rows, setRows] = useState<readonly FilterRow[] | undefined>(() => rowsOf(written));
  const [rowIssues, setRowIssues] = useState<readonly (string | undefined)[]>([]);
  // A saved step opens with what the checks last said of its settings, each under its own.
  const [problems, setProblems] = useState<Record<string, string>>(() =>
    retyped ? {} : { ...editing?.problems },
  );
  // Choosing a type swaps the list of choices for this form, and takes the button that had
  // the keyboard with it: the keyboard moves to the first setting, or to the way forward.
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>(INITIAL_FOCUS)?.focus();
  }, []);
  // A "Form submitted" trigger reads the answers of the form it names as it is being edited.
  const namedForm = config['form'];
  // The forms the workflow's triggers name, as text: the list itself is made anew each
  // drawing, and the setup must stay the same object while they are the same forms.
  const formsWritten =
    submissionForms === undefined
      ? undefined
      : JSON.stringify(submissionForms.map((form) => form ?? null));
  const setup = useMemo<BuilderSetup>(() => {
    if (owner === 'trigger' && type === 'form.submitted')
      return { ...given, answers: answerFields(submissionScope(given.forms, [namedForm])) };
    if (formsWritten === undefined || given.answers !== undefined) return given;
    const forms = (JSON.parse(formsWritten) as readonly unknown[]).map((form) => form ?? undefined);
    return { ...given, answers: answerFields(submissionScope(given.forms, forms)) };
  }, [given, owner, type, namedForm, formsWritten]);
  const isEmail = owner === 'step' && type === 'email.send';
  const everyField = shownFields(owner, type, config);
  // A trigger's source filters are listed with its filters, once they are set.
  const compact =
    owner === 'trigger'
      ? everyField.filter((field) => field.key === 'sources' || field.key === 'sessionSources')
      : [];
  // A Send email action's settings are all drawn by its own panel.
  const fields = isEmail ? [] : everyField.filter((field) => !compact.includes(field));
  const hasCondition = owner === 'step' && fields.some((field) => field.key === 'if');
  const set = (key: string, value: unknown): void => {
    onDirty();
    setConfig((current) => {
      const { [key]: _old, ...rest } = current;
      const next =
        value === undefined || (value === '' && !(type === 'email.send' && key === 'template'))
          ? rest
          : { ...rest, [key]: value };
      // A stage belongs to a pipeline: another pipeline's stage doesn't carry over.
      if (key === 'pipeline' && typeof next['stage'] === 'string') {
        const stages = referenceOptions('stages', setup, next);
        if (currentReference(stages, next['stage']) === undefined) {
          const { stage: _stage, ...withoutStage } = next;
          return withoutStage;
        }
      }
      return next;
    });
    // What was said of the setting, and of anything inside it, is asked about again on saving.
    setProblems((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([place]) => place !== key && !place.startsWith(`${key}/`)),
      ),
    );
  };
  const changeRows = (next: FilterRow[]): void => {
    onDirty();
    setRows(next);
    setRowIssues([]);
    setProblems(({ if: _fixed, ...others }) => others);
  };
  const [submitting, setSubmitting] = useState(false);
  // A Send email action's two tabs: its settings, and what it has sent.
  const [emailTab, setEmailTab] = useState<'edit' | 'statistics'>('edit');
  const submit = async (): Promise<void> => {
    if (submitting) return;
    setEmailTab('edit');
    const withRows =
      hasCondition && rows !== undefined ? { ...config, if: conditionOf(rows) } : config;
    // A Send email action says itself what it saves and what it lacks (email-step/check.ts).
    const sent = isEmail ? (await import('./email-step/check')).emailSubmit(config) : undefined;
    const cleaned = sent?.config ?? cleanConfig(owner, type, withRows);
    const issues = rows === undefined ? [] : rowProblems(rows, filterFields(setup), setup);
    const found: Record<string, string> = { ...sent?.problems };
    for (const key of missingFields(owner, type, cleaned)) {
      if (found[key] !== undefined) continue;
      const kind = fields.find((field) => field.key === key)?.input.kind;
      found[key] =
        key === 'if'
          ? t`Add at least one condition.`
          : kind === 'members'
            ? t`Choose at least one team member.`
            : kind === 'deal_changes'
              ? t`Add at least one field to change.`
              : kind === 'contact_fields'
                ? t`Add at least one field to set.`
                : t`Fill this in.`;
    }
    const rowsWhole = issues.every((issue) => issue === undefined);
    if (Object.keys(found).length === 0 && rowsWhole)
      Object.assign(found, configProblems(owner, type, cleaned));
    setProblems(found);
    setRowIssues(issues);
    const [first] = Object.keys(found);
    if (first === undefined && rowsWhole) {
      setSubmitting(true);
      try {
        onSaving(true);
        await onSubmit(type, cleaned, {
          label: label.trim() === '' ? undefined : label.trim(),
          condition:
            owner !== 'trigger' ? undefined : rows === undefined ? written : conditionOf(rows),
        });
        onDone();
      } catch {
        setProblems({
          save: t`We couldn't save this action. Your edits are still here. Check for a changed template or workflow and try again.`,
        });
      } finally {
        onSaving(false);
        setSubmitting(false);
      }
      return;
    }
    // The keyboard goes to the first setting to fix.
    queueMicrotask(() => {
      const settings = formRef.current?.querySelectorAll<HTMLElement>('[data-setting]') ?? [];
      const wanted =
        first === undefined ? (hasCondition ? 'if' : 'filters') : (settingOf(first) ?? first);
      [...settings]
        .find((setting) => setting.dataset['setting'] === wanted)
        ?.querySelector<HTMLElement>(FIRST_TO_FIX)
        ?.focus();
    });
  };
  const summary =
    owner === 'step'
      ? stepSummary({ type, config }, setup)
      : triggerSummary({ type, config }, setup);
  /** The setting a problem is said under: the one that stands for the member it names. */
  const settingOf = (place: string): string | undefined => {
    const [member = ''] = place.split('/');
    // A Send email action's panel says what is wrong under each of its own controls.
    if (isEmail)
      return everyField.some((field) => (field.covers ?? [field.key]).includes(member))
        ? 'email'
        : undefined;
    return fields.find((field) => (field.covers ?? [field.key]).includes(member))?.key;
  };
  const unplaced = Object.entries(problems).filter(([key]) => settingOf(key) === undefined);
  const incomplete =
    Object.keys(problems).length > 0 || rowIssues.some((issue) => issue !== undefined);
  const inJson =
    editing === undefined || onEditInJson === undefined
      ? undefined
      : () => {
          if (submitting) return;
          onDone();
          onEditInJson();
        };
  const typeName = labelOf(owner, type);

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-w-0 flex-1 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        {onBack === undefined ? null : (
          <Button type="button" variant="quiet" size="small" onClick={onBack}>
            <ArrowLeft aria-hidden className="size-4" strokeWidth={1.8} />
            <Trans>Back</Trans>
          </Button>
        )}
        {owner === 'step' && editing !== undefined ? (
          <div className="flex gap-1">
            <Button
              type="button"
              variant="secondary"
              size="small"
              className="px-2.5"
              aria-label={t`Previous action`}
              disabled={onPrevious === undefined}
              onClick={() => {
                onStep('previous');
              }}
            >
              <ChevronUp aria-hidden className="size-4" strokeWidth={1.8} />
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="small"
              className="px-2.5"
              aria-label={t`Next action`}
              disabled={onNext === undefined}
              onClick={() => {
                onStep('next');
              }}
            >
              <ChevronDown aria-hidden className="size-4" strokeWidth={1.8} />
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <Suspense fallback={<span aria-hidden className="size-10 shrink-0" />}>
          <Tile owner={owner} type={type} className="size-10" />
        </Suspense>
        <div className="flex min-w-0 flex-col">
          <span className="text-md font-medium text-foreground">{typeName}</span>
          {description === undefined ? null : (
            <span className="text-sm text-muted-foreground">{description}</span>
          )}
        </div>
      </div>
      {isEmail && email?.step !== undefined ? (
        <Suspense fallback={null}>
          <EmailTabs label={labelOf(owner, type)} tab={emailTab} onTab={setEmailTab} />
        </Suspense>
      ) : null}
      {incomplete ? (
        <p
          role="alert"
          className="rounded-xl border border-destructive bg-card px-3.5 py-2.5 text-sm font-medium text-destructive"
        >
          <Trans>Oops! Looks like you've missed out on some fields.</Trans>
        </p>
      ) : null}
      {owner === 'trigger' ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor={typeId}>
            <Trans>Choose a workflow trigger</Trans>
          </label>
          <Select id={typeId} value={type} onValueChange={onType}>
            {triggerTypes.includes(type) ? null : <option value={type}>{typeName}</option>}
            {triggerTypes.map((each) => (
              <option key={each} value={each}>
                {labelOf('trigger', each)}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <div hidden={emailTab !== 'edit'} className="flex min-w-0 flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor={nameId}>
            <Trans>Action name</Trans>{' '}
            <span className="font-normal text-muted-foreground">
              <Trans>(optional)</Trans>
            </span>
          </label>
          <Input
            id={nameId}
            maxLength={80}
            placeholder={typeName}
            value={label}
            onChange={(event) => {
              onDirty();
              setLabel(event.target.value);
            }}
          />
        </div>
      )}
      {isEmail ? (
        <div data-email-edit hidden={emailTab !== 'edit'} className="min-w-0">
          <Suspense fallback={null}>
            <EmailPanel
              id={`${formId}-email`}
              config={config}
              setup={setup}
              actionName={label}
              problems={problems}
              context={email}
              onChange={(next) => {
                onDirty();
                setConfig(next);
                setProblems({});
              }}
            />
          </Suspense>
        </div>
      ) : null}
      {isEmail && emailTab === 'statistics' && email?.step !== undefined ? (
        <Suspense fallback={null}>
          <EmailStatistics automationId={email.automationId} step={email.step} />
        </Suspense>
      ) : null}
      {owner === 'step' && DEAL_IN_HAND_STEPS.includes(type) ? (
        <p className="text-sm text-muted-foreground">
          <Trans>
            Acts on the opportunity found or created earlier in this workflow; otherwise the
            contact's one open opportunity.
          </Trans>
        </p>
      ) : null}
      {fields.length === 0 && owner === 'step' && !isEmail ? (
        <p className="text-md text-muted-foreground">
          <Trans>There is nothing to set up for this one.</Trans>
        </p>
      ) : null}
      {fields.map((field) =>
        field.key === 'if' && hasCondition && rows !== undefined ? (
          <div key={field.key} data-setting="if" className="flex min-w-0 flex-col gap-2">
            <span className="text-sm font-medium">
              <Trans>Conditions</Trans>
            </span>
            <p className="text-sm text-muted-foreground">
              <Trans>
                The yes branch is taken when every condition holds, otherwise the no branch.
              </Trans>
            </p>
            <FilterEditor
              rows={rows}
              setup={setup}
              problems={rowIssues}
              noun="condition"
              onChange={changeRows}
            />
            {problems['if'] === undefined ? null : (
              <p className="text-sm font-medium text-destructive">{problems['if']}</p>
            )}
          </div>
        ) : (
          <Setting
            key={field.key}
            id={`${formId}-${field.key}`}
            field={field}
            client={client}
            // An If / else's branches are made from its condition as the rows now hold it.
            config={
              field.key === 'branches' && hasCondition && rows !== undefined
                ? { ...config, if: conditionOf(rows) }
                : config
            }
            setup={setup}
            self={automationId}
            steps={steps}
            problem={problems[field.key]}
            problems={problems}
            reads={summary}
            onChange={set}
            onEditInJson={inJson}
          />
        ),
      )}
      {owner === 'trigger' ? (
        <TriggerFilters
          labelId={filtersId}
          fields={compact}
          config={config}
          answers={setup.answers ?? []}
          rows={rows}
          writtenWords={
            rows === undefined
              ? (conditionWords(written, false, setup) ?? JSON.stringify(written))
              : ''
          }
          onSet={set}
          onRows={changeRows}
          onEditInJson={inJson}
        >
          {rows === undefined ? null : (
            <FilterEditor
              rows={rows}
              setup={setup}
              problems={rowIssues}
              noun="filter"
              adding={false}
              onChange={changeRows}
            />
          )}
        </TriggerFilters>
      ) : null}
      {unplaced.length === 0 ? null : (
        <div role="alert">
          <ul className="flex flex-col gap-1 text-sm font-medium text-destructive">
            {unplaced.map(([key, message]) => (
              <li key={key}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="sticky bottom-0 -mx-5 mt-auto -mb-5 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-card px-5 py-3">
        {editing === undefined || onDelete === undefined ? null : (
          <Button
            type="button"
            variant="secondary"
            className="mr-auto border-destructive text-destructive"
            disabled={submitting}
            onClick={() => {
              if (submitting) return;
              onDone();
              onDelete();
            }}
          >
            <Trans>Delete</Trans>
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" data-initial-focus disabled={submitting}>
          {owner === 'step' ? <Trans>Save action</Trans> : <Trans>Save trigger</Trans>}
        </Button>
      </div>
    </form>
  );
}

function Setting({
  id,
  field,
  config,
  setup,
  client,
  self,
  steps,
  problem,
  problems,
  reads,
  onChange,
  onEditInJson,
}: {
  readonly id: string;
  readonly field: FieldSpec;
  readonly config: Config;
  readonly setup: BuilderSetup;
  readonly client: Client | undefined;
  readonly self: string | undefined;
  readonly steps: NonNullable<SettingsDialogProps['steps']>;
  readonly problem: string | undefined;
  /** Everything the checks said of the step's settings, for a setting made of rows. */
  readonly problems: Readonly<Record<string, string>>;
  /** How the whole step reads, for a setting that covers several members. */
  readonly reads: string | undefined;
  readonly onChange: (key: string, value: unknown) => void;
  readonly onEditInJson: (() => void) | undefined;
}): ReactElement {
  const { t, i18n } = useLingui();
  const [unitChoice, setUnitChoice] = useState<DurationUnit>('days');
  const label = i18n._(field.label);
  const value = config[field.key];
  const hintId = `${id}-hint`;
  const problemId = `${id}-problem`;
  const describedBy =
    [field.hint === undefined ? undefined : hintId, problem === undefined ? undefined : problemId]
      .filter((each) => each !== undefined)
      .join(' ') || undefined;
  const common = {
    id,
    'aria-invalid': problem !== undefined,
    ...(describedBy === undefined ? {} : { 'aria-describedby': describedBy }),
    'data-field-control': true,
  } as const;
  const { input } = field;
  const units: readonly (readonly [DurationUnit, string])[] = [
    ['seconds', t`Seconds`],
    ['minutes', t`Minutes`],
    ['hours', t`Hours`],
    ['days', t`Days`],
    ['weeks', t`Weeks`],
  ];

  const frame = (control: ReactNode, labelled = true, quiet = false): ReactElement => (
    <div data-setting={field.key} className="flex min-w-0 flex-col gap-1.5">
      {labelled ? (
        <label className="text-sm font-medium" htmlFor={id}>
          {label}
          {field.required ? null : (
            <>
              {' '}
              <span className="font-normal text-muted-foreground">
                <Trans>(optional)</Trans>
              </span>
            </>
          )}
        </label>
      ) : (
        <span className="text-sm font-medium">{label}</span>
      )}
      {control}
      {field.hint === undefined ? null : (
        <p id={hintId} className="text-sm text-muted-foreground">
          {i18n._(field.hint)}
        </p>
      )}
      {problem === undefined || quiet ? null : (
        <p id={problemId} className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
  const readOnly = (words: string): ReactElement =>
    frame(
      <div className="flex min-w-0 flex-col items-start gap-2 rounded-xl border border-dashed border-input px-3.5 py-3">
        <span className="max-w-full text-md wrap-anywhere">{words}</span>
        <span className="text-sm text-muted-foreground">
          {onEditInJson === undefined ? (
            <Trans>This setting is edited in the JSON view, once the step is added.</Trans>
          ) : (
            <Trans>This setting is edited in the JSON view.</Trans>
          )}
        </span>
        {onEditInJson === undefined ? null : (
          <Button type="button" variant="secondary" size="small" onClick={onEditInJson}>
            <Trans>Edit in JSON</Trans>
          </Button>
        )}
      </div>,
      false,
    );

  if (input.kind === 'json') {
    const keys = field.covers ?? [field.key];
    const empty = keys.every((key) => config[key] === undefined);
    return readOnly(
      empty
        ? t`Not set`
        : keys.length > 1
          ? (reads ?? JSON.stringify(Object.fromEntries(keys.map((key) => [key, config[key]]))))
          : settingWords(field, value, setup),
    );
  }
  if (input.kind === 'contact_fields')
    return frame(
      <ContactFieldChanges
        value={value}
        setup={setup}
        problems={Object.fromEntries(
          Object.entries(problems).flatMap(([place, message]) =>
            place.startsWith('fields/') ? [[place.slice('fields/'.length), message]] : [],
          ),
        )}
        onChange={(next) => {
          onChange(field.key, next);
        }}
      />,
      false,
    );
  // Rows that stand for several members of the settings say what is wrong under each row.
  if (
    input.kind === 'members' ||
    input.kind === 'deal_filters' ||
    input.kind === 'deal_changes' ||
    input.kind === 'lead_sources' ||
    input.kind === 'deal_source'
  )
    return frame(
      <RecordSetting
        {...common}
        aria-invalid={false}
        input={input}
        label={label}
        config={config}
        setup={setup}
        problems={problems}
        onSet={onChange}
      />,
      false,
      true,
    );
  // The settings that need more than a box are fetched when first needed. Each form shows
  // every one of its own from the start, so the panel waits for their code only once.
  if (input.kind === 'branches' || input.kind === 'goal_events')
    return frame(
      <FlowSetting
        {...common}
        input={input}
        value={value}
        config={config}
        setup={setup}
        onChange={(next) => {
          onChange(field.key, next);
        }}
        onSet={onChange}
      />,
      false,
    );
  if (
    input.kind === 'automations' ||
    input.kind === 'choices' ||
    input.kind === 'step' ||
    (input.kind === 'choice' && input.radios === true)
  )
    return frame(
      <TargetSetting
        {...common}
        input={input}
        name={field.key}
        label={label}
        value={value}
        setup={setup}
        self={self}
        steps={steps}
        onChange={(next) => {
          onChange(field.key, next);
        }}
      />,
      input.kind === 'step' || (input.kind === 'automations' && !input.many),
    );
  if (input.kind === 'resume_window') {
    if (value !== undefined && resumeWindowParts(value) === undefined)
      return readOnly(settingWords(field, value, setup));
    return frame(
      // On its own, so the rest of the panel stays while its code is on the way.
      <Suspense fallback={null}>
        <ResumeWindow
          id={id}
          value={value}
          describedBy={describedBy}
          onChange={(next) => {
            onChange(field.key, next);
          }}
        />
      </Suspense>,
      false,
    );
  }
  if (input.kind === 'duration') {
    const parts = durationParts(value);
    if (value !== undefined && parts === undefined)
      return readOnly(settingWords(field, value, setup));
    const amount = parts?.amount;
    // The unit last chosen holds while the amount is empty, when there's no value to read it from.
    const unit = parts?.unit ?? unitChoice;
    const stepBy = (by: number): void => {
      onChange(field.key, durationOf(Math.max(1, (amount ?? 0) + by), unit));
    };
    const stepClassName =
      'flex size-11 shrink-0 items-center justify-center rounded-control border border-input text-body hover:bg-muted disabled:opacity-40 lg:size-9';
    return frame(
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        <button
          type="button"
          className={stepClassName}
          aria-label={t`One less: ${label}`}
          disabled={amount === undefined || amount <= 1}
          onClick={() => {
            stepBy(-1);
          }}
        >
          <Minus aria-hidden className="size-4" strokeWidth={2} />
        </button>
        <Input
          {...common}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={amount ?? ''}
          onChange={(event) => {
            const typed = event.target.valueAsNumber;
            onChange(field.key, Number.isNaN(typed) ? undefined : durationOf(typed, unit));
          }}
        />
        <button
          type="button"
          className={stepClassName}
          aria-label={t`One more: ${label}`}
          onClick={() => {
            stepBy(1);
          }}
        >
          <Plus aria-hidden className="size-4" strokeWidth={2} />
        </button>
        <Select
          aria-label={t`Unit for: ${label}`}
          value={unit}
          onValueChange={(next) => {
            const chosen = units.find(([each]) => each === next)?.[0];
            if (chosen === undefined) return;
            setUnitChoice(chosen);
            if (amount !== undefined) onChange(field.key, durationOf(amount, chosen));
          }}
        >
          {units.map(([each, name]) => (
            <option key={each} value={each}>
              {name}
            </option>
          ))}
        </Select>
      </div>,
    );
  }
  // The form a trigger starts for: a list that can be searched, which names a draft as one.
  if (input.kind === 'reference' && input.list === 'forms')
    return frame(
      <FormChoice
        id={id}
        label={label}
        value={value}
        setup={setup}
        client={client}
        problem={problem}
        describedBy={field.hint === undefined ? undefined : hintId}
        onChange={(next) => {
          onChange(field.key, next);
        }}
      />,
      true,
      true,
    );
  if (input.kind === 'choice' || input.kind === 'reference') {
    const options =
      input.kind === 'choice'
        ? input.options.map((option) => ({ value: option.value, label: i18n._(option.label) }))
        : referenceOptions(input.list, setup, config);
    const given = typeof value === 'string' ? value : undefined;
    const current = input.kind === 'choice' ? given : currentReference(options, given);
    const unknown =
      given !== undefined && given !== '' && !options.some((option) => option.value === current);
    // An optional choice with no "unset" meaning shows its first option: the contract's default.
    const blank =
      field.required || field.unset !== undefined || input.kind === 'reference'
        ? field.unset === undefined
          ? field.required
            ? t`Choose one`
            : t`Not set`
          : i18n._(field.unset)
        : undefined;
    const selected = unknown ? given : (current ?? (blank === undefined ? options[0]?.value : ''));
    return frame(
      <>
        <Select
          {...common}
          value={selected ?? ''}
          onValueChange={(next) => {
            onChange(field.key, next);
          }}
        >
          {blank === undefined ? null : <option value="">{blank}</option>}
          {unknown ? <option value={given}>{t`${given} (not found)`}</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        {input.kind === 'reference' && options.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>This business doesn't have any yet.</Trans>
          </p>
        ) : null}
      </>,
    );
  }
  const text = typeof value === 'string' ? value : '';
  // On its own, so the text can be typed into while the list's code is on the way.
  const insert =
    field.merge === true ? (
      <Suspense fallback={null}>
        <MergeInsert
          setup={setup}
          label={label}
          targetId={id}
          value={text}
          onChange={(next) => {
            onChange(field.key, next);
          }}
        />
      </Suspense>
    ) : null;
  if (input.kind === 'long_text')
    return frame(
      <>
        <Textarea
          {...common}
          rows={4}
          value={text}
          onChange={(event) => {
            onChange(field.key, event.target.value);
          }}
        />
        {insert}
      </>,
    );
  if (input.kind === 'number')
    return frame(
      <Input
        {...common}
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        value={typeof value === 'number' ? value : ''}
        onChange={(event) => {
          const typed = event.target.valueAsNumber;
          onChange(field.key, Number.isNaN(typed) ? undefined : typed);
        }}
      />,
    );
  return frame(
    <>
      <Input
        {...common}
        placeholder={input.placeholder}
        value={text}
        onChange={(event) => {
          onChange(field.key, event.target.value);
        }}
      />
      {insert}
    </>,
  );
}
