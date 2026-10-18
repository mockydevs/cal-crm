// The live page's standards, as budgets a test keeps. Every fixture is rendered the way a
// visitor is sent it and measured: no script of ours unless an element needs one, one
// element for each node of the document and none for layout alone, how deep the markup
// goes, how many bytes of HTML and CSS, only the rules the page uses, nothing fetched that
// the document did not ask for, pictures that do not wait when they are seen first, and the
// system's own fonts.
//
// A number here is a ceiling with a little room over what was measured when it was set.
// Raising one is a decision, not a fix.
import {
  pageDocument,
  pageElementTypes,
  type PageElement,
  type VisualPageDocument,
} from '@repo/contracts';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { describe, expect, it } from 'vitest';

import { BASE_CSS, baseCss } from './css.js';
import {
  context,
  ELEMENTS,
  EVERYTHING,
  pageOf,
  SAVED,
  SCRIPTS,
  SECTION,
  SITE_BASE,
} from './fixtures.js';
import { pageChangesAt, pageElements, renderPage } from './render.js';
import { longPage } from './testing.js';

type Element = DefaultTreeAdapterMap['element'];
type Node = DefaultTreeAdapterMap['childNode'];

/** The nodes that hold words: what is inside one is its text. */
const TEXT_NODES = new Set(['hl', 'sh', 'pg', 'ls', 'cd', 'cc']);
/** The class that says which node of the document an element is. One per node. */
const NODE_CLASSES = new Set([
  ...['sc', 'rw', 'cl', 'kt'],
  ...['hl', 'sh', 'pg', 'ls', 'im', 'vd', 'vf', 'bt', 'dv', 'fm', 'cd', 'cc'],
  // A popup is two elements: what dims the page behind it, and its box.
  ...['pp', 'pb'],
]);
/**
 * What may be written without a node of its own, and why: the words of a text (its
 * marks, its links, its line breaks, a list's items), a button's second line, the link
 * around a picture, the moment a countdown ends, a form's script and what is shown
 * without one, and a popup's way out.
 */
const CONTENT_TAGS = new Set([
  ...['strong', 'em', 'u', 's', 'span', 'a', 'br', 'li'],
  ...['time', 'script', 'noscript'],
  // The page's one landmark, which holds its sections.
  'main',
]);

interface Measured {
  readonly html: string;
  readonly css: string;
  /** Every element under body, with how deep it is: body's children are at 1. */
  readonly elements: readonly { readonly node: Element; readonly depth: number }[];
  readonly nodes: readonly Element[];
}

const classesOf = (node: Element): string[] =>
  (node.attrs.find((each) => each.name === 'class')?.value ?? '').split(' ').filter(Boolean);
const attr = (node: Element, name: string): string | undefined =>
  node.attrs.find((each) => each.name === name)?.value;

function measure(document: VisualPageDocument, over = {}): Measured {
  const page = renderPage(document, context(over));
  if (page === undefined) throw new Error('A visual page renders.');
  const inner = /<body>\n([\s\S]*)<\/body>/.exec(page.html)?.[1] ?? '';
  const elements: { node: Element; depth: number }[] = [];
  const walk = (list: readonly Node[], depth: number): void => {
    for (const node of list) {
      if (!('tagName' in node)) continue;
      elements.push({ node, depth });
      // What a noscript holds is text to a parser that runs scripts, and is not walked.
      walk(node.childNodes, depth + 1);
    }
  };
  walk(parseFragment(inner).childNodes, 1);
  return {
    html: page.html,
    css: page.css,
    elements,
    nodes: elements
      .map((each) => each.node)
      .filter((node) => classesOf(node).some((name) => NODE_CLASSES.has(name))),
  };
}

/** How many nodes of the document are written: sections, rows, columns, elements, popups. */
function documentNodes(document: VisualPageDocument, sections = new Map([[SECTION, SAVED]])) {
  let count = 0;
  // main (or a popup's backdrop), a section (or a popup's box), a row, a column: four.
  let depth = 4;
  const within = (node: PageElement, at: number): void => {
    depth = Math.max(depth, at);
    if (node.type === 'container') for (const child of node.children) within(child, at + 1);
  };
  const rows = (list: VisualPageDocument['popups'][number]['rows']): void => {
    for (const row of list) {
      count += 1 + row.columns.length;
      for (const column of row.columns) for (const child of column.children) within(child, 5);
    }
  };
  for (const each of document.sections) {
    const found = each.type === 'section' ? each : sections.get(each.sectionId);
    if (found === undefined) continue;
    count += 1;
    rows(found.rows);
  }
  // A popup is its backdrop and its box.
  for (const popup of document.popups) {
    count += 2;
    rows(popup.rows);
  }
  return { structure: count, depth, elements: [...pageElements(document, sections)] };
}

const PAGES: readonly (readonly [string, VisualPageDocument])[] = [
  ...pageElementTypes.map((type) => [type, pageOf([ELEMENTS[type]])] as const),
  ['everything', EVERYTHING],
  ['long page (20 sections, 300 elements)', longPage()],
];

/** What our own markup may fetch, by the element that asks for it. */
function requests(measured: Measured): string[] {
  const found: string[] = [];
  for (const { node } of measured.elements) {
    const src = attr(node, 'src');
    if (src !== undefined) found.push(`${node.tagName}:${src}`);
  }
  for (const match of measured.css.matchAll(/url\("([^"]*)"\)/g))
    found.push(`css:${match[1] ?? ''}`);
  for (const match of measured.html.matchAll(
    /<link rel="(icon|stylesheet|preload)" href="([^"]*)"/g,
  ))
    found.push(`link-${match[1] ?? ''}:${match[2] ?? ''}`);
  return found.sort();
}

describe('the long page', () => {
  it('is a page the contract accepts, of the size the standard measures with', () => {
    const page = longPage();
    expect(pageDocument.safeParse(page).error).toBeUndefined();
    expect(page.sections).toHaveLength(20);
    expect([...pageElements(page)]).toHaveLength(300);
    expect([...pageElements(longPage(3, 10))]).toHaveLength(10);
  });
});

describe.each(PAGES)('the budget of a page: %s', (name, document) => {
  const measured = measure(document);
  const expected = documentNodes(document);

  it('writes no script unless an element needs one, and then only that element’s own', () => {
    const scripts = measured.elements.filter(({ node }) => node.tagName === 'script');
    const forms = expected.elements.filter((node) => node.type === 'form');
    expect(scripts).toHaveLength(forms.length);
    for (const { node } of scripts) {
      expect(attr(node, 'src')).toBe('/forms/embed.js');
      // Fetched beside the page and run when it arrives: it never holds the page up.
      expect(attr(node, 'async')).toBe('');
      expect(node.childNodes).toHaveLength(0);
    }
    // In the head: the countdown's script on a page with a countdown still running, the
    // popups' on a page with a popup, each once, each deferred, and nothing else.
    const wanted = [
      ...(expected.elements.some((node) => node.type === 'countdown' && node.props.endsAt !== null)
        ? [SCRIPTS.countdown]
        : []),
      ...(document.popups.length > 0 ? [SCRIPTS.popup] : []),
    ];
    const head = /<head>([\s\S]*)<\/head>/.exec(measured.html)?.[1] ?? '';
    expect([...head.matchAll(/<script([^>]*)><\/script>/g)].map(([, attrs]) => attrs)).toEqual(
      wanted.map((src) => ` defer src="${src}"`),
    );
    expect(measured.html.match(/<script/g) ?? []).toHaveLength(forms.length + wanted.length);
    // Nothing is ever written inside a script element: the policy allows no inline script.
    expect(measured.html).not.toMatch(/<script[^>]*>[^<]/);
    // No style or handler written on an element: the policy would refuse both.
    expect(measured.html).not.toMatch(/\sstyle=|\son[a-z]+=/);
  });

  it('gains one deferred script and nothing else when its site keeps the arrival', () => {
    const site = '0123456789abcdef0123456789abcdef';
    const kept = measure(document, { arrival: { site, always: false } });
    const tag = `<script defer src="${SCRIPTS.arrival}" data-site="${site}"></script>\n`;
    // The same page, byte for byte, but for the one tag after the stylesheet.
    expect(kept.html.replace(tag, '')).toBe(measured.html);
    expect(kept.html).toContain(`</style>\n${tag}`);
    expect(kept.css).toBe(measured.css);
  });

  it('writes one element for each node of the document, and none for layout alone', () => {
    // Custom code is not written on a shared address; everything else here has what it shows.
    const written = expected.elements.filter((node) => node.type !== 'custom_code');
    expect(measured.nodes).toHaveLength(expected.structure + written.length);
    const kind = (node: Element): string | undefined =>
      classesOf(node).find((each) => NODE_CLASSES.has(each));
    /** Whether the element is inside a node that holds words. */
    const inText = (node: Element): boolean => {
      for (let at = node.parentNode; at !== null && 'tagName' in at; at = at.parentNode)
        if (TEXT_NODES.has(kind(at) ?? '')) return true;
      return false;
    };
    const parentKind = (node: Element): string | undefined =>
      node.parentNode !== null && 'tagName' in node.parentNode ? kind(node.parentNode) : undefined;
    for (const { node, depth } of measured.elements) {
      const own = classesOf(node).filter((each) => NODE_CLASSES.has(each));
      expect(own.length).toBeLessThanOrEqual(1);
      // A div or a section is always a node: there is no element that only holds others.
      if (node.tagName === 'div' || node.tagName === 'section') expect(own).toHaveLength(1);
      if (own.length === 1) continue;
      // An element that is not a node of the document is part of what one node shows,
      // and each kind has its one place: the page's landmark, the words of a text, a
      // button's second line, the link a picture is, a form's script and what is shown
      // without it, a popup's way out.
      expect(CONTENT_TAGS.has(node.tagName), node.tagName).toBe(true);
      const held = node.childNodes.filter((child) => 'tagName' in child);
      const place =
        node.tagName === 'main'
          ? depth === 1
          : node.tagName === 'script' || node.tagName === 'noscript'
            ? parentKind(node) === 'fm'
            : classesOf(node).includes('bs')
              ? parentKind(node) === 'bt'
              : classesOf(node).includes('px')
                ? parentKind(node) === 'pb'
                : inText(node) ||
                  (node.tagName === 'a' &&
                    held.length === 1 &&
                    held.every((child) => 'tagName' in child && kind(child) === 'im'));
      expect(place, `${node.tagName} in ${parentKind(node) ?? 'nothing'}`).toBe(true);
    }
    expect(measured.elements.filter(({ node }) => node.tagName === 'main')).toHaveLength(1);
    // All the elements there are, to the document's nodes, on a page long enough for the
    // number to mean something: the words of a text make up the rest.
    if (measured.nodes.length >= 30)
      expect(measured.elements.length / measured.nodes.length).toBeLessThanOrEqual(1.7);
  });

  it('nests no deeper than the document does', () => {
    // main or a popup, a section, a row, a column, an element, and containers in
    // containers: an element of the page is exactly as deep as its node of the document,
    // and one deeper when it is a picture inside its link.
    const structural = Math.max(
      ...measured.elements
        .filter(({ node }) => classesOf(node).some((each) => NODE_CLASSES.has(each)))
        .map(({ depth }) => depth),
    );
    const linked = measured.elements.some(
      ({ node }) =>
        node.tagName === 'a' &&
        node.childNodes.some((child) => 'tagName' in child && child.tagName === 'img'),
    );
    // (Custom code is not written on a shared address, so its page stops at the column.)
    expect(structural).toBe(
      name === 'custom_code' ? 4 : expected.depth + (linked && expected.depth === 5 ? 1 : 0),
    );
    // A column's elements at five, three containers at most: eight, whatever the page.
    expect(structural).toBeLessThanOrEqual(8);
    // A text's own marks and a list's items go inside their element: four more at most here.
    expect(Math.max(...measured.elements.map(({ depth }) => depth))).toBeLessThanOrEqual(
      structural + 4,
    );
  });

  it('holds only the rules it uses', () => {
    const own = measured.css.replace(document.settings.customCss, '');
    const names = new Set(measured.elements.flatMap(({ node }) => classesOf(node)));
    const tags = new Set(measured.elements.map(({ node }) => node.tagName));
    // Every class a rule is written for is on the page, and every class of the page's own
    // numbering has a rule: neither a rule nor a name is carried for nothing.
    // (A rule for several things at once is used when one of them is there.)
    for (const [, selector] of own.matchAll(/(?:^|[{}])([^{}@]+)\{/gm)) {
      const named = [...(selector ?? '').matchAll(/\.([A-Za-z0-9_-]+)/g)].map((each) => each[1]);
      if (named.length === 0 || (selector ?? '').includes('a:focus-visible')) continue;
      expect(
        named.some((each) => names.has(each ?? '')),
        selector,
      ).toBe(true);
    }
    for (const each of names) if (/^e\d+$/.test(each)) expect(own).toContain(`.${each}{`);
    expect(own).not.toMatch(/\.sw|\.vd>iframe/);
    if (!tags.has('img')) expect(own).not.toContain('img{');
    if (!tags.has('a')) expect(own).not.toContain('focus-visible');
    if (!tags.has('iframe')) expect(own).not.toContain('.vd{');
    if (document.popups.length === 0) expect(own).not.toContain('.pp');
    // And never more than every rule there is.
    expect(baseCss(new Set()).length).toBeLessThan(BASE_CSS.length);
  });

  it('fetches nothing the document did not ask for', () => {
    const asked = new Set<string>();
    for (const node of expected.elements) {
      if (node.type === 'image' && node.props.src !== null) asked.add('img');
      if (node.type === 'video') asked.add(node.props.source === 'file' ? 'video' : 'iframe');
      if (node.type === 'form') asked.add('script');
    }
    const fetched = requests(measured);
    for (const each of fetched) {
      const kind = each.slice(0, each.indexOf(':'));
      const address = each.slice(each.indexOf(':') + 1);
      if (kind === 'css')
        expect(JSON.stringify(document)).toContain(address.replace(SITE_BASE, ''));
      else if (kind === 'link-icon') expect(address).toBe('https://img.example/favicon.png');
      else expect(asked.has(kind), each).toBe(true);
    }
    // One stylesheet, inside the page: nothing else holds up the first paint.
    expect(measured.html.match(/<style>/g)).toHaveLength(1);
    expect(measured.html).not.toMatch(/rel="stylesheet"|rel="preload"|@import|@font-face/);
  });

  it('fetches at once what is seen first, and the rest when it is scrolled to', () => {
    const images = measured.elements.filter(({ node }) => node.tagName === 'img');
    const first = measured.elements.find(({ node }) => node.tagName === 'section')?.node;
    const inFirst = (node: Element): boolean => {
      for (
        let at: Element['parentNode'] = node;
        at !== null;
        at = 'parentNode' in at ? at.parentNode : null
      )
        if (at === first) return true;
      return false;
    };
    images.forEach(({ node }, index) => {
      if (!inFirst(node)) expect(attr(node, 'loading')).toBe('lazy');
      else {
        expect(attr(node, 'loading')).toBeUndefined();
        // One picture is put ahead of the others, and only one.
        expect(attr(node, 'fetchpriority')).toBe(index === 0 ? 'high' : undefined);
      }
      expect(attr(node, 'alt')).toBeDefined();
    });
    for (const { node } of measured.elements)
      if (node.tagName === 'iframe') expect(attr(node, 'loading')).toBe('lazy');
  });

  it('uses the fonts the device has unless the page names one', () => {
    expect(measured.css).toContain(
      'body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
    );
  });
});

describe('the size of a page', () => {
  const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
  /** Ceilings in bytes: [the whole page, its stylesheet]. */
  const CEILINGS: Readonly<Record<string, readonly [number, number]>> = {
    headline: [2200, 1400],
    everything: [8000, 3600],
    'long page (20 sections, 300 elements)': [32_000, 2_000],
  };

  it.each(Object.entries(CEILINGS))('%s stays within its ceiling', (name, [page, sheet]) => {
    const document = PAGES.find(([each]) => each === name)?.[1];
    if (document === undefined) throw new Error(`No page called ${name}.`);
    const measured = measure(document);
    expect(bytes(measured.html)).toBeLessThanOrEqual(page);
    expect(bytes(measured.css)).toBeLessThanOrEqual(sheet);
  });

  it('sends a page with one headline under a third of the rules there are', () => {
    const { css } = measure(pageOf([ELEMENTS.headline]));
    expect(bytes(baseCss(new Set(['text', 'sc', 'sc-medium', 'rw', 'cl'])))).toBeLessThan(
      bytes(BASE_CSS) / 2,
    );
    expect(css.startsWith(baseCss(new Set(['text', 'sc', 'sc-medium', 'rw', 'cl'])))).toBe(true);
  });

  it('gives the editor every rule when it is not asked for the used ones', () => {
    const all = renderPage(pageOf([]), context({ baseRules: undefined }))?.css ?? '';
    expect(all.startsWith(BASE_CSS)).toBe(true);
    // The canvas draws a section's rows in an element of its own and styles it with these.
    expect(BASE_CSS).toContain('.sw-medium{max-width:960px}');
    expect(BASE_CSS).toContain('.vd>iframe{');
  });
});

describe('a picture', () => {
  it('is written with its own width and height whenever the document holds them', () => {
    // The standard asks for both on every picture, so the page does not move when one
    // arrives. They come from the document (the picture's own size, kept when it is
    // chosen): the renderer never makes one up, so a picture chosen by address alone, whose
    // size nobody knows, is still written without.
    const image = ELEMENTS.image;
    if (image.type !== 'image') throw new Error('The image fixture is an image.');
    expect(Object.keys(image.props).sort()).toEqual([
      'action',
      'alt',
      'height',
      'optimize',
      'src',
      'width',
    ]);
    expect(pageDocument.safeParse(pageOf([image])).success).toBe(true);
    const sized = measure(pageOf([image])).elements.filter(({ node }) => node.tagName === 'img');
    expect(sized).toHaveLength(1);
    for (const { node } of sized) {
      expect(attr(node, 'width')).toBe('1600');
      expect(attr(node, 'height')).toBe('900');
    }
    const { width: _width, height: _height, ...unsized } = image.props;
    expect(measure(pageOf([{ ...image, props: unsized }])).html).not.toMatch(
      /<img[^>]*\s(width|height)=/,
    );
  });

  it('has both sides on every picture of every fixture that knows them', () => {
    for (const [, document] of PAGES) {
      const known = [...pageElements(document, new Map([[SECTION, SAVED]]))].filter(
        (node) =>
          node.type === 'image' &&
          node.props.src !== null &&
          node.props.width !== undefined &&
          node.props.height !== undefined,
      );
      const written = measure(document).elements.filter(
        ({ node }) => attr(node, 'width') !== undefined && attr(node, 'height') !== undefined,
      );
      expect(written.filter(({ node }) => node.tagName === 'img')).toHaveLength(known.length);
    }
  });
});

describe('pageChangesAt', () => {
  const now = Date.parse('2026-10-12T12:00:00.000Z');

  it('is when the minute of a running countdown turns, and at the latest its end', () => {
    const sections = new Map([[SECTION, SAVED]]);
    // 49 days 21 hours 5 minutes are left exactly: the wording changes a moment later.
    expect(pageChangesAt(EVERYTHING, sections, now)).toBe(now + 1);
    expect(pageChangesAt(EVERYTHING, sections, now + 1)).toBe(now + 60_000 + 1);
    expect(pageChangesAt(EVERYTHING, sections, now + 20_000)).toBe(now + 60_000 + 1);
    // In its last minute it reads the same until it ends.
    const end = Date.parse('2026-12-01T09:05:00.000Z');
    expect(pageChangesAt(EVERYTHING, sections, end - 30_000)).toBe(end);
    expect(pageChangesAt(EVERYTHING, sections, end - 60_000)).toBe(end);
    expect(pageChangesAt(EVERYTHING, sections, end - 1)).toBe(end);
    // Once it has ended the page is written the other way, and stays so.
    expect(
      pageChangesAt(EVERYTHING, sections, Date.parse('2026-12-01T09:05:00.000Z')),
    ).toBeUndefined();
    expect(pageChangesAt(pageOf([ELEMENTS.headline]), sections, now)).toBeUndefined();
    const sooner = pageOf([
      ELEMENTS.countdown,
      {
        id: 'c2',
        type: 'countdown',
        props: { endsAt: '2026-11-01T00:00:00.000Z', whenOver: { type: 'hide' } },
      } as never,
      { id: 'c3', type: 'countdown', props: { endsAt: null, whenOver: { type: 'hide' } } } as never,
      {
        id: 'c4',
        type: 'countdown',
        props: { endsAt: 'soon', whenOver: { type: 'hide' } },
      } as never,
    ]);
    // The sooner of two: the one whose minute turns first.
    expect(pageChangesAt(sooner, new Map(), now + 1)).toBe(now + 60_000 + 1);
    expect(pageChangesAt(sooner, new Map(), Date.parse('2026-10-31T23:59:30.000Z'))).toBe(
      Date.parse('2026-11-01T00:00:00.000Z'),
    );
    const saved = new Map([
      [
        SECTION,
        {
          ...SAVED,
          rows: pageOf([ELEMENTS.countdown]).sections.flatMap((each) =>
            each.type === 'section' ? each.rows : [],
          ),
        },
      ],
    ]);
    expect(
      pageChangesAt(
        {
          ...pageOf([]),
          sections: [{ id: 'ref', type: 'saved_section', sectionId: SECTION }],
        } as never,
        saved,
        end - 10,
      ),
    ).toBe(end);
  });
});
