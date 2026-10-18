// The Canvas view (docs/AUTOMATIONS.md section 9): the automation drawn as boxes and lines.
// It draws the same document the Steps and JSON views show, and every change here is a
// change to that document: adding, changing and removing steps goes through the forms the
// Steps view uses, and moving a box changes only the document's `layout`.
//
// Everything a mouse can do here, the keyboard can: each box and each "add a step" point is
// a button in the order a contact meets the steps, a box is moved with the arrow keys from
// its Move button, and a step chosen in the library is put in place by choosing where it
// goes. The lines are decoration; what each step leads to is also said in words.
//
// Its own chunk, loaded when someone opens this view.
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { AutomationSetup, AutomationStats } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { CatchBoundary } from '@tanstack/react-router';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import {
  ChartColumn,
  CircleAlert,
  Copy,
  Ellipsis,
  GripVertical,
  Hand,
  Maximize,
  Minus,
  Plus,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  canvasGraph,
  hasLayout,
  moveStep,
  NODE,
  nudgeStep,
  placeAddedStep,
  tidyLayout,
  TRIGGER,
  type CanvasEdge,
  type Point,
} from './automation-canvas-layout';
import {
  branchNamesOf,
  canRemoveTrigger,
  stepOf,
  stopsOf,
  subjectOf,
  type Draft,
  type InsertAt,
  type StepView,
} from './automation-document';
import { useCanvasPan } from './automation-canvas-pan';
import { STEPS_HEADING_ID, stepElementId, triggerElementId } from './automation-element-ids';
import type { ShownIssue } from './automation-issues';
import { pointerToken } from './automation-json';
import { stepPicker } from './automation-availability';
import { Tile } from './automation-tile';
import {
  branchLabel,
  conditionWords,
  stepLabel,
  stepName,
  stepSummary,
  stopSummary,
  triggerLabel,
  triggerSummary,
} from './automation-summary';

/** What the canvas needs of the step and trigger forms, which the builder owns. */
export interface CanvasEditing {
  readonly addStep: (
    at: InsertAt,
    type?: string,
    place?: (before: Draft, after: Draft, added: string) => Draft,
  ) => void;
  readonly editStep: (id: string) => void;
  readonly removeStep: (id: string) => void;
  readonly addTrigger: () => void;
  readonly editTrigger: (index: number) => void;
  readonly removeTrigger: (index: number) => void;
  readonly duplicateTrigger: (index: number) => void;
  /** The step or trigger whose panel is open: its card has the accent border. */
  readonly selected:
    | { readonly kind: 'step'; readonly id: string }
    | { readonly kind: 'trigger'; readonly index: number }
    | undefined;
}

export interface CanvasViewProps {
  readonly draft: Draft;
  readonly setup: AutomationSetup;
  /** The step types there are, in their groups, as the catalog lists them. */
  readonly steps: readonly {
    readonly type: string;
    readonly group: string;
    readonly label: string;
    readonly description: string;
  }[];
  readonly stepGroups: readonly string[];
  readonly issues: readonly ShownIssue[];
  /** Whether the person may change the draft, and it can be changed right now. */
  readonly editable: boolean;
  readonly editing: CanvasEditing;
  /** The workflow's numbers, once someone has asked for a trigger's Stats and they came. */
  readonly stats?: AutomationStats | undefined;
  readonly statsFailed?: boolean | undefined;
  /** Says a trigger's Stats were asked for, so the numbers are read. */
  readonly onWantStats?: (() => void) | undefined;
  readonly onChange: (draft: Draft) => void;
  /** Opens the JSON view at a place in the document, by JSON Pointer. */
  readonly onEditInJson: (pointer: string) => void;
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5] as const;
const FORM_CONTROLS = 'input, textarea, select, [role="dialog"]';
/** The space around a number of CSS pixels read from a computed style, such as "16px". */
const pixels = (length: string): number => Number.parseFloat(length) || 0;
const STEP_MIME = 'application/x-crm-automation-step';
/** How far a pointer travels before a press on a box becomes a drag rather than a click. */
const DRAG_THRESHOLD = 4;

const ARROWS: Readonly<Record<string, Point>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

const placeKey = (at: InsertAt | undefined): string | undefined =>
  at === undefined
    ? undefined
    : at.kind === 'start'
      ? 'start'
      : at.kind === 'before'
        ? `before\u0000${at.step}`
        : `after\u0000${at.step}\u0000${at.branch ?? ''}`;
const sameAt = (a: InsertAt | undefined, b: InsertAt): boolean => placeKey(a) === placeKey(b);

const boxStyle = (at: Point, size: { width: number; height: number } = NODE): CSSProperties => ({
  position: 'absolute',
  left: at.x,
  top: at.y,
  width: size.width,
  height: size.height,
});

function Box({
  id,
  label,
  at,
  size = NODE,
  tile,
  caption,
  captionClassName = 'text-muted-foreground',
  summary,
  line,
  dashed,
  selected,
  issues,
  leadsTo,
  said,
  onOpen,
  openLabel,
  corner,
  handle,
  footer,
  chip,
  dragging,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  readonly id: string;
  readonly label: string;
  readonly at: Point;
  readonly size?: { readonly width: number; readonly height: number };
  /** The icon on its tinted tile. */
  readonly tile: ReactNode;
  readonly caption: ReactNode;
  readonly captionClassName?: string;
  readonly summary: ReactNode;
  /** One more line under the summary, such as a trigger's filters. */
  readonly line?: ReactNode;
  readonly dashed?: boolean;
  /** Whether its panel is open: the card then has the accent border. */
  readonly selected?: boolean;
  readonly issues: readonly ShownIssue[];
  /** What it leads to, in words, for a screen reader: the lines themselves are decoration. */
  readonly leadsTo?: ReactNode;
  /** Something to say as it changes, such as numbers that have just come. */
  readonly said?: string | undefined;
  readonly onOpen?: (() => void) | undefined;
  readonly openLabel?: string | undefined;
  /** The card's own menu, in its top right corner. */
  readonly corner?: ReactNode;
  /** What moves the card, at its left. */
  readonly handle?: ReactNode;
  /** A row of buttons along the foot of the card. */
  readonly footer?: ReactNode;
  /** A small button on the card's lower edge, such as where a Go To leads. */
  readonly chip?: ReactNode;
  readonly dragging?: boolean;
  readonly onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove?: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp?: (event: PointerEvent<HTMLElement>) => void;
}): ReactElement {
  const errors = issues.filter((issue) => issue.level === 'error').length;
  const warnings = issues.length - errors;
  return (
    <div
      id={id}
      role="group"
      aria-label={label}
      tabIndex={-1}
      data-canvas-box
      data-selected={selected === true ? '' : undefined}
      style={boxStyle(at, size)}
      className={`rounded-xl bg-card outline-offset-2 ${
        selected === true
          ? 'border-2 border-primary'
          : dashed === true
            ? 'border-2 border-dashed border-input'
            : 'border border-border'
      } ${dragging === true ? 'z-20 shadow-xl' : 'shadow-[0_1px_2px_rgb(16_24_40/0.05)]'}`}
    >
      <div
        className="pointer-events-none flex min-w-0 flex-col gap-1 px-3 py-2.5"
        style={{ height: footer === undefined ? size.height - 2 : size.height - 42 }}
        aria-hidden={onOpen !== undefined}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          {tile}
          <span className={`flex min-w-0 flex-1 flex-col ${corner === undefined ? '' : 'pr-7'}`}>
            <span className={`truncate text-xs ${captionClassName}`}>{caption}</span>
            <span className="line-clamp-2 text-sm leading-5 font-medium wrap-anywhere">
              {summary}
            </span>
          </span>
        </div>
        {line === undefined ? null : (
          <span className="truncate text-xs text-muted-foreground">{line}</span>
        )}
      </div>
      {onOpen === undefined ? null : (
        // The whole card is the button; what it shows is read out as its name.
        <button
          type="button"
          aria-label={openLabel}
          className="absolute inset-0 cursor-pointer rounded-xl"
          onClick={onOpen}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      )}
      {issues.length === 0 ? null : (
        <span className="absolute -top-3 left-3 flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium">
          {errors > 0 ? (
            <CircleAlert aria-hidden className="size-3.5 text-destructive" strokeWidth={2} />
          ) : (
            <TriangleAlert
              aria-hidden
              className="size-3.5 text-attention-foreground"
              strokeWidth={2}
            />
          )}
          {errors > 0 ? (
            <Plural value={errors} one="# error" other="# errors" />
          ) : (
            <Plural value={warnings} one="# warning" other="# warnings" />
          )}
          <span className="sr-only"> {issues.map((issue) => issue.message).join(' ')}</span>
        </span>
      )}
      {leadsTo === undefined ? null : <span className="sr-only">{leadsTo}</span>}
      {said === undefined ? null : (
        <span role="status" className="sr-only">
          {said}
        </span>
      )}
      {handle === undefined ? null : (
        <span className="absolute top-1/2 -left-11 -translate-y-1/2">{handle}</span>
      )}
      {corner === undefined ? null : <span className="absolute top-1 right-1 z-10">{corner}</span>}
      {chip === undefined ? null : (
        <span className="absolute -bottom-3 left-3 z-10 flex max-w-[calc(100%-1.5rem)]">
          {chip}
        </span>
      )}
      {footer === undefined ? null : (
        <span className="absolute inset-x-0 bottom-0 z-10 flex h-10 items-center gap-0.5 rounded-b-xl border-t border-border bg-card px-1.5">
          {footer}
        </span>
      )}
    </div>
  );
}

function MissingStep({ id }: { readonly id: string }): ReactElement {
  return <Trans>Missing step: {id}</Trans>;
}

/** The search box of the list of actions: where the keyboard goes when the list opens. */
const SEARCH_BOX = 'input[type="search"]';

const Library = lazy(() => import('./automation-canvas-library'));

/** In the list's place when its code doesn't arrive: the draft and the drawing are untouched. */
function LibraryUnavailable(): ReactElement {
  return (
    <p role="alert" className="text-sm">
      <Trans>
        The actions couldn't load. Use a + on the canvas, or reload the page to try again.
      </Trans>
    </p>
  );
}

const toolClassName =
  'flex size-10 items-center justify-center rounded-full border border-input bg-card text-foreground hover:bg-muted';
const cardButtonClassName =
  'flex size-10 items-center justify-center rounded-control text-body -outline-offset-2 hover:bg-muted hover:text-foreground data-popup-open:bg-muted lg:size-8';

export default function CanvasView({
  draft,
  setup,
  steps,
  stepGroups,
  issues,
  editable,
  editing,
  stats,
  statsFailed,
  onWantStats,
  onChange,
  onEditInJson,
}: CanvasViewProps): ReactElement {
  const { t, i18n } = useLingui();
  const libraryId = useId();
  const moveHintId = useId();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pan = useCanvasPan(scrollerRef);
  /** The sheet the drawing is on: its top-left corner is the drawing's own. */
  const sheetRef = useRef<HTMLDivElement>(null);
  // Where the keyboard returns when the list of actions closes or a placing is called off.
  const toggleRef = useRef<HTMLButtonElement>(null);
  /** Whether a menu's choice opened something that takes the keyboard from its button. */
  const openedRef = useRef(false);
  const libraryListRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const wheel = (event: WheelEvent): void => {
      if (
        (!event.ctrlKey && !event.metaKey) ||
        !Number.isFinite(event.deltaY) ||
        event.deltaY === 0 ||
        event.shiftKey ||
        (event.target instanceof Element && event.target.closest(FORM_CONTROLS) !== null)
      )
        return;
      event.preventDefault();
      setZoom((current) =>
        Math.max(0.5, Math.min(1.5, current + (event.deltaY < 0 ? 0.25 : -0.25))),
      );
    };
    scroller.addEventListener('wheel', wheel, { passive: false });
    return () => {
      scroller.removeEventListener('wheel', wheel);
    };
  }, []);
  const [libraryOpen, setLibraryOpen] = useState(false);
  /** The triggers whose Stats are showing, by id. */
  const [statsOpen, setStatsOpen] = useState<readonly string[]>([]);
  /** A step type chosen in the library, waiting for the person to say where it goes. */
  const [placing, setPlacing] = useState<string>();
  /** A step type being dragged from the library, and the add point nearest the pointer. */
  const [dragType, setDragType] = useState<string>();
  const [nearest, setNearest] = useState<InsertAt>();
  const [moving, setMoving] = useState<{
    readonly id: string;
    readonly from: Point;
    readonly by: Point;
  }>();
  const [announcement, setAnnouncement] = useState('');
  // A press that became a drag ends with a click on the same box, which must not open it.
  const draggedRef = useRef(false);
  // The drag itself is kept here: pointer events arrive faster than renders, so the release
  // must not depend on what the last render saw.
  const pressRef = useRef<{ id: string; x: number; y: number; from: Point; by: Point } | undefined>(
    undefined,
  );

  const base = useMemo(() => canvasGraph(draft), [draft]);
  // While a box is dragged the drawing follows, from where it was: the corner stays put.
  const preview = useMemo(() => {
    if (moving === undefined) return undefined;
    const moved = canvasGraph(
      moveStep(draft, moving.id, {
        x: moving.from.x + moving.by.x,
        y: moving.from.y + moving.by.y,
      }),
    );
    return {
      graph: moved,
      shift: { x: moved.origin.x - base.origin.x, y: moved.origin.y - base.origin.y },
    };
  }, [base, draft, moving]);
  const graph = preview?.graph ?? base;
  const shift = preview?.shift ?? { x: 0, y: 0 };

  // A workflow has one goal: the list of actions offers it only until it is there.
  const hasGoal = graph.nodes.some((node) => node.step.type === 'goal');
  const picker = useMemo(
    () =>
      stepPicker(
        // A type that has a name here is one this version has a form for.
        steps.filter((step) => stepLabel(step.type) !== undefined),
        stepGroups,
        setup,
        hasGoal ? ['goal'] : [],
      ),
    [steps, stepGroups, setup, hasGoal],
  );
  const labelOf = (type: string): string => stepLabel(type) ?? type;
  const placingName = placing === undefined ? '' : labelOf(placing);
  const stops = stopsOf(draft);
  const nameOfStep = (id: string): string => {
    const step = stepOf(draft, id);
    return step === undefined ? id : stepName(step, setup);
  };
  const issuesOf = (kind: 'step' | 'trigger', key: string | number): ShownIssue[] =>
    issues.filter((issue) => {
      const subject = subjectOf(issue.path);
      return subject.kind === 'step'
        ? kind === 'step' && subject.id === key
        : subject.kind === 'trigger' && kind === 'trigger' && subject.index === key;
    });

  const cancelPlacing = (): void => {
    setPlacing(undefined);
    setAnnouncement('');
    toggleRef.current?.focus();
  };
  const choose = (type: string): void => {
    const name = labelOf(type);
    setPlacing(type);
    setLibraryOpen(false);
    setAnnouncement(t`Choose where to put: ${name}. Use an Add button on the canvas.`);
    // The keyboard goes on to the first place it could go.
    queueMicrotask(() => {
      scrollerRef.current?.querySelector<HTMLElement>('[data-add-point]')?.focus();
    });
  };
  const addAt = (at: InsertAt, type?: string): void => {
    const chosen = type ?? placing;
    setPlacing(undefined);
    setDragType(undefined);
    setNearest(undefined);
    setAnnouncement('');
    // A drawing arranged by hand makes room for the new step; nothing else changes.
    editing.addStep(at, chosen, placeAddedStep);
  };

  /** Where each add point is, for finding the one nearest a step dropped on open canvas. */
  const addPoints: { readonly at: InsertAt; readonly plus: Point }[] = [
    ...(graph.beforeStart === undefined
      ? []
      : [{ at: { kind: 'start' } as const, plus: graph.beforeStart }]),
    ...(graph.firstStep === undefined
      ? []
      : [{ at: { kind: 'start' } as const, plus: graph.firstStep.plus }]),
    ...graph.edges.flatMap((edge) =>
      edge.plus === undefined ? [] : [{ at: edge.at, plus: edge.plus }],
    ),
    ...graph.joins.map((join) => ({
      at: { kind: 'before', step: join.step } as const,
      plus: join.plus,
    })),
  ];
  // A place on the screen as a place in the drawing: measured from the drawing's own
  // corner, wherever scrolling, the gutters and the open library have put it.
  const pointIn = (event: { clientX: number; clientY: number }): Point | undefined => {
    const sheet = sheetRef.current;
    if (sheet === null) return undefined;
    const bounds = sheet.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / zoom, y: (event.clientY - bounds.top) / zoom };
  };
  const nearestTo = (point: Point | undefined): InsertAt | undefined => {
    let best: { at: InsertAt; distance: number } | undefined;
    if (point === undefined) return undefined;
    for (const each of addPoints) {
      const distance = Math.hypot(each.plus.x - point.x, each.plus.y - point.y);
      if (best === undefined || distance < best.distance) best = { at: each.at, distance };
    }
    return best?.at;
  };

  // Escape backs out of choosing a place for a step, and otherwise closes the library.
  useEffect(() => {
    if (placing === undefined && !libraryOpen) return undefined;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (placing === undefined) setLibraryOpen(false);
      else {
        setPlacing(undefined);
        setAnnouncement('');
      }
      toggleRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [placing, libraryOpen]);

  // A step dragged from the library can be dropped anywhere on the canvas: it goes to the
  // add point nearest the pointer, which is shown while it is dragged. The same step can
  // always be put there without dragging, by choosing it and then the add point.
  const dropRef = useRef<(event: globalThis.DragEvent, dropped: boolean) => void>(() => undefined);
  useEffect(() => {
    dropRef.current = (event, dropped) => {
      if (event.dataTransfer?.types.includes(STEP_MIME) !== true) return;
      const at = nearestTo(pointIn(event));
      if (at === undefined) return;
      event.preventDefault();
      if (!dropped) {
        event.dataTransfer.dropEffect = 'copy';
        setNearest(at);
        return;
      }
      const type = event.dataTransfer.getData(STEP_MIME);
      if (type !== '') addAt(at, type);
    };
  });
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null || !editable) return undefined;
    const over = (event: globalThis.DragEvent): void => {
      dropRef.current(event, false);
    };
    const dropped = (event: globalThis.DragEvent): void => {
      dropRef.current(event, true);
    };
    scroller.addEventListener('dragover', over);
    scroller.addEventListener('drop', dropped);
    return () => {
      scroller.removeEventListener('dragover', over);
      scroller.removeEventListener('drop', dropped);
    };
  }, [editable]);

  const addLabel = (edge: Pick<CanvasEdge, 'from' | 'branch'>): string => {
    const step = stepOf(draft, edge.from);
    const name = nameOfStep(edge.from);
    if (edge.branch === undefined || step === undefined) return t`Add an action after: ${name}`;
    const branch = branchLabel(step, edge.branch);
    return t`Add an action to: ${branch} of ${name}`;
  };
  const addButton = (key: string, at: InsertAt, plus: Point, label: string): ReactElement => {
    const lit = placing !== undefined || (dragType !== undefined && sameAt(nearest, at));
    return (
      <button
        key={key}
        type="button"
        data-add-point
        aria-label={label}
        // Forty pixels to press, with the small round mark of the design inside.
        style={boxStyle({ x: plus.x - 20, y: plus.y - 20 }, { width: 40, height: 40 })}
        className="group z-10 flex items-center justify-center rounded-full"
        onClick={() => {
          addAt(at);
        }}
      >
        <span
          className={`flex items-center justify-center rounded-full border bg-card transition-[width,height] ${
            lit
              ? 'size-9 border-2 border-primary text-primary'
              : 'size-6 border-input text-foreground group-hover:size-8 group-focus-visible:size-8'
          }`}
        >
          <Plus aria-hidden className="size-3.5" strokeWidth={2.5} />
        </span>
      </button>
    );
  };

  const leadsTo = (step: StepView): string =>
    graph.edges
      .filter((edge) => edge.from === step.id)
      .map((edge) => {
        const target =
          edge.to.kind === 'step'
            ? nameOfStep(edge.to.id)
            : edge.to.kind === 'end'
              ? undefined
              : edge.to.id;
        const where =
          edge.to.kind === 'end'
            ? t`it ends`
            : edge.to.kind === 'missing'
              ? t`a step that isn't there: ${target}`
              : target;
        if (edge.branch === undefined) return t`Then: ${where}`;
        const branch = branchLabel(step, edge.branch);
        return t`${branch}: ${where}`;
      })
      .join('; ');

  const drop = (press: { id: string; from: Point; by: Point }): void => {
    const { id, from, by } = press;
    setMoving(undefined);
    if (by.x === 0 && by.y === 0) return;
    onChange(moveStep(draft, id, { x: from.x + by.x, y: from.y + by.y }));
  };
  const dragHandlers = (
    id: string,
    at: Point,
    anyPointer: boolean,
  ): {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  } => ({
    onPointerDown: (event) => {
      // A finger on a box scrolls the canvas; the Move button is what a finger drags.
      if (event.button !== 0 || (!anyPointer && event.pointerType === 'touch')) return;
      draggedRef.current = false;
      pressRef.current = {
        id,
        x: event.clientX,
        y: event.clientY,
        from: { x: at.x + graph.origin.x, y: at.y + graph.origin.y },
        by: { x: 0, y: 0 },
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event) => {
      const press = pressRef.current;
      if (press?.id !== id) return;
      const by = {
        x: (event.clientX - press.x) / zoom,
        y: (event.clientY - press.y) / zoom,
      };
      if (!draggedRef.current && Math.hypot(by.x * zoom, by.y * zoom) < DRAG_THRESHOLD) return;
      draggedRef.current = true;
      press.by = by;
      setMoving({ id, from: press.from, by });
    },
    onPointerUp: () => {
      const press = pressRef.current;
      if (press?.id !== id) return;
      pressRef.current = undefined;
      drop(press);
    },
  });

  const moveByKey = (event: KeyboardEvent<HTMLButtonElement>, step: StepView): void => {
    const arrow = Object.hasOwn(ARROWS, event.key) ? ARROWS[event.key] : undefined;
    if (arrow === undefined) return;
    event.preventDefault();
    // A square at a time, or five with Shift held.
    const squares = event.shiftKey ? 5 : 1;
    const next = nudgeStep(draft, step.id, { x: arrow.x * squares, y: arrow.y * squares });
    const name = stepName(step, setup);
    const direction =
      event.key === 'ArrowLeft'
        ? t`left`
        : event.key === 'ArrowRight'
          ? t`right`
          : event.key === 'ArrowUp'
            ? t`up`
            : t`down`;
    setAnnouncement(t`Moved ${name} ${direction}.`);
    onChange(next);
  };

  const zoomIndex = ZOOMS.findIndex((each) => each >= zoom);
  const percent = Math.round(zoom * 100);
  const fit = (): void => {
    const scroller = scrollerRef.current;
    // The room the drawing has: the canvas, less its gutters and the library beside it.
    const style = scroller === null ? undefined : getComputedStyle(scroller);
    const width =
      scroller === null || style === undefined
        ? graph.size.width
        : scroller.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight);
    // Whole percents, never larger than life, and never so small nothing can be read.
    setZoom(Math.max(0.3, Math.min(1, Math.floor((width / graph.size.width) * 100) / 100)));
  };

  const number = new Intl.NumberFormat(i18n.locale);
  /** What a trigger's Stats shows: how many it has enrolled, as the server counts them. */
  const statsLine = (triggerId: string): string => {
    if (statsFailed === true) return t`The numbers couldn't be loaded.`;
    if (stats === undefined) return t`Loading the numbers…`;
    const counted = stats.triggers.find((each) => each.trigger === triggerId);
    const all = number.format(counted?.allTime.enrolled ?? 0);
    if (counted?.live === null || counted?.live === undefined) return t`Enrolled: ${all}`;
    const live = number.format(counted.live.enrolled);
    return t`Enrolled: ${all} (live version: ${live})`;
  };

  return (
    <section
      aria-labelledby={STEPS_HEADING_ID}
      className="@container relative flex min-w-0 flex-col rounded-card border border-border bg-background bg-[radial-gradient(var(--color-input)_1px,transparent_1px)] bg-size-[20px_20px]"
    >
      <h2 id={STEPS_HEADING_ID} tabIndex={-1} className="sr-only">
        <Trans>Canvas</Trans>
      </h2>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
        {/* Below the Add button where the canvas is narrow, so the list of actions never
            lies over the button that opened it. */}
        <span className="order-last flex min-w-0 basis-full flex-wrap items-center gap-1.5 text-sm @xl:order-none @xl:flex-1 @xl:basis-0">
          <Hand aria-hidden className="size-4" strokeWidth={1.8} />
          {stops.length === 0 ? (
            <Trans>Nothing stops it early.</Trans>
          ) : (
            <>
              <Trans>Stops as soon as</Trans>
              {stops.map((stop) => {
                const { event } = stop;
                return (
                  <span
                    key={stop.index}
                    className="max-w-full rounded-full border border-border bg-card px-2.5 py-1 text-[13px] wrap-anywhere"
                  >
                    {stopSummary(stop) ?? t`Unknown event: ${event}`}
                  </span>
                );
              })}
            </>
          )}
        </span>
        {editable && hasLayout(draft) ? (
          <Button
            variant="quiet"
            size="small"
            onClick={() => {
              onChange(tidyLayout(draft));
              setAnnouncement(t`Laid out automatically again.`);
            }}
          >
            <Trans>Tidy layout</Trans>
          </Button>
        ) : null}
        {editable ? (
          <DropdownMenu
            // Not modal: the list of actions it opens is beside it, and takes the keyboard.
            modal={false}
            onOpenChange={(open) => {
              // Until a choice opens something, closing gives the keyboard back to the button.
              if (open) openedRef.current = false;
            }}
          >
            <DropdownMenuTrigger
              ref={toggleRef}
              className="ml-auto inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted data-popup-open:bg-muted lg:min-h-9"
            >
              <Plus aria-hidden className="size-4" strokeWidth={2} />
              <Trans>Add</Trans>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="min-w-40"
              // Adding an action opens the list beside the canvas, and the keyboard goes to its
              // search box; adding a trigger opens a panel, which takes the keyboard itself.
              finalFocus={() =>
                openedRef.current
                  ? (libraryListRef.current?.querySelector<HTMLElement>(SEARCH_BOX) ?? false)
                  : true
              }
            >
              <DropdownMenuItem
                onClick={() => {
                  editing.addTrigger();
                }}
              >
                <Trans>Add trigger</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  openedRef.current = true;
                  setLibraryOpen(true);
                }}
              >
                <Trans>Add action</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {placing === undefined ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-2 px-3.5 pb-3 text-sm">
          <span className="font-medium">
            <Trans>Choose where to put: {placingName}</Trans>
          </span>
          <Button variant="quiet" size="small" onClick={cancelPlacing}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <p id={moveHintId} hidden>
        <Trans>
          Use the arrow keys to move it. Hold Shift to move further. Moving an action never changes
          what the workflow does.
        </Trans>
      </p>

      <div
        ref={scrollerRef}
        // With nothing in it to press, the drawing itself takes the keyboard, so it can
        // still be scrolled with the arrow keys.
        role="group"
        aria-label={t`The workflow, drawn`}
        tabIndex={editable ? undefined : 0}
        data-testid="automation-canvas"
        onPointerDown={pan.onPointerDown}
        onPointerMove={pan.onPointerMove}
        onPointerUp={pan.onPointerUp}
        onPointerCancel={pan.onPointerUp}
        // Where the canvas is wide enough, the drawing makes room for the open list of
        // actions, so one can be dragged from it onto any line. Narrower, the list lies over
        // it, and makes way once an action is chosen.
        className={`relative max-h-[max(24rem,calc(100dvh-16rem))] min-h-[max(20rem,calc(100dvh-22rem))] overflow-auto px-4 pb-20 ${
          pan.panning ? 'cursor-grabbing select-none' : 'cursor-grab'
        } ${editable && libraryOpen ? '@3xl:pr-[25rem]' : ''}`}
      >
        <div
          ref={sheetRef}
          className="mx-auto"
          style={{ width: graph.size.width * zoom, height: graph.size.height * zoom }}
        >
          <div
            style={{
              position: 'relative',
              width: graph.size.width,
              height: graph.size.height,
              transform: `scale(${String(zoom)}) translate(${String(shift.x)}px, ${String(shift.y)}px)`,
              transformOrigin: '0 0',
            }}
          >
            <svg
              aria-hidden
              width={graph.size.width}
              height={graph.size.height}
              className="pointer-events-none absolute top-0 left-0 overflow-visible fill-none stroke-muted-foreground"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <defs>
                <marker
                  id={`${libraryId}-arrow`}
                  orient="auto"
                  markerWidth="5"
                  markerHeight="5"
                  refX="4"
                  refY="2"
                >
                  <path d="M0 0 L4 2 L0 4 Z" className="fill-muted-foreground stroke-none" />
                </marker>
              </defs>
              {graph.addTriggerPath === undefined ? null : <path d={graph.addTriggerPath} />}
              {graph.triggers.map(({ trigger, path }) =>
                path === undefined ? null : <path key={trigger.index} d={path} />,
              )}
              {graph.edges.map((edge) => (
                <path
                  key={edge.key}
                  d={edge.path}
                  strokeDasharray={edge.back || edge.to.kind === 'missing' ? '6 6' : undefined}
                  markerEnd={edge.to.kind === 'step' ? `url(#${libraryId}-arrow)` : undefined}
                />
              ))}
            </svg>

            {graph.triggers.map(({ trigger, at }) => {
              const summary = triggerSummary(trigger, setup);
              const kind = triggerLabel(trigger.type);
              const name = summary ?? kind ?? trigger.type;
              const known = triggerLabel(trigger.type) !== undefined;
              const { type } = trigger;
              const counted = statsOpen.includes(trigger.id);
              return (
                <Box
                  key={`trigger:${String(trigger.index)}`}
                  id={triggerElementId(trigger.index)}
                  label={t`Trigger: ${name}`}
                  at={at}
                  size={TRIGGER}
                  tile={<Tile owner="trigger" type={trigger.type} />}
                  caption={kind ?? <Trans>Trigger</Trans>}
                  captionClassName="font-medium text-success"
                  selected={
                    editing.selected?.kind === 'trigger' && editing.selected.index === trigger.index
                  }
                  summary={
                    summary ??
                    (kind === undefined ? (
                      t`Unknown trigger: ${type}`
                    ) : (
                      <span className="text-muted-foreground">
                        <Trans>Not set up yet</Trans>
                      </span>
                    ))
                  }
                  line={
                    counted ? (
                      statsLine(trigger.id)
                    ) : trigger.condition === undefined ? (
                      <Trans>No filters applied</Trans>
                    ) : (
                      (conditionWords(trigger.condition, false, setup) ?? (
                        <Trans>Filters set in JSON</Trans>
                      ))
                    )
                  }
                  said={counted ? statsLine(trigger.id) : undefined}
                  issues={issuesOf('trigger', trigger.index)}
                  onOpen={
                    editable
                      ? () => {
                          if (known) editing.editTrigger(trigger.index);
                          else onEditInJson(`/triggers/${String(trigger.index)}`);
                        }
                      : undefined
                  }
                  openLabel={known ? t`Edit: ${name}` : t`Edit in JSON: ${name}`}
                  footer={
                    <>
                      {editable ? (
                        <button
                          type="button"
                          className={cardButtonClassName}
                          aria-label={t`Duplicate: ${name}`}
                          onClick={() => {
                            editing.duplicateTrigger(trigger.index);
                            setAnnouncement(t`Added a copy of the trigger.`);
                          }}
                        >
                          <Copy aria-hidden className="size-4" strokeWidth={1.8} />
                        </button>
                      ) : null}
                      {editable && canRemoveTrigger(draft) ? (
                        <button
                          type="button"
                          className={cardButtonClassName}
                          aria-label={t`Delete: ${name}`}
                          onClick={() => {
                            editing.removeTrigger(trigger.index);
                          }}
                        >
                          <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="ml-auto inline-flex h-8 items-center gap-1 rounded-control px-2 text-xs font-medium text-body -outline-offset-2 hover:bg-muted hover:text-foreground"
                        aria-expanded={counted}
                        aria-label={t`Stats: ${name}`}
                        onClick={() => {
                          onWantStats?.();
                          setStatsOpen((current) =>
                            counted
                              ? current.filter((id) => id !== trigger.id)
                              : [...current, trigger.id],
                          );
                        }}
                      >
                        <ChartColumn aria-hidden className="size-3.5" strokeWidth={1.8} />
                        <Trans>Stats</Trans>
                      </button>
                    </>
                  }
                />
              );
            })}
            {editable ? (
              <button
                type="button"
                style={boxStyle(graph.addTrigger, TRIGGER)}
                className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-accent px-3.5 text-center text-sm font-medium text-link hover:text-primary-hover"
                onClick={() => {
                  editing.addTrigger();
                }}
              >
                <Plus aria-hidden className="size-5 flex-none" strokeWidth={2} />
                <Trans>Add new trigger</Trans>
              </button>
            ) : null}
            {editable && graph.beforeStart !== undefined
              ? addButton(
                  'start',
                  { kind: 'start' },
                  graph.beforeStart,
                  t`Add an action at the start`,
                )
              : null}
            {graph.firstStep === undefined ? null : (
              <>
                {editable
                  ? addButton(
                      'first',
                      { kind: 'start' },
                      graph.firstStep.plus,
                      t`Add the first action`,
                    )
                  : null}
                <span
                  style={{
                    position: 'absolute',
                    left: graph.firstStep.pill.x,
                    top: graph.firstStep.pill.y,
                  }}
                  className="-translate-x-1/2 rounded-full bg-secondary px-3 py-2 text-[13px] font-medium whitespace-nowrap"
                >
                  <span className="sr-only">
                    <Trans>No actions yet.</Trans>{' '}
                  </span>
                  <span aria-hidden>
                    <Trans>END</Trans>
                  </span>
                </span>
              </>
            )}

            {graph.nodes.map(({ step, at, connected }) => {
              const name = stepName(step, setup);
              const summary = stepSummary(step, setup);
              const known = stepLabel(step.type) !== undefined;
              const { type } = step;
              const held = moving?.id === step.id;
              // A Go To's jump is not a line: its card says where it leads, and takes you there.
              const goesTo =
                type === 'goto' && typeof step.config['target'] === 'string'
                  ? step.config['target']
                  : undefined;
              const target = graph.nodes.find((node) => node.step.id === goesTo)?.step;
              const targetName = target === undefined ? goesTo : stepName(target, setup);
              const open = (): void => {
                if (known) editing.editStep(step.id);
                else onEditInJson(`/steps/${pointerToken(step.id)}`);
              };
              return (
                <div key={step.id} className="contents">
                  <Box
                    id={stepElementId(step.id)}
                    label={name}
                    at={at}
                    tile={<Tile owner="step" type={step.type} />}
                    caption={
                      connected ? (
                        (stepLabel(step.type) ?? t`Unknown step: ${type}`)
                      ) : (
                        <Trans>Not connected · never runs</Trans>
                      )
                    }
                    summary={
                      step.label ??
                      summary ?? (
                        <span className="text-muted-foreground">
                          <Trans>Not set up yet</Trans>
                        </span>
                      )
                    }
                    dashed={!connected}
                    selected={editing.selected?.kind === 'step' && editing.selected.id === step.id}
                    issues={issuesOf('step', step.id)}
                    leadsTo={leadsTo(step)}
                    chip={
                      goesTo === undefined ? undefined : (
                        <button
                          type="button"
                          className="min-w-0 truncate rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium text-link hover:bg-muted"
                          onClick={() => {
                            const card = document.getElementById(stepElementId(goesTo));
                            card?.focus();
                            card?.scrollIntoView({ block: 'center', inline: 'center' });
                          }}
                        >
                          <Trans>Goes to: {targetName}</Trans>
                        </button>
                      )
                    }
                    dragging={held}
                    onOpen={
                      editable
                        ? () => {
                            // The click that ends a drag is not a request to open the step.
                            if (draggedRef.current) {
                              draggedRef.current = false;
                              return;
                            }
                            open();
                          }
                        : undefined
                    }
                    openLabel={known ? t`Edit: ${name}` : t`Edit in JSON: ${name}`}
                    {...(editable ? dragHandlers(step.id, at, false) : {})}
                    handle={
                      editable ? (
                        <button
                          type="button"
                          className={`${toolClassName} cursor-grab touch-none`}
                          aria-label={t`Move: ${name}`}
                          aria-describedby={moveHintId}
                          onKeyDown={(event) => {
                            moveByKey(event, step);
                          }}
                          {...dragHandlers(step.id, at, true)}
                          onPointerCancel={dragHandlers(step.id, at, true).onPointerUp}
                        >
                          <GripVertical aria-hidden className="size-4" strokeWidth={1.8} />
                        </button>
                      ) : undefined
                    }
                    corner={
                      editable ? (
                        <DropdownMenu
                          onOpenChange={(open) => {
                            // Until a choice opens something, closing gives the keyboard back to the button.
                            if (open) openedRef.current = false;
                          }}
                        >
                          <DropdownMenuTrigger
                            aria-label={t`Actions for: ${name}`}
                            className={cardButtonClassName}
                          >
                            <Ellipsis aria-hidden className="size-4" strokeWidth={1.8} />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="min-w-36"
                            // Either choice opens something that takes the keyboard.
                            finalFocus={() => !openedRef.current}
                          >
                            <DropdownMenuItem
                              onClick={() => {
                                openedRef.current = true;
                                open();
                              }}
                            >
                              {known ? <Trans>Edit</Trans> : <Trans>Edit in JSON</Trans>}
                            </DropdownMenuItem>
                            {/* Where paths join, the line has one add button for all of
                                them; this adds to this path alone. */}
                            {branchNamesOf(step) === undefined ? (
                              <DropdownMenuItem
                                onClick={() => {
                                  openedRef.current = true;
                                  addAt({ kind: 'after', step: step.id });
                                }}
                              >
                                <Trans>Add an action after this one</Trans>
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => {
                                openedRef.current = true;
                                editing.removeStep(step.id);
                              }}
                            >
                              <Trans>Delete</Trans>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : undefined
                    }
                  />
                  {editable
                    ? graph.joins
                        .filter((join) => join.step === step.id)
                        .map((join) =>
                          addButton(
                            `before:${join.step}`,
                            { kind: 'before', step: join.step },
                            join.plus,
                            t`Add an action before: ${name}, for every path that joins here`,
                          ),
                        )
                    : null}
                  {graph.edges
                    .filter((edge) => edge.from === step.id)
                    .map((edge) => (
                      <div key={edge.key} className="contents">
                        {edge.label === undefined || edge.branch === undefined ? null : (
                          <span
                            aria-hidden
                            data-branch-label={edge.key}
                            // A pill centred on the branch's own line, as each column's heading.
                            style={{
                              position: 'absolute',
                              left: edge.label.x,
                              top: edge.label.y,
                            }}
                            className="max-w-36 -translate-x-1/2 -translate-y-1/2 truncate rounded-full border border-border bg-card px-2 text-xs leading-5 font-medium text-body"
                          >
                            {branchLabel(step, edge.branch)}
                          </span>
                        )}
                        {editable && edge.plus !== undefined
                          ? addButton(edge.key, edge.at, edge.plus, addLabel(edge))
                          : null}
                        {edge.pill === undefined ? null : (
                          <span
                            aria-hidden
                            style={{ position: 'absolute', left: edge.pill.x, top: edge.pill.y }}
                            className={`-translate-x-1/2 rounded-full px-3 py-2 text-[13px] font-medium whitespace-nowrap ${
                              edge.to.kind === 'missing'
                                ? 'border border-destructive bg-card text-destructive'
                                : 'bg-secondary'
                            }`}
                          >
                            {edge.to.kind === 'missing' ? (
                              <MissingStep id={edge.to.id} />
                            ) : (
                              <Trans>END</Trans>
                            )}
                          </span>
                        )}
                      </div>
                    ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="absolute bottom-3.5 left-3.5 z-30 flex items-center gap-0.5 rounded-xl border border-border bg-card p-1">
        <button
          type="button"
          className="flex size-10 items-center justify-center rounded-lg hover:bg-muted disabled:opacity-40"
          aria-label={t`Zoom in`}
          disabled={zoom >= 1.5}
          onClick={() => {
            setZoom(ZOOMS.find((each) => each > zoom) ?? 1.5);
          }}
        >
          <Plus aria-hidden className="size-4" strokeWidth={2} />
        </button>
        <span className="min-w-11 text-center text-xs text-muted-foreground" aria-live="polite">
          <span className="sr-only">
            <Trans>Zoom</Trans>{' '}
          </span>
          {percent}%
        </span>
        <button
          type="button"
          className="flex size-10 items-center justify-center rounded-lg hover:bg-muted disabled:opacity-40"
          aria-label={t`Zoom out`}
          disabled={zoom <= 0.5}
          onClick={() => {
            setZoom(ZOOMS[Math.max(0, (zoomIndex === -1 ? ZOOMS.length : zoomIndex) - 1)] ?? 0.5);
          }}
        >
          <Minus aria-hidden className="size-4" strokeWidth={2} />
        </button>
        <button
          type="button"
          className="flex size-10 items-center justify-center rounded-lg hover:bg-muted"
          aria-label={t`Fit to screen`}
          onClick={fit}
        >
          <Maximize aria-hidden className="size-4" strokeWidth={2} />
        </button>
      </div>

      {editable && libraryOpen ? (
        <div
          id={libraryId}
          role="region"
          aria-label={t`Actions`}
          className="absolute top-16 right-3.5 z-40 flex max-h-[min(640px,calc(100%-5rem))] w-[min(360px,calc(100%-1.75rem))] flex-col gap-3 overflow-auto rounded-card border border-border bg-card p-4 shadow-xl"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-medium">
              <Trans>Actions</Trans>
            </h3>
            <button
              type="button"
              className="flex size-10 items-center justify-center rounded-full hover:bg-muted"
              aria-label={t`Close`}
              onClick={() => {
                setLibraryOpen(false);
                toggleRef.current?.focus();
              }}
            >
              <X aria-hidden className="size-5" strokeWidth={1.8} />
            </button>
          </div>
          <p className="text-sm text-muted-foreground">
            <Trans>
              Drag an action onto the canvas, or choose one and then where it goes with a + on the
              canvas.
            </Trans>
          </p>
          <div ref={libraryListRef}>
            <CatchBoundary
              getResetKey={() => 'automation-canvas-library'}
              errorComponent={LibraryUnavailable}
            >
              <Suspense
                fallback={
                  <p role="status" className="text-sm text-muted-foreground">
                    <Trans>Loading the actions…</Trans>
                  </p>
                }
              >
                <Library
                  picker={picker}
                  onChoose={choose}
                  onDragStart={(type, event) => {
                    event.dataTransfer.setData(STEP_MIME, type);
                    event.dataTransfer.effectAllowed = 'copy';
                    setDragType(type);
                  }}
                  onDragEnd={() => {
                    setDragType(undefined);
                    setNearest(undefined);
                  }}
                />
              </Suspense>
            </CatchBoundary>
          </div>
        </div>
      ) : null}
    </section>
  );
}
