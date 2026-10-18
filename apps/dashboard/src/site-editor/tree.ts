// The rules of a page's tree while it is edited: where each node sits, what a place may
// hold, how many, how deep, and where "add", "move" and "duplicate" put things. Everything
// here is a plain function over the canvas's data (document-map.ts), so the limits the
// server's schema enforces at save are enforced here while editing, and a refusal is known
// before anything is changed. Nothing imports the canvas library.
import { PAGE_DOCUMENT_LIMITS, pageElementTypes } from '@repo/contracts';
import { SLOT_OF, type CanvasData, type CanvasNode } from './document-map';

export const SECTIONS_ZONE = 'root:sections';
export const POPUPS_ZONE = 'root:popups';

/** The element types of the format, in the order the element panel lists them. */
export const ELEMENT_TYPES: readonly string[] = pageElementTypes;
/** Every element but the one that holds others: what the deepest container may hold. */
export const LEAF_TYPES: readonly string[] = pageElementTypes.filter(
  (type) => type !== 'container',
);
export const isElementType = (type: string): boolean => ELEMENT_TYPES.includes(type);

/** The deepest a container may sit: straight in a column is 1 (the schema refuses 4). */
export const DEEPEST_CONTAINER = PAGE_DOCUMENT_LIMITS.containerDepth - 1;

/** A node with where it sits. */
export interface Placed {
  readonly node: CanvasNode;
  /** The zone that holds it, as the canvas names zones: `<parent id>:<slot>`. */
  readonly zone: string;
  readonly index: number;
  /** The node that holds it, or null for a section or a popup. */
  readonly parent: CanvasNode | null;
  /** How deep in containers an element sits: 1 straight in a column. 0 for layout nodes. */
  readonly depth: number;
}

export type TreeIndex = ReadonlyMap<string, Placed>;

const slotChildren = (node: CanvasNode): readonly CanvasNode[] => {
  const slot = SLOT_OF[node.type];
  const children = slot === undefined ? undefined : node.props[slot];
  return Array.isArray(children) ? (children as readonly CanvasNode[]) : [];
};

/** Every node of a page by its id, with its place. */
export function indexTree(data: CanvasData): TreeIndex {
  const index = new Map<string, Placed>();
  const visit = (
    nodes: readonly CanvasNode[],
    zone: string,
    parent: CanvasNode | null,
    depth: number,
  ): void => {
    nodes.forEach((node, at) => {
      index.set(node.props.id, { node, zone, index: at, parent, depth });
      const slot = SLOT_OF[node.type];
      if (slot === undefined) return;
      // An element straight in a column is at depth 1; inside a container, one deeper.
      const below = node.type === 'column' ? 1 : node.type === 'container' ? depth + 1 : 0;
      visit(slotChildren(node), `${node.props.id}:${slot}`, node, below);
    });
  };
  visit(data.root.props.sections, SECTIONS_ZONE, null, 0);
  visit(data.root.props.popups, POPUPS_ZONE, null, 0);
  return index;
}

/** What a zone holds now. */
export function zoneNodes(data: CanvasData, index: TreeIndex, zone: string): readonly CanvasNode[] {
  if (zone === SECTIONS_ZONE) return data.root.props.sections;
  if (zone === POPUPS_ZONE) return data.root.props.popups;
  const [ownerId] = zone.split(':');
  const owner = ownerId === undefined ? undefined : index.get(ownerId);
  return owner === undefined ? [] : slotChildren(owner.node);
}

/** The zone a node keeps its own children in, or undefined for a node that holds none. */
export function zoneOf(node: CanvasNode): string | undefined {
  const slot = SLOT_OF[node.type];
  return slot === undefined ? undefined : `${node.props.id}:${slot}`;
}

/** Why something cannot be put somewhere, as a word the page turns into a sentence. */
export type Refusal =
  | 'sections'
  | 'popups'
  | 'rows'
  | 'columns'
  | 'children'
  | 'depth'
  | 'nodes'
  | 'kind'
  | 'last_column'
  | 'needs_row';

const slotOf = (zone: string): string => zone.split(':')[1] ?? '';

/** How many nodes a zone may hold: the schema's own limits. */
export function zoneCapacity(zone: string): number {
  switch (slotOf(zone)) {
    case 'sections':
      return PAGE_DOCUMENT_LIMITS.sections;
    case 'popups':
      return PAGE_DOCUMENT_LIMITS.popups;
    case 'rows':
      return PAGE_DOCUMENT_LIMITS.rows;
    case 'columns':
      return PAGE_DOCUMENT_LIMITS.columns;
    default:
      return PAGE_DOCUMENT_LIMITS.children;
  }
}

/** The refusal a full zone gives: the name of its limit. */
const fullRefusal = (zone: string): Refusal => {
  const slot = slotOf(zone);
  return slot === 'sections' || slot === 'popups' || slot === 'rows' || slot === 'columns'
    ? slot
    : 'children';
};

/** How deep an element put into this zone would sit, or 0 for a zone of layout nodes. */
export function depthIn(index: TreeIndex, zone: string): number {
  if (slotOf(zone) !== 'children') return 0;
  const owner = index.get(zone.split(':')[0] ?? '');
  if (owner === undefined) return 0;
  return owner.node.type === 'column' ? 1 : owner.depth + 1;
}

/** The kinds of node a zone takes, whatever is in it now. */
export function kindsIn(index: TreeIndex, zone: string): readonly string[] {
  switch (slotOf(zone)) {
    case 'sections':
      return ['section', 'saved_section'];
    case 'popups':
      return ['popup'];
    case 'rows':
      return ['row'];
    case 'columns':
      return ['column'];
    default:
      return depthIn(index, zone) > DEEPEST_CONTAINER ? LEAF_TYPES : ELEMENT_TYPES;
  }
}

/** How many containers deep a node goes below itself: 0 for anything but a container. */
export function containerHeight(node: CanvasNode): number {
  if (node.type !== 'container') return 0;
  return 1 + Math.max(0, ...slotChildren(node).map(containerHeight));
}

/** How many nodes a node is, itself and everything under it. */
export function countNodes(node: CanvasNode): number {
  return 1 + slotChildren(node).reduce((sum, child) => sum + countNodes(child), 0);
}

/** How many nodes a page holds: what the schema counts against its limit. */
export const pageNodeCount = (index: TreeIndex): number => index.size;

/**
 * Why a node may not be put into a zone, or null when it may. `moving` is true for a node
 * that is already on the page: it adds nothing to the page's count, and it does not count
 * against the zone it is already in.
 */
export function refusalFor(
  data: CanvasData,
  index: TreeIndex,
  node: CanvasNode,
  zone: string,
  moving: boolean,
): Refusal | null {
  if (!kindsIn(index, zone).includes(node.type)) {
    // The deepest container takes every element but another container.
    return isElementType(node.type) && slotOf(zone) === 'children' ? 'depth' : 'kind';
  }
  const already = moving && index.get(node.props.id)?.zone === zone;
  if (!already && zoneNodes(data, index, zone).length >= zoneCapacity(zone))
    return fullRefusal(zone);
  if (node.type === 'container') {
    const deepest = depthIn(index, zone) + containerHeight(node) - 1;
    if (deepest > DEEPEST_CONTAINER) return 'depth';
  }
  if (!moving && pageNodeCount(index) + countNodes(node) > PAGE_DOCUMENT_LIMITS.nodes)
    return 'nodes';
  return null;
}

/** Whether a zone can take one more node of the kinds it holds. */
export const isFull = (data: CanvasData, index: TreeIndex, zone: string): boolean =>
  zoneNodes(data, index, zone).length >= zoneCapacity(zone);

/** One node to add: its kind, the id it will have, and where it goes. */
export interface InsertStep {
  readonly type: string;
  readonly id: string;
  readonly zone: string;
  readonly index: number;
}

/** Where a new node went, as seen from what was selected: for the sentence that says so. */
export type Where = 'page' | 'after' | 'inside' | 'near';

export type AddPlan =
  | {
      readonly ok: true;
      readonly steps: readonly InsertStep[];
      readonly select: string;
      readonly where: Where;
    }
  | { readonly ok: false; readonly refusal: Refusal };

const refused = (refusal: Refusal): AddPlan => ({ ok: false, refusal });

/** The nearest node of some kinds at or above a node. */
function nearest(index: TreeIndex, id: string | null, kinds: readonly string[]): Placed | null {
  let at = id === null ? undefined : index.get(id);
  while (at !== undefined) {
    if (kinds.includes(at.node.type)) return at;
    at = at.parent === null ? undefined : index.get(at.parent.props.id);
  }
  return null;
}

const stub = (type: string, id: string): CanvasNode => ({ type, props: { id } });

/**
 * Where a new node of a kind goes, given what is selected: an element goes after the
 * selected element, or inside the selected column or container; a row, a column and a
 * section go after the one the selection is in. Whatever is missing on the way (a
 * section, a row, its column) is added first, so "add a headline" works on an empty page.
 * Every step is checked against the limits before anything is planned.
 */
export function planAdd(
  data: CanvasData,
  index: TreeIndex,
  type: string,
  selectedId: string | null,
  newId: () => string,
): AddPlan {
  const steps: InsertStep[] = [];
  let added = 0;
  // A step into a zone that exists is checked against it; one into a zone a step before
  // it made is into an empty zone of the right kind, so only the page's count matters.
  const plan = (kind: string, zone: string, at: number, fresh: boolean): Refusal | null => {
    const id = newId();
    if (!fresh) {
      const refusal = refusalFor(data, index, stub(kind, id), zone, false);
      if (refusal !== null) return refusal;
    }
    added += 1;
    if (pageNodeCount(index) + added > PAGE_DOCUMENT_LIMITS.nodes) return 'nodes';
    steps.push({ type: kind, id, zone, index: at });
    return null;
  };
  const last = (): InsertStep => {
    const step = steps.at(-1);
    if (step === undefined) throw new Error('a plan has a step');
    return step;
  };
  const where = (): Where => {
    const [first] = steps;
    const selected = selectedId === null ? undefined : index.get(selectedId);
    if (selected === undefined || first === undefined) return 'page';
    if (first.zone === zoneOf(selected.node)) return 'inside';
    return first.zone === selected.zone && first.index === selected.index + 1 ? 'after' : 'near';
  };
  const done = (): AddPlan => ({ ok: true, steps, select: last().id, where: where() });
  const endOf = (zone: string): number => zoneNodes(data, index, zone).length;

  if (type === 'popup') {
    const refusal = plan('popup', POPUPS_ZONE, endOf(POPUPS_ZONE), false);
    return refusal === null ? done() : refused(refusal);
  }
  if (type === 'section') {
    const within = nearest(index, selectedId, ['section', 'saved_section']);
    const at = within === null ? endOf(SECTIONS_ZONE) : within.index + 1;
    const refusal = plan('section', SECTIONS_ZONE, at, false);
    return refusal === null ? done() : refused(refusal);
  }

  /** The zone of rows the selection is in, made first when the page has no section. */
  const rowsZone = (): { zone: string; fresh: boolean } | Refusal => {
    const holder = nearest(index, selectedId, ['section', 'popup']);
    if (holder !== null) return { zone: `${holder.node.props.id}:rows`, fresh: false };
    const sections = data.root.props.sections.filter((each) => each.type === 'section');
    const lastSection = sections.at(-1);
    if (lastSection !== undefined) return { zone: `${lastSection.props.id}:rows`, fresh: false };
    const refusal = plan('section', SECTIONS_ZONE, endOf(SECTIONS_ZONE), false);
    return refusal ?? { zone: `${last().id}:rows`, fresh: true };
  };
  /** A new row with its one column, after the row the selection is in or last of all. */
  const addRow = (): Refusal | null => {
    const rows = rowsZone();
    if (typeof rows === 'string') return rows;
    const within = rows.fresh ? null : nearest(index, selectedId, ['row']);
    const at = rows.fresh ? 0 : within === null ? endOf(rows.zone) : within.index + 1;
    const refusal = plan('row', rows.zone, at, rows.fresh);
    if (refusal !== null) return refusal;
    return plan('column', `${last().id}:columns`, 0, true);
  };

  if (type === 'row') {
    const refusal = addRow();
    if (refusal !== null) return refused(refusal);
    // The row is what was asked for: it is what stays selected, not its column.
    const row = steps.at(-2);
    return row === undefined ? done() : { ok: true, steps, select: row.id, where: where() };
  }
  if (type === 'column') {
    const row = nearest(index, selectedId, ['row']);
    if (row === null) return refused('needs_row');
    const within = nearest(index, selectedId, ['column']);
    const zone = `${row.node.props.id}:columns`;
    const refusal = plan('column', zone, within === null ? endOf(zone) : within.index + 1, false);
    return refusal === null ? done() : refused(refusal);
  }
  if (!isElementType(type)) return refused('kind');

  const selected = selectedId === null ? undefined : index.get(selectedId);
  // After the selected element; inside the selected column or container.
  if (selected !== undefined && isElementType(selected.node.type)) {
    const inside = selected.node.type === 'container' ? `${selected.node.props.id}:children` : null;
    if (inside !== null) {
      const refusal = plan(type, inside, endOf(inside), false);
      // A container that cannot take it (the deepest one, or a full one): after it instead.
      if (refusal === null) return done();
    }
    const refusal = plan(type, selected.zone, selected.index + 1, false);
    return refusal === null ? done() : refused(refusal);
  }
  const column =
    selected?.node.type === 'column'
      ? selected.node
      : selected?.node.type === 'row'
        ? slotChildren(selected.node)[0]
        : undefined;
  if (column !== undefined) {
    const zone = `${column.props.id}:children`;
    const refusal = plan(type, zone, endOf(zone), false);
    return refusal === null ? done() : refused(refusal);
  }
  // A section, a popup or nothing: the first column of its last row, made when there is none.
  const rows = rowsZone();
  if (typeof rows === 'string') return refused(rows);
  const lastRow = rows.fresh ? undefined : zoneNodes(data, index, rows.zone).at(-1);
  const firstColumn = lastRow === undefined ? undefined : slotChildren(lastRow)[0];
  if (firstColumn !== undefined) {
    const zone = `${firstColumn.props.id}:children`;
    const refusal = plan(type, zone, endOf(zone), false);
    return refusal === null ? done() : refused(refusal);
  }
  const row = plan('row', rows.zone, rows.fresh ? 0 : endOf(rows.zone), rows.fresh);
  if (row !== null) return refused(row);
  const made = plan('column', `${last().id}:columns`, 0, true);
  if (made !== null) return refused(made);
  const refusal = plan(type, `${last().id}:children`, 0, true);
  return refusal === null ? done() : refused(refusal);
}

/** The kinds of node that can be dragged onto the page from the list of what can be added. */
export const DRAG_IN_TYPES: readonly string[] = ['section', 'row', 'column', ...pageElementTypes];

/** How many nodes dragging one kind in adds to the page: a row arrives with its first column. */
export const dragInCost = (type: string): number => (type === 'row' ? 2 : 1);

/**
 * Why a kind of node may not be picked up from the list at all, or null when it may. Where
 * it may be dropped is decided while it is dragged, zone by zone: each zone takes only its
 * own kinds, a full zone takes nothing, and the deepest container takes no container
 * (`kindsIn`, `isFull`, and elements.tsx, which hands them to the canvas). What no zone can
 * know is decided here: a kind that is never dragged (a popup has no place in the page's
 * flow; a saved section is not made here), and a page that already holds as many nodes as
 * a page may.
 */
export function dragInRefusal(index: TreeIndex, type: string): Refusal | null {
  if (!DRAG_IN_TYPES.includes(type)) return 'kind';
  return pageNodeCount(index) + dragInCost(type) > PAGE_DOCUMENT_LIMITS.nodes ? 'nodes' : null;
}

/** Whether a node is a row that holds no column yet: one just dropped on the page. */
export function rowNeedsColumn(index: TreeIndex, id: string): boolean {
  const placed = index.get(id);
  return placed?.node.type === 'row' && slotChildren(placed.node).length === 0;
}

/** One step of a node's way from the page down to it: its kind and its place among its siblings. */
export interface PathPart {
  readonly type: string;
  /** Its place in its zone, from 1. */
  readonly place: number;
  /** The name a section or a popup was given, when it has one. */
  readonly name: string | undefined;
}

/** A node's way from the page down to it, itself last. */
export function pathTo(index: TreeIndex, id: string): readonly PathPart[] {
  const parts: PathPart[] = [];
  let at = index.get(id);
  while (at !== undefined) {
    const name = at.node.props['name'];
    parts.unshift({
      type: at.node.type,
      place: at.index + 1,
      name: typeof name === 'string' && name !== '' ? name : undefined,
    });
    at = at.parent === null ? undefined : index.get(at.parent.props.id);
  }
  return parts;
}

/** Whether a node is another, or somewhere under it. */
function isWithin(index: TreeIndex, id: string, ancestorId: string): boolean {
  let at = index.get(id);
  while (at !== undefined) {
    if (at.node.props.id === ancestorId) return true;
    at = at.parent === null ? undefined : index.get(at.parent.props.id);
  }
  return false;
}

/** A place a node may be moved to, or why it may not. */
export interface MoveTarget {
  readonly zone: string;
  /** The node that owns the zone. */
  readonly ownerId: string;
  readonly refusal: Refusal | null;
}

/**
 * Where a node may be moved to besides its own zone: an element to any column or
 * container, a column to any row, a row to any section or popup. Sections and popups
 * only change places among themselves. A node is never moved into itself.
 */
export function moveTargets(data: CanvasData, index: TreeIndex, id: string): readonly MoveTarget[] {
  const placed = index.get(id);
  if (placed === undefined) return [];
  const { node } = placed;
  const owners: readonly string[] = isElementType(node.type)
    ? ['column', 'container']
    : node.type === 'column'
      ? ['row']
      : node.type === 'row'
        ? ['section', 'popup']
        : [];
  const targets: MoveTarget[] = [];
  for (const [ownerId, owner] of index) {
    if (!owners.includes(owner.node.type)) continue;
    const zone = zoneOf(owner.node);
    if (zone === undefined || zone === placed.zone || isWithin(index, ownerId, id)) continue;
    // The last column of a row stays: a row with no column is not a row.
    const refusal =
      node.type === 'column' && zoneNodes(data, index, placed.zone).length <= 1
        ? 'last_column'
        : refusalFor(data, index, node, zone, true);
    targets.push({ zone, ownerId, refusal });
  }
  return targets;
}

/** Why a node may not be deleted, or null when it may. */
export function removalRefusal(data: CanvasData, index: TreeIndex, id: string): Refusal | null {
  const placed = index.get(id);
  if (placed?.node.type !== 'column') return null;
  return zoneNodes(data, index, placed.zone).length <= 1 ? 'last_column' : null;
}

/** Why a node may not be duplicated beside itself, or null when it may. */
export function duplicateRefusal(data: CanvasData, index: TreeIndex, id: string): Refusal | null {
  const placed = index.get(id);
  if (placed === undefined || placed.node.type === 'saved_section') return 'kind';
  if (isFull(data, index, placed.zone)) return fullRefusal(placed.zone);
  return pageNodeCount(index) + countNodes(placed.node) > PAGE_DOCUMENT_LIMITS.nodes
    ? 'nodes'
    : null;
}

/** The text an element shows, for the outline to name it by: its first words. */
export function excerptOf(node: CanvasNode): string {
  const runs = (value: unknown): string =>
    Array.isArray(value)
      ? value
          .map((run: unknown) =>
            typeof run === 'object' && run !== null && 'text' in run && typeof run.text === 'string'
              ? run.text
              : '',
          )
          .join('')
      : '';
  const { props } = node;
  const items = props['items'];
  const words =
    typeof props['name'] === 'string'
      ? props['name']
      : typeof props['label'] === 'string'
        ? props['label']
        : Array.isArray(items)
          ? runs(items[0])
          : runs(props['text']);
  const plain = words.replace(/\s+/g, ' ').trim();
  return plain.length > 40 ? `${plain.slice(0, 39)}…` : plain;
}

/** An id for a new node: short, unique enough within a page, and one the schema accepts. */
export function newNodeId(random: () => number = Math.random): string {
  let id = 'n';
  for (let at = 0; at < 11; at += 1) id += Math.floor(random() * 36).toString(36);
  return id;
}
