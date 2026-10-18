// Adding, changing and removing steps and triggers, for whichever view the person is in. The
// Steps view and the Canvas view both ask here, so a step is added through the same form,
// removed after the same question, and lands in the same draft, whichever view asked.
//
// The forms themselves (every step's settings, with the themed lists they need) are fetched
// the first time one is opened, so opening an automation to read it doesn't wait for them.
// If their code doesn't arrive, the builder says so and nothing of the draft is lost.
import { Plural, Trans } from '@lingui/react/macro';
import type { AutomationSetup, MessageTemplate } from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { CatchBoundary } from '@tanstack/react-router';
import { lazy, Suspense, useRef, useState, type ReactElement } from 'react';
import { AutomationDialog } from './automation-dialog';
import {
  addStep,
  addTrigger,
  newStepId,
  outlineOf,
  removalEffect,
  removeStep,
  removeTrigger,
  stepOf,
  stepsOf,
  triggersOf,
  updateStepConfig,
  type Draft,
  type InsertAt,
  type OutlineItem,
} from './automation-document';
import { duplicateTrigger, setStepLabel, updateTrigger } from './automation-edits';
import {
  JSON_EDITOR_ID,
  STEPS_HEADING_ID,
  stepElementId,
  triggerElementId,
} from './automation-element-ids';
import type { ShownIssue } from './automation-issues';
import { pointerToken } from './automation-json';
import type { EmailCommand } from './automation-email-copy';
import type { AutomationCatalogData } from './automation-step-dialog';
import { problemsAt } from './automation-step-problems';
import { stepName, triggerLabel, triggerSummary } from './automation-summary';

const SettingsDialog = lazy(() =>
  import('./automation-step-dialog').then((module) => ({ default: module.SettingsDialog })),
);

/**
 * What saving a Send email action asks of the server beyond the draft itself: a template
 * newly named is copied into the action, and one it newly syncs with is linked.
 */
function emailLink(
  config: Readonly<Record<string, unknown>>,
  before: Readonly<Record<string, unknown>>,
): Pick<EmailCommand & { kind: 'copy' | 'sync' }, 'kind' | 'template'> | undefined {
  const synced = (each: Readonly<Record<string, unknown>>): unknown =>
    each['mode'] === 'sync' ? (each['source'] as { readonly id?: unknown } | undefined)?.id : null;
  const source = synced(config);
  if (typeof source === 'string')
    return source === synced(before) ? undefined : { kind: 'sync', template: source };
  const template = config['template'];
  return typeof template === 'string' && template !== before['template']
    ? { kind: 'copy', template }
    : undefined;
}

/** What the boundary shows itself: nothing, since the dialog below says what happened. */
function Nothing(): null {
  return null;
}

/**
 * Makes room in a drawing for a step just added: given the draft before, the draft with the
 * step in it and the step's id, it answers the draft to keep. The canvas has one.
 */
export type PlaceAddedStep = (before: Draft, after: Draft, added: string) => Draft;

type Editing =
  | {
      readonly kind: 'add-step';
      readonly at: InsertAt;
      readonly type: string | undefined;
      readonly place: PlaceAddedStep | undefined;
    }
  | { readonly kind: 'edit-step'; readonly id: string }
  | { readonly kind: 'add-trigger' }
  | { readonly kind: 'edit-trigger'; readonly index: number };

type Removing =
  | { readonly kind: 'step'; readonly id: string }
  | { readonly kind: 'trigger'; readonly index: number };

export interface StepEditing {
  /**
   * Opens the form for a new step at a place in the flow; with a type, straight to its
   * settings. A view that draws the steps says how to make room for the new one.
   */
  readonly addStep: (at: InsertAt, type?: string, place?: PlaceAddedStep) => void;
  readonly editStep: (id: string) => void;
  /** Asks first, saying what removing it does to the flow. */
  readonly removeStep: (id: string) => void;
  readonly addTrigger: () => void;
  readonly editTrigger: (index: number) => void;
  readonly removeTrigger: (index: number) => void;
  /** Adds a copy of a trigger, right after it. */
  readonly duplicateTrigger: (index: number) => void;
  /** The step or trigger whose panel is open, for a view to mark it. */
  readonly selected:
    | { readonly kind: 'step'; readonly id: string }
    | { readonly kind: 'trigger'; readonly index: number }
    | undefined;
  /** The dialogs themselves: rendered once, by whoever owns the draft. */
  readonly dialogs: ReactElement;
}

export function useStepEditing({
  draft,
  setup,
  catalog,
  client,
  automationId,
  issues = [],
  onChange,
  onEditInJson,
  onEmailCommand,
}: {
  readonly draft: Draft;
  readonly setup: AutomationSetup;
  readonly catalog: AutomationCatalogData;
  /** The business's API, for a panel that reads more than the setup holds. */
  readonly client?: Client | undefined;
  /** The automation the draft is of, which none of its steps can start or name. */
  readonly automationId?: string | undefined;
  /** What the checks found, so a step's panel opens with what is wrong under its settings. */
  readonly issues?: readonly ShownIssue[];
  readonly onChange: (draft: Draft) => void;
  /**
   * Asks the server for what a Send email action's save needs beyond the draft (a copy of
   * a template, a link to one, an edit of the template it syncs with); it adopts the draft
   * that comes back, and answers the template when the command saved one.
   */
  readonly onEmailCommand?:
    ((command: EmailCommand) => Promise<MessageTemplate | undefined>) | undefined;
  /** Opens the JSON view at a place in the document, by JSON Pointer. */
  readonly onEditInJson: (pointer: string) => void;
}): StepEditing {
  const [editing, setEditing] = useState<Editing>();
  const [removing, setRemoving] = useState<Removing>();
  // Once a form has been asked for, its dialog stays, so it can close as dialogs do and
  // give the keyboard back; before that, nothing of the forms has been fetched.
  const [formsWanted, setFormsWanted] = useState(false);
  const [formsFailed, setFormsFailed] = useState(false);
  const edit = (next: Editing): void => {
    setFormsWanted(true);
    setEditing(next);
  };
  // Where the keyboard goes when a dialog closes after a change: to what was added or
  // changed (Base UI puts it on that card's first control), or to the view's heading when
  // the thing it came from is gone.
  // And when a dialog sends the person to the JSON view, to the text there: while the
  // dialog is open nothing outside it can take the keyboard, so the dialog hands it over
  // as it closes.
  const focusAfterRef = useRef<string | undefined>(undefined);
  const finalFocus = (): HTMLElement | null => {
    const id = focusAfterRef.current;
    focusAfterRef.current = undefined;
    return id === undefined ? null : document.getElementById(id);
  };

  const triggers = triggersOf(draft);
  // The answers of the forms this workflow starts from, for the panels' lists of fields.
  const submissionForms = triggers
    .filter((trigger) => trigger.type === 'form.submitted')
    .map((trigger) => trigger.config['form']);
  // The steps in the order a contact meets them, for the panel's previous and next.
  const order: string[] = [];
  const walk = (items: readonly OutlineItem[]): void => {
    for (const item of items) {
      if (item.kind !== 'step') continue;
      order.push(item.step.id);
      for (const branch of item.branches) walk(branch.items);
    }
  };
  const outline = outlineOf(draft);
  walk(outline.main.items);
  for (const path of outline.detached) walk(path.items);
  const place = editing?.kind === 'edit-step' ? order.indexOf(editing.id) : -1;
  const before = place > 0 ? order[place - 1] : undefined;
  const after = place >= 0 ? order[place + 1] : undefined;
  const nameOfStep = (id: string): string => {
    const step = stepOf(draft, id);
    return step === undefined ? id : stepName(step, setup);
  };
  const editingStep = editing?.kind === 'edit-step' ? stepOf(draft, editing.id) : undefined;
  const editingTrigger = editing?.kind === 'edit-trigger' ? triggers[editing.index] : undefined;
  const settingsOwner =
    editing?.kind === 'add-trigger' || editing?.kind === 'edit-trigger' ? 'trigger' : 'step';
  const removingStep = removing?.kind === 'step' ? stepOf(draft, removing.id) : undefined;
  const removingTrigger = removing?.kind === 'trigger' ? triggers[removing.index] : undefined;
  const effect = removing?.kind === 'step' ? removalEffect(draft, removing.id) : undefined;
  const joinsTo = effect?.joinsTo === undefined ? undefined : nameOfStep(effect.joinsTo);
  const cutOff = effect?.cutOff.length ?? 0;

  const settings = !formsWanted ? null : (
    <CatchBoundary
      getResetKey={() => 'automation-step-forms'}
      errorComponent={Nothing}
      onCatch={() => {
        setEditing(undefined);
        setFormsFailed(true);
      }}
    >
      <Suspense fallback={null}>
        <SettingsDialog
          open={editing !== undefined}
          onOpenChange={(open) => {
            if (!open) setEditing(undefined);
          }}
          owner={settingsOwner}
          editing={
            editingStep !== undefined
              ? {
                  key: `step:${editingStep.id}`,
                  type: editingStep.type,
                  config: editingStep.config,
                  label: editingStep.label,
                  // What is refused of a Go To or a goal as a whole is about its one setting.
                  problems: problemsAt(
                    issues,
                    editingStep.id,
                    editingStep.type === 'goto'
                      ? 'target'
                      : editingStep.type === 'goal'
                        ? 'events'
                        : undefined,
                  ),
                }
              : editingTrigger !== undefined
                ? {
                    key: `trigger:${editingTrigger.id}`,
                    type: editingTrigger.type,
                    config: editingTrigger.config,
                    condition: editingTrigger.condition,
                    problems:
                      editing?.kind === 'edit-trigger'
                        ? problemsAt(issues, editing.index)
                        : undefined,
                  }
                : undefined
          }
          onDelete={
            editing?.kind === 'edit-step'
              ? () => {
                  setRemoving({ kind: 'step', id: editing.id });
                }
              : editing?.kind === 'edit-trigger' && triggers.length > 1
                ? () => {
                    setRemoving({ kind: 'trigger', index: editing.index });
                  }
                : undefined
          }
          onPrevious={
            before === undefined
              ? undefined
              : () => {
                  setEditing({ kind: 'edit-step', id: before });
                }
          }
          onNext={
            after === undefined
              ? undefined
              : () => {
                  setEditing({ kind: 'edit-step', id: after });
                }
          }
          presetType={editing?.kind === 'add-step' ? editing.type : undefined}
          catalog={catalog}
          setup={setup}
          submissionForms={submissionForms}
          client={client}
          automationId={automationId}
          email={
            automationId === undefined
              ? undefined
              : {
                  automationId,
                  step: editingStep?.id,
                  saved: editingStep?.config,
                  saveSynced:
                    editingStep === undefined || onEmailCommand === undefined
                      ? undefined
                      : async (change) => {
                          const template = await onEmailCommand({
                            kind: 'save',
                            document: draft,
                            step: editingStep.id,
                            edit: change,
                          });
                          if (template === undefined) throw new Error('No template came back.');
                          return template;
                        },
                }
          }
          steps={order
            .filter((id) => editing?.kind !== 'edit-step' || id !== editing.id)
            .map((id) => ({ id, name: nameOfStep(id) }))}
          taken={stepsOf(draft).some((step) => step.type === 'goal') ? ['goal'] : []}
          finalFocus={finalFocus}
          onEditInJson={
            editing?.kind === 'edit-step'
              ? () => {
                  focusAfterRef.current = JSON_EDITOR_ID;
                  onEditInJson(`/steps/${pointerToken(editing.id)}`);
                }
              : editing?.kind === 'edit-trigger'
                ? () => {
                    focusAfterRef.current = JSON_EDITOR_ID;
                    onEditInJson(`/triggers/${String(editing.index)}`);
                  }
                : undefined
          }
          onSubmit={async (type, config, extras) => {
            if (editing === undefined) return;
            if (editing.kind === 'add-step') {
              const id = newStepId(draft, type);
              focusAfterRef.current = stepElementId(id);
              const added = addStep(draft, editing.at, { id, type, config, label: extras.label });
              const next = editing.place?.(draft, added, id) ?? added;
              const link = type === 'email.send' ? emailLink(config, {}) : undefined;
              if (link !== undefined && onEmailCommand !== undefined)
                await onEmailCommand({ ...link, document: next, step: id });
              else onChange(next);
            } else if (editing.kind === 'edit-step') {
              focusAfterRef.current = stepElementId(editing.id);
              const next = setStepLabel(
                updateStepConfig(draft, editing.id, config),
                editing.id,
                extras.label,
              );
              const previous = stepOf(draft, editing.id);
              const link =
                type === 'email.send' ? emailLink(config, previous?.config ?? {}) : undefined;
              if (link !== undefined && onEmailCommand !== undefined)
                await onEmailCommand({ ...link, document: next, step: editing.id });
              else onChange(next);
            } else if (editing.kind === 'add-trigger') {
              focusAfterRef.current = triggerElementId(triggers.length);
              onChange(addTrigger(draft, { type, config, condition: extras.condition }));
            } else {
              focusAfterRef.current = triggerElementId(editing.index);
              onChange(
                updateTrigger(draft, editing.index, {
                  type,
                  config,
                  condition: extras.condition,
                }),
              );
            }
          }}
        />
      </Suspense>
    </CatchBoundary>
  );

  const dialogs = (
    <>
      {settings}
      <AutomationDialog
        open={formsFailed}
        onOpenChange={(open) => {
          if (!open) setFormsFailed(false);
        }}
        title={<Trans>This form couldn't load</Trans>}
      >
        <p className="text-md">
          <Trans>Your draft is as you left it. Save it, then reload the page to try again.</Trans>
        </p>
      </AutomationDialog>

      <AutomationDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        finalFocus={finalFocus}
        title={
          removing?.kind === 'trigger' ? (
            <Trans>Delete this trigger?</Trans>
          ) : (
            <Trans>Delete this action?</Trans>
          )
        }
      >
        <div className="flex min-w-0 flex-col gap-2 text-md">
          <p className="font-medium wrap-anywhere">
            {removingStep !== undefined
              ? stepName(removingStep, setup)
              : removingTrigger !== undefined
                ? (triggerSummary(removingTrigger, setup) ??
                  triggerLabel(removingTrigger.type) ??
                  removingTrigger.type)
                : null}
          </p>
          {removing?.kind === 'step' ? (
            <p className="wrap-anywhere">
              {joinsTo === undefined ? (
                <Trans>The path will end where this action was.</Trans>
              ) : (
                <Trans>What came before it will lead straight to: {joinsTo}</Trans>
              )}
            </p>
          ) : (
            <p>
              <Trans>The workflow will no longer start this way.</Trans>
            </p>
          )}
          {cutOff === 0 ? null : (
            <p>
              <Plural
                value={cutOff}
                one="# action on its other branches will no longer be connected. It stays in the workflow, under Not connected, until you delete it."
                other="# actions on its other branches will no longer be connected. They stay in the workflow, under Not connected, until you delete them."
              />
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            <Trans>Nothing is saved until you save the workflow.</Trans>
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="quiet"
            data-initial-focus
            onClick={() => {
              setRemoving(undefined);
            }}
          >
            <Trans>Keep it</Trans>
          </Button>
          <Button
            onClick={() => {
              if (removing === undefined) return;
              focusAfterRef.current = STEPS_HEADING_ID;
              onChange(
                removing.kind === 'step'
                  ? removeStep(draft, removing.id)
                  : removeTrigger(draft, removing.index),
              );
              setRemoving(undefined);
            }}
          >
            {removing?.kind === 'trigger' ? (
              <Trans>Delete trigger</Trans>
            ) : (
              <Trans>Delete action</Trans>
            )}
          </Button>
        </div>
      </AutomationDialog>
    </>
  );

  return {
    addStep: (at, type, place) => {
      edit({ kind: 'add-step', at, type, place });
    },
    editStep: (id) => {
      edit({ kind: 'edit-step', id });
    },
    removeStep: (id) => {
      setRemoving({ kind: 'step', id });
    },
    addTrigger: () => {
      edit({ kind: 'add-trigger' });
    },
    editTrigger: (index) => {
      edit({ kind: 'edit-trigger', index });
    },
    removeTrigger: (index) => {
      setRemoving({ kind: 'trigger', index });
    },
    duplicateTrigger: (index) => {
      onChange(duplicateTrigger(draft, index));
    },
    selected:
      editing?.kind === 'edit-step'
        ? { kind: 'step', id: editing.id }
        : editing?.kind === 'edit-trigger'
          ? { kind: 'trigger', index: editing.index }
          : undefined,
    dialogs,
  };
}
