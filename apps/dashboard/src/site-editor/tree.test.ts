import {
  EMPTY_PAGE_DOCUMENT,
  PAGE_DOCUMENT_LIMITS,
  pageDocument,
  type PageElement,
  type VisualPageDocument,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { toCanvas, toDocument, type CanvasData, type CanvasNode } from './document-map';
import { everyElementPage, longPage, smallPage } from './fixtures';
import { defaultProps } from './node-defaults';
import {
  containerHeight,
  countNodes,
  depthIn,
  DRAG_IN_TYPES,
  dragInCost,
  dragInRefusal,
  duplicateRefusal,
  excerptOf,
  indexTree,
  isElementType,
  isFull,
  kindsIn,
  moveTargets,
  newNodeId,
  pageNodeCount,
  pathTo,
  planAdd,
  POPUPS_ZONE,
  refusalFor,
  removalRefusal,
  rowNeedsColumn,
  SECTIONS_ZONE,
  zoneCapacity,
  zoneNodes,
  zoneOf,
  type AddPlan,
  type InsertStep,
} from './tree';

const small = toCanvas(smallPage);
const every = toCanvas(everyElementPage);
const empty = toCanvas(EMPTY_PAGE_DOCUMENT);

/** Ids in order, so a plan can be read: n1, n2, … */
function counter(): () => string {
  let made = 0;
  return () => {
    made += 1;
    return `n${String(made)}`;
  };
}

const plan = (data: CanvasData, type: string, selectedId: string | null): AddPlan =>
  planAdd(data, indexTree(data), type, selectedId, counter());
const stepsOf = (planned: AddPlan): readonly InsertStep[] => (planned.ok ? planned.steps : []);
const node = (type: string, id = 'new', props: Record<string, unknown> = {}): CanvasNode => ({
  type,
  props: { id, ...props },
});

const words = {
  headline: 'Headline',
  subHeadline: 'Sub',
  paragraph: 'Paragraph',
  listItem: 'Point',
  button: 'Button',
  popup: 'Popup',
};

/** A plan carried out on plain data, as the canvas would: each step with its default props. */
function carriedOut(data: CanvasData, planned: AddPlan): CanvasData {
  if (!planned.ok) throw new Error(planned.refusal);
  const defaults = defaultProps(words) as Record<string, Record<string, unknown>>;
  const copy = structuredClone(data) as unknown as {
    root: { props: Record<string, CanvasNode[]> };
    content: CanvasNode[];
  };
  for (const step of planned.steps) {
    const [ownerId = '', slot = ''] = step.zone.split(':');
    const made = node(step.type, step.id, structuredClone(defaults[step.type]));
    const find = (nodes: CanvasNode[]): CanvasNode | undefined => {
      for (const each of nodes) {
        if (each.props.id === ownerId) return each;
        for (const key of ['rows', 'columns', 'children']) {
          const children = each.props[key];
          const found = Array.isArray(children) ? find(children as CanvasNode[]) : undefined;
          if (found !== undefined) return found;
        }
      }
      return undefined;
    };
    const list =
      ownerId === 'root'
        ? copy.root.props[slot]
        : ((find([...(copy.root.props['sections'] ?? []), ...(copy.root.props['popups'] ?? [])])
            ?.props[slot] as CanvasNode[] | undefined) ?? undefined);
    if (list === undefined) throw new Error(`no zone ${step.zone}`);
    list.splice(step.index, 0, made);
  }
  return copy as unknown as CanvasData;
}

describe('indexTree', () => {
  it('knows every node by its id, with its zone, its place and what holds it', () => {
    const index = indexTree(small);
    expect([...index.keys()]).toStrictEqual([
      'top',
      'top-row',
      'left',
      'title',
      'copy',
      'right',
      'picture',
    ]);
    expect(index.get('top')).toMatchObject({ zone: SECTIONS_ZONE, index: 0, parent: null });
    expect(index.get('copy')).toMatchObject({ zone: 'left:children', index: 1, depth: 1 });
    expect(index.get('copy')?.parent?.props.id).toBe('left');
    expect(pageNodeCount(index)).toBe(7);
  });

  it('counts how deep in containers an element sits', () => {
    const index = indexTree(every);
    expect(index.get('box-1')?.depth).toBe(1);
    expect(index.get('box-2')?.depth).toBe(2);
    expect(index.get('box-3')?.depth).toBe(3);
    expect(index.get('deep-text')?.depth).toBe(4);
    expect(index.get('claim')).toMatchObject({ zone: POPUPS_ZONE, index: 0 });
    expect(depthIn(index, 'box-3:children')).toBe(4);
    expect(depthIn(index, 'details-one:children')).toBe(1);
    expect(depthIn(index, 'hero:rows')).toBe(0);
    expect(depthIn(index, 'gone:children')).toBe(0);
  });
});

describe('zones', () => {
  it('reads what a zone holds, and nothing for a zone that is not there', () => {
    const index = indexTree(small);
    expect(zoneNodes(small, index, SECTIONS_ZONE).map((each) => each.props.id)).toStrictEqual([
      'top',
    ]);
    expect(zoneNodes(small, index, POPUPS_ZONE)).toStrictEqual([]);
    expect(zoneNodes(small, index, 'left:children')).toHaveLength(2);
    expect(zoneNodes(small, index, 'gone:children')).toStrictEqual([]);
    expect(zoneNodes(small, index, '')).toStrictEqual([]);
    expect(zoneOf(node('column', 'c'))).toBe('c:children');
    expect(zoneOf(node('headline'))).toBeUndefined();
  });

  it('takes its limits from the page document', () => {
    expect(zoneCapacity(SECTIONS_ZONE)).toBe(PAGE_DOCUMENT_LIMITS.sections);
    expect(zoneCapacity(POPUPS_ZONE)).toBe(PAGE_DOCUMENT_LIMITS.popups);
    expect(zoneCapacity('x:rows')).toBe(PAGE_DOCUMENT_LIMITS.rows);
    expect(zoneCapacity('x:columns')).toBe(PAGE_DOCUMENT_LIMITS.columns);
    expect(zoneCapacity('x:children')).toBe(PAGE_DOCUMENT_LIMITS.children);
  });

  it('names the kinds each zone takes: the deepest container takes no container', () => {
    const index = indexTree(every);
    expect(kindsIn(index, SECTIONS_ZONE)).toStrictEqual(['section', 'saved_section']);
    expect(kindsIn(index, POPUPS_ZONE)).toStrictEqual(['popup']);
    expect(kindsIn(index, 'hero:rows')).toStrictEqual(['row']);
    expect(kindsIn(index, 'hero-row:columns')).toStrictEqual(['column']);
    expect(kindsIn(index, 'box-2:children')).toContain('container');
    expect(kindsIn(index, 'box-3:children')).not.toContain('container');
    expect(kindsIn(index, 'box-3:children')).toContain('headline');
    expect(isElementType('container')).toBe(true);
    expect(isElementType('row')).toBe(false);
  });
});

describe('refusalFor', () => {
  it('refuses a kind a zone does not take', () => {
    const index = indexTree(every);
    expect(refusalFor(every, index, node('popup'), SECTIONS_ZONE, false)).toBe('kind');
    expect(refusalFor(every, index, node('headline'), 'hero:rows', false)).toBe('kind');
    expect(refusalFor(every, index, node('section'), SECTIONS_ZONE, false)).toBeNull();
  });

  it('holds containers to three deep, whole subtree counted', () => {
    const index = indexTree(every);
    const one = node('container', 'c1', { children: [] });
    const two = node('container', 'c2', { children: [node('container', 'c3', { children: [] })] });
    expect(containerHeight(node('paragraph'))).toBe(0);
    expect(containerHeight(one)).toBe(1);
    expect(containerHeight(two)).toBe(2);
    // Into the deepest container: no container at all.
    expect(refusalFor(every, index, one, 'box-3:children', false)).toBe('depth');
    // Beside it, at the third level: a single container fits, two inside one another do not.
    expect(refusalFor(every, index, one, 'box-2:children', false)).toBeNull();
    expect(refusalFor(every, index, two, 'box-2:children', false)).toBe('depth');
    expect(refusalFor(every, index, two, 'box-1:children', false)).toBeNull();
    expect(refusalFor(every, index, node('divider'), 'box-3:children', false)).toBeNull();
  });

  it('holds each zone to its count: 50 elements, 6 columns, 20 rows', () => {
    const full: VisualPageDocument = structuredClone(smallPage);
    const [section] = full.sections;
    if (section?.type !== 'section') throw new Error('a section');
    const [row] = section.rows;
    if (row === undefined) throw new Error('a row');
    const [left] = row.columns;
    if (left === undefined) throw new Error('a column');
    left.children = Array.from({ length: 50 }, (_, at): PageElement => ({
      id: `p${String(at)}`,
      type: 'paragraph',
      props: { text: [] },
    }));
    for (let at = 0; at < 4; at += 1)
      row.columns.push({ id: `c${String(at)}`, type: 'column', props: { span: 2 }, children: [] });
    for (let at = 0; at < 19; at += 1)
      section.rows.push({
        id: `r${String(at)}`,
        type: 'row',
        columns: [{ id: `rc${String(at)}`, type: 'column', props: { span: 12 }, children: [] }],
      });
    expect(pageDocument.safeParse(full).success).toBe(true);
    const data = toCanvas(full);
    const index = indexTree(data);
    expect(isFull(data, index, 'left:children')).toBe(true);
    expect(isFull(data, index, 'right:children')).toBe(false);
    expect(refusalFor(data, index, node('headline'), 'left:children', false)).toBe('children');
    expect(refusalFor(data, index, node('column'), 'top-row:columns', false)).toBe('columns');
    expect(refusalFor(data, index, node('row'), 'top:rows', false)).toBe('rows');
    // A node that is already in the zone does not count against it: it may change places.
    const there = index.get('p3')?.node;
    if (there === undefined) throw new Error('p3');
    expect(refusalFor(data, index, there, 'left:children', true)).toBeNull();
    expect(refusalFor(data, index, there, 'right:children', true)).toBeNull();
    const picture = index.get('picture')?.node;
    if (picture === undefined) throw new Error('picture');
    expect(refusalFor(data, index, picture, 'left:children', true)).toBe('children');
    // The schema agrees with the refusals: one more would not be saved.
    left.children.push({ id: 'p50', type: 'paragraph', props: { text: [] } });
    expect(pageDocument.safeParse(full).success).toBe(false);
  });

  it('holds a page to its sections, its popups and its nodes in all', () => {
    const many: VisualPageDocument = {
      ...EMPTY_PAGE_DOCUMENT,
      sections: Array.from({ length: PAGE_DOCUMENT_LIMITS.sections }, (_, at) => ({
        id: `s${String(at)}`,
        type: 'section' as const,
        props: { width: 'full' as const },
        rows: [],
      })),
      popups: Array.from({ length: PAGE_DOCUMENT_LIMITS.popups }, (_, at) => ({
        id: `p${String(at)}`,
        type: 'popup' as const,
        name: 'Popup',
        props: { trigger: 'none' as const, delaySeconds: 0, width: 'small' as const },
        rows: [],
      })),
    };
    const data = toCanvas(many);
    const index = indexTree(data);
    expect(refusalFor(data, index, node('section'), SECTIONS_ZONE, false)).toBe('sections');
    expect(refusalFor(data, index, node('popup'), POPUPS_ZONE, false)).toBe('popups');
    expect(plan(data, 'section', null)).toStrictEqual({ ok: false, refusal: 'sections' });
    expect(plan(data, 'popup', null)).toStrictEqual({ ok: false, refusal: 'popups' });

    // 2,000 nodes in all: the page of the speed check, made as large as a page may be.
    const big = toCanvas(longPage(100, 5));
    const bigIndex = indexTree(big);
    expect(pageNodeCount(bigIndex)).toBe(2000);
    expect(refusalFor(big, bigIndex, node('headline'), 's0-c0:children', false)).toBe('nodes');
    expect(plan(big, 'headline', 's0-c0-e0')).toStrictEqual({ ok: false, refusal: 'nodes' });
    expect(duplicateRefusal(big, bigIndex, 's0-c0-e0')).toBe('nodes');
    const moved = bigIndex.get('s0-c0-e0')?.node;
    if (moved === undefined) throw new Error('an element');
    expect(refusalFor(big, bigIndex, moved, 's0-c1:children', true)).toBeNull();
    expect(countNodes(bigIndex.get('s0')?.node ?? node('section'))).toBe(20);
  });
});

describe('planAdd', () => {
  it('puts an element after the selected element, and inside the selected column', () => {
    expect(plan(small, 'button', 'title')).toStrictEqual({
      ok: true,
      steps: [{ type: 'button', id: 'n1', zone: 'left:children', index: 1 }],
      select: 'n1',
      where: 'after',
    });
    expect(plan(small, 'button', 'right')).toMatchObject({
      steps: [{ zone: 'right:children', index: 1 }],
      where: 'inside',
    });
    expect(plan(small, 'button', 'top-row')).toMatchObject({
      steps: [{ zone: 'left:children', index: 2 }],
      where: 'near',
    });
  });

  it('puts an element at the end of the page when nothing, or a section, is selected', () => {
    expect(plan(small, 'divider', null)).toMatchObject({
      steps: [{ type: 'divider', zone: 'left:children', index: 2 }],
      where: 'page',
    });
    expect(plan(small, 'divider', 'top')).toMatchObject({
      steps: [{ zone: 'left:children', index: 2 }],
      where: 'near',
    });
    expect(plan(small, 'divider', 'gone')).toMatchObject({ where: 'page' });
    // A saved section holds nothing here: the page's last section of its own takes it.
    expect(plan(every, 'divider', 'shared-footer')).toMatchObject({
      steps: [{ zone: 'details-one:children' }],
    });
  });

  it('makes the section, row and column an element needs on an empty page', () => {
    const planned = plan(empty, 'headline', null);
    expect(planned).toStrictEqual({
      ok: true,
      steps: [
        { type: 'section', id: 'n1', zone: SECTIONS_ZONE, index: 0 },
        { type: 'row', id: 'n2', zone: 'n1:rows', index: 0 },
        { type: 'column', id: 'n3', zone: 'n2:columns', index: 0 },
        { type: 'headline', id: 'n4', zone: 'n3:children', index: 0 },
      ],
      select: 'n4',
      where: 'page',
    });
    // Carried out, the page is one the contract accepts.
    const made = carriedOut(empty, planned);
    expect(pageDocument.safeParse(toDocument(made)).error).toBeUndefined();
  });

  it('makes a row and its column in a section that has none', () => {
    const bare: VisualPageDocument = {
      ...EMPTY_PAGE_DOCUMENT,
      sections: [{ id: 'only', type: 'section', props: { width: 'full' }, rows: [] }],
    };
    const data = toCanvas(bare);
    const planned = plan(data, 'paragraph', 'only');
    expect(stepsOf(planned)).toStrictEqual([
      { type: 'row', id: 'n1', zone: 'only:rows', index: 0 },
      { type: 'column', id: 'n2', zone: 'n1:columns', index: 0 },
      { type: 'paragraph', id: 'n3', zone: 'n2:children', index: 0 },
    ]);
    expect(pageDocument.safeParse(toDocument(carriedOut(data, planned))).error).toBeUndefined();
    // A popup with no rows is filled the same way.
    expect(stepsOf(plan(every, 'paragraph', 'leaving'))).toMatchObject([
      { type: 'row', zone: 'leaving:rows', index: 0 },
      { type: 'column' },
      { type: 'paragraph' },
    ]);
  });

  it('puts an element into the selected container, or after it when it cannot go in', () => {
    expect(plan(every, 'divider', 'box-3')).toMatchObject({
      steps: [{ zone: 'box-3:children', index: 1 }],
      where: 'inside',
    });
    expect(plan(every, 'container', 'box-3')).toMatchObject({
      steps: [{ zone: 'box-2:children', index: 1 }],
      where: 'after',
    });
    // Beside the first container there is no room for a container holding containers,
    // but one alone still fits.
    expect(plan(every, 'container', 'box-1')).toMatchObject({
      steps: [{ zone: 'box-1:children', index: 1 }],
    });
  });

  it('adds a section after the one the selection is in, and a popup last', () => {
    expect(plan(every, 'section', 'hero-title')).toMatchObject({
      steps: [{ type: 'section', zone: SECTIONS_ZONE, index: 1 }],
      where: 'near',
    });
    expect(plan(every, 'section', 'hero')).toMatchObject({ where: 'after' });
    expect(plan(every, 'section', null)).toMatchObject({ steps: [{ index: 3 }], where: 'page' });
    expect(plan(every, 'section', 'claim-title')).toMatchObject({ steps: [{ index: 3 }] });
    expect(plan(every, 'popup', 'hero')).toMatchObject({
      steps: [{ type: 'popup', zone: POPUPS_ZONE, index: 2 }],
    });
  });

  it('adds a row with its first column, and keeps the row selected', () => {
    const planned = plan(small, 'row', 'title');
    expect(planned).toStrictEqual({
      ok: true,
      steps: [
        { type: 'row', id: 'n1', zone: 'top:rows', index: 1 },
        { type: 'column', id: 'n2', zone: 'n1:columns', index: 0 },
      ],
      select: 'n1',
      where: 'near',
    });
    expect(pageDocument.safeParse(toDocument(carriedOut(small, planned))).error).toBeUndefined();
    expect(plan(small, 'row', null)).toMatchObject({ steps: [{ index: 1 }, {}], select: 'n1' });
    expect(plan(small, 'row', 'top-row')).toMatchObject({ where: 'after' });
    // On an empty page the section comes first.
    expect(stepsOf(plan(empty, 'row', null)).map((step) => step.type)).toStrictEqual([
      'section',
      'row',
      'column',
    ]);
    expect(plan(empty, 'row', null)).toMatchObject({ select: 'n2' });
  });

  it('adds a column after the one the selection is in, and needs a row to add it to', () => {
    expect(plan(small, 'column', 'title')).toMatchObject({
      steps: [{ type: 'column', zone: 'top-row:columns', index: 1 }],
    });
    expect(plan(small, 'column', 'top-row')).toMatchObject({ steps: [{ index: 2 }] });
    expect(plan(small, 'column', 'top')).toStrictEqual({ ok: false, refusal: 'needs_row' });
    expect(plan(small, 'column', null)).toStrictEqual({ ok: false, refusal: 'needs_row' });
  });

  it('refuses what is not a kind of node, and a place that is full', () => {
    expect(plan(small, 'saved_section', null)).toStrictEqual({ ok: false, refusal: 'kind' });
    const full: VisualPageDocument = structuredClone(smallPage);
    const [section] = full.sections;
    if (section?.type !== 'section') throw new Error('a section');
    const column = section.rows[0]?.columns[0];
    if (column === undefined) throw new Error('a column');
    column.children = Array.from({ length: 50 }, (_, at): PageElement => ({
      id: `p${String(at)}`,
      type: 'divider',
      props: { thickness: 1, line: 'solid', color: null },
    }));
    const data = toCanvas(full);
    expect(plan(data, 'headline', 'p0')).toStrictEqual({ ok: false, refusal: 'children' });
    expect(plan(data, 'headline', 'left')).toStrictEqual({ ok: false, refusal: 'children' });
    expect(plan(data, 'headline', null)).toStrictEqual({ ok: false, refusal: 'children' });
    section.rows = Array.from({ length: 20 }, (_, at) => ({
      id: `r${String(at)}`,
      type: 'row' as const,
      columns: [
        { id: `c${String(at)}`, type: 'column' as const, props: { span: 12 }, children: [] },
      ],
    }));
    expect(plan(toCanvas(full), 'row', null)).toStrictEqual({ ok: false, refusal: 'rows' });
    section.rows = [];
    const hundred: VisualPageDocument = {
      ...full,
      sections: [
        { id: 'ref', type: 'saved_section', sectionId: 'ssec_01h455vb4pex5vsknk084sn02q' },
      ],
    };
    // A page of saved sections only: an element needs a section of the page's own first.
    expect(
      stepsOf(plan(toCanvas(hundred), 'headline', null)).map((step) => step.type),
    ).toStrictEqual(['section', 'row', 'column', 'headline']);
  });
});

describe('moving, copying and deleting', () => {
  it('offers an element every other column and container, a column every other row', () => {
    const index = indexTree(every);
    const zones = moveTargets(every, index, 'hero-title').map((target) => target.zone);
    expect(zones).toContain('hero-right:children');
    expect(zones).toContain('box-3:children');
    expect(zones).toContain('claim-col:children');
    expect(zones).not.toContain('hero-left:children');
    expect(moveTargets(every, index, 'hero-left').map((target) => target.zone)).toStrictEqual([
      'details-row:columns',
      'claim-row:columns',
    ]);
    expect(moveTargets(every, index, 'hero-row').map((target) => target.zone)).toStrictEqual([
      'details:rows',
      'claim:rows',
      'leaving:rows',
    ]);
    expect(moveTargets(every, index, 'hero')).toStrictEqual([]);
    expect(moveTargets(every, index, 'gone')).toStrictEqual([]);
  });

  it('never moves a node into itself, and says why a place is refused', () => {
    const index = indexTree(every);
    const forBox = moveTargets(every, index, 'box-1');
    expect(forBox.map((target) => target.ownerId)).not.toContain('box-1');
    expect(forBox.map((target) => target.ownerId)).not.toContain('box-2');
    expect(forBox.map((target) => target.ownerId)).not.toContain('box-3');
    expect(forBox.every((target) => target.refusal === null)).toBe(true);
    // A container cannot go into the deepest container.
    const deep = moveTargets(every, index, 'box-3');
    expect(deep.find((target) => target.ownerId === 'hero-left')?.refusal).toBeNull();
    // The last column of a row stays.
    expect(
      moveTargets(every, index, 'details-one').every((each) => each.refusal === 'last_column'),
    ).toBe(true);
    expect(removalRefusal(every, index, 'details-one')).toBe('last_column');
    expect(removalRefusal(every, index, 'hero-left')).toBeNull();
    expect(removalRefusal(every, index, 'hero-title')).toBeNull();
    expect(removalRefusal(every, index, 'gone')).toBeNull();
  });

  it('copies a node beside itself unless the place is full or it is a reference', () => {
    const index = indexTree(every);
    expect(duplicateRefusal(every, index, 'hero-title')).toBeNull();
    expect(duplicateRefusal(every, index, 'shared-footer')).toBe('kind');
    expect(duplicateRefusal(every, index, 'gone')).toBe('kind');
    const six: VisualPageDocument = structuredClone(smallPage);
    const [section] = six.sections;
    if (section?.type !== 'section') throw new Error('a section');
    const row = section.rows[0];
    if (row === undefined) throw new Error('a row');
    for (let at = 0; at < 4; at += 1)
      row.columns.push({ id: `c${String(at)}`, type: 'column', props: { span: 2 }, children: [] });
    const data = toCanvas(six);
    expect(duplicateRefusal(data, indexTree(data), 'left')).toBe('columns');
  });
});

describe('naming', () => {
  it('writes a node’s way from the page down to it', () => {
    const index = indexTree(every);
    expect(pathTo(index, 'hero-title')).toStrictEqual([
      { type: 'section', place: 1, name: 'Hero' },
      { type: 'row', place: 1, name: undefined },
      { type: 'column', place: 1, name: undefined },
      { type: 'headline', place: 1, name: undefined },
    ]);
    expect(pathTo(index, 'claim').at(0)).toStrictEqual({
      type: 'popup',
      place: 1,
      name: 'Claim the offer',
    });
    expect(pathTo(index, 'gone')).toStrictEqual([]);
  });

  it('names an element by its first words', () => {
    const index = indexTree(every);
    const of = (id: string): string => excerptOf(index.get(id)?.node ?? node('divider'));
    expect(of('hero-title')).toBe('Spring offer for {{contact.first_name}}');
    expect(of('hero-cta')).toBe('Claim it');
    expect(of('details-list')).toBe('Free delivery');
    expect(of('hero')).toBe('Hero');
    expect(of('details-line')).toBe('');
    expect(
      excerptOf(node('paragraph', 'p', { text: [{ text: 'a  b\n'.repeat(20) }] })),
    ).toHaveLength(40);
    expect(excerptOf(node('paragraph', 'p', { text: [null, { text: 5 }, 'x'] }))).toBe('');
  });

  it('makes ids the page document accepts', () => {
    const id = newNodeId();
    expect(id).toMatch(/^n[a-z0-9]{11}$/);
    expect(newNodeId(() => 0)).toBe('n00000000000');
    expect(newNodeId()).not.toBe(newNodeId());
  });
});

describe('dragging a new node in from the list', () => {
  it('lets the layout kinds and every element be picked up, and nothing else', () => {
    const index = indexTree(small);
    for (const type of ['section', 'row', 'column', 'headline', 'image', 'container', 'calendar'])
      expect(dragInRefusal(index, type), type).toBeNull();
    // A popup has no place in the page's flow, and a saved section is not made here.
    expect(dragInRefusal(index, 'popup')).toBe('kind');
    expect(dragInRefusal(index, 'saved_section')).toBe('kind');
    expect(dragInRefusal(index, 'marquee')).toBe('kind');
    expect(DRAG_IN_TYPES).toHaveLength(3 + 13);
  });

  it('lets nothing be picked up that the page has no room for', () => {
    // A page one node short of full takes an element, and not a row with its column.
    const sections = Math.ceil((PAGE_DOCUMENT_LIMITS.nodes - 1) / 34);
    const index = indexTree(toCanvas(longPage(sections, 10)));
    expect(pageNodeCount(index)).toBeGreaterThanOrEqual(PAGE_DOCUMENT_LIMITS.nodes - 1);
    const nearlyFull = new Map([...index].slice(0, PAGE_DOCUMENT_LIMITS.nodes - 1));
    expect(dragInCost('row')).toBe(2);
    expect(dragInCost('headline')).toBe(1);
    expect(dragInRefusal(nearlyFull, 'headline')).toBeNull();
    expect(dragInRefusal(nearlyFull, 'section')).toBeNull();
    expect(dragInRefusal(nearlyFull, 'row')).toBe('nodes');
    const fullPage = new Map([...index, ...indexTree(every)].slice(0, PAGE_DOCUMENT_LIMITS.nodes));
    expect(pageNodeCount(fullPage)).toBe(PAGE_DOCUMENT_LIMITS.nodes);
    expect(dragInRefusal(fullPage, 'headline')).toBe('nodes');
    expect(dragInRefusal(fullPage, 'column')).toBe('nodes');
  });

  it('holds a dragged node to the same places a button would put it: kind, count and depth', () => {
    // The canvas asks each zone what it takes while something is dragged over it
    // (elements.tsx hands these answers on): the rules are the ones "add" and "move" obey.
    const index = indexTree(every);
    expect(kindsIn(index, SECTIONS_ZONE)).toEqual(['section', 'saved_section']);
    expect(kindsIn(index, 'hero:rows')).toEqual(['row']);
    expect(kindsIn(index, 'hero-row:columns')).toEqual(['column']);
    expect(kindsIn(index, 'hero-left:children')).toContain('container');
    // The deepest container takes every element but another container.
    expect(kindsIn(index, 'box-3:children')).not.toContain('container');
    expect(kindsIn(index, 'box-3:children')).toContain('headline');
    expect(refusalFor(every, index, node('container'), 'box-3:children', false)).toBe('depth');
    expect(refusalFor(every, index, node('headline'), 'hero:rows', false)).toBe('kind');
    // A full place takes nothing more.
    const full: VisualPageDocument = structuredClone(smallPage);
    const row = full.sections[0];
    if (row?.type !== 'section') throw new Error('a section');
    const columns = row.rows[0]?.columns ?? [];
    while (columns.length < PAGE_DOCUMENT_LIMITS.columns)
      columns.push({
        id: `extra${String(columns.length)}`,
        type: 'column',
        props: { span: 2 },
        children: [],
      });
    const data = toCanvas(full);
    expect(isFull(data, indexTree(data), 'top-row:columns')).toBe(true);
    expect(refusalFor(data, indexTree(data), node('column'), 'top-row:columns', false)).toBe(
      'columns',
    );
  });

  it('knows a row that was dropped with no column, which is given its first', () => {
    const dropped: CanvasData = {
      ...small,
      root: {
        props: {
          ...small.root.props,
          sections: [
            ...small.root.props.sections,
            node('section', 's2', { rows: [node('row', 'bare', { columns: [] })] }),
          ],
        },
      },
    };
    const index = indexTree(dropped);
    expect(rowNeedsColumn(index, 'bare')).toBe(true);
    expect(rowNeedsColumn(index, 'top-row')).toBe(false);
    expect(rowNeedsColumn(index, 'title')).toBe(false);
    expect(rowNeedsColumn(index, 'gone')).toBe(false);
  });
});
