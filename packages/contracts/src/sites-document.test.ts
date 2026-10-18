import { describe, expect, it } from 'vitest';

import {
  EMPTY_PAGE_DOCUMENT,
  PAGE_DOCUMENT_FORMAT,
  PAGE_DOCUMENT_LIMITS,
  PageDocumentFormatError,
  pageDocument,
  pageDocumentReferences,
  pageElementTypes,
  pageSection,
  pageSectionStepIds,
  siteFile,
  upgradePageDocument,
  type PageElement,
} from './sites-document.js';

const STEP = 'sstp_01h455vb4pex5vsknk084sn02q';
const SECTION = 'ssec_01h455vb4pex5vsknk084sn02q';
const FORM = 'form_01h455vb4pex5vsknk084sn02q';
const CALENDAR = 'cal_01h455vb4pex5vsknk084sn02q';
const FILE = 'file_01h455vb4pex5vsknk084sn02q';

const none = { type: 'none' } as const;
const run = (text: string, extra: Record<string, unknown> = {}) => ({ text, ...extra });

/** One of every element of the format, each with a valid shape. */
const everyElement = (): PageElement[] => [
  { id: 'h', type: 'headline', props: { text: [run('Hello {{custom_values.name}}')], level: 1 } },
  { id: 'sh', type: 'sub_headline', props: { text: [run('Sub', { bold: true })], level: 2 } },
  {
    id: 'p',
    type: 'paragraph',
    props: {
      text: [run('Read '), run('more', { link: { type: 'url', href: '/more', newTab: false } })],
    },
  },
  { id: 'l', type: 'bullet_list', props: { items: [[run('One')], [run('Two')]], marker: 'check' } },
  {
    id: 'i',
    type: 'image',
    props: { src: 'https://img.example/a.png', alt: 'A', action: none, optimize: true },
  },
  {
    id: 'v',
    type: 'video',
    props: {
      source: 'youtube',
      url: 'https://www.youtube.com/watch?v=abc',
      autoplay: false,
      controls: true,
      muted: false,
      loop: false,
    },
  },
  { id: 'b', type: 'button', props: { label: 'Go', subLabel: '', action: { type: 'next_step' } } },
  { id: 'd', type: 'divider', props: { thickness: 1, line: 'solid', color: '#cccccc' } },
  { id: 'f', type: 'form', props: { formId: FORM } },
  { id: 'c', type: 'calendar', props: { calendarId: CALENDAR } },
  {
    id: 'cd',
    type: 'countdown',
    props: { endsAt: '2026-12-01T00:00:00.000Z', whenOver: { type: 'hide' } },
  },
  { id: 'code', type: 'custom_code', props: { code: '<script>alert(1)</script>' } },
  {
    id: 'box',
    type: 'container',
    props: { direction: 'horizontal', gap: 8 },
    children: [{ id: 'inner', type: 'paragraph', props: { text: [run('In a box')] } }],
  },
];

const page = (children: unknown[] = everyElement(), extra: Record<string, unknown> = {}) => ({
  ...EMPTY_PAGE_DOCUMENT,
  sections: [
    {
      id: 'hero',
      type: 'section',
      props: { width: 'wide' },
      style: { padding: { top: 40, bottom: 40 }, backgroundColor: '#ffffff' },
      responsive: { mobile: { padding: { top: 16 } }, tablet: { fontSize: 18 } },
      hidden: { mobile: false },
      customClass: 'hero dark',
      rows: [
        {
          id: 'row',
          type: 'row',
          columns: [{ id: 'col', type: 'column', props: { span: 12 }, children }],
        },
      ],
    },
  ],
  ...extra,
});

const issues = (input: unknown) => {
  const result = pageDocument.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('/'));
};
const messages = (input: unknown) => {
  const result = pageDocument.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('a visual page', () => {
  it('starts empty and valid, in the current format', () => {
    expect(pageDocument.parse(EMPTY_PAGE_DOCUMENT)).toEqual(EMPTY_PAGE_DOCUMENT);
    expect(EMPTY_PAGE_DOCUMENT.format).toBe(PAGE_DOCUMENT_FORMAT);
  });

  it('holds one of every element, with style, per-device overrides and a class, unchanged', () => {
    const document = page();
    expect(everyElement().map((element) => element.type)).toEqual([...pageElementTypes]);
    expect(pageDocument.parse(document)).toEqual(document);
  });

  it('refuses an element it does not know, an unknown prop and an unknown style property', () => {
    expect(issues(page([{ id: 'x', type: 'marquee', props: {} }]))).not.toEqual([]);
    expect(
      issues(page([{ id: 'x', type: 'paragraph', props: { text: [], html: '<b>x</b>' } }])),
    ).not.toEqual([]);
    expect(
      issues(
        page([
          {
            id: 'x',
            type: 'paragraph',
            props: { text: [] },
            style: { position: 'fixed' },
          },
        ]),
      ),
    ).not.toEqual([]);
  });

  it('holds style values to a closed grammar, so none can carry markup or a script', () => {
    const styled = (style: unknown) =>
      page([{ id: 'x', type: 'paragraph', props: { text: [] }, style }]);
    expect(issues(styled({ backgroundColor: '#fff' }))).toEqual([]);
    expect(issues(styled({ backgroundColor: 'transparent' }))).toEqual([]);
    for (const style of [
      { backgroundColor: 'red;background:url(javascript:alert(1))' },
      { backgroundImageUrl: 'javascript:alert(1)' },
      { backgroundImageUrl: 'https://img.example/a.png"onerror="x' },
      { fontFamily: 'Arial</style><script>' },
      { fontWeight: 450 },
      { opacity: 2 },
      { width: { value: 50, unit: 'em' } },
    ])
      expect(issues(styled(style)), JSON.stringify(style)).not.toEqual([]);
    expect(
      issues(page([], { settings: { ...EMPTY_PAGE_DOCUMENT.settings, customCss: 'a{}</style>' } })),
    ).toEqual(['settings/customCss']);
  });

  it('takes a link to the web, mail, a phone, a path, an anchor or one merge field, and nothing else', () => {
    const linked = (href: string) =>
      page([
        {
          id: 'b',
          type: 'button',
          props: { label: 'Go', subLabel: '', action: { type: 'url', href, newTab: true } },
        },
      ]);
    for (const href of [
      'https://example.com/a?b=c',
      'http://example.com',
      'mailto:hello@example.com',
      'tel:+254700000000',
      '/thanks',
      '#top',
      '{{custom_values.booking_link}}',
    ])
      expect(issues(linked(href)), href).toEqual([]);
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,x',
      '//evil.example',
      'https://example.com/"onclick="x',
      'https://example.com/ a',
      'ftp://example.com',
      '{{custom_values.a}}{{custom_values.b}}',
    ])
      expect(issues(linked(href)), href).not.toEqual([]);
  });

  it('wants every id once, in sections, rows, columns, elements and popups alike', () => {
    const [first] = everyElement();
    expect(messages(page([first, first]))).toEqual(['Two nodes are called h.']);
    expect(messages(page([{ id: 'hero', type: 'paragraph', props: { text: [] } }]))).toEqual([
      'Two nodes are called hero.',
    ]);
    const popup = {
      id: 'row',
      type: 'popup',
      name: 'Offer',
      props: { trigger: 'exit', delaySeconds: 0, width: 'medium' },
      rows: [],
    };
    expect(messages(page([], { popups: [popup] }))).toEqual(['Two nodes are called row.']);
  });

  it('wants a popup or an anchor that an action names to be on the page', () => {
    const opening = (action: unknown) =>
      page([{ id: 'b', type: 'button', props: { label: 'Open', subLabel: '', action } }]);
    expect(messages(opening({ type: 'popup', popupId: 'offer' }))).toEqual([
      'This page has no such popup.',
    ]);
    expect(messages(opening({ type: 'anchor', sectionId: 'pricing' }))).toEqual([
      'This page has no such section.',
    ]);
    expect(issues(opening({ type: 'anchor', sectionId: 'hero' }))).toEqual([]);
    const popup = {
      id: 'offer',
      type: 'popup',
      name: 'Offer',
      props: { trigger: 'delay', delaySeconds: 5, width: 'small' },
      rows: [],
    };
    expect(issues({ ...opening({ type: 'popup', popupId: 'offer' }), popups: [popup] })).toEqual(
      [],
    );
    // A link inside text is held to the same rule.
    expect(
      messages(
        page([
          {
            id: 'p',
            type: 'paragraph',
            props: { text: [run('x', { link: { type: 'popup', popupId: 'gone' } })] },
          },
        ]),
      ),
    ).toEqual(['This page has no such popup.']);
  });

  it('keeps a row to six columns and containers to four deep', () => {
    const column = (id: string) => ({ id, type: 'column', props: { span: 2 }, children: [] });
    const columns = (count: number) => ({
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
              columns: Array.from({ length: count }, (_, n) => column(`c${String(n)}`)),
            },
          ],
        },
      ],
    });
    expect(issues(columns(6))).toEqual([]);
    expect(issues(columns(7))).not.toEqual([]);
    expect(issues(columns(0))).not.toEqual([]);

    const nest = (depth: number): unknown =>
      depth === 0
        ? { id: 'leaf', type: 'paragraph', props: { text: [] } }
        : {
            id: `box${String(depth)}`,
            type: 'container',
            props: { direction: 'vertical', gap: 0 },
            children: [nest(depth - 1)],
          };
    // A column's child is depth 1; containers at depths 1 to 3 hold a fourth level.
    expect(issues(page([nest(3)]))).toEqual([]);
    expect(messages(page([nest(4)]))).toEqual(['Nest containers at most 4 deep.']);
  });

  it('caps the text of one element and the size of the whole page', () => {
    const long = (count: number) =>
      page([
        {
          id: 'p',
          type: 'paragraph',
          props: { text: [run('a'.repeat(count / 2)), run('b'.repeat(count / 2))] },
        },
      ]);
    expect(issues(long(PAGE_DOCUMENT_LIMITS.text))).toEqual([]);
    expect(messages(long(PAGE_DOCUMENT_LIMITS.text + 2))).toEqual([
      'Use at most 20,000 characters in one element.',
    ]);
    const heavy = page(
      Array.from({ length: 12 }, (_, n) => ({
        id: `code${String(n)}`,
        type: 'custom_code',
        props: { code: 'x'.repeat(PAGE_DOCUMENT_LIMITS.code) },
      })),
    );
    expect(messages(heavy)).toEqual(['This page is too large to save. Remove some content.']);
  });

  it('names the saved sections and steps it refers to', () => {
    const document = pageDocument.parse({
      ...page([
        {
          id: 'b',
          type: 'button',
          props: { label: 'Go', subLabel: '', action: { type: 'step', stepId: STEP } },
        },
      ]),
      sections: [
        { id: 'header', type: 'saved_section', sectionId: SECTION },
        ...page([
          {
            id: 'b',
            type: 'button',
            props: { label: 'Go', subLabel: '', action: { type: 'step', stepId: STEP } },
          },
        ]).sections,
      ],
    });
    expect(pageDocumentReferences(document)).toEqual({ sectionIds: [SECTION], stepIds: [STEP] });
    expect(pageDocumentReferences(EMPTY_PAGE_DOCUMENT)).toEqual({ sectionIds: [], stepIds: [] });
  });
});

describe('what the document gained for speed and for scripts', () => {
  const picture = (extra: Record<string, unknown>) =>
    page([
      {
        id: 'i',
        type: 'image',
        props: {
          src: 'https://img.example/a.png',
          alt: 'A',
          action: none,
          optimize: true,
          ...extra,
        },
      },
    ]);
  it('takes a picture’s own size in whole pixels, within bounds, or none', () => {
    expect(issues(picture({}))).toEqual([]);
    expect(issues(picture({ width: 1600, height: 900 }))).toEqual([]);
    expect(issues(picture({ width: 1, height: 20_000 }))).toEqual([]);
    for (const bad of [0, -1, 1.5, 20_001, '1600'])
      expect(issues(picture({ width: bad, height: 900 }))).toHaveLength(1);
    expect(issues(picture({ width: 1600, height: 0 }))).toHaveLength(1);
  });

  it('takes what a calendar’s link says, and how often a popup opens by itself', () => {
    const calendar = (props: Record<string, unknown>) =>
      page([{ id: 'c', type: 'calendar', props: { calendarId: CALENDAR, ...props } }]);
    expect(issues(calendar({ label: 'Book your free visit' }))).toEqual([]);
    expect(issues(calendar({ label: '   ' }))).toHaveLength(1);
    expect(issues(calendar({ label: 'x'.repeat(201) }))).toHaveLength(1);
    const popup = (props: Record<string, unknown>) =>
      page([], {
        popups: [
          {
            id: 'offer',
            type: 'popup',
            name: 'Offer',
            props: { trigger: 'delay', delaySeconds: 5, width: 'medium', ...props },
            rows: [],
          },
        ],
      });
    expect(issues(popup({}))).toEqual([]);
    expect(issues(popup({ frequency: 'always' }))).toEqual([]);
    expect(issues(popup({ frequency: 'session' }))).toEqual([]);
    expect(issues(popup({ frequency: 'daily' }))).toHaveLength(1);
  });
});

describe('a saved section', () => {
  const [section] = page().sections;
  it('is one section with its own ids checked', () => {
    expect(pageSection.parse(section)).toEqual(section);
    const [first] = everyElement();
    const [twice] = page([first, first]).sections;
    expect(pageSection.safeParse(twice).success).toBe(false);
    expect(
      pageSection.safeParse({ id: 'x', type: 'saved_section', sectionId: SECTION }).success,
    ).toBe(false);
  });
  it('names the steps its actions go to', () => {
    const [linked] = page([
      {
        id: 'b',
        type: 'button',
        props: { label: 'Go', subLabel: '', action: { type: 'step', stepId: STEP } },
      },
      {
        id: 'i',
        type: 'image',
        props: { src: null, alt: '', action: { type: 'step', stepId: STEP }, optimize: true },
      },
    ]).sections;
    expect(pageSectionStepIds(pageSection.parse(linked))).toEqual([STEP]);
  });
});

describe('a code page', () => {
  const code = (files: unknown[]) => ({
    format: 1,
    mode: 'code',
    settings: { seo: EMPTY_PAGE_DOCUMENT.settings.seo },
    files,
  });
  const index = { path: 'index.html', kind: 'text', content: '<h1>Hello</h1>' };
  it('is files with an index.html, text kept in the document and assets named by file id', () => {
    const document = code([
      index,
      { path: 'css/site.css', kind: 'text', content: 'h1{color:red}' },
      { path: 'assets/logo.png', kind: 'asset', fileId: FILE },
    ]);
    expect(pageDocument.parse(document)).toEqual(document);
    expect(pageDocumentReferences(pageDocument.parse(document))).toEqual({
      sectionIds: [],
      stepIds: [],
    });
  });
  it('refuses a missing entry, a repeated path and a path that leaves its folder', () => {
    expect(messages(code([{ path: 'about.html', kind: 'text', content: '' }]))).toEqual([
      'A code page needs an index.html file.',
    ]);
    expect(messages(code([{ path: 'index.html', kind: 'asset', fileId: FILE }]))).toEqual([
      'A code page needs an index.html file.',
    ]);
    expect(messages(code([index, { ...index, path: 'Index.html' }]))).toEqual([
      'Two files have this path.',
    ]);
    for (const path of ['../secret', '/etc/passwd', 'a//b', '.env', 'a/../b', 'a b.html'])
      expect(siteFile.safeParse({ path, kind: 'text', content: '' }).success, path).toBe(false);
  });
});

describe('upgradePageDocument', () => {
  it('returns a document of the current format as it is', () => {
    expect(upgradePageDocument(EMPTY_PAGE_DOCUMENT)).toBe(EMPTY_PAGE_DOCUMENT);
  });
  it('walks the chain of upgraders, one format at a time', () => {
    const steps = {
      1: (document: Record<string, unknown>) => ({ ...document, format: 2, second: true }),
      2: (document: Record<string, unknown>) => ({ ...document, format: 3, third: true }),
    };
    expect(upgradePageDocument({ format: 1 }, steps, 3)).toEqual({
      format: 3,
      second: true,
      third: true,
    });
    expect(upgradePageDocument({ format: 2 }, steps, 3)).toEqual({ format: 3, third: true });
  });
  it('refuses a newer format, a missing one, a gap in the chain and an upgrade that goes nowhere', () => {
    const refusal = (work: () => unknown) => {
      try {
        work();
      } catch (error) {
        expect(error).toBeInstanceOf(PageDocumentFormatError);
        return (error as Error).message;
      }
      return undefined;
    };
    expect(refusal(() => upgradePageDocument({ format: 2 }))).toBe(
      'This page was saved by a newer release (format 2).',
    );
    for (const stored of [null, [], 'x', {}, { format: '1' }, { format: 0 }, { format: 1.5 }])
      expect(refusal(() => upgradePageDocument(stored))).toMatch(/^A page document/);
    expect(refusal(() => upgradePageDocument({ format: 1 }, {}, 2))).toBe(
      'No upgrade from format 1.',
    );
    expect(refusal(() => upgradePageDocument({ format: 1 }, { 1: (d) => d }, 2))).toBe(
      'The upgrade from format 1 went nowhere.',
    );
    expect(refusal(() => upgradePageDocument({ format: 1 }, { 1: () => null }, 2))).toBe(
      'The upgrade from format 1 went nowhere.',
    );
  });
});
