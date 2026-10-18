// The Steps view (docs/AUTOMATIONS.md section 9): the automation as a list in plain words,
// written from the document. What starts it, each step in the order a contact meets it with
// every branch under its step, and what stops it. Someone who may change automations can
// add, edit and remove steps and triggers here; each change is made to the same draft the
// JSON and Canvas views show.
import { Trans, useLingui } from '@lingui/react/macro';
import type { AutomationSetup } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Hand, Plus, type LucideIcon } from 'lucide-react';
import { useMemo, type ReactElement, type ReactNode } from 'react';
import {
  canRemoveTrigger,
  outlineOf,
  stepOf,
  stopsOf,
  subjectOf,
  triggersOf,
  type Draft,
  type InsertAt,
  type OutlineItem,
  type OutlinePath,
  type StepView,
  type TriggerView,
} from './automation-document';
import { fieldsOf } from './automation-fields';
import { stepIcon, triggerIcon } from './automation-icons';
import { IssueLine, type ShownIssue } from './automation-issues';
import { pointerToken } from './automation-json';
import { STEPS_HEADING_ID, stepElementId, triggerElementId } from './automation-element-ids';
import type { StepEditing } from './automation-step-editing';
import {
  branchLabel,
  stepLabel,
  stepName,
  stepSummary,
  stopSummary,
  triggerLabel,
  triggerSummary,
} from './automation-summary';

export interface StepsViewProps {
  readonly draft: Draft;
  readonly setup: AutomationSetup;
  readonly issues: readonly ShownIssue[];
  /** Whether the person may change the draft, and it can be changed right now. */
  readonly editable: boolean;
  /** Adds, changes and removes steps and triggers, with the forms and questions they need. */
  readonly editing: StepEditing;
  /** Opens the JSON view at a place in the document, by JSON Pointer. */
  readonly onEditInJson: (pointer: string) => void;
}

function Card({
  id,
  label,
  icon: Icon,
  caption,
  children,
  actions,
  issues,
}: {
  readonly id: string;
  /** What a screen reader says when the keyboard is brought here. */
  readonly label: string;
  readonly icon: LucideIcon;
  readonly caption: string;
  readonly children: ReactNode;
  readonly actions: ReactNode;
  readonly issues: readonly ShownIssue[];
}): ReactElement {
  return (
    <div
      id={id}
      role="group"
      aria-label={label}
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-2 rounded-2xl bg-background px-4 py-3.5 outline-offset-2"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-2">
        <span
          aria-hidden
          className="flex size-10 flex-none items-center justify-center rounded-full border border-border bg-card"
        >
          <Icon className="size-5" strokeWidth={1.8} />
        </span>
        <span className="flex min-w-0 flex-1 basis-44 flex-col gap-0.5">
          <span className="text-[13px] text-muted-foreground">{caption}</span>
          <span className="text-base font-medium wrap-anywhere">{children}</span>
        </span>
        {actions}
      </div>
      {issues.length === 0 ? null : (
        <ul className="flex min-w-0 flex-col gap-1.5">
          {issues.map((issue, position) => (
            <li key={`${issue.path}:${issue.code}:${String(position)}`}>
              <IssueLine issue={issue} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const Connector = (): ReactElement => <div aria-hidden className="ml-[35px] h-4 w-0.5 bg-input" />;

export function StepsView({
  draft,
  setup,
  issues,
  editable,
  editing,
  onEditInJson,
}: StepsViewProps): ReactElement {
  const { t } = useLingui();
  const outline = useMemo(() => outlineOf(draft), [draft]);

  const triggers = triggersOf(draft);
  const stops = stopsOf(draft);
  const about = (issue: ShownIssue): ReturnType<typeof subjectOf> => subjectOf(issue.path);
  const stepIssues = (id: string): ShownIssue[] =>
    issues.filter((issue) => {
      const subject = about(issue);
      return subject.kind === 'step' && subject.id === id;
    });
  const triggerIssues = (index: number): ShownIssue[] =>
    issues.filter((issue) => {
      const subject = about(issue);
      return subject.kind === 'trigger' && subject.index === index;
    });
  const nameOfStep = (id: string): string => {
    const step = stepOf(draft, id);
    return step === undefined ? id : stepName(step, setup);
  };

  const addButton = (at: InsertAt, label: string, text: ReactNode): ReactElement => (
    <Button
      variant="quiet"
      size="small"
      className="self-start"
      aria-label={label}
      onClick={() => {
        editing.addStep(at);
      }}
    >
      <Plus aria-hidden className="size-4" strokeWidth={1.8} />
      {text}
    </Button>
  );

  const stepCard = (step: StepView): ReactElement => {
    const name = stepName(step, setup);
    const summary = stepSummary(step, setup);
    const known = fieldsOf('step', step.type) !== undefined;
    const { type } = step;
    return (
      <Card
        id={stepElementId(step.id)}
        label={name}
        icon={stepIcon(step.type)}
        caption={step.label ?? stepLabel(step.type) ?? t`Unknown step: ${type}`}
        issues={stepIssues(step.id)}
        actions={
          editable ? (
            <span className="flex flex-none flex-wrap gap-1">
              <Button
                variant="quiet"
                size="small"
                aria-label={known ? t`Edit: ${name}` : t`Edit in JSON: ${name}`}
                onClick={() => {
                  if (known) editing.editStep(step.id);
                  else onEditInJson(`/steps/${pointerToken(step.id)}`);
                }}
              >
                {known ? <Trans>Edit</Trans> : <Trans>Edit in JSON</Trans>}
              </Button>
              <Button
                variant="quiet"
                size="small"
                aria-label={t`Remove: ${name}`}
                onClick={() => {
                  editing.removeStep(step.id);
                }}
              >
                <Trans>Remove</Trans>
              </Button>
            </span>
          ) : null
        }
      >
        {summary ?? (
          <span className="text-muted-foreground">
            <Trans>Not set up yet</Trans>
          </span>
        )}
      </Card>
    );
  };

  const ending = (item: Exclude<OutlineItem, { kind: 'step' }>): ReactElement => {
    const target = item.kind === 'end' ? '' : nameOfStep(item.to);
    return (
      <p className="py-1 pl-1 text-sm text-muted-foreground">
        {item.kind === 'end' ? (
          <Trans>Then it ends.</Trans>
        ) : item.kind === 'back' ? (
          <Trans>Then it goes back to: {target}</Trans>
        ) : item.kind === 'join' ? (
          <Trans>Then it carries on at: {target}</Trans>
        ) : (
          <Trans>Then it leads to a step that isn't there: {target}</Trans>
        )}
      </p>
    );
  };

  const pathList = (path: OutlinePath, place: string | undefined): ReactElement => {
    const [first] = path.items;
    const empty = first?.kind !== 'step';
    return (
      <ol className="flex min-w-0 list-none flex-col">
        {editable && path.at !== undefined ? (
          <li className="flex flex-col">
            {addButton(
              path.at,
              place === undefined ? t`Add an action at the start` : t`Add an action to: ${place}`,
              <Trans>Add a step</Trans>,
            )}
            {empty ? null : <Connector />}
          </li>
        ) : null}
        {path.items.map((item, position) => {
          if (item.kind !== 'step')
            return (
              <li key={`${item.kind}:${String(position)}`} className="flex flex-col">
                {ending(item)}
              </li>
            );
          const { step } = item;
          const name = stepName(step, setup);
          const linear = item.branches.length === 0;
          return (
            <li key={step.id} className="flex min-w-0 flex-col">
              {stepCard(step)}
              {linear ? (
                <>
                  <Connector />
                  {editable ? (
                    <>
                      {addButton(
                        { kind: 'after', step: step.id },
                        t`Add an action after: ${name}`,
                        <Trans>Add a step</Trans>,
                      )}
                      {path.items[position + 1]?.kind === 'step' ? <Connector /> : null}
                    </>
                  ) : null}
                </>
              ) : (
                <div className="mt-3 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(230px,100%),1fr))] gap-3">
                  {item.branches.map((branch) => {
                    const label = branchLabel(step, branch.name);
                    return (
                      // A group, not a landmark: two If / else steps both have an "If yes".
                      <div
                        key={branch.name}
                        role="group"
                        aria-label={label}
                        className="flex min-w-0 flex-col gap-2 rounded-2xl border border-dashed border-input p-3"
                      >
                        <h3 className="text-sm font-semibold">{label}</h3>
                        {pathList(branch, label)}
                      </div>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    );
  };

  const triggerCard = (trigger: TriggerView): ReactElement => {
    const summary = triggerSummary(trigger, setup);
    const name = summary ?? triggerLabel(trigger.type) ?? trigger.type;
    const known = fieldsOf('trigger', trigger.type) !== undefined;
    const { type } = trigger;
    return (
      <li key={`${String(trigger.index)}:${trigger.id}`}>
        <Card
          id={triggerElementId(trigger.index)}
          label={t`Starts when: ${name}`}
          icon={triggerIcon(type)}
          caption={t`Starts when`}
          issues={triggerIssues(trigger.index)}
          actions={
            editable ? (
              <span className="flex flex-none flex-wrap gap-1">
                <Button
                  variant="quiet"
                  size="small"
                  aria-label={known ? t`Edit: ${name}` : t`Edit in JSON: ${name}`}
                  onClick={() => {
                    if (known) editing.editTrigger(trigger.index);
                    else onEditInJson(`/triggers/${String(trigger.index)}`);
                  }}
                >
                  {known ? <Trans>Edit</Trans> : <Trans>Edit in JSON</Trans>}
                </Button>
                {canRemoveTrigger(draft) ? (
                  <Button
                    variant="quiet"
                    size="small"
                    aria-label={t`Remove: ${name}`}
                    onClick={() => {
                      editing.removeTrigger(trigger.index);
                    }}
                  >
                    <Trans>Remove</Trans>
                  </Button>
                ) : null}
              </span>
            ) : null
          }
        >
          {summary ??
            (triggerLabel(trigger.type) === undefined ? (
              t`Unknown trigger: ${type}`
            ) : (
              <span className="text-muted-foreground">
                <Trans>Not set up yet</Trans>
              </span>
            ))}
        </Card>
      </li>
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section
        aria-labelledby={STEPS_HEADING_ID}
        className="flex min-w-0 flex-col gap-3.5 rounded-card border border-border bg-card p-5"
      >
        <h2 id={STEPS_HEADING_ID} tabIndex={-1} className="text-lg font-semibold outline-offset-4">
          <Trans>Steps</Trans>
        </h2>
        {triggers.length === 0 ? (
          <p className="text-md text-muted-foreground">
            <Trans>
              Nothing starts this automation on its own. Add a way to start it, or leave it so if
              another automation starts it.
            </Trans>
          </p>
        ) : (
          <ul aria-label={t`What starts it`} className="flex min-w-0 list-none flex-col gap-2">
            {triggers.map(triggerCard)}
          </ul>
        )}
        {editable ? (
          <Button
            variant="quiet"
            size="small"
            className="self-start"
            onClick={() => {
              editing.addTrigger();
            }}
          >
            <Plus aria-hidden className="size-4" strokeWidth={1.8} />
            <Trans>Add trigger</Trans>
          </Button>
        ) : null}
        <div aria-hidden className="h-px bg-border" />
        {outline.main.items[0]?.kind === 'end' ? (
          <>
            <p className="text-md text-muted-foreground">
              <Trans>This automation has no steps yet.</Trans>
            </p>
            {editable
              ? addButton(
                  { kind: 'start' },
                  t`Add the first action`,
                  <Trans>Add the first action</Trans>,
                )
              : null}
          </>
        ) : (
          pathList(outline.main, undefined)
        )}
      </section>

      {outline.detached.length === 0 ? null : (
        <section
          aria-label={t`Not connected`}
          className="flex min-w-0 flex-col gap-3.5 rounded-card border border-dashed border-input bg-card p-5"
        >
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            <Trans>Not connected</Trans>
            <Badge variant="attention" size="count" className="h-auto px-2.5 py-0.5 text-xs">
              <Trans>Never runs</Trans>
            </Badge>
          </h2>
          <p className="text-md text-muted-foreground">
            <Trans>
              Nothing leads to these steps, so no contact reaches them. Remove them, or link a step
              to them in the JSON view.
            </Trans>
          </p>
          {outline.detached.map((path) => {
            const [head] = path.items;
            return (
              <div key={head?.kind === 'step' ? head.step.id : 'empty'} className="min-w-0">
                {pathList(path, undefined)}
              </div>
            );
          })}
        </section>
      )}

      <section
        aria-label={t`Stops as soon as`}
        className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-5"
      >
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Hand aria-hidden className="size-5" strokeWidth={1.8} />
          <Trans>Stops as soon as</Trans>
        </h2>
        {stops.length === 0 ? (
          <p className="text-md text-muted-foreground">
            <Trans>
              Nothing stops it early. Each contact goes through to the end of their path.
            </Trans>
          </p>
        ) : (
          <ul className="flex min-w-0 list-disc flex-col gap-1 pl-5 text-md">
            {stops.map((stop) => {
              const { event } = stop;
              return (
                <li key={stop.index} className="wrap-anywhere">
                  {stopSummary(stop) ?? t`Unknown event: ${event}`}
                </li>
              );
            })}
          </ul>
        )}
        {editable ? (
          <Button
            variant="secondary"
            size="small"
            className="self-start"
            aria-label={t`Edit in JSON: what stops it`}
            onClick={() => {
              onEditInJson('/stopWhen');
            }}
          >
            <Trans>Edit in JSON</Trans>
          </Button>
        ) : null}
      </section>
    </div>
  );
}
