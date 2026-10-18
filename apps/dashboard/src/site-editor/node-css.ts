// The canvas's stylesheet. A published page gets every look from one stylesheet the
// renderer writes (packages/site-render): its base rules, then one rule per node from
// `Stylesheet.node`, with the tablet's and the phone's overrides as media queries. The
// canvas uses the same functions over the same document, so a node in the editor is
// styled by the rules its published page will have. Three things differ, on purpose:
// - a node hidden on a device is drawn faint there, not removed: it must stay selectable;
// - the canvas library wraps a section's rows, a row's columns and a column's elements in
//   one more element (its drop zone), so the layout rule of what holds them is said again
//   for that element: what lies inside it lies as it will on the published page;
// - what a published page shows through a script or a frame (a form, a video) is a
//   labelled box here.
/* eslint-disable lingui/no-unlocalized-strings -- stylesheet rules, not words */
import { EMPTY_PAGE_DOCUMENT, type VisualPageDocument } from '@repo/contracts';
import {
  baseCss,
  BREAKPOINTS,
  DEVICE_QUERIES,
  renderPage,
  Stylesheet,
  type RenderContext,
} from '@repo/site-render';
import { DEVICES, type Look } from './device';
import { SLOT_OF, type CanvasData, type CanvasNode } from './document-map';

/** Site paths (`/picture.png`) have no site to be read from while a page is edited. */
const CONTEXT = { siteBase: '' } as const;

const RENDER_CONTEXT: RenderContext = {
  siteBase: '',
  title: '',
  index: false,
  preview: true,
  steps: new Map(),
  sections: new Map(),
  forms: new Map(),
  formScriptUrl: '',
  calendars: new Map(),
  now: 0,
  // The stylesheet a visitor is sent, not the wider one kept for an older canvas.
  baseRules: 'used',
};

/** A page on which everything is found: the canvas draws what is not on the page yet. */
class Everything extends Set<string> {
  override has(): boolean {
    return true;
  }
}

/**
 * Every base rule a published page can be sent (packages/site-render, css.ts), and not one
 * more: the rules the canvas starts from are the live page's own.
 */
export const LIVE_BASE_CSS = baseCss(new Everything());
/** The base rules of a page with nothing on it: what `renderPage` writes before a page's own. */
const EMPTY_BASE_CSS = baseCss(new Set());

/** The class a node's own rule is written for. An id holds only letters, numbers, - and _. */
export const nodeClass = (id: string): string => `n_${id.replace(/[^A-Za-z0-9_-]/g, '')}`;
/** The class of one coloured stretch of a node's text. */
export const runClass = (id: string, item: number, run: number): string =>
  `${nodeClass(id)}_t${String(item)}_${String(run)}`;

const number = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const COLOR = /^(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|transparent)$/;
const color = (value: unknown): string | undefined =>
  typeof value === 'string' && COLOR.test(value) ? value : undefined;

/** What the renderer adds to a node's rule from its own props, kind by kind. */
function ownDeclarations(node: CanvasNode): string[] {
  const { props } = node;
  switch (node.type) {
    case 'divider': {
      const thickness = Math.min(50, Math.max(1, number(props['thickness'], 1)));
      const line = ['solid', 'dashed', 'dotted'].find((each) => each === props['line']) ?? 'solid';
      return [
        `border-top:${String(thickness)}px ${line} ${color(props['color']) ?? 'currentColor'}`,
      ];
    }
    case 'container': {
      // No gap is what a container has before any rule.
      const gap = Math.min(200, Math.max(0, number(props['gap'], 0)));
      return gap === 0 ? [] : [`gap:${String(gap)}px`];
    }
    case 'column':
      return [`flex:${String(Math.min(12, Math.max(1, number(props['span'], 12))))} 1 0%`];
    default:
      return [];
  }
}

const lookOf = (node: CanvasNode): Look => {
  const look = node.props['look'];
  return typeof look === 'object' && look !== null ? look : {};
};

/** The colours of a node's text runs, each as a rule for its own class. */
function runRules(node: CanvasNode): string[] {
  const rules: string[] = [];
  const add = (runs: unknown, item: number): void => {
    if (!Array.isArray(runs)) return;
    runs.forEach((run: unknown, at) => {
      const chosen =
        typeof run === 'object' && run !== null && 'color' in run ? color(run.color) : undefined;
      if (chosen !== undefined)
        rules.push(`.${runClass(node.props.id, item, at)}{color:${chosen}}`);
    });
  };
  add(node.props['text'], 0);
  const items = node.props['items'];
  if (Array.isArray(items))
    items.forEach((item: unknown, at) => {
      add(item, at);
    });
  return rules;
}

/**
 * One node's rules: its style, its overrides on narrower screens, and where it is hidden.
 * Written by the renderer's own `Stylesheet`, so the declarations, their order and the
 * breakpoints are the published page's.
 */
export function nodeCss(node: CanvasNode): string {
  const known = written.get(node);
  if (known !== undefined) return known;
  const css = writeNodeCss(node);
  written.set(node, css);
  return css;
}

/**
 * The rules already written, by node. An edit makes new objects only for the node it
 * changes and for what holds it, so on a long page all the others are found here.
 */
const written = new WeakMap<CanvasNode, string>();

function writeNodeCss(node: CanvasNode): string {
  const look = lookOf(node);
  const name = nodeClass(node.props.id);
  const sheet = new Stylesheet();
  sheet.node(name, { style: look.style, responsive: look.responsive }, CONTEXT, [
    ...ownDeclarations(node),
  ]);
  const rules = [sheet.toString(), ...runRules(node)];
  for (const device of DEVICES)
    if (look.hidden?.[device] === true)
      rules.push(`@media ${DEVICE_QUERIES[device]}{.${name}{filter:opacity(.35)}}`);
  return rules.filter((rule) => rule !== '').join('\n');
}

/** Every node's rules, in the order of the page. */
export function nodesCss(data: CanvasData): string {
  const rules: string[] = [];
  const walk = (nodes: readonly CanvasNode[]): void => {
    for (const node of nodes) {
      if (node.type !== 'saved_section') {
        const css = nodeCss(node);
        if (css !== '') rules.push(css);
      }
      const slot = SLOT_OF[node.type];
      const children = slot === undefined ? undefined : node.props[slot];
      if (Array.isArray(children)) walk(children as readonly CanvasNode[]);
    }
  };
  walk(data.root.props.sections);
  walk(data.root.props.popups);
  return rules.join('\n');
}

/**
 * The page's own rules as the renderer writes them for a published page: the base rules,
 * the page's background and typography, and the page's custom CSS. Rendered from a page
 * with these settings and nothing on it, so not one of these rules is written here; the
 * base rules are those of every element, since any of them may be added next.
 */
export function pageCss(settings: unknown): string {
  const page: VisualPageDocument = {
    ...EMPTY_PAGE_DOCUMENT,
    settings: settings as VisualPageDocument['settings'],
  };
  try {
    const css = renderPage(page, RENDER_CONTEXT)?.css;
    return css?.startsWith(EMPTY_BASE_CSS) === true
      ? `${LIVE_BASE_CSS}${css.slice(EMPTY_BASE_CSS.length)}`
      : LIVE_BASE_CSS;
  } catch {
    // Settings the canvas holds for a moment may not be ones the renderer can read.
    return LIVE_BASE_CSS;
  }
}

/**
 * What only the editor needs. The canvas library puts one element of its own between a
 * section and its rows, a row and its columns, a column and its elements, and a container
 * and its children (the drop zone); `ez` rules give that element the layout the published
 * page's parent has, so the children lie as they will: a section's rows in the section's
 * own one-column grid (so a row's own margin above or below adds to the space between
 * rows, as it does live, and is not swallowed), a row's columns side by side, a column's
 * elements one under the other. `ep` is the labelled box of something the canvas does not
 * draw. Nothing here is copied from a document.
 */
export const EDITOR_CSS = [
  '.ez{height:auto;min-width:0}',
  '.sc>.ez{display:grid;grid-template-columns:minmax(0,1fr);align-content:start}',
  '.rw>.ez-row{display:flex;gap:24px;flex:1 1 auto}',
  '.cl>.ez-col{display:flex;flex-direction:column;flex:1 1 auto}',
  '.kt>.ez-kt{display:flex;flex:1 1 auto;gap:inherit}',
  `@media (max-width:${String(BREAKPOINTS.mobile)}px){.rw>.ez-row{flex-direction:column}.ez-row>.cl{flex:0 0 auto}}`,
  '.ep{display:block;margin:0 0 16px;padding:16px;border:1px dashed #98a2b3;border-radius:6px;background-color:#f9fafb;color:#344054;font:14px/1.4 system-ui,sans-serif;text-align:center}',
  // A video is one element live (a frame, or a player), and one box here, of the frame's shape.
  '.ev{display:flex;align-items:center;justify-content:center;margin:0}',
  '.vf.ev{aspect-ratio:16/9}',
  '.fm>.ep{margin:0}',
  // The one thing drawn inside a page's own element that the page does not have: a tag that
  // says a countdown's time left is a sample. Small, and apart from the page's own words.
  '.ep-tag{display:inline-block;padding:1px 6px;border:1px dashed #98a2b3;border-radius:4px;background-color:#f9fafb;color:#344054;font:12px/1.4 system-ui,sans-serif;font-weight:400;letter-spacing:0;text-transform:none;white-space:normal}',
  '.ep-popups{margin-top:32px;padding:16px;border-top:2px dashed #98a2b3;background-color:#f2f4f7}',
  '.ep-note{margin:0 0 12px;color:#344054;font:14px/1.4 system-ui,sans-serif}',
  '.ep-popup{margin:0 auto 16px}',
  '.ep-popup>.pb{margin:0 auto;border:1px solid #d0d5dd}',
  'a{cursor:inherit}',
].join('\n');
