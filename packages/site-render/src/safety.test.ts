// @vitest-environment jsdom
// What a rendered page is, whatever the document holds: valid HTML, accessible, and with
// nothing a tenant wrote running. The documents here are not ones the contract would
// accept: every text, address and value is replaced by an attack, because the renderer
// must be safe by itself.
import axe from 'axe-core';
import { parse } from 'parse5';
import { describe, expect, it } from 'vitest';

import { CALENDAR, context, EVERYTHING, FORM, SCRIPTS, SECTION, SITE_BASE } from './fixtures.js';
import { renderPage, type RenderContext } from './render.js';

const ATTACKS = [
  '"><script>alert(1)</script>',
  "'><script>alert(1)</script>",
  '</style><script>alert(1)</script>',
  '</title><script>alert(1)</script>',
  '</script><script>alert(1)</script>',
  '<svg onload=alert(1)>',
  '<svg><script>alert(1)</script></svg>',
  '<img src=x onerror=alert(1)>',
  '" onmouseover="alert(1)',
  "' onfocus='alert(1)' autofocus='",
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  'java\nscript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'data:image/svg+xml,<svg onload=alert(1)>',
  'https://example.com/"onload="alert(1)',
  "https://example.com/'onload='alert(1)",
  '//evil.example/x',
  '/\\evil.example/x',
  'url(javascript:alert(1))',
  'red;}</style><script>alert(1)</script>',
  'x;background:url(https://evil.example/steal)',
  '{{custom_values.attack}}',
  '\u0000<script>alert(1)</script>',
  '<!--<script>alert(1)</script>',
  '<base href="https://evil.example/">',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
];

/** The document with every text, address and value in it replaced by the attack. */
function poisoned(value: unknown, attack: string, key = ''): unknown {
  // What says which kind of node this is stays, so every renderer branch is reached.
  if (key === 'type' || key === 'mode' || key === 'format') return value;
  if (Array.isArray(value)) return value.map((each) => poisoned(each, attack));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([name, each]) => [name, poisoned(each, attack, name)]),
    );
  return value === null ? null : attack;
}

/** The ids other things are found by keep their value, so forms, steps and sections resolve. */
function reachable(document: typeof EVERYTHING, attack: string): typeof EVERYTHING {
  const hostile = poisoned(document, attack) as typeof EVERYTHING;
  hostile.sections.forEach((section, index) => {
    const original = document.sections[index];
    if (section.type === 'saved_section' && original?.type === 'saved_section')
      section.sectionId = original.sectionId;
  });
  return hostile;
}

const hostileContext = (attack: string): RenderContext =>
  context({
    title: attack,
    canonicalUrl: attack,
    faviconUrl: attack,
    lang: attack,
    forms: new Map([[FORM, attack]]),
    calendars: new Map([[CALENDAR, attack]]),
    sections: new Map([[SECTION, poisoned(EVERYTHING.sections[0], attack) as never]]),
    mergeValues: new Map([
      ['custom_values.name', attack],
      ['custom_values.attack', '<script>alert(2)</script>'],
    ]),
  });

const ALLOWED_LINK = new RegExp(`^(https?://[^\\s"'<>\`\\\\]+|mailto:|tel:|${SITE_BASE}/|#)`, 'i');

function check(html: string, css: string): void {
  const page = new DOMParser().parseFromString(html, 'text/html');
  // The only scripts a page may hold are the CRM's own: the form embed where a form is,
  // and in the head the small scripts of a countdown and of popups, by their own addresses.
  for (const script of page.querySelectorAll('script')) {
    expect(script.textContent).toBe('');
    if (script.closest('head') !== null) {
      expect(Object.values(SCRIPTS)).toContain(script.getAttribute('src'));
      expect(script.getAttributeNames().sort()).toEqual(['defer', 'src']);
      continue;
    }
    expect(script.getAttribute('src')).toBe('/forms/embed.js');
    expect(script.getAttributeNames().sort()).toEqual(['async', 'data-form-key', 'src']);
    expect(script.getAttribute('data-form-key')).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  }
  for (const node of page.querySelectorAll('*')) {
    for (const name of node.getAttributeNames()) {
      expect(name.startsWith('on'), `${node.tagName} ${name}`).toBe(false);
      expect(name).not.toBe('style');
      expect(name).not.toBe('srcdoc');
      expect(name).not.toBe('formaction');
    }
    const href = node.getAttribute('href');
    if (href !== null) expect(href, node.outerHTML).toMatch(ALLOWED_LINK);
    const src = node.getAttribute('src');
    if (src !== null && node.tagName !== 'SCRIPT')
      expect(src, node.outerHTML).toMatch(new RegExp(`^(https://[^\\s"'<>]+|${SITE_BASE}/)`));
  }
  expect(
    page.querySelectorAll('base, object, embed, form, meta[http-equiv], svg, math'),
  ).toHaveLength(0);
  for (const frame of page.querySelectorAll('iframe'))
    expect(frame.getAttribute('src')).toMatch(
      /^https:\/\/(www\.youtube\.com\/embed|player\.vimeo\.com\/video)\/[A-Za-z0-9_-]+(\?[a-z0-9=&_-]*)?$/i,
    );
  for (const link of page.querySelectorAll('link'))
    expect(['canonical', 'icon']).toContain(link.getAttribute('rel'));
  // One stylesheet, exactly the text the policy's digest is made from, and it cannot
  // end its own element.
  const styles = page.querySelectorAll('style');
  expect(styles).toHaveLength(1);
  expect(styles[0]?.textContent).toBe(css);
  expect(css).not.toContain('<');
}

describe('a rendered page, whatever its document holds', () => {
  it.each(ATTACKS)('runs nothing and loads nothing unexpected for %j', (attack) => {
    const page = renderPage(reachable(EVERYTHING, attack), hostileContext(attack));
    if (page === undefined) throw new Error('A visual page renders.');
    check(page.html, page.css);
    // Outside the page's custom CSS, which is the tenant's own stylesheet, no value of
    // the document reaches the stylesheet as it was written.
    const own = renderPage(
      {
        ...reachable(EVERYTHING, attack),
        settings: { ...reachable(EVERYTHING, attack).settings, customCss: '' },
      },
      hostileContext(attack),
    );
    expect(own?.css).not.toMatch(/javascript:|expression\(|evil\.example|alert\(/i);
    expect(page.needs.frames).toEqual([]);
    expect(page.needs.forms).toBe(false);
  });

  it('shows an attack in text as the text it is', () => {
    const attack = '<img src=x onerror=alert(1)>';
    const page = renderPage(
      {
        ...EVERYTHING,
        sections: [
          {
            id: 'top',
            type: 'section',
            props: { width: 'full' },
            rows: [
              {
                id: 'r',
                type: 'row',
                columns: [
                  {
                    id: 'c',
                    type: 'column',
                    props: { span: 12 },
                    children: [{ id: 'p', type: 'paragraph', props: { text: [{ text: attack }] } }],
                  },
                ],
              },
            ],
          },
        ],
        popups: [],
      },
      context(),
    );
    const parsed = new DOMParser().parseFromString(page?.html ?? '', 'text/html');
    expect(parsed.querySelector('p.pg')?.textContent).toBe(attack);
    expect(parsed.querySelector('img')).toBeNull();
  });

  it('keeps the well-formed page clean under the same checks', () => {
    const page = renderPage(EVERYTHING, context());
    check(page?.html ?? '', page?.css ?? '');
  });
});

describe('a rendered page as a document', () => {
  const pages: readonly (readonly [string, RenderContext])[] = [
    ['published', context()],
    ['previewed', context({ preview: true })],
    ['after its countdown', context({ now: Date.parse('2027-01-01T00:00:00Z') })],
  ];

  it.each(pages)('is HTML a parser reads without one error, when %s', (_name, given) => {
    const errors: string[] = [];
    parse(renderPage(EVERYTHING, given)?.html ?? '', {
      onParseError: (error) => errors.push(`${error.code} at line ${String(error.startLine)}`),
    });
    expect(errors).toEqual([]);
  });

  it.each(pages)(
    'passes the accessibility rules a page can be checked for here, when %s',
    async (_name, given) => {
      const html = renderPage(EVERYTHING, given)?.html ?? '';
      // The test's own document becomes the page: its root element, with its language,
      // its head and its body, is the parsed page's.
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      document.replaceChild(document.adoptNode(parsed.documentElement), document.documentElement);
      const results = await axe.run(document, {
        // jsdom draws nothing, so what needs a drawn page is not checked here.
        rules: { 'color-contrast': { enabled: false } },
        // A frame's own page is its owner's; only the frame's place on this page is checked.
        iframes: false,
      });
      expect(
        results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.html ?? ''}`),
      ).toEqual([]);
      expect(results.passes.length).toBeGreaterThan(10);
    },
  );
});
