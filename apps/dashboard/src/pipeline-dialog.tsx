// The dialog that creates a pipeline or edits one, laid out as GoHighLevel's: the name,
// "Use opportunity-level probability", the display colors, then the stages as one compact
// table with a row each: a handle, the name, the two "Show in reports" toggles, the
// probability and a delete or archive button; with display colors on, a row also has its
// stage's color, chosen from the design system's tokens (pipeline-stage-colors.ts).
// Everything shown is what the server keeps (packages/contracts/src/pipelines.ts). The
// pipeline's description and each stage's description are not in GoHighLevel's dialog; they
// are kept, behind "More options" and behind each row's details button; "More options" also
// has whether the pipeline itself shows in the two charts. Saving sends the whole
// configuration under the revision the dialog opened with; a stale one is refused, and the
// draft is kept until the person asks for the saved version. Leaving with unsaved changes,
// by any way out, asks first. The body scrolls between a header and a footer that stay put,
// so the footer never lies over a stage. Fetched when it first opens.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getPipelines,
  pipelineColorStyles,
  savePipelines,
  savePipelinesInput,
  type Pipeline,
  type PipelineColorStyle,
  type PipelineConfiguration,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import {
  Archive,
  ArchiveRestore,
  ChartPie,
  ChevronDown,
  Funnel,
  GripVertical,
  Info,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';

import { apiIn } from './api';
import { Switch } from './automation-switch';
import {
  draftInput,
  draftOf,
  isReady,
  moved,
  newDraft,
  newStage,
  probabilityIsValid,
  probabilityTyped,
  sameDraft,
  type PipelineDraft,
  type StageDraft,
} from './pipeline-rules';
import { stageColorChoices, stageColorOf, type StageColorChoice } from './pipeline-stage-colors';
import { iconButtonClassName, returnTo } from './settings-list';

const STAGE_LIMIT = 100;

// One row of the stages table and its headings share these columns from 640px up: handle,
// name, reports, probability, details, delete. Below that a row is two lines: the handle,
// the name and the two buttons, then the toggles and the probability under the name.
const wideColumnsClassName =
  'sm:grid-cols-[44px_minmax(0,1fr)_132px_124px_44px_44px] lg:grid-cols-[32px_minmax(0,1fr)_132px_124px_32px_32px]';
const rowClassName = `grid grid-cols-[44px_minmax(0,1fr)_44px_44px] items-center gap-x-2 gap-y-1 border-b border-border px-2 py-1 last:border-b-0 ${wideColumnsClassName}`;
const headingsClassName = `hidden items-center gap-x-2 border-b border-border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground sm:grid ${wideColumnsClassName}`;
const cardClassName = 'flex min-w-0 gap-3 rounded-lg border border-border p-3';
const hintButtonClassName =
  'inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground -outline-offset-2 hover:text-foreground aria-expanded:text-link';

type Hint = 'reports' | 'probability';

/** A round swatch to press: as tall as a finger needs, 32px beside the page. */
const swatchButtonClassName =
  'flex size-11 shrink-0 items-center justify-center rounded-full border-2 border-transparent -outline-offset-2 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:border-primary lg:size-8';

/**
 * The colors a stage can have, as swatches: the design system's tokens, each saved as the
 * value the page gives it. A token the page gives no plain color is not offered.
 */
function StageColors({
  id,
  label,
  names,
  value,
  disabled,
  onChange,
}: {
  readonly id: string;
  /** What the group is for, such as "Color of New Lead". */
  readonly label: string;
  readonly names: Readonly<Record<StageColorChoice['key'], string>>;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onChange: (color: string | null) => void;
}): ReactElement {
  // The tokens as the page has them when the swatches open.
  const [styles] = useState(() => getComputedStyle(document.documentElement));
  return (
    <div id={id} role="group" aria-label={label} className="flex min-w-0 flex-wrap items-center">
      {stageColorChoices.map((choice) => {
        const color = stageColorOf(choice, styles);
        return color === undefined ? null : (
          <button
            key={choice.key}
            type="button"
            aria-label={names[choice.key]}
            title={names[choice.key]}
            aria-pressed={value === color}
            disabled={disabled}
            className={swatchButtonClassName}
            onClick={() => {
              onChange(color);
            }}
          >
            <span aria-hidden className={`size-5 rounded-full ${choice.className}`} />
          </button>
        );
      })}
      <Button
        variant="quiet"
        size="small"
        aria-pressed={value === null}
        disabled={disabled}
        className="min-h-11 aria-pressed:text-link lg:min-h-8"
        onClick={() => {
          onChange(null);
        }}
      >
        <Trans>No color</Trans>
      </Button>
    </div>
  );
}

export default function PipelineDialog({
  configuration,
  pipeline,
  businessId,
  returnFocus,
  onClose,
  onSaved,
}: {
  /** The pipelines as they were read when the dialog opened, and their revision. */
  readonly configuration: PipelineConfiguration;
  /** The pipeline to edit, or undefined to create one. */
  readonly pipeline: Pipeline | undefined;
  readonly businessId: string;
  readonly returnFocus: RefObject<HTMLElement | null>;
  /** Asks to close: the page takes the dialog out of the address. */
  readonly onClose: () => void;
  readonly onSaved: (configuration: PipelineConfiguration, created: boolean) => void;
}): ReactElement {
  const { t } = useLingui();
  const client = apiIn(businessId);
  const creating = pipeline === undefined;
  // What the draft is compared with and saved over: replaced only by "Reload saved version".
  const [base, setBase] = useState(configuration);
  const [initial, setInitial] = useState<PipelineDraft>(() =>
    pipeline === undefined
      ? newDraft([t`New Lead`, t`Contacted`, t`Proposal Sent`, t`Closed`])
      : draftOf(pipeline),
  );
  const [draft, setDraft] = useState(initial);
  const [problem, setProblem] = useState<string>();
  const [moveNotice, setMoveNotice] = useState('');
  // A name is asked for once it was typed in and emptied. Never when its box is left: a
  // message that appears as the keyboard leaves moves what is under the pointer, and the
  // press that took the keyboard away would land on something else.
  const [edited, setEdited] = useState<ReadonlySet<string>>(() => new Set());
  const [openDetails, setOpenDetails] = useState<ReadonlySet<string>>(() => new Set());
  const [openColors, setOpenColors] = useState<ReadonlySet<string>>(() => new Set());
  const [moreOpen, setMoreOpen] = useState(false);
  const [hint, setHint] = useState<Hint>();
  const keepRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const savedRef = useRef(false);
  const baseId = useId();
  const canManage = base.canManage;
  const dirty = !sameDraft(draft, initial);
  const ready = isReady(draft);

  const save = useMutation({
    mutationFn: () =>
      client.request(savePipelines, {
        body: savePipelinesInput.parse(draftInput(base, draft)),
      }),
    onSuccess: (saved) => {
      savedRef.current = true;
      onSaved(saved, creating);
    },
    onError: (error) => {
      setProblem(
        error instanceof ApiError
          ? (error.problem.detail ?? t`Check the pipeline and stage names, then try again.`)
          : t`We couldn't save the pipeline. Try again.`,
      );
    },
  });
  const reload = useMutation({
    mutationFn: () => client.request(getPipelines, {}),
    onSuccess: (latest) => {
      const saved = latest.items.find((item) => item.id === pipeline?.id);
      setBase(latest);
      if (saved !== undefined) {
        const next = draftOf(saved);
        setInitial(next);
        setDraft(next);
      }
      save.reset();
      setProblem(undefined);
    },
    onError: () => {
      setProblem(t`We couldn't reload the pipelines. Try again.`);
    },
  });
  const busy = save.isPending || reload.isPending;
  const locked = !canManage || busy;
  const stale = save.error instanceof ApiError && save.error.status === 409;

  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !savedRef.current,
    enableBeforeUnload: () => dirty && !savedRef.current,
    withResolver: true,
  });

  const change = (next: Partial<PipelineDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
  };
  const changeStage = (key: string, next: Partial<StageDraft>) => {
    setDraft((current) => ({
      ...current,
      stages: current.stages.map((stage) => (stage.key === key ? { ...stage, ...next } : stage)),
    }));
  };
  const markEdited = (key: string) => {
    setEdited((current) => (current.has(key) ? current : new Set(current).add(key)));
  };
  const toggled = (current: ReadonlySet<string>, key: string): ReadonlySet<string> => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  };
  const toggleDetails = (key: string) => {
    setOpenDetails((current) => toggled(current, key));
  };
  const toggleColors = (key: string) => {
    setOpenColors((current) => toggled(current, key));
  };

  // Reordering: the handle moves its stage with the arrow keys, or by dragging it over the
  // stage whose place it takes. A row moved in the page loses the keyboard, so the handle
  // is given it back once the new order is drawn.
  const rowsRef = useRef(new Map<string, HTMLLIElement>());
  const handlesRef = useRef(new Map<string, HTMLButtonElement>());
  const focusHandleRef = useRef<string>(undefined);
  const newStageRef = useRef<string>(undefined);
  const [dragging, setDragging] = useState<string>();
  useLayoutEffect(() => {
    const key = focusHandleRef.current;
    if (key === undefined) return;
    focusHandleRef.current = undefined;
    handlesRef.current.get(key)?.focus();
  }, [draft.stages]);
  const stageLabel = (stage: StageDraft, index: number): string => {
    const number = index + 1;
    return stage.name.trim() === '' ? t`stage ${number}` : stage.name.trim();
  };
  const moveStage = (key: string, to: number) => {
    const from = draft.stages.findIndex((stage) => stage.key === key);
    const stage = draft.stages[from];
    if (stage === undefined || to < 0 || to >= draft.stages.length || to === from) return;
    focusHandleRef.current = key;
    change({ stages: moved(draft.stages, from, to) });
    const label = stageLabel(stage, from);
    const position = to + 1;
    const total = draft.stages.length;
    setMoveNotice(t`${label} moved to position ${position} of ${total}.`);
  };
  // While a stage is dragged the window is listened to, not the handle: a row that is moved
  // in the page lets go of the pointer it had captured.
  const stagesRef = useRef(draft.stages);
  useLayoutEffect(() => {
    stagesRef.current = draft.stages;
  }, [draft.stages]);
  useEffect(() => {
    if (dragging === undefined) return;
    const over = (event: PointerEvent) => {
      const stages = stagesRef.current;
      const from = stages.findIndex((stage) => stage.key === dragging);
      for (const [index, stage] of stages.entries()) {
        if (index === from) continue;
        const box = rowsRef.current.get(stage.key)?.getBoundingClientRect();
        if (box === undefined || event.clientY < box.top || event.clientY > box.bottom) continue;
        const middle = box.top + box.height / 2;
        // A stage gives up its place once the pointer is past its middle, on the way there.
        if (index > from ? event.clientY > middle : event.clientY < middle) {
          focusHandleRef.current = dragging;
          setDraft((current) => ({ ...current, stages: moved(current.stages, from, index) }));
        }
        return;
      }
    };
    const drop = () => {
      setDragging(undefined);
    };
    window.addEventListener('pointermove', over);
    window.addEventListener('pointerup', drop);
    window.addEventListener('pointercancel', drop);
    return () => {
      window.removeEventListener('pointermove', over);
      window.removeEventListener('pointerup', drop);
      window.removeEventListener('pointercancel', drop);
    };
  }, [dragging]);

  const name = pipeline?.name ?? '';
  const stageCount = draft.stages.length;
  const nameMissing = edited.has('name') && draft.name.trim() === '';
  const colorStyleNames: Record<PipelineColorStyle, string> = {
    none: t`Default (no color)`,
    dot: t`Colored dot`,
    tint: t`Background tint`,
  };
  const colorNames: Record<StageColorChoice['key'], string> = {
    blue: t`Blue`,
    green: t`Green`,
    amber: t`Amber`,
    red: t`Red`,
    gray: t`Gray`,
    mint: t`Mint`,
    peach: t`Peach`,
    sky: t`Sky blue`,
    violet: t`Violet`,
  };
  const hintButton = (which: Hint, label: string): ReactNode => (
    <button
      type="button"
      aria-label={label}
      aria-expanded={hint === which}
      aria-controls={`${baseId}hint`}
      className={hintButtonClassName}
      onClick={() => {
        setHint(hint === which ? undefined : which);
      }}
    >
      <Info aria-hidden className="size-3.5" strokeWidth={1.8} />
    </button>
  );
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40" />
        <Dialog.Popup
          initialFocus={canManage ? nameRef : true}
          finalFocus={returnTo(returnFocus)}
          className="fixed inset-0 z-60 flex flex-col overflow-hidden bg-card text-card-foreground outline-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[min(880px,calc(100dvh-48px))] sm:w-[min(750px,calc(100vw-32px))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-card sm:shadow-xl"
        >
          <div className="flex min-w-0 shrink-0 items-start justify-between gap-3 border-b px-5 pt-[max(16px,env(safe-area-inset-top))] pb-3">
            <Dialog.Title className="text-lg font-medium wrap-anywhere">
              {creating ? (
                <Trans>Create pipeline</Trans>
              ) : canManage ? (
                <Trans>Edit pipeline</Trans>
              ) : (
                name
              )}
            </Dialog.Title>
            <Dialog.Close
              render={
                <Button variant="quiet" size="small" className="px-2.5" aria-label={t`Close`} />
              }
            >
              <X aria-hidden className="size-5" strokeWidth={1.8} />
            </Dialog.Close>
          </div>
          <form
            noValidate
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canManage || !ready || busy || !(creating || dirty)) return;
              setProblem(undefined);
              save.mutate();
            }}
          >
            {/* The only part that scrolls: a plain block, so nothing in it is squeezed. */}
            <div
              data-slot="pipeline-dialog-body"
              className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain"
            >
              <div className="flex min-w-0 flex-col gap-4 px-5 py-4">
                <Field invalid={nameMissing}>
                  <FieldLabel>
                    <Trans>Pipeline name</Trans>{' '}
                    <span aria-hidden className="text-destructive">
                      *
                    </span>
                  </FieldLabel>
                  <Input
                    ref={nameRef}
                    required
                    maxLength={80}
                    autoComplete="off"
                    placeholder={t`Marketing pipeline`}
                    disabled={locked}
                    value={draft.name}
                    onChange={(event) => {
                      markEdited('name');
                      change({ name: event.target.value });
                    }}
                  />
                  <FieldDescription>
                    <Trans>
                      Use a unique, descriptive name so you can find this pipeline later
                    </Trans>
                  </FieldDescription>
                  <FieldError match={nameMissing}>
                    <Trans>Give the pipeline a name.</Trans>
                  </FieldError>
                </Field>
                <div className={`${cardClassName} items-start`}>
                  <Switch
                    checked={draft.dealProbability}
                    disabled={locked}
                    aria-labelledby={`${baseId}probability`}
                    aria-describedby={`${baseId}probability-note`}
                    onChange={(dealProbability) => {
                      change({ dealProbability });
                    }}
                  />
                  <div className="flex min-w-0 flex-col gap-0.5 pt-3 lg:pt-2">
                    <p id={`${baseId}probability`} className="text-sm font-medium text-foreground">
                      <Trans>Use opportunity-level probability</Trans>
                    </p>
                    <p id={`${baseId}probability-note`} className="text-sm text-muted-foreground">
                      <Trans>
                        When enabled, each opportunity uses its own probability. When disabled,
                        probability is based on the stage.
                      </Trans>
                    </p>
                  </div>
                </div>
                <div
                  role="radiogroup"
                  aria-labelledby={`${baseId}colors`}
                  aria-describedby={`${baseId}colors-note`}
                  className={`${cardClassName} flex-col`}
                >
                  <p className="text-sm">
                    <span id={`${baseId}colors`} className="font-medium text-foreground">
                      <Trans>Set pipeline display colors</Trans>
                    </span>
                    <span aria-hidden className="text-muted-foreground">
                      :{' '}
                    </span>
                    <span id={`${baseId}colors-note`} className="text-muted-foreground">
                      <Trans>Choose how stage colors appear across your pipeline views</Trans>
                    </span>
                  </p>
                  <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
                    {pipelineColorStyles.map((style) => (
                      <label
                        key={style}
                        className={`flex min-h-11 min-w-0 cursor-pointer flex-col gap-1.5 rounded-lg border p-2 has-disabled:cursor-not-allowed has-disabled:opacity-60 ${draft.colorStyle === style ? 'border-primary' : 'border-border'}`}
                      >
                        <span
                          aria-hidden
                          className="flex h-7 min-w-0 items-center rounded-control bg-muted px-2"
                        >
                          <span
                            className={`inline-flex min-w-0 items-center gap-1.5 rounded px-1.5 text-xs font-medium ${style === 'tint' ? 'bg-accent text-link' : 'text-foreground'}`}
                          >
                            {style === 'dot' ? (
                              <span className="size-2 shrink-0 rounded-full bg-primary" />
                            ) : null}
                            <span className="truncate">
                              <Trans>Stage name</Trans>
                            </span>
                          </span>
                        </span>
                        <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                          <input
                            type="radio"
                            name={`${baseId}color-style`}
                            className="size-4 shrink-0 accent-primary"
                            disabled={locked}
                            checked={draft.colorStyle === style}
                            onChange={() => {
                              change({ colorStyle: style });
                            }}
                          />
                          {colorStyleNames[style]}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                <section aria-label={t`Pipeline stages`} className="flex min-w-0 flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-medium text-foreground">
                      <Trans>Pipeline stages ({stageCount})</Trans>
                    </h2>
                    {canManage ? (
                      <Button
                        variant="quiet"
                        size="small"
                        className="font-medium text-link"
                        disabled={busy || stageCount >= STAGE_LIMIT}
                        onClick={() => {
                          const stage = newStage();
                          newStageRef.current = stage.key;
                          change({ stages: [...draft.stages, stage] });
                        }}
                      >
                        <Plus aria-hidden className="size-4" strokeWidth={2} />
                        <Trans>Add stage</Trans>
                      </Button>
                    ) : null}
                  </div>
                  {canManage ? (
                    <p id={`${baseId}reorder`} className="sr-only">
                      <Trans>
                        Drag a stage by its handle, or focus the handle and press the up or down
                        arrow key, to change the order. Archive a stage when you stop using it: its
                        opportunities and history stay intact.
                      </Trans>
                    </p>
                  ) : null}
                  {stageCount === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>No stages yet.</Trans>
                    </p>
                  ) : (
                    <div className="min-w-0 rounded-lg border border-border">
                      <div className={headingsClassName}>
                        <span />
                        <span>
                          <Trans>Stage name</Trans>
                        </span>
                        <span className="flex items-center gap-0.5">
                          <Trans>Show in reports</Trans>
                          {hintButton('reports', t`About Show in reports`)}
                        </span>
                        <span className="flex items-center gap-0.5">
                          <Trans>Probability (%)</Trans>
                          {hintButton('probability', t`About Probability (%)`)}
                        </span>
                        <span />
                        <span />
                      </div>
                      <p
                        id={`${baseId}hint`}
                        className="border-b border-border px-3 py-2 text-sm text-muted-foreground empty:hidden"
                      >
                        {hint === 'reports'
                          ? t`Use the funnel icon to show a stage in the funnel chart, and the pie chart icon to show it in the stage distribution chart.`
                          : hint === 'probability'
                            ? t`The chance, in percent, that an opportunity in this stage is won. Leave it empty for none.`
                            : null}
                      </p>
                      <ol className={dragging === undefined ? '' : 'select-none'}>
                        {draft.stages.map((stage, index) => {
                          const label = stageLabel(stage, index);
                          const stageNameMissing =
                            edited.has(stage.key) && stage.name.trim() === '';
                          const probabilityWrong = !probabilityIsValid(stage.probability);
                          const detailsOpen = openDetails.has(stage.key);
                          const detailsId = `${baseId}details-${stage.key}`;
                          // A stage's color shows only where the pipeline draws colors.
                          const colored = draft.colorStyle !== 'none';
                          const colorsOpen = colored && openColors.has(stage.key);
                          const colorsId = `${baseId}colors-${stage.key}`;
                          const wrongId = `${baseId}wrong-${stage.key}`;
                          return (
                            <li
                              key={stage.key}
                              ref={(element) => {
                                if (element === null) rowsRef.current.delete(stage.key);
                                else rowsRef.current.set(stage.key, element);
                              }}
                              className={`${rowClassName} ${dragging === stage.key ? 'bg-accent' : stage.archived ? 'bg-muted' : 'bg-card'}`}
                            >
                              {canManage ? (
                                <button
                                  type="button"
                                  ref={(element) => {
                                    if (element === null) handlesRef.current.delete(stage.key);
                                    else handlesRef.current.set(stage.key, element);
                                  }}
                                  aria-label={t`Reorder ${label}`}
                                  aria-describedby={`${baseId}reorder`}
                                  title={t`Drag, or press the up or down arrow key, to reorder`}
                                  disabled={busy}
                                  className={`${iconButtonClassName} cursor-grab touch-none text-muted-foreground`}
                                  onKeyDown={(event) => {
                                    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')
                                      return;
                                    event.preventDefault();
                                    moveStage(
                                      stage.key,
                                      index + (event.key === 'ArrowUp' ? -1 : 1),
                                    );
                                  }}
                                  onPointerDown={() => {
                                    setDragging(stage.key);
                                  }}
                                >
                                  <GripVertical aria-hidden className="size-4" strokeWidth={1.8} />
                                </button>
                              ) : (
                                <span />
                              )}
                              <Field invalid={stageNameMissing} className="min-w-0 gap-1">
                                <FieldLabel className="sr-only">
                                  <Trans>Stage name</Trans>
                                </FieldLabel>
                                <div className="flex min-w-0 items-center gap-2">
                                  {colored ? (
                                    <button
                                      type="button"
                                      aria-label={t`Color of ${label}`}
                                      title={t`Stage color`}
                                      aria-expanded={colorsOpen}
                                      aria-controls={colorsOpen ? colorsId : undefined}
                                      className={`${iconButtonClassName} shrink-0`}
                                      onClick={() => {
                                        toggleColors(stage.key);
                                      }}
                                    >
                                      <span
                                        aria-hidden
                                        data-slot="stage-color"
                                        className="size-4 rounded-full border border-input bg-card"
                                        style={
                                          stage.color === null
                                            ? undefined
                                            : { backgroundColor: stage.color }
                                        }
                                      />
                                    </button>
                                  ) : null}
                                  <Input
                                    ref={(element) => {
                                      if (element !== null && newStageRef.current === stage.key) {
                                        newStageRef.current = undefined;
                                        element.focus();
                                      }
                                    }}
                                    required
                                    maxLength={80}
                                    autoComplete="off"
                                    placeholder={t`Stage name`}
                                    disabled={locked}
                                    value={stage.name}
                                    onChange={(event) => {
                                      markEdited(stage.key);
                                      changeStage(stage.key, { name: event.target.value });
                                    }}
                                  />
                                  {stage.archived ? (
                                    <span className="shrink-0 text-xs font-medium text-muted-foreground">
                                      <Trans>Archived</Trans>
                                    </span>
                                  ) : null}
                                </div>
                                <FieldError match={stageNameMissing} className="text-xs">
                                  <Trans>Give the stage a name.</Trans>
                                </FieldError>
                              </Field>
                              <div className="col-start-2 col-end-5 row-start-2 flex min-w-0 flex-wrap items-center gap-2 sm:contents">
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    aria-label={t`Show ${label} in the funnel chart`}
                                    title={t`Funnel chart`}
                                    aria-pressed={stage.showInFunnel}
                                    disabled={locked}
                                    className={`${iconButtonClassName} aria-pressed:bg-accent aria-pressed:text-link`}
                                    onClick={() => {
                                      changeStage(stage.key, {
                                        showInFunnel: !stage.showInFunnel,
                                      });
                                    }}
                                  >
                                    <Funnel aria-hidden className="size-4" strokeWidth={1.8} />
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={t`Show ${label} in the stage distribution chart`}
                                    title={t`Stage distribution chart`}
                                    aria-pressed={stage.showInPie}
                                    disabled={locked}
                                    className={`${iconButtonClassName} aria-pressed:bg-accent aria-pressed:text-link`}
                                    onClick={() => {
                                      changeStage(stage.key, { showInPie: !stage.showInPie });
                                    }}
                                  >
                                    <ChartPie aria-hidden className="size-4" strokeWidth={1.8} />
                                  </button>
                                </div>
                                <div className="flex min-w-0 flex-col gap-1">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <span
                                      aria-hidden
                                      className="text-xs text-muted-foreground sm:hidden"
                                    >
                                      <Trans>Probability</Trans>
                                    </span>
                                    <div className="relative w-20 min-w-0 sm:w-full">
                                      <Input
                                        inputMode="numeric"
                                        autoComplete="off"
                                        aria-label={t`Probability of ${label} (%)`}
                                        aria-invalid={probabilityWrong || undefined}
                                        aria-describedby={probabilityWrong ? wrongId : undefined}
                                        className="pr-7 text-right aria-invalid:border-destructive"
                                        disabled={locked}
                                        value={stage.probability}
                                        onChange={(event) => {
                                          changeStage(stage.key, {
                                            probability: probabilityTyped(event.target.value),
                                          });
                                        }}
                                      />
                                      <span
                                        aria-hidden
                                        className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-sm text-muted-foreground"
                                      >
                                        %
                                      </span>
                                    </div>
                                  </div>
                                  {probabilityWrong ? (
                                    <p
                                      id={wrongId}
                                      className="text-xs font-medium text-destructive"
                                    >
                                      <Trans>Enter 0 to 100.</Trans>
                                    </p>
                                  ) : null}
                                </div>
                              </div>
                              <button
                                type="button"
                                aria-label={t`Stage details for ${label}`}
                                title={t`Stage details`}
                                aria-expanded={detailsOpen}
                                aria-controls={detailsOpen ? detailsId : undefined}
                                className={`${iconButtonClassName} col-start-3 row-start-1 sm:col-start-auto sm:row-start-auto ${stage.description === '' ? '' : 'text-link'}`}
                                onClick={() => {
                                  toggleDetails(stage.key);
                                }}
                              >
                                <ChevronDown
                                  aria-hidden
                                  className={`size-4 ${detailsOpen ? 'rotate-180' : ''}`}
                                  strokeWidth={1.8}
                                />
                              </button>
                              {!canManage ? (
                                <span className="col-start-4 row-start-1 sm:col-start-auto sm:row-start-auto" />
                              ) : stage.id === undefined ? (
                                <button
                                  type="button"
                                  aria-label={t`Remove ${label}`}
                                  title={t`Remove`}
                                  disabled={busy}
                                  className={`${iconButtonClassName} col-start-4 row-start-1 sm:col-start-auto sm:row-start-auto`}
                                  onClick={() => {
                                    change({
                                      stages: draft.stages.filter((each) => each.key !== stage.key),
                                    });
                                  }}
                                >
                                  <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  aria-label={
                                    stage.archived ? t`Restore ${label}` : t`Archive ${label}`
                                  }
                                  title={stage.archived ? t`Restore` : t`Archive`}
                                  disabled={busy}
                                  className={`${iconButtonClassName} col-start-4 row-start-1 sm:col-start-auto sm:row-start-auto`}
                                  onClick={() => {
                                    changeStage(stage.key, { archived: !stage.archived });
                                  }}
                                >
                                  {stage.archived ? (
                                    <ArchiveRestore
                                      aria-hidden
                                      className="size-4"
                                      strokeWidth={1.8}
                                    />
                                  ) : (
                                    <Archive aria-hidden className="size-4" strokeWidth={1.8} />
                                  )}
                                </button>
                              )}
                              {colorsOpen || detailsOpen ? (
                                <div className="col-span-full row-start-3 flex min-w-0 flex-col gap-2 pb-1 sm:row-start-auto">
                                  {colorsOpen ? (
                                    <StageColors
                                      id={colorsId}
                                      label={t`Color of ${label}`}
                                      names={colorNames}
                                      value={stage.color}
                                      disabled={locked}
                                      onChange={(color) => {
                                        changeStage(stage.key, { color });
                                      }}
                                    />
                                  ) : null}
                                  {detailsOpen ? (
                                    <Field id={detailsId}>
                                      <FieldLabel className="text-xs text-muted-foreground">
                                        <Trans>Stage description</Trans>
                                      </FieldLabel>
                                      <Textarea
                                        rows={2}
                                        maxLength={2000}
                                        placeholder={t`When does an opportunity belong in this stage? (optional)`}
                                        disabled={locked}
                                        value={stage.description}
                                        onChange={(event) => {
                                          changeStage(stage.key, {
                                            description: event.target.value,
                                          });
                                        }}
                                      />
                                    </Field>
                                  ) : null}
                                </div>
                              ) : null}
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  )}
                  <p aria-live="polite" className="sr-only">
                    {moveNotice}
                  </p>
                </section>
                <div className="flex min-w-0 flex-col gap-2">
                  <Button
                    variant="quiet"
                    size="small"
                    className="self-start"
                    aria-expanded={moreOpen}
                    aria-controls={moreOpen ? `${baseId}more` : undefined}
                    onClick={() => {
                      setMoreOpen(!moreOpen);
                    }}
                  >
                    <ChevronDown
                      aria-hidden
                      className={`size-4 ${moreOpen ? 'rotate-180' : ''}`}
                      strokeWidth={1.8}
                    />
                    <Trans>More options</Trans>
                  </Button>
                  {moreOpen ? (
                    <div id={`${baseId}more`} className="flex min-w-0 flex-col gap-3">
                      <Field>
                        <FieldLabel>
                          <Trans>Pipeline description</Trans>
                        </FieldLabel>
                        <Textarea
                          rows={2}
                          maxLength={2000}
                          disabled={locked}
                          value={draft.description}
                          onChange={(event) => {
                            change({ description: event.target.value });
                          }}
                        />
                      </Field>
                      <div
                        role="group"
                        aria-labelledby={`${baseId}charts`}
                        className={`${cardClassName} flex-col gap-1`}
                      >
                        <p id={`${baseId}charts`} className="text-sm font-medium text-foreground">
                          <Trans>Show this pipeline in reports</Trans>
                        </p>
                        <div className="flex min-w-0 flex-wrap gap-x-6">
                          <div className="flex min-w-0 items-center gap-2">
                            <Switch
                              checked={draft.showInFunnel}
                              disabled={locked}
                              aria-labelledby={`${baseId}funnel`}
                              onChange={(showInFunnel) => {
                                change({ showInFunnel });
                              }}
                            />
                            <span id={`${baseId}funnel`} className="text-sm text-foreground">
                              <Trans>Visible in funnel chart</Trans>
                            </span>
                          </div>
                          <div className="flex min-w-0 items-center gap-2">
                            <Switch
                              checked={draft.showInPie}
                              disabled={locked}
                              aria-labelledby={`${baseId}pie`}
                              onChange={(showInPie) => {
                                change({ showInPie });
                              }}
                            />
                            <span id={`${baseId}pie`} className="text-sm text-foreground">
                              <Trans>Visible in stage distribution chart</Trans>
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
            {problem === undefined ? null : (
              <div
                role="alert"
                className="flex shrink-0 flex-col items-start gap-2 border-t px-5 py-3 text-sm text-destructive"
              >
                <p>{problem}</p>
                {stale ? (
                  <>
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={busy}
                      onClick={() => {
                        reload.mutate();
                      }}
                    >
                      <Trans>Reload saved version</Trans>
                    </Button>
                    <p>
                      <Trans>Reloading replaces your unsaved changes.</Trans>
                    </p>
                  </>
                ) : null}
              </div>
            )}
            <div
              data-slot="pipeline-dialog-footer"
              className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-card px-5 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]"
            >
              <p role="status" className="mr-auto text-sm text-muted-foreground empty:sr-only">
                {reload.isPending ? t`Reloading…` : save.isPending ? t`Saving…` : ''}
              </p>
              {canManage ? (
                <>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      onClose();
                    }}
                  >
                    <Trans>Cancel</Trans>
                  </Button>
                  <Button type="submit" disabled={busy || !ready || !(creating || dirty)}>
                    {creating ? <Trans>Create</Trans> : <Trans>Save</Trans>}
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    onClose();
                  }}
                >
                  <Trans>Close</Trans>
                </Button>
              )}
            </div>
          </form>
          <Dialog.Root
            open={blocker.status === 'blocked'}
            onOpenChange={(next) => {
              if (!next) blocker.reset?.();
            }}
          >
            <Dialog.Portal>
              <Dialog.Backdrop className="fixed inset-0 z-60 bg-foreground/40" />
              <Dialog.Popup
                // On the way that loses nothing.
                initialFocus={keepRef}
                className="fixed top-1/2 left-1/2 z-[65] flex w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-card bg-card p-5 text-card-foreground shadow-xl outline-none"
              >
                <div className="flex flex-col gap-1">
                  <Dialog.Title className="text-lg font-medium">
                    <Trans>You have unsaved changes</Trans>
                  </Dialog.Title>
                  <Dialog.Description className="text-md text-muted-foreground">
                    <Trans>Your changes to this pipeline haven't been saved.</Trans>
                  </Dialog.Description>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="secondary"
                    className="border-destructive text-destructive"
                    onClick={() => {
                      blocker.proceed?.();
                    }}
                  >
                    <Trans>Discard changes</Trans>
                  </Button>
                  <Button
                    ref={keepRef}
                    onClick={() => {
                      blocker.reset?.();
                    }}
                  >
                    <Trans>Keep editing</Trans>
                  </Button>
                </div>
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
