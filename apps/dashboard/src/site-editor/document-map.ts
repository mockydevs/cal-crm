// The page document as the canvas holds it while a page is being edited, and back. The
// stored format stays ours: the canvas's data lives only in the browser, and what this file
// returns is checked by the contract's schema before anything is saved.
//
// The shape is the one the canvas library asks for (Puck 0.23, its `Data` type in
// `dist/actions-*.d.ts`): `{ root: { props }, content }`, each node `{ type, props }` with
// its `id` among the props and its children inline under the name of a slot. Nothing here
// imports the library: these are plain objects.
//
// How one of our nodes is carried:
//   { id, type, props, style?, responsive?, hidden?, customClass?, <children> }
//     ⇄ { type, props: { id, ...props, look: { style?, responsive?, hidden?, customClass? }, <slot> } }
// - `look` keeps everything that differs by device in one prop, so one field of ours
//   edits it (device.ts) and the canvas never has to know what a breakpoint is.
// - Sections and popups are two slots of the root (`sections`, `popups`), so a popup
//   can never be dropped among the sections, and `content` stays empty.
// - A saved section stays a reference: a node with its `sectionId` and no children.
import type { VisualPageDocument } from '@repo/contracts';

/** A node as the canvas holds it. */
export interface CanvasNode {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>> & { readonly id: string };
}

/** A page as the canvas holds it. */
export interface CanvasData {
  readonly root: {
    readonly props: {
      readonly settings: unknown;
      readonly sections: readonly CanvasNode[];
      readonly popups: readonly CanvasNode[];
    };
  };
  readonly content: readonly CanvasNode[];
}

/** What every node may carry besides its own props, kept together under `look`. */
export const LOOK_KEYS = ['style', 'responsive', 'hidden', 'customClass'] as const;

/** The slot each kind of node keeps its children under, in the document and in the canvas. */
export const SLOT_OF: Readonly<Record<string, string>> = {
  section: 'rows',
  popup: 'rows',
  row: 'columns',
  column: 'children',
  container: 'children',
};

/** Keys a node of ours holds beside `props`, which the canvas keeps among the props. */
const OWN_KEYS: Readonly<Record<string, readonly string[]>> = {
  section: ['name'],
  popup: ['name'],
  saved_section: ['sectionId'],
};

/** The kinds of node that hold no `props` of their own in the document. */
const WITHOUT_PROPS: readonly string[] = ['row', 'saved_section'];

/** Names an element's own prop may never take: the canvas uses them. */
export const RESERVED_PROPS = ['id', 'look', 'rows', 'columns', 'children', 'name', 'sectionId'];

type Json = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const NODE_ID = /^[a-z0-9_-]{1,40}$/;

/**
 * A node id the document accepts. Ours pass through untouched. The canvas names a new
 * node `<type>-<uuid>` (Puck's `generateId`), which is longer than our forty characters,
 * so such an id is cut to the letters and numbers of its end: the same id always gives
 * the same answer, so an action that points at the node is rewritten to match.
 */
export function documentId(id: string): string {
  if (NODE_ID.test(id)) return id;
  const plain = id.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `n${plain.slice(-32)}`;
}

function nodeToCanvas(node: Json): CanvasNode {
  const type = String(node['type']);
  const look: Record<string, unknown> = {};
  for (const key of LOOK_KEYS) if (key in node) look[key] = node[key];
  const props: Record<string, unknown> = {
    id: String(node['id']),
    ...(isRecord(node['props']) ? node['props'] : {}),
  };
  for (const key of OWN_KEYS[type] ?? []) if (key in node) props[key] = node[key];
  if (type !== 'saved_section') props['look'] = look;
  const slot = SLOT_OF[type];
  if (slot !== undefined) {
    const children = Array.isArray(node[slot]) ? (node[slot] as readonly Json[]) : [];
    props[slot] = children.map(nodeToCanvas);
  }
  return { type, props: props as CanvasNode['props'] };
}

/** Our document as the canvas holds it. */
export function toCanvas(document: VisualPageDocument): CanvasData {
  return {
    root: {
      props: {
        settings: document.settings,
        sections: (document.sections as readonly Json[]).map(nodeToCanvas),
        popups: (document.popups as readonly Json[]).map(nodeToCanvas),
      },
    },
    content: [],
  };
}

/** A value of a prop, with the ids an action points at made ours. */
function propToDocument(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(propToDocument);
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, each] of Object.entries(value)) copy[key] = propToDocument(each);
  if (value['type'] === 'popup' && typeof value['popupId'] === 'string')
    copy['popupId'] = documentId(value['popupId']);
  if (value['type'] === 'anchor' && typeof value['sectionId'] === 'string')
    copy['sectionId'] = documentId(value['sectionId']);
  return copy;
}

function nodeToDocument(node: CanvasNode): Json {
  const { type } = node;
  const slot = SLOT_OF[type];
  const own = OWN_KEYS[type] ?? [];
  const result: Record<string, unknown> = { id: documentId(node.props.id), type };
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.props)) {
    if (key === 'id' || key === 'look' || key === slot) continue;
    if (own.includes(key)) result[key] = value;
    else props[key] = propToDocument(value);
  }
  if (!WITHOUT_PROPS.includes(type)) result['props'] = props;
  const look = node.props['look'];
  if (isRecord(look)) for (const key of LOOK_KEYS) if (key in look) result[key] = look[key];
  if (slot !== undefined) {
    const children = node.props[slot];
    result[slot] = (Array.isArray(children) ? (children as readonly CanvasNode[]) : []).map(
      nodeToDocument,
    );
  }
  return result;
}

/**
 * What the canvas holds, as a page document. The answer is not trusted: whoever saves it
 * parses it with `pageDocument` first, and the server parses it again.
 */
export function toDocument(data: CanvasData): unknown {
  const { settings, sections, popups } = data.root.props;
  return {
    format: 1,
    mode: 'visual',
    settings,
    sections: sections.map(nodeToDocument),
    popups: popups.map(nodeToDocument),
  };
}

/** How deep a container may sit inside a column, and how many children a slot may hold. */
export const CANVAS_LIMITS = { containerDepth: 4, children: 50, columns: 6, rows: 20 } as const;

/** Every node under some canvas nodes with the slot (zone) that holds it, top first. */
export function walkCanvas(
  nodes: readonly CanvasNode[],
  zone: string,
  visit: (node: CanvasNode, zone: string, index: number) => void,
): void {
  nodes.forEach((node, index) => {
    visit(node, zone, index);
    const slot = SLOT_OF[node.type];
    if (slot === undefined) return;
    const children = node.props[slot];
    if (Array.isArray(children))
      walkCanvas(children as readonly CanvasNode[], `${node.props.id}:${slot}`, visit);
  });
}

/** The columns of a page, in reading order: where an element may be moved to. */
export function columnZones(data: CanvasData): { zone: string; label: number }[] {
  const zones: { zone: string; label: number }[] = [];
  const collect = (node: CanvasNode): void => {
    if (node.type === 'column')
      zones.push({ zone: `${node.props.id}:children`, label: zones.length + 1 });
  };
  walkCanvas(data.root.props.sections, 'root:sections', collect);
  walkCanvas(data.root.props.popups, 'root:popups', collect);
  return zones;
}
