import { EMPTY_PAGE_DOCUMENT, type PageElement, type VisualPageDocument } from '@repo/contracts';
import { baseCss, renderPage, type RenderContext } from '@repo/site-render';
import { describe, expect, it } from 'vitest';
import { toCanvas, type CanvasNode } from './document-map';
import { everyElementPage } from './fixtures';
import {
  EDITOR_CSS,
  LIVE_BASE_CSS,
  nodeClass,
  nodeCss,
  nodesCss,
  pageCss,
  runClass,
} from './node-css';

const context: RenderContext = {
  siteBase: '',
  title: 'Test',
  index: false,
  preview: true,
  steps: new Map(),
  sections: new Map(),
  forms: new Map(),
  formScriptUrl: '',
  calendars: new Map(),
  now: 0,
  // What a visitor is sent: only the base rules of what is on the page.
  baseRules: 'used',
};

const node = (type: string, props: Record<string, unknown>, id = 'a'): CanvasNode => ({
  type,
  props: { id, ...props },
});

/** One element on a page of its own, as the published page's renderer writes its rules. */
function published(element: PageElement): string {
  const page: VisualPageDocument = {
    ...EMPTY_PAGE_DOCUMENT,
    sections: [
      {
        id: 's',
        type: 'section',
        props: { width: 'full' },
        rows: [
          {
            id: 'r',
            type: 'row',
            columns: [{ id: 'c', type: 'column', props: { span: 12 }, children: [element] }],
          },
        ],
      },
    ],
  };
  const css = renderPage(page, context)?.css ?? '';
  // A class is written only for a node that has rules: the column's share of the row is
  // the first, the element's the second. No base rule names such a class.
  return css
    .split('\n')
    .filter((line) => line.includes('.e2'))
    .join('\n')
    .replaceAll('.e2', '.X');
}

describe('nodeCss', () => {
  it('writes a node’s rules as the published page’s renderer writes them', () => {
    const elements: PageElement[] = [
      {
        id: 'a',
        type: 'headline',
        props: { level: 1, text: [{ text: 'Hello' }] },
        style: { fontSize: 48, textAlign: 'left', margin: { bottom: 8 } },
        responsive: { tablet: { fontSize: 36 }, mobile: { fontSize: 28, textAlign: 'center' } },
      },
      {
        id: 'a',
        type: 'button',
        props: { label: 'Go', subLabel: '', action: { type: 'none' } },
        style: {
          backgroundColor: '#0f766e',
          textColor: '#ffffff',
          borderRadius: 8,
          shadow: 'small',
          width: { value: 50, unit: '%' },
        },
        responsive: { mobile: { width: { value: 100, unit: '%' } } },
      },
      {
        id: 'a',
        type: 'divider',
        props: { thickness: 2, line: 'dashed', color: '#cccccc' },
        style: { margin: { top: 4 } },
      },
      { id: 'a', type: 'divider', props: { thickness: 1, line: 'solid', color: null } },
      {
        id: 'a',
        type: 'container',
        props: { direction: 'horizontal', gap: 12 },
        style: { padding: { top: 8, left: 8 }, align: 'center' },
        children: [],
      },
    ];
    for (const element of elements) {
      const [canvasNode] = toCanvas({
        ...EMPTY_PAGE_DOCUMENT,
        sections: [
          {
            id: 's',
            type: 'section',
            props: { width: 'full' },
            rows: [
              {
                id: 'r',
                type: 'row',
                columns: [{ id: 'c', type: 'column', props: { span: 12 }, children: [element] }],
              },
            ],
          },
        ],
      }).root.props.sections[0]?.props['rows'] as CanvasNode[];
      const column = (canvasNode?.props['columns'] as CanvasNode[])[0];
      const drawn = (column?.props['children'] as CanvasNode[])[0];
      if (drawn === undefined) throw new Error('an element');
      expect(nodeCss(drawn).replaceAll('.n_a', '.X'), element.type).toBe(published(element));
    }
  });

  it('gives a column its share of the row, as the published page does', () => {
    expect(nodeCss(node('column', { span: 7, look: {} }))).toBe('.n_a{flex:7 1 0%}');
    expect(nodeCss(node('column', { span: 99, look: {} }, 'b'))).toBe('.n_b{flex:12 1 0%}');
    expect(nodeCss(node('column', { look: {} }, 'c'))).toBe('.n_c{flex:12 1 0%}');
    expect(nodeCss(node('container', { gap: 999 }, 'd'))).toBe('.n_d{gap:200px}');
    expect(nodeCss(node('container', {}, 'e'))).toBe('');
    expect(nodeCss(node('container', { gap: 0 }, 'g'))).toBe('');
    expect(nodeCss(node('divider', { thickness: 'x', line: 'wavy', color: 'red' }, 'f'))).toBe(
      '.n_f{border-top:1px solid currentColor}',
    );
  });

  it('draws a node hidden on a device faint there, and never removes it', () => {
    const css = nodeCss(node('paragraph', { look: { hidden: { mobile: true, desktop: true } } }));
    expect(css).toBe(
      '@media (min-width:1025px){.n_a{filter:opacity(.35)}}\n' +
        '@media (max-width:640px){.n_a{filter:opacity(.35)}}',
    );
    expect(css).not.toContain('display:none');
    expect(nodeCss(node('paragraph', { look: { hidden: { tablet: false } } }, 'b'))).toBe('');
  });

  it('gives each coloured stretch of text a rule of its own', () => {
    const css = nodeCss(
      node('bullet_list', {
        items: [
          [{ text: 'One' }],
          [
            { text: 'Two', color: '#ff0000' },
            { text: 'x', color: 'red' },
          ],
        ],
        look: {},
      }),
    );
    expect(css).toBe(`.${runClass('a', 1, 0)}{color:#ff0000}`);
    expect(
      nodeCss(node('headline', { text: [{ text: 'A', color: '#00f' }, null, 'x'], look: {} }, 'h')),
    ).toBe('.n_h_t0_0{color:#00f}');
    expect(nodeCss(node('headline', { text: 'not runs', items: 'not items' }, 'i'))).toBe('');
  });

  it('writes nothing for a node with no look, and lets no value through unchecked', () => {
    expect(nodeCss(node('paragraph', {}))).toBe('');
    expect(nodeCss(node('paragraph', { look: null }, 'b'))).toBe('');
    expect(
      nodeCss(
        node('paragraph', { look: { style: { backgroundColor: 'red;}</style><script>' } } }, 'c'),
      ),
    ).toBe('');
    expect(nodeClass('headline-3F25:04e0</style>')).toBe('n_headline-3F2504e0style');
  });

  it('keeps a node’s rules until the node itself changes', () => {
    const drawn = node('paragraph', { look: { style: { fontSize: 20 } } }, 'kept');
    const first = nodeCss(drawn);
    expect(first).toBe('.n_kept{font-size:20px}');
    expect(nodeCss(drawn)).toBe(first);
    expect(nodeCss({ ...drawn, props: { ...drawn.props, look: {} } })).toBe('');
  });
});

describe('nodesCss', () => {
  it('writes every node’s rules, in the order of the page, popups after sections', () => {
    const css = nodesCss(toCanvas(everyElementPage));
    expect(css).toContain('.n_hero{padding-top:48px;padding-bottom:48px;background-color:#f1f5f9}');
    expect(css).toContain('@media (max-width:1024px){.n_hero{padding-top:32px}}');
    expect(css).toContain(
      '@media (max-width:640px){.n_hero-title{font-size:28px;text-align:center}}',
    );
    expect(css).toContain('.n_hero-left{flex:7 1 0%}');
    expect(css).toContain('.n_hero-title_t0_1{color:#0f766e}');
    expect(css.indexOf('.n_hero{')).toBeLessThan(css.indexOf('.n_details-row{'));
    expect(css.indexOf('.n_details-row{')).toBeLessThan(css.indexOf('.n_claim{'));
    // A saved section is drawn by reference: it has no rules of its own here.
    expect(css).not.toContain('shared-footer');
    expect(nodesCss(toCanvas(EMPTY_PAGE_DOCUMENT))).toBe('');
  });
});

/** The lines of a stylesheet: the renderer writes one rule, or one media query, a line. */
const lines = (css: string): string[] => css.split('\n').filter((line) => line !== '');

describe('pageCss', () => {
  it('is the live page’s own stylesheet for these settings, with the base rules of every element', () => {
    const { settings } = everyElementPage;
    const css = pageCss(settings);
    // What a visitor is sent for a page with these settings and nothing on it…
    const live =
      renderPage({ ...EMPTY_PAGE_DOCUMENT, settings }, { ...context, title: '' })?.css ?? '';
    // …is the canvas's stylesheet but for the base rules of what is not on the page yet.
    expect(css.startsWith(LIVE_BASE_CSS)).toBe(true);
    expect(`${baseCss(new Set())}${css.slice(LIVE_BASE_CSS.length)}`).toBe(live);
    expect(css).toContain('body{background-color:#ffffff;color:#1f2937}');
    expect(css).toContain('h1,h2,h3,h4,h5,h6{font-family:"Lexend",system-ui,sans-serif}');
    expect(css).toContain('.offer { letter-spacing: 1px; }');
    // Head and body code are never part of a stylesheet.
    expect(css).not.toContain('window.tenant');
  });

  it('holds every base rule the live page of a page with everything on it is sent, and no other kind', () => {
    const live = renderPage(everyElementPage, context)?.css ?? '';
    const base = lines(LIVE_BASE_CSS);
    // Each base rule of the live page is one the canvas has, in the same order.
    const used = lines(live).filter((line) => base.includes(line));
    expect(used.length).toBeGreaterThan(15);
    expect(base.filter((line) => used.includes(line))).toStrictEqual(used);
    // The rules an older canvas needed (a wrapper in a section, a frame inside a video's
    // box) are not part of what the canvas draws with.
    expect(LIVE_BASE_CSS).not.toContain('.sw');
    expect(LIVE_BASE_CSS).not.toContain('.vd>iframe');
    expect(LIVE_BASE_CSS).toContain('.rw+.rw{margin-top:24px}');
  });

  it('falls back to the base rules for settings it cannot read', () => {
    expect(pageCss(null)).toBe(LIVE_BASE_CSS);
    expect(pageCss(EMPTY_PAGE_DOCUMENT.settings)).toBe(LIVE_BASE_CSS);
  });
});

describe('EDITOR_CSS', () => {
  it('says again, for the canvas’s own drop zones, the layout the published page gives', () => {
    expect(LIVE_BASE_CSS).toContain('.rw{display:flex;gap:24px}');
    expect(EDITOR_CSS).toContain('.rw>.ez-row{display:flex;gap:24px;flex:1 1 auto}');
    expect(LIVE_BASE_CSS).toContain('.cl{display:flex;flex-direction:column;min-width:0}');
    expect(EDITOR_CSS).toContain('.cl>.ez-col{display:flex;flex-direction:column;flex:1 1 auto}');
    // The same breakpoint as the published page's own rule for a row on a phone.
    expect(LIVE_BASE_CSS).toContain('@media (max-width:640px){.rw{flex-direction:column}');
    expect(EDITOR_CSS).toContain('@media (max-width:640px){.rw>.ez-row{flex-direction:column}');
  });

  it('lays a section’s rows out in the section’s own one-column grid, so a row’s margin is kept', () => {
    // Live, a section is a grid and its rows are the grid's items: a row's own margin adds
    // to the 24 px between rows. Rows in a plain block would have the two margins collapse
    // into one, and sit up to 24 px closer than on the published page.
    expect(LIVE_BASE_CSS).toContain(
      '.sc{display:grid;grid-template-columns:minmax(0,1fr);align-content:start;',
    );
    expect(EDITOR_CSS).toContain(
      '.sc>.ez{display:grid;grid-template-columns:minmax(0,1fr);align-content:start}',
    );
  });
});
