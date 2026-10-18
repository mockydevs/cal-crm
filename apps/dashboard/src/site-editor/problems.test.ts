import { describe, expect, it } from 'vitest';
import { toCanvas, type CanvasData, type CanvasNode } from './document-map';
import { everyElementPage, smallPage } from './fixtures';
import { canvasIdOf, checkCanvas, nodeIdAt } from './problems';

/** The canvas's data with one node's props changed. */
function withProps(data: CanvasData, id: string, props: Record<string, unknown>): CanvasData {
  const change = (nodes: readonly CanvasNode[]): CanvasNode[] =>
    nodes.map((node) => {
      const next: Record<string, unknown> = { ...node.props };
      for (const slot of ['rows', 'columns', 'children']) {
        const children = next[slot];
        if (Array.isArray(children)) next[slot] = change(children as CanvasNode[]);
      }
      return {
        type: node.type,
        props: (node.props.id === id ? { ...next, ...props } : next) as CanvasNode['props'],
      };
    });
  return {
    ...data,
    root: {
      props: {
        ...data.root.props,
        sections: change(data.root.props.sections),
        popups: change(data.root.props.popups),
      },
    },
  };
}

describe('checkCanvas', () => {
  it('hands back the page as a document the contract accepts', () => {
    const checked = checkCanvas(toCanvas(everyElementPage));
    expect(checked.problems).toStrictEqual([]);
    expect(checked.document).toStrictEqual(everyElementPage);
  });

  it('says what is wrong, at the element it is wrong with, once', () => {
    const data = withProps(withProps(toCanvas(smallPage), 'title', { level: 9 }), 'picture', {
      src: 'javascript:alert(1)',
      alt: 5,
    });
    const checked = checkCanvas(data);
    expect(checked.document).toBeNull();
    expect(new Set(checked.problems.map((problem) => problem.nodeId))).toStrictEqual(
      new Set(['title', 'picture']),
    );
    expect(checked.problems.every((problem) => problem.blocking)).toBe(true);
    // A link to a popup the page no longer has is said in the contract's own words.
    const dangling = checkCanvas(
      withProps(toCanvas(everyElementPage), 'hero-cta', {
        action: { type: 'popup', popupId: 'gone' },
      }),
    );
    expect(dangling.problems).toStrictEqual([
      { message: 'This page has no such popup.', nodeId: 'hero-cta', blocking: true },
    ]);
  });

  it('reports a problem of the page as a whole with no element', () => {
    const data = toCanvas(smallPage);
    const broken: CanvasData = {
      ...data,
      root: { props: { ...data.root.props, settings: { seo: null } } },
    };
    const checked = checkCanvas(broken);
    expect(checked.document).toBeNull();
    expect(checked.problems.length).toBeGreaterThan(0);
    expect(checked.problems.every((problem) => problem.nodeId === null)).toBe(true);
  });

  it('lists the same sentence about one element only once', () => {
    const twice = withProps(toCanvas(smallPage), 'copy', {
      text: [{ text: 5 }, { text: 6 }],
    });
    const checked = checkCanvas(twice);
    expect(checked.problems).toHaveLength(1);
    expect(checked.problems[0]?.nodeId).toBe('copy');
  });
});

describe('nodeIdAt', () => {
  it('finds the element a path into a document ends in or passes last', () => {
    const at = (path: (string | number | symbol)[]): string | null => nodeIdAt(smallPage, path);
    expect(at(['sections', 0, 'rows', 0, 'columns', 0, 'children', 1, 'props', 'text'])).toBe(
      'copy',
    );
    expect(at(['sections', 0])).toBe('top');
    expect(at(['sections', 0, 'rows', 0, 'id'])).toBe('top-row');
    expect(at(['settings', 'seo', 'title'])).toBeNull();
    expect(at([])).toBeNull();
    // A path that leaves the document ends where it left.
    expect(at(['sections', 'first', 'rows'])).toBeNull();
    expect(at(['sections', 0, Symbol('x')])).toBe('top');
    expect(at(['sections', 0, 'id', 'deeper'])).toBe('top');
    expect(nodeIdAt(null, ['sections'])).toBeNull();
  });
});

describe('canvasIdOf', () => {
  it('finds the canvas’s own id of a node the saved page knows by a shortened one', () => {
    const data = toCanvas(smallPage);
    expect(canvasIdOf(data, 'title')).toBe('title');
    expect(canvasIdOf(data, 'gone')).toBeNull();
    const long = 'headline-3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const named = withProps(data, 'title', { id: long });
    expect(canvasIdOf(named, 'n3f2504e04f8941d39a0c0305e82c3301')).toBe(long);
    const inPopup = toCanvas(everyElementPage);
    expect(canvasIdOf(inPopup, 'claim-form')).toBe('claim-form');
  });
});
