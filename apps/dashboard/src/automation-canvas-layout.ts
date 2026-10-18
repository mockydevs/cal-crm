// Where the Canvas view draws an automation (docs/AUTOMATIONS.md sections 2 and 9). The
// document may carry a `layout`: a position for each step someone has placed. Whatever it
// doesn't place is laid out here, as a tree that reads from the top: each step under the one
// before it, each branch in a column of its own. Layout never changes what an automation
// does, and nothing here is kept anywhere but in the document's own `layout`, so the Steps
// and JSON views hold everything the canvas shows.
import {
  branchNamesOf,
  isRecord,
  outlineOf,
  startOf,
  stepOf,
  stepsOf,
  triggersOf,
  type Draft,
  type InsertAt,
  type OutlineItem,
  type StepView,
  type TriggerView,
} from './automation-document';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A step's card. */
export const NODE = { width: 240, height: 80 } as const;
/** A trigger's card, which also holds its filters in a line and a footer of its own. */
export const TRIGGER = { width: 240, height: 140 } as const;
/** The small "End" marker under the last step of a path. */
export const PILL = { width: 80, height: 36 } as const;
/**
 * Boxes moved by hand or by keyboard land on this grid. Every measure of the automatic
 * layout is a whole number of squares too, so writing a drawing down moves nothing.
 */
export const GRID = 20;
/** From one step to the next below it, and from one branch's column to the next. */
export const PITCH = { x: 400, y: 140 } as const;
/** The extra room under a step that branches, for the line that fans out and its labels. */
export const BRANCH_DROP = 60;
/** Clear space around the drawing. */
const MARGIN = 40;
/** Between two triggers side by side. */
const TRIGGER_GAP = 48;

const snap = (value: number): number => Math.round(value / GRID) * GRID;

function pointOf(value: unknown): Point | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y } = value;
  // A finite number can still be too large to advance by GRID or PITCH. Such a saved
  // point would make the collision search stay at the same coordinate forever.
  return typeof x === 'number' &&
    typeof y === 'number' &&
    Number.isSafeInteger(Math.trunc(x)) &&
    Number.isSafeInteger(Math.trunc(y))
    ? { x, y }
    : undefined;
}

/** The positions the document keeps, for steps it has: anything else in `layout` is ignored. */
export function savedPositions(draft: Draft): Map<string, Point> {
  const saved = new Map<string, Point>();
  const layout = draft['layout'];
  if (!isRecord(layout)) return saved;
  for (const step of stepsOf(draft)) {
    const point = Object.hasOwn(layout, step.id) ? pointOf(layout[step.id]) : undefined;
    if (point !== undefined) saved.set(step.id, point);
  }
  return saved;
}

/** One path out of a step: the step itself, and the branch when it has branches. */
const slotKey = (step: string, branch: string | undefined): string =>
  `${step}\u0000${branch ?? ''}`;

/** The step each branch (or the one unnamed path) of a step leads to, in order. */
function pathsOf(
  step: StepView,
): { readonly branch: string | undefined; readonly to: string | undefined }[] {
  const names = branchNamesOf(step);
  if (names === undefined)
    return [{ branch: undefined, to: typeof step.next === 'string' ? step.next : undefined }];
  const next = step.next;
  return names.map((name) => ({
    branch: name,
    to: typeof next === 'string' || next === undefined ? undefined : next[name],
  }));
}

/**
 * What a path out of a step leads to, for the drawing:
 * - `child`: a step only this path leads to, drawn straight under it;
 * - `join`: a step several paths lead to, drawn under all of them;
 * - `back`: a step the path has already been through, as in a loop;
 * - `cross`: a step of another group of steps (steps nothing leads to can still lead somewhere);
 * - `missing`: a step the document doesn't have;
 * - `end`: nothing.
 */
type Fate = 'child' | 'join' | 'back' | 'cross' | 'missing' | 'end';

interface Flow {
  readonly steps: ReadonlyMap<string, StepView>;
  readonly fates: ReadonlyMap<string, Fate>;
  /**
   * The joins each branching step gathers under itself, in the order the flow reaches
   * them: a join belongs to the last step every way into it has been through.
   */
  readonly gathers: ReadonlyMap<string, readonly string[]>;
  /** The start, when the document has it. */
  readonly main: string | undefined;
  /** The first step of each group of steps nothing leads to. */
  readonly detached: readonly string[];
}

// Reads the document as a flow: from the start, then from each step nothing has led to yet.
// A path back to a step it has been through is set aside, so what is left never goes round,
// and each step has one place: under the only path into it, or under every path into it.
function flowOf(draft: Draft): Flow {
  const all = stepsOf(draft);
  const steps = new Map(all.map((step) => [step.id, step]));
  const fates = new Map<string, Fate>();
  const gathers = new Map<string, string[]>();
  const seen = new Set<string>();
  const start = startOf(draft);
  const main = start !== undefined && steps.has(start) ? start : undefined;
  const detached: string[] = [];

  const explore = (root: string): void => {
    const members = new Set<string>();
    const onPath = new Set<string>();
    const into = new Map<string, { readonly from: string; readonly key: string }[]>();
    const finished: string[] = [];
    const stack: { id: string; ways: ReturnType<typeof pathsOf>; next: number }[] = [];
    const enter = (id: string): void => {
      const step = steps.get(id);
      seen.add(id);
      members.add(id);
      onPath.add(id);
      stack.push({ id, ways: step === undefined ? [] : pathsOf(step), next: 0 });
    };
    enter(root);
    for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
      const way = top.ways[top.next];
      if (way === undefined) {
        onPath.delete(top.id);
        finished.push(top.id);
        stack.pop();
        continue;
      }
      top.next += 1;
      const key = slotKey(top.id, way.branch);
      const { to } = way;
      if (to === undefined) fates.set(key, 'end');
      else if (!steps.has(to)) fates.set(key, 'missing');
      else if (onPath.has(to)) fates.set(key, 'back');
      else if (seen.has(to) && !members.has(to)) fates.set(key, 'cross');
      else {
        into.set(to, [...(into.get(to) ?? []), { from: top.id, key }]);
        if (!seen.has(to)) enter(to);
      }
    }
    // In the order the flow reaches them, every way into a step comes before the step.
    const order = finished.toReversed();
    const rank = new Map(order.map((id, index) => [id, index]));
    const boss = new Map<string, string>();
    const rankOf = (id: string): number => rank.get(id) ?? 0;
    const meet = (one: string, other: string): string => {
      let a = one;
      let b = other;
      while (a !== b) {
        while (rankOf(a) > rankOf(b)) a = boss.get(a) ?? root;
        while (rankOf(b) > rankOf(a)) b = boss.get(b) ?? root;
      }
      return a;
    };
    for (const id of order) {
      const [first, ...rest] = into.get(id) ?? [];
      if (first === undefined) continue;
      const owner = rest.reduce((found, each) => meet(found, each.from), first.from);
      boss.set(id, owner);
      if (rest.length === 0) {
        fates.set(first.key, 'child');
        continue;
      }
      for (const each of [first, ...rest]) fates.set(each.key, 'join');
      gathers.set(owner, [...(gathers.get(owner) ?? []), id]);
    }
  };

  if (main !== undefined) explore(main);
  for (const step of all)
    if (!seen.has(step.id)) {
      detached.push(step.id);
      explore(step.id);
    }
  return { steps, fates, gathers, main, detached };
}

interface Rect {
  readonly x1: number;
  readonly x2: number;
  readonly y1: number;
  readonly y2: number;
}

/**
 * A path laid out by itself, measured from the top of its own column: x is across from the
 * column's centre line, y down from where its first step starts.
 */
interface Laid {
  /** How far it reaches either side of its centre line. */
  left: number;
  right: number;
  /** Each step's centre line and top. */
  readonly cards: Map<string, Point>;
  /** Where each path that leads to no step of its own stops: an end marker's top centre. */
  readonly slots: Map<string, Point>;
  /** The centre line of each branch's column. */
  readonly columns: Map<string, number>;
  /** Everything a later card or line must keep clear of: cards, end markers, join lanes. */
  readonly rects: Rect[];
  /** Paths still on their way down to a step several paths lead to: where each has got to. */
  open: { readonly x: number; readonly y: number; readonly to: string }[];
}

const HALF = NODE.width / 2;
/** The room between two columns side by side. */
const GAP = PITCH.x - NODE.width;
/** The room between a step and the next below it. */
const ROW_GAP = PITCH.y - NODE.height;
/** From the lowest card of the paths that join, down to the step they join at. */
export const JOIN_DROP = 120;
/**
 * How far above a step several paths lead to their shared line runs: room for one add
 * button on the run into the step, under the lane, clear of each branch's own above it.
 */
export const LANE_RISE = 60;
/** Half the room between two steps: how far an add button stands from the card beside it. */
const HALF_GAP = ROW_GAP / 2;
/** The least room a line keeps from a card it passes. */
const CLEAR = 20;

function measured(laid: Laid): Laid {
  laid.left = Math.min(-HALF, ...laid.rects.map((rect) => rect.x1));
  laid.right = Math.max(HALF, ...laid.rects.map((rect) => rect.x2));
  return laid;
}

function absorb(into: Laid, part: Laid, dx: number, dy: number): void {
  for (const [id, at] of part.cards) into.cards.set(id, { x: at.x + dx, y: at.y + dy });
  for (const [key, at] of part.slots) into.slots.set(key, { x: at.x + dx, y: at.y + dy });
  for (const [key, x] of part.columns) into.columns.set(key, x + dx);
  for (const rect of part.rects)
    into.rects.push({
      x1: rect.x1 + dx,
      x2: rect.x2 + dx,
      y1: rect.y1 + dy,
      y2: rect.y2 + dy,
    });
  for (const tail of part.open) into.open.push({ x: tail.x + dx, y: tail.y + dy, to: tail.to });
}

// Puts a step several paths lead to, with everything after it, under those paths: below the
// lowest thing in the way, under the step that branched when it stands between them, and
// never under a path that is still on its way down to another join.
function gather(into: Laid, join: string, part: Laid): void {
  const feeding = into.open.filter((tail) => tail.to === join);
  const others = into.open.filter((tail) => tail.to !== join);
  const across = feeding.length === 0 ? [0] : feeding.map((tail) => tail.x);
  const lo = Math.min(...across);
  const hi = Math.max(...across);
  const blocked = (at: number): boolean =>
    others.some((tail) => tail.x > at + part.left - CLEAR && tail.x < at + part.right + CLEAR);
  let at = lo < 0 && hi > 0 && !blocked(0) ? 0 : snap((lo + hi) / 2);
  // Past the last path in the way nothing blocks, so this ends.
  while (blocked(at)) at += GRID;
  const from = Math.min(lo, at + part.left) - CLEAR;
  const to = Math.max(hi, at + part.right) + CLEAR;
  const under = Math.max(
    0,
    ...into.rects.filter((rect) => rect.x2 > from && rect.x1 < to).map((rect) => rect.y2),
    ...feeding.map((tail) => tail.y),
  );
  const top = Math.ceil((under + JOIN_DROP) / GRID) * GRID;
  const lane = top - LANE_RISE;
  into.open = others;
  into.rects.push({ x1: Math.min(lo, at), x2: Math.max(hi, at), y1: lane, y2: lane });
  absorb(into, part, at, top);
}

function layPath(
  flow: Flow,
  first: string | undefined,
  from: { readonly step: string; readonly branch: string | undefined } | undefined,
): Laid {
  const laid: Laid = {
    left: -HALF,
    right: HALF,
    cards: new Map(),
    slots: new Map(),
    columns: new Map(),
    rects: [],
    open: [],
  };
  let y = 0;
  let last = from;
  let step = first === undefined ? undefined : flow.steps.get(first);
  while (step !== undefined) {
    const { id } = step;
    laid.cards.set(id, { x: 0, y });
    laid.rects.push({ x1: -HALF, x2: HALF, y1: y, y2: y + NODE.height });
    const ways = pathsOf(step);
    if (branchNamesOf(step) === undefined) {
      last = { step: id, branch: undefined };
      y += PITCH.y;
      const next = flow.fates.get(slotKey(id, undefined)) === 'child' ? ways[0]?.to : undefined;
      step = next === undefined ? undefined : flow.steps.get(next);
      continue;
    }
    // A step that branches ends the column: its branches stand side by side under it, each
    // wide enough for everything in it, and what they join at comes under them.
    const top = y + PITCH.y + BRANCH_DROP;
    const columns = ways.map((way) =>
      layPath(flow, flow.fates.get(slotKey(id, way.branch)) === 'child' ? way.to : undefined, {
        step: id,
        branch: way.branch,
      }),
    );
    const total =
      columns.reduce((sum, column) => sum + column.right - column.left, 0) +
      (columns.length - 1) * GAP;
    let cursor = -snap(total / 2);
    columns.forEach((column, index) => {
      const dx = cursor - column.left;
      laid.columns.set(slotKey(id, ways[index]?.branch), dx);
      absorb(laid, column, dx, top);
      cursor += column.right - column.left + GAP;
    });
    for (const join of flow.gathers.get(id) ?? [])
      gather(laid, join, layPath(flow, join, undefined));
    return measured(laid);
  }
  if (last !== undefined) {
    const { branch } = last;
    const key = slotKey(last.step, branch);
    const fate = flow.fates.get(key);
    const ended = flow.steps.get(last.step);
    const to =
      ended === undefined ? undefined : pathsOf(ended).find((way) => way.branch === branch)?.to;
    laid.slots.set(key, { x: 0, y });
    if (fate === 'join' && to !== undefined) {
      // Its column is kept, even with no step in it: the line down needs the room.
      laid.open.push({ x: 0, y: y - ROW_GAP, to });
      laid.rects.push({ x1: -HALF, x2: HALF, y1: y - ROW_GAP, y2: y - ROW_GAP });
    } else if (fate === 'end' || fate === 'missing')
      laid.rects.push({ x1: -PILL.width / 2, x2: PILL.width / 2, y1: y, y2: y + PILL.height });
  }
  return measured(laid);
}

interface Tree {
  readonly positions: Map<string, Point>;
  /** The top centre of each path's end, by the step and branch it ends. */
  readonly slots: Map<string, Point>;
  /** The centre line of each branch's column. */
  readonly columns: Map<string, number>;
}

/**
 * Every step laid out from the document alone: the flow from the start as a tree whose
 * branches come together again under themselves, then any steps nothing leads to, each
 * group to the right of the last.
 */
function treeOf(draft: Draft): Tree {
  const flow = flowOf(draft);
  const whole = layPath(flow, flow.main, undefined);
  let left = whole.right + GAP;
  for (const root of flow.detached) {
    const group = layPath(flow, root, undefined);
    absorb(whole, group, left - group.left, 0);
    left += group.right - group.left + GAP;
  }
  const positions = new Map<string, Point>();
  for (const [id, at] of whole.cards) positions.set(id, { x: at.x - HALF, y: at.y });
  return { positions, slots: whole.slots, columns: whole.columns };
}

/** Where every step would be with no `layout` at all. */
export function autoPositions(draft: Draft): Map<string, Point> {
  return treeOf(draft).positions;
}

const overlaps = (a: Point, b: Point): boolean =>
  Math.abs(a.x - b.x) < NODE.width && Math.abs(a.y - b.y) < NODE.height;

// Across from a step, where its i-th path of n goes when nothing else decides.
const columnOffset = (index: number, count: number): number => (index - (count - 1) / 2) * PITCH.x;

/**
 * Where every step is: where the document places it, and for the rest, laid out
 * automatically. With nothing placed, that is the whole tree. Once some steps are placed,
 * each other step goes under the placed step that leads to it, moved aside if that spot is
 * taken, so a step added in another view never lands on top of one placed by hand.
 */
export function positionsOf(draft: Draft): Map<string, Point> {
  const saved = savedPositions(draft);
  const auto = autoPositions(draft);
  if (saved.size === 0) return auto;
  const positions = new Map(saved);
  const free = (wanted: Point): Point => {
    let point = wanted;
    while ([...positions.values()].some((taken) => overlaps(taken, point)))
      point = { x: point.x + PITCH.x, y: point.y };
    return point;
  };
  // Outward from the placed steps, in the order the flow reaches them.
  const waiting = [...saved.keys()];
  while (waiting.length > 0) {
    const id = waiting.shift();
    const step = id === undefined ? undefined : stepOf(draft, id);
    const origin = id === undefined ? undefined : positions.get(id);
    if (step === undefined || origin === undefined) continue;
    const paths = pathsOf(step);
    paths.forEach(({ to }, index) => {
      if (to === undefined || positions.has(to) || stepOf(draft, to) === undefined) return;
      positions.set(
        to,
        free({
          x: origin.x + columnOffset(index, paths.length),
          y: origin.y + PITCH.y + (paths.length > 1 ? BRANCH_DROP : 0),
        }),
      );
      waiting.push(to);
    });
  }
  // Whatever no placed step leads to keeps its place in the tree, below everything placed.
  const floor = Math.max(...[...positions.values()].map((point) => point.y)) + PITCH.y;
  const ceiling = Math.min(
    ...[...auto.entries()].filter(([id]) => !positions.has(id)).map(([, point]) => point.y),
  );
  for (const [id, point] of auto)
    if (!positions.has(id)) positions.set(id, free({ x: point.x, y: floor + point.y - ceiling }));
  return positions;
}

export type EdgeTarget =
  | { readonly kind: 'step'; readonly id: string }
  /** The path ends here. */
  | { readonly kind: 'end' }
  /** The path names a step the document doesn't have. */
  | { readonly kind: 'missing'; readonly id: string };

export interface CanvasEdge {
  /** Unique among the drawing's edges. */
  readonly key: string;
  readonly from: string;
  readonly branch: string | undefined;
  readonly to: EdgeTarget;
  /** Where a step added on this edge goes. */
  readonly at: InsertAt;
  /** The corners of the line, from the foot of its step to where it arrives. */
  readonly points: readonly Point[];
  /** The line, as SVG path data, with its corners rounded. */
  readonly path: string;
  /**
   * The centre of the "add a step here" button. None for a step's line into a step several
   * paths lead to: there the one button is the join's own (`CanvasGraph.joins`).
   */
  readonly plus: Point | undefined;
  /** The centre of the branch's name, on its own column, when the edge is a branch. */
  readonly label: Point | undefined;
  /** The middle of the end marker's top edge, for an edge that leads to no step. */
  readonly pill: Point | undefined;
  /** Whether it leads back up the drawing, as a loop does. */
  readonly back: boolean;
}

/** A step several paths lead to: the add button on the one run they all come in by. */
export interface CanvasJoin {
  readonly step: string;
  /** The centre of the button that adds a step before it, for every path into it. */
  readonly plus: Point;
}

export interface CanvasNode {
  readonly step: StepView;
  readonly at: Point;
  /** Whether a contact can reach it from the start. */
  readonly connected: boolean;
}

export interface CanvasTrigger {
  readonly trigger: TriggerView;
  readonly at: Point;
  /** The line down to the first step, when there is one. */
  readonly path: string | undefined;
}

export interface CanvasGraph {
  readonly size: { readonly width: number; readonly height: number };
  /** What to add to a drawing position to get the document's own. */
  readonly origin: Point;
  readonly triggers: readonly CanvasTrigger[];
  /** Where the "Add new trigger" card goes, beside the last trigger. */
  readonly addTrigger: Point;
  /** With no trigger yet, the line from that card down to where the flow starts. */
  readonly addTriggerPath: string | undefined;
  /** The steps in the order a contact meets them, then those nothing leads to. */
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
  /** Where several paths come together, with room for an add button of their own. */
  readonly joins: readonly CanvasJoin[];
  /** The add button under the triggers of an automation with no steps yet. */
  readonly firstStep: { readonly plus: Point; readonly pill: Point } | undefined;
  /** The add button between the triggers and the first step. */
  readonly beforeStart: Point | undefined;
}

const bottomOf = (at: Point): Point => ({ x: at.x + NODE.width / 2, y: at.y + NODE.height });
const topOf = (at: Point): Point => ({ x: at.x + NODE.width / 2, y: at.y });

/** How far under a step that branches the line across to its branches runs. */
const BAR = BRANCH_DROP / 2;
/** How round a line's corners are. */
const CORNER = 10;
/** How far above a step a line that comes round the side turns in to it. */
const SIDE_RISE = 12;
/** The least a line must go down for it to be drawn downwards, not round the side. */
const LEAST_DROP = 32;

// What a line doesn't need: the same point twice, and a point in the middle of a straight run.
function cornersOf(points: readonly Point[]): Point[] {
  const kept: Point[] = [];
  for (const point of points) {
    const last = kept.at(-1);
    if (last?.x === point.x && last.y === point.y) continue;
    const before = kept.at(-2);
    if (
      before !== undefined &&
      last !== undefined &&
      ((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))
    )
      kept.pop();
    kept.push(point);
  }
  return kept;
}

/**
 * SVG path data for a line of straight runs through these points, with each corner
 * rounded: M moves, L draws straight, and Q bends round a corner.
 */
export function linePath(points: readonly Point[]): string {
  const corners = cornersOf(points);
  const [first, ...rest] = corners;
  if (first === undefined) return '';
  const parts: (string | number)[] = ['M', first.x, first.y];
  rest.forEach((point, index) => {
    const before = corners[index];
    const after = rest[index + 1];
    if (before === undefined || after === undefined) {
      parts.push('L', point.x, point.y);
      return;
    }
    const lengthTo = (other: Point): number =>
      Math.abs(other.x - point.x) + Math.abs(other.y - point.y);
    const radius = Math.min(CORNER, lengthTo(before) / 2, lengthTo(after) / 2);
    const toward = (other: Point): Point => ({
      x: point.x + ((other.x - point.x) * radius) / lengthTo(other),
      y: point.y + ((other.y - point.y) * radius) / lengthTo(other),
    });
    const into = toward(before);
    const out = toward(after);
    parts.push('L', into.x, into.y, 'Q', point.x, point.y, out.x, out.y);
  });
  return parts.join(' ');
}

/** A path out of a step, before its line is drawn: where it leaves and where it arrives. */
interface Wanted {
  readonly from: string;
  readonly branch: string | undefined;
  readonly to: EdgeTarget;
  /** The middle of the foot of the step it leaves. */
  readonly source: Point;
  /** The middle of the top of the step, or of the end marker, it arrives at. */
  readonly target: Point;
  readonly pill: Point | undefined;
  /** Whether it is one of several branches. */
  readonly branching: boolean;
  /** The centre line of the column it goes down. */
  readonly column: number;
}

interface Drawn {
  readonly points: readonly Point[];
  readonly plus: Point | undefined;
  readonly label: Point;
  readonly back: boolean;
}

// Straight down a column, and round any card in the way: across above it to its nearer
// side, then on down. A drawing laid out automatically has nothing in the way; one arranged
// by hand may.
function dropPast(
  x: number,
  from: number,
  to: number,
  toward: number,
  cards: readonly Point[],
): Point[] {
  const points: Point[] = [];
  let at = x;
  let y = from;
  for (let turns = 0; turns < 8; turns += 1) {
    const [hit] = cards
      .filter(
        (card) =>
          card.x < at && at < card.x + NODE.width && card.y + NODE.height > y && card.y < to,
      )
      .toSorted((a, b) => a.y - b.y);
    if (hit === undefined) break;
    const turn = Math.max(y, hit.y - CLEAR);
    const side = toward >= at ? hit.x + NODE.width + CLEAR : hit.x - CLEAR;
    points.push({ x: at, y: turn }, { x: side, y: turn });
    at = side;
    y = turn;
  }
  points.push({ x: at, y: to });
  return points;
}

/**
 * The line of every path, by these rules:
 * - a path to the next step goes straight down;
 * - the branches of a step leave it together, run along one bar under it, and each goes
 *   down its own column, with its name and its add button on that column;
 * - paths that lead to the same step each go straight down their own column to one shared
 *   lane just above that step, along it, and into the top of the step, so no line runs
 *   over a card or along another line; two lanes that would lie on each other are set apart.
 *   There is one add button where they join: under the lane, on the run every path shares,
 *   and what it adds comes before the step for all of them. Only a branch with no step of
 *   its own keeps a button on its column, under its name;
 * - a path that leads back up, as a loop does, goes round the right-hand side.
 */
function drawn(
  wanted: readonly Wanted[],
  positions: ReadonlyMap<string, Point>,
): { readonly lines: Drawn[]; readonly joins: CanvasJoin[] } {
  const down = (edge: Wanted): boolean => edge.target.y - edge.source.y >= LEAST_DROP;
  const into = new Map<string, Wanted[]>();
  for (const edge of wanted)
    if (edge.to.kind === 'step' && down(edge))
      into.set(edge.to.id, [...(into.get(edge.to.id) ?? []), edge]);
  const topOfLine = (edge: Wanted): number =>
    edge.branching ? edge.source.y + BAR : edge.source.y;
  const lanes = new Map<string, number>();
  const joins: CanvasJoin[] = [];
  /** Joins with no room for a button of their own: each path into one keeps its own. */
  const tight = new Set<string>();
  const taken: { readonly y: number; readonly x1: number; readonly x2: number }[] = [];
  for (const [id, edges] of into) {
    const [first] = edges;
    if (first === undefined || edges.length < 2) continue;
    const across = [first.target.x, ...edges.map((edge) => edge.column)];
    const x1 = Math.min(...across);
    const x2 = Math.max(...across);
    // With room, the lane leaves space under it for the add button of the step itself.
    // A drawing arranged by hand may leave less: then the lane runs close above the step.
    const roomy = edges.every((edge) => first.target.y - LANE_RISE - topOfLine(edge) >= ROW_GAP);
    let y = first.target.y - (roomy ? LANE_RISE : CLEAR);
    const lies = (): boolean => taken.some((lane) => lane.y === y && lane.x1 < x2 && x1 < lane.x2);
    for (let moved = 0; moved < 2 && lies(); moved += 1) y -= CORNER;
    lanes.set(id, y);
    taken.push({ y, x1, x2 });
    if (roomy) joins.push({ step: id, plus: { x: first.target.x, y: first.target.y - HALF_GAP } });
    else tight.add(id);
  }

  let sides = 0;
  const lines = wanted.map((edge): Drawn => {
    const { source, target, column, branching } = edge;
    const bar = source.y + BAR;
    const top = branching ? bar : source.y;
    // Where a branch's name and add button go on its column, between the bar and `end`.
    const marks = (x: number, end: number): { plus: Point; label: Point } => {
      const room = end - bar >= 84;
      return {
        label: { x, y: room ? bar + 24 : bar },
        plus: { x, y: room ? bar + 60 : (bar + end) / 2 },
      };
    };
    const lane = edge.to.kind === 'step' && down(edge) ? lanes.get(edge.to.id) : undefined;
    if (lane !== undefined && lane - top >= CLEAR) {
      const others = [...positions]
        .filter(([id]) => id !== edge.from && (edge.to.kind !== 'step' || id !== edge.to.id))
        .map(([, at]) => at);
      const points = [
        source,
        { x: source.x, y: top },
        { x: column, y: top },
        ...dropPast(column, top, lane, target.x, others),
        { x: target.x, y: lane },
        target,
      ];
      return {
        points,
        ...(branching
          ? marks(column, lane)
          : {
              // Where paths join there is one add button, the join's own, under the lane.
              plus:
                edge.to.kind === 'step' && !tight.has(edge.to.id)
                  ? undefined
                  : { x: column, y: source.y + Math.min(HALF_GAP, (lane - source.y) / 2) },
              label: { x: column, y: source.y },
            }),
        back: false,
      };
    }
    if (down(edge)) {
      if (branching)
        return {
          points: [source, { x: source.x, y: bar }, { x: target.x, y: bar }, target],
          ...marks(target.x, target.y),
          back: false,
        };
      const turn = (source.y + target.y) / 2;
      const straight = source.x === target.x;
      return {
        points: [source, { x: source.x, y: turn }, { x: target.x, y: turn }, target],
        plus: { x: target.x, y: straight ? turn : (turn + target.y) / 2 },
        label: { x: target.x, y: turn },
        back: false,
      };
    }
    // Back up, or across: out past every card beside the way, and in from above.
    const beside = [...positions.values()].filter(
      (at) => at.y + NODE.height > target.y - SIDE_RISE && at.y < source.y + 16,
    );
    const side =
      Math.max(source.x + HALF, target.x + HALF, ...beside.map((at) => at.x + NODE.width)) +
      MARGIN +
      sides * GRID;
    sides += 1;
    return {
      points: [
        source,
        { x: source.x, y: source.y + 16 },
        { x: side, y: source.y + 16 },
        { x: side, y: target.y - SIDE_RISE },
        { x: target.x, y: target.y - SIDE_RISE },
        target,
      ],
      plus: { x: side, y: (source.y + target.y) / 2 },
      label: { x: source.x, y: source.y + 16 },
      back: true,
    };
  });
  return { lines, joins };
}

/**
 * The whole drawing: every trigger, step, line and end marker, with positions measured
 * from the drawing's own top-left corner.
 */
export function canvasGraph(draft: Draft): CanvasGraph {
  const positions = positionsOf(draft);
  const placedByHand = savedPositions(draft).size > 0;
  const tree = placedByHand ? undefined : treeOf(draft);
  const steps = stepsOf(draft);
  const start = startOf(draft);
  const startAt = start === undefined ? undefined : positions.get(start);

  // The order a contact meets the steps in, which is also the order they are read out in.
  const ordered: string[] = [];
  const reached = new Set<string>();
  const walk = (items: readonly OutlineItem[]): void => {
    for (const item of items) {
      if (item.kind !== 'step') continue;
      ordered.push(item.step.id);
      for (const branch of item.branches) walk(branch.items);
    }
  };
  const outline = outlineOf(draft);
  walk(outline.main.items);
  for (const id of ordered) reached.add(id);
  for (const path of outline.detached) walk(path.items);

  // Triggers stand in a row above the first step; with no steps, at the top by themselves.
  const triggerViews = triggersOf(draft);
  const triggerRow: Point = startAt ?? { x: 0, y: PITCH.y };
  // The gap under a trigger is the gap under a step, however tall the trigger's card is.
  const triggerAt = (index: number): Point => ({
    x: triggerRow.x + index * (TRIGGER.width + TRIGGER_GAP),
    y: triggerRow.y - PITCH.y - (TRIGGER.height - NODE.height),
  });

  // How many paths lead down to each step: one goes straight to it, several share a lane.
  const arrivals = new Map<string, number>();
  for (const step of steps) {
    const at = positions.get(step.id);
    if (at === undefined) continue;
    for (const { to } of pathsOf(step)) {
      const targetAt = to === undefined ? undefined : positions.get(to);
      if (to !== undefined && targetAt !== undefined && targetAt.y - bottomOf(at).y >= LEAST_DROP)
        arrivals.set(to, (arrivals.get(to) ?? 0) + 1);
    }
  }

  const wanted: Wanted[] = [];
  for (const step of steps) {
    const at = positions.get(step.id);
    if (at === undefined) continue;
    const paths = pathsOf(step);
    const source = bottomOf(at);
    paths.forEach(({ branch, to }, index) => {
      const branching = paths.length > 1;
      const key = slotKey(step.id, branch);
      const across = source.x + columnOffset(index, paths.length);
      const targetAt = to === undefined ? undefined : positions.get(to);
      if (to !== undefined && targetAt !== undefined) {
        const target = topOf(targetAt);
        wanted.push({
          from: step.id,
          branch,
          to: { kind: 'step', id: to },
          source,
          target,
          pill: undefined,
          branching,
          // The column the tree gave the branch; by hand, over the step only it leads to.
          column: !branching
            ? source.x
            : (tree?.columns.get(key) ?? ((arrivals.get(to) ?? 0) < 2 ? target.x : across)),
        });
        return;
      }
      // No step to lead to: an end marker, in the tree's own slot when the tree laid it out.
      const centre = tree?.slots.get(key) ?? {
        x: across,
        y: at.y + PITCH.y + (branching ? BRANCH_DROP : 0),
      };
      wanted.push({
        from: step.id,
        branch,
        to: to === undefined ? { kind: 'end' } : { kind: 'missing', id: to },
        source,
        target: centre,
        pill: centre,
        branching,
        column: centre.x,
      });
    });
  }
  const { lines, joins } = drawn(wanted, positions);

  const boxes: { at: Point; width: number; height: number }[] = [
    ...[...positions.values()].map((at) => ({ at, ...NODE })),
    ...wanted.flatMap((edge) =>
      edge.pill === undefined
        ? []
        : [{ at: { x: edge.pill.x - PILL.width / 2, y: edge.pill.y }, ...PILL }],
    ),
    ...triggerViews.map((_, index) => ({ at: triggerAt(index), ...TRIGGER })),
    // The "Add new trigger" card, and the first-step marker of an empty flow.
    { at: triggerAt(triggerViews.length), ...TRIGGER },
    ...(startAt === undefined ? [{ at: { x: triggerRow.x, y: triggerRow.y }, ...NODE }] : []),
  ];
  const corners = lines.flatMap((each) => each.points);
  const minX = Math.min(...boxes.map((box) => box.at.x), ...corners.map((point) => point.x));
  const minY = Math.min(...boxes.map((box) => box.at.y), ...corners.map((point) => point.y));
  const maxX = Math.max(
    ...boxes.map((box) => box.at.x + box.width),
    ...corners.map((point) => point.x),
  );
  const maxY = Math.max(
    ...boxes.map((box) => box.at.y + box.height),
    ...corners.map((point) => point.y),
  );
  const origin: Point = { x: minX - MARGIN, y: minY - MARGIN };
  const shown = (point: Point): Point => ({ x: point.x - origin.x, y: point.y - origin.y });

  const first = startAt === undefined ? undefined : shown(topOf(startAt));
  const under = (at: Point): Point => ({ x: at.x + TRIGGER.width / 2, y: at.y + TRIGGER.height });
  const to = first ?? { x: shown(triggerRow).x + NODE.width / 2, y: shown(triggerRow).y };
  const triggers = triggerViews.map((trigger, index): CanvasTrigger => {
    const at = shown(triggerAt(index));
    const from = under(at);
    // The first trigger's line is straight down; the others join it above the first step.
    return {
      trigger,
      at,
      path: linePath(
        index === 0
          ? [from, { x: from.x, y: to.y }]
          : [from, { x: from.x, y: from.y + 16 }, { x: to.x, y: from.y + 16 }],
      ),
    };
  });

  const emptyAt = shown(triggerRow);
  return {
    size: { width: maxX - minX + 2 * MARGIN, height: maxY - minY + 2 * MARGIN },
    origin,
    triggers,
    addTrigger: shown(triggerAt(triggerViews.length)),
    addTriggerPath:
      triggerViews.length === 0
        ? linePath([
            { x: to.x, y: under(shown(triggerAt(0))).y },
            { x: to.x, y: to.y },
          ])
        : undefined,
    nodes: ordered.flatMap((id) => {
      const step = stepOf(draft, id);
      const at = positions.get(id);
      return step === undefined || at === undefined
        ? []
        : [{ step, at: shown(at), connected: reached.has(id) }];
    }),
    edges: wanted.flatMap((edge, index): CanvasEdge[] => {
      const line = lines[index];
      if (line === undefined) return [];
      const points = cornersOf(line.points.map(shown));
      return [
        {
          key: slotKey(edge.from, edge.branch),
          from: edge.from,
          branch: edge.branch,
          to: edge.to,
          at:
            edge.branch === undefined
              ? { kind: 'after', step: edge.from }
              : { kind: 'after', step: edge.from, branch: edge.branch },
          points,
          path: linePath(points),
          plus: line.plus === undefined ? undefined : shown(line.plus),
          label: edge.branch === undefined ? undefined : shown(line.label),
          pill: edge.pill === undefined ? undefined : shown(edge.pill),
          back: line.back,
        },
      ];
    }),
    joins: joins.map((join) => ({ step: join.step, plus: shown(join.plus) })),
    firstStep:
      startAt === undefined
        ? {
            plus: { x: emptyAt.x + NODE.width / 2, y: emptyAt.y - (PITCH.y - NODE.height) / 2 },
            pill: { x: emptyAt.x + NODE.width / 2, y: emptyAt.y },
          }
        : undefined,
    beforeStart:
      first === undefined || triggerViews.length === 0
        ? undefined
        : { x: first.x, y: first.y - (PITCH.y - NODE.height) / 2 },
  };
}

function withLayout(draft: Draft, positions: ReadonlyMap<string, Point>): Draft {
  // In the order the document lists its steps, so the JSON reads the same way each time.
  const layout: Record<string, Point> = {};
  for (const step of stepsOf(draft)) {
    const point = positions.get(step.id);
    if (point !== undefined) layout[step.id] = point;
  }
  return { ...draft, layout };
}

/**
 * Puts a step somewhere by hand. Every step's place is written down with it, so the rest of
 * the drawing stays exactly where the person saw it. Only `layout` changes.
 */
export function moveStep(draft: Draft, id: string, to: Point): Draft {
  const point = pointOf({ x: snap(to.x), y: snap(to.y) });
  if (stepOf(draft, id) === undefined || point === undefined) return draft;
  const positions = positionsOf(draft);
  positions.set(id, point);
  return withLayout(draft, positions);
}

/** Moves a step by a number of grid squares, as the arrow keys do. */
export function nudgeStep(draft: Draft, id: string, by: Point): Draft {
  const from = positionsOf(draft).get(id);
  return from === undefined
    ? draft
    : moveStep(draft, id, { x: snap(from.x) + by.x * GRID, y: snap(from.y) + by.y * GRID });
}

/** Whether any step has been placed by hand. */
export const hasLayout = (draft: Draft): boolean => savedPositions(draft).size > 0;

/** Forgets every placement, so the whole automation is laid out automatically again. */
export function tidyLayout(draft: Draft): Draft {
  const { layout: _layout, ...rest } = draft;
  return rest;
}

/**
 * Makes room for a step just added to a drawing that has been arranged by hand: the new
 * step takes the place of the step it now leads to, and that step and everything after it
 * moves down one row. A step added at the end of a path goes under the step before it.
 * With nothing arranged by hand there is nothing to do: the tree lays the new step out.
 */
export function placeAddedStep(before: Draft, after: Draft, added: string): Draft {
  const saved = savedPositions(before);
  const step = stepOf(after, added);
  if (saved.size === 0 || step === undefined) return after;
  const positions = positionsOf(before);
  const displaced = pathsOf(step).find(({ to }) => to !== undefined)?.to;
  const displacedAt = displaced === undefined ? undefined : positions.get(displaced);
  const leadsToIt = stepsOf(after).find((each) => pathsOf(each).some(({ to }) => to === added));
  const beforeAt = leadsToIt === undefined ? undefined : positions.get(leadsToIt.id);
  // What it leads to is back up the drawing, as in a loop: nothing below needs to move.
  const loopsBack =
    displacedAt !== undefined && beforeAt !== undefined && displacedAt.y <= beforeAt.y;
  if (displaced === undefined || displacedAt === undefined || loopsBack) {
    // Nothing follows it below: the automatic place under what leads to it is free or made free.
    const placed = positionsOf(withLayout(after, positions)).get(added);
    return placed === undefined ? after : withLayout(after, new Map(positions).set(added, placed));
  }
  // Everything the displaced step leads to that is level with it or below, itself
  // included, moves down a row. What a loop leads back up to stays where it is.
  const moving = new Set<string>();
  const waiting = [displaced];
  while (waiting.length > 0) {
    const id = waiting.pop();
    if (id === undefined || id === added || moving.has(id)) continue;
    const next = stepOf(after, id);
    const at = positions.get(id);
    if (next === undefined || at === undefined || at.y < displacedAt.y) continue;
    moving.add(id);
    for (const { to } of pathsOf(next)) if (to !== undefined) waiting.push(to);
  }
  const shifted = new Map<string, Point>();
  for (const [id, point] of positions)
    shifted.set(id, moving.has(id) ? { x: point.x, y: point.y + PITCH.y } : point);
  shifted.set(added, displacedAt);
  return withLayout(after, shifted);
}
