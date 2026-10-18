// The page document: what a funnel step's or a website's page is stored as. It is our own
// format, versioned by `format`, validated here on every save, and tied to no editor's
// private data. A page is one of two kinds: a visual page (sections, rows, columns and
// elements, with popups) or a code page (files). Text is a list of runs, never HTML: only
// the custom code element, the head and body code and a code page's files carry markup or
// script, and those run on the sites origin alone, never the dashboard's.
import * as z from 'zod';

import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** The newest document format this release writes. */
export const PAGE_DOCUMENT_FORMAT = 1;

export const PAGE_DOCUMENT_LIMITS = {
  /** Characters of a document as JSON: under the size a request may carry. */
  json: 524_288,
  sections: 100,
  rows: 20,
  columns: 6,
  children: 50,
  /** How deep layout containers may nest inside a column. */
  containerDepth: 4,
  nodes: 2000,
  popups: 10,
  /** Characters of text in one element. */
  text: 20_000,
  customCss: 100_000,
  /** The most pixels one side of a picture may be said to have. */
  imagePixels: 20_000,
  /** Head code, body code, and one custom code element. */
  code: 50_000,
  metaTags: 30,
  files: 200,
  /** Characters of one text file of a code page. */
  file: 500_000,
} as const;

/** The breakpoints a node's style may be overridden at; the base style is the desktop's. */
export const pageBreakpoints = ['tablet', 'mobile'] as const;
export const pageDevices = ['desktop', 'tablet', 'mobile'] as const;

const nodeId = z
  .string()
  .regex(/^[a-z0-9_-]{1,40}$/, {
    error: 'Use 1 to 40 lowercase letters, numbers, hyphens or underscores.',
  })
  .meta({ description: 'Unique within its document.' });

const MERGE_TOKEN = /^\{\{[a-z][a-z0-9_.]{0,126}\}\}$/;
const hasNoMarkup = (value: string): boolean => !/[\s<>"'`\\]/.test(value);

/** Where a link may go: the web, mail, a phone, this site, this page, or one merge field. */
const linkAddress = z
  .string()
  .min(1)
  .max(2000)
  .refine(
    (value) =>
      MERGE_TOKEN.test(value) ||
      (/^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i.test(value) && hasNoMarkup(value)),
    { error: 'Use a web address, a mailto: or tel: address, a path, an anchor or a merge field.' },
  );

/** Where an image or a file is read from: a web address, a path on this site, or a merge field. */
const mediaAddress = z
  .string()
  .min(1)
  .max(2000)
  .refine(
    (value) =>
      MERGE_TOKEN.test(value) || (/^(https:\/\/|\/(?!\/))/i.test(value) && hasNoMarkup(value)),
    { error: 'Use a secure web address, a path on this site or a merge field.' },
  );

const color = z
  .string()
  .regex(/^(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|transparent)$/, {
    error: 'Use a hex colour such as #1f2937, or transparent.',
  });
const fontName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 -]{0,79}$/, { error: 'Use the name of a font.' });

const edges = z
  .strictObject({
    top: z.number().min(-1000).max(1000),
    right: z.number().min(-1000).max(1000),
    bottom: z.number().min(-1000).max(1000),
    left: z.number().min(-1000).max(1000),
  })
  .partial();
const length = z.strictObject({
  value: z.number().min(0).max(10_000),
  unit: z.enum(['px', '%', 'vw', 'vh']),
});

/**
 * What a node may look like. A closed set of properties with checked values: nothing here
 * is free CSS, so no value can carry markup or a script. Free CSS is the page's customCss.
 */
export const pageStyle = z
  .strictObject({
    margin: edges,
    padding: edges,
    backgroundColor: color,
    backgroundImageUrl: mediaAddress,
    backgroundSize: z.enum(['cover', 'contain', 'auto']),
    textColor: color,
    fontFamily: fontName,
    fontSize: z.number().min(1).max(400),
    fontWeight: z.number().int().min(100).max(900).multipleOf(100),
    lineHeight: z.number().min(0.5).max(5),
    letterSpacing: z.number().min(-10).max(50),
    textAlign: z.enum(['left', 'center', 'right', 'justify']),
    textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']),
    borderWidth: z.number().min(0).max(50),
    borderStyle: z.enum(['none', 'solid', 'dashed', 'dotted']),
    borderColor: color,
    borderRadius: z.number().min(0).max(1000),
    shadow: z.enum(['none', 'small', 'medium', 'large']),
    width: length,
    maxWidth: length,
    minHeight: length,
    opacity: z.number().min(0).max(1),
    align: z.enum(['start', 'center', 'end', 'stretch']),
  })
  .partial()
  .meta({ id: 'SitePageStyle' });
export type PageStyle = z.output<typeof pageStyle>;

const responsive = z.strictObject({ tablet: pageStyle, mobile: pageStyle }).partial().meta({
  description:
    'Style overrides for narrower screens. Each replaces only the properties it names; the base style is the desktop’s.',
});
const hidden = z
  .strictObject({ desktop: z.boolean(), tablet: z.boolean(), mobile: z.boolean() })
  .partial();
const customClass = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}( [A-Za-z_][A-Za-z0-9_-]{0,63}){0,9}$/, {
    error: 'Use up to ten class names separated by single spaces.',
  });

/** What every node of a visual page carries besides its own props. */
const nodeShape = {
  id: nodeId,
  style: pageStyle.optional(),
  responsive: responsive.optional(),
  hidden: hidden.optional(),
  customClass: customClass.optional(),
};

/** What pressing a button, an image or a piece of text does. */
export const pageAction = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('none') }),
    z.strictObject({ type: z.literal('url'), href: linkAddress, newTab: z.boolean() }),
    z.strictObject({ type: z.literal('next_step') }),
    z.strictObject({ type: z.literal('step'), stepId: publicId('site_step') }),
    z.strictObject({ type: z.literal('popup'), popupId: nodeId }),
    z.strictObject({ type: z.literal('anchor'), sectionId: nodeId }),
  ])
  .meta({ id: 'SitePageAction' });
export type PageAction = z.output<typeof pageAction>;

/** A stretch of text with one look. Merge fields are written in the text as {{…}}. */
const textRun = z.strictObject({
  text: z.string().max(PAGE_DOCUMENT_LIMITS.text),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  color: color.optional(),
  link: pageAction.optional(),
});
const text = z
  .array(textRun)
  .max(500)
  .refine(
    (runs) => runs.reduce((sum, run) => sum + run.text.length, 0) <= PAGE_DOCUMENT_LIMITS.text,
    { error: 'Use at most 20,000 characters in one element.' },
  )
  .meta({ id: 'SitePageText' });
export type PageText = z.output<typeof text>;

const headline = z.strictObject({
  ...nodeShape,
  type: z.literal('headline'),
  props: z.strictObject({ text, level: z.int().min(1).max(6) }),
});
const subHeadline = z.strictObject({
  ...nodeShape,
  type: z.literal('sub_headline'),
  props: z.strictObject({ text, level: z.int().min(1).max(6) }),
});
const paragraph = z.strictObject({
  ...nodeShape,
  type: z.literal('paragraph'),
  props: z.strictObject({ text }),
});
const bulletList = z.strictObject({
  ...nodeShape,
  type: z.literal('bullet_list'),
  props: z.strictObject({
    items: z.array(text).min(1).max(100),
    marker: z.enum(['disc', 'number', 'check', 'none']),
  }),
});
/** One side of a picture, in pixels. */
const imagePixels = z.int().min(1).max(PAGE_DOCUMENT_LIMITS.imagePixels);
const image = z.strictObject({
  ...nodeShape,
  type: z.literal('image'),
  props: z.strictObject({
    src: mediaAddress.nullable().meta({ description: 'Null until an image is chosen.' }),
    alt: z.string().max(500),
    action: pageAction,
    optimize: z.boolean(),
    // The picture's own size in pixels, as the file has it: a published page writes both
    // on the image, so the browser keeps its place before it loads.
    width: imagePixels.optional().meta({
      description:
        'The picture’s own width in pixels. With height, a published page keeps the picture’s place while it loads; its style still decides how wide it is shown.',
    }),
    height: imagePixels.optional().meta({ description: 'The picture’s own height in pixels.' }),
  }),
});
const video = z.strictObject({
  ...nodeShape,
  type: z.literal('video'),
  props: z.strictObject({
    source: z.enum(['youtube', 'vimeo', 'file']),
    url: mediaAddress.nullable(),
    autoplay: z.boolean(),
    controls: z.boolean(),
    muted: z.boolean(),
    loop: z.boolean(),
  }),
});
const button = z.strictObject({
  ...nodeShape,
  type: z.literal('button'),
  props: z.strictObject({
    label: z.string().min(1).max(200),
    subLabel: z.string().max(200),
    action: pageAction,
  }),
});
const divider = z.strictObject({
  ...nodeShape,
  type: z.literal('divider'),
  props: z.strictObject({
    thickness: z.number().min(1).max(50),
    line: z.enum(['solid', 'dashed', 'dotted']),
    color: color.nullable(),
  }),
});
const formEmbed = z.strictObject({
  ...nodeShape,
  type: z.literal('form'),
  props: z.strictObject({
    formId: publicId('form').nullable().meta({ description: 'Null until a form is chosen.' }),
  }),
});
const calendarEmbed = z.strictObject({
  ...nodeShape,
  type: z.literal('calendar'),
  props: z.strictObject({
    calendarId: publicId('calendar').nullable(),
    label: z.string().trim().min(1).max(200).optional().meta({
      description: 'What the link to the calendar’s booking page says. Left out: Book a time.',
    }),
  }),
});
const countdown = z.strictObject({
  ...nodeShape,
  type: z.literal('countdown'),
  props: z.strictObject({
    endsAt: timestamp.nullable(),
    whenOver: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('hide') }),
      z.strictObject({ type: z.literal('text'), text: z.string().max(500) }),
      z.strictObject({ type: z.literal('url'), href: linkAddress }),
    ]),
  }),
});
const customCode = z.strictObject({
  ...nodeShape,
  type: z.literal('custom_code'),
  props: z.strictObject({
    code: z.string().max(PAGE_DOCUMENT_LIMITS.code).meta({
      description:
        'HTML and JavaScript, stored as written. It runs only on the published page, on the sites origin.',
    }),
  }),
});
const containerProps = z.strictObject({
  direction: z.enum(['vertical', 'horizontal']),
  gap: z.number().min(0).max(200),
});

type Leaf =
  | z.output<typeof headline>
  | z.output<typeof subHeadline>
  | z.output<typeof paragraph>
  | z.output<typeof bulletList>
  | z.output<typeof image>
  | z.output<typeof video>
  | z.output<typeof button>
  | z.output<typeof divider>
  | z.output<typeof formEmbed>
  | z.output<typeof calendarEmbed>
  | z.output<typeof countdown>
  | z.output<typeof customCode>;

/** A layout container: the one element that holds other elements. */
export interface PageContainer {
  id: string;
  type: 'container';
  props: z.output<typeof containerProps>;
  style?: PageStyle | undefined;
  responsive?: z.output<typeof responsive> | undefined;
  hidden?: z.output<typeof hidden> | undefined;
  customClass?: string | undefined;
  children: PageElement[];
}
export type PageElement = Leaf | PageContainer;

/** The element types of this format, in the order the element panel lists them. */
export const pageElementTypes = [
  'headline',
  'sub_headline',
  'paragraph',
  'bullet_list',
  'image',
  'video',
  'button',
  'divider',
  'form',
  'calendar',
  'countdown',
  'custom_code',
  'container',
] as const;
export type PageElementType = (typeof pageElementTypes)[number];

const container: z.ZodType<PageContainer> = z.strictObject({
  ...nodeShape,
  type: z.literal('container'),
  props: containerProps,
  children: z.array(z.lazy(() => pageElement)).max(PAGE_DOCUMENT_LIMITS.children),
});

/** One element of a visual page. */
export const pageElement: z.ZodType<PageElement> = z
  .union([
    z.discriminatedUnion('type', [
      headline,
      subHeadline,
      paragraph,
      bulletList,
      image,
      video,
      button,
      divider,
      formEmbed,
      calendarEmbed,
      countdown,
      customCode,
    ]),
    container,
  ])
  .meta({ id: 'SitePageElement' });

const column = z.strictObject({
  ...nodeShape,
  type: z.literal('column'),
  props: z.strictObject({
    span: z.int().min(1).max(12).meta({ description: 'Its share of the row, in twelfths.' }),
  }),
  children: z.array(pageElement).max(PAGE_DOCUMENT_LIMITS.children),
});
const row = z
  .strictObject({
    ...nodeShape,
    type: z.literal('row'),
    columns: z.array(column).min(1).max(PAGE_DOCUMENT_LIMITS.columns),
  })
  .meta({ id: 'SitePageRow' });
export type PageRow = z.output<typeof row>;

const sectionShape = z.strictObject({
  ...nodeShape,
  type: z.literal('section'),
  name: z.string().max(120).optional(),
  props: z.strictObject({ width: z.enum(['full', 'wide', 'medium', 'small']) }),
  rows: z.array(row).max(PAGE_DOCUMENT_LIMITS.rows),
});
type SectionShape = z.output<typeof sectionShape>;

/** A section a page refers to instead of holding a copy (a universal or global section). */
const savedSectionRef = z.strictObject({
  id: nodeId,
  type: z.literal('saved_section'),
  sectionId: publicId('site_section'),
});

const popup = z.strictObject({
  id: nodeId,
  type: z.literal('popup'),
  name: z.string().trim().min(1).max(120),
  props: z.strictObject({
    trigger: z.enum(['none', 'delay', 'exit']).meta({
      description:
        'none: opened by an action; delay: some seconds after the page loads; exit: when the pointer leaves the page.',
    }),
    delaySeconds: z.int().min(0).max(3600),
    width: z.enum(['small', 'medium', 'large']),
    frequency: z.enum(['session', 'always']).optional().meta({
      description:
        'How often a popup that opens by itself does so. session (when left out): once in a visit, remembered in the browser tab only. always: on every page view. A popup opened from a link or a button always opens.',
    }),
  }),
  style: pageStyle.optional(),
  rows: z.array(row).max(PAGE_DOCUMENT_LIMITS.rows),
});

const seo = z.strictObject({
  title: z.string().max(200),
  description: z.string().max(500),
  imageUrl: mediaAddress.nullable(),
  noIndex: z.boolean(),
  canonicalUrl: z
    .string()
    .max(2000)
    .regex(/^https:\/\/[^\s<>"'`\\]+$/)
    .nullable(),
  meta: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[A-Za-z0-9:_.-]{1,100}$/),
        content: z.string().max(1000),
      }),
    )
    .max(PAGE_DOCUMENT_LIMITS.metaTags),
});

const code = z.string().max(PAGE_DOCUMENT_LIMITS.code);
const visualSettings = z.strictObject({
  seo,
  background: z.strictObject({
    color: color.nullable(),
    imageUrl: mediaAddress.nullable(),
    size: z.enum(['cover', 'contain', 'auto']),
    position: z.enum(['center', 'top', 'bottom', 'left', 'right']),
    repeat: z.boolean(),
  }),
  typography: z.strictObject({
    headingFont: fontName.nullable(),
    bodyFont: fontName.nullable(),
    textColor: color.nullable(),
    linkColor: color.nullable(),
  }),
  // A stylesheet cannot contain "<": nothing in it can close its own style element.
  customCss: z
    .string()
    .max(PAGE_DOCUMENT_LIMITS.customCss)
    .refine((css) => !css.includes('<'), { error: 'A stylesheet cannot contain "<".' }),
  headCode: code,
  bodyCode: code,
});

interface Problem {
  readonly path: (string | number)[];
  readonly message: string;
}

/** The nodes of some rows, with the problems only the whole tree shows. */
function walkRows(
  rows: readonly PageRow[],
  path: (string | number)[],
  seen: Map<string, number>,
  actions: { action: PageAction; path: (string | number)[] }[],
  problems: Problem[],
): void {
  const visit = (id: string, at: (string | number)[]) => {
    seen.set(id, (seen.get(id) ?? 0) + 1);
    if (seen.get(id) === 2)
      problems.push({ path: [...at, 'id'], message: `Two nodes are called ${id}.` });
  };
  const runs = (runsOf: PageText, at: (string | number)[]) => {
    runsOf.forEach((run, index) => {
      if (run.link !== undefined) actions.push({ action: run.link, path: [...at, index, 'link'] });
    });
  };
  const element = (node: PageElement, at: (string | number)[], depth: number): void => {
    visit(node.id, at);
    if (node.type === 'container') {
      if (depth >= PAGE_DOCUMENT_LIMITS.containerDepth)
        problems.push({
          path: at,
          message: `Nest containers at most ${String(PAGE_DOCUMENT_LIMITS.containerDepth)} deep.`,
        });
      else
        node.children.forEach((child, index) => {
          element(child, [...at, 'children', index], depth + 1);
        });
      return;
    }
    if (node.type === 'headline' || node.type === 'sub_headline' || node.type === 'paragraph')
      runs(node.props.text, [...at, 'props', 'text']);
    if (node.type === 'bullet_list')
      node.props.items.forEach((item, index) => {
        runs(item, [...at, 'props', 'items', index]);
      });
    if (node.type === 'image' || node.type === 'button')
      actions.push({ action: node.props.action, path: [...at, 'props', 'action'] });
  };
  rows.forEach((each, rowIndex) => {
    const rowPath = [...path, rowIndex];
    visit(each.id, rowPath);
    each.columns.forEach((cell, columnIndex) => {
      const cellPath = [...rowPath, 'columns', columnIndex];
      visit(cell.id, cellPath);
      cell.children.forEach((child, index) => {
        element(child, [...cellPath, 'children', index], 1);
      });
    });
  });
}

const report = (context: z.RefinementCtx, problems: readonly Problem[]): void => {
  for (const { path, message } of problems) context.addIssue({ code: 'custom', path, message });
};

/** One section as a saved section or a section template holds it. */
export const pageSection = sectionShape
  .superRefine((section, context) => {
    const seen = new Map<string, number>([[section.id, 1]]);
    const problems: Problem[] = [];
    const actions: { action: PageAction; path: (string | number)[] }[] = [];
    walkRows(section.rows, ['rows'], seen, actions, problems);
    if (seen.size > PAGE_DOCUMENT_LIMITS.nodes)
      problems.push({ path: ['rows'], message: 'This section has too many elements.' });
    report(context, problems);
  })
  .meta({ id: 'SitePageSection' });
export type PageSection = SectionShape;

const visualPage = z
  .strictObject({
    format: z.literal(PAGE_DOCUMENT_FORMAT),
    mode: z.literal('visual'),
    settings: visualSettings,
    sections: z
      .array(z.discriminatedUnion('type', [sectionShape, savedSectionRef]))
      .max(PAGE_DOCUMENT_LIMITS.sections),
    popups: z.array(popup).max(PAGE_DOCUMENT_LIMITS.popups),
  })
  .superRefine((page, context) => {
    const seen = new Map<string, number>();
    const problems: Problem[] = [];
    const actions: { action: PageAction; path: (string | number)[] }[] = [];
    const own = (id: string, path: (string | number)[]) => {
      seen.set(id, (seen.get(id) ?? 0) + 1);
      if (seen.get(id) === 2)
        problems.push({ path: [...path, 'id'], message: `Two nodes are called ${id}.` });
    };
    page.sections.forEach((section, index) => {
      own(section.id, ['sections', index]);
      if (section.type === 'section')
        walkRows(section.rows, ['sections', index, 'rows'], seen, actions, problems);
    });
    page.popups.forEach((each, index) => {
      own(each.id, ['popups', index]);
      walkRows(each.rows, ['popups', index, 'rows'], seen, actions, problems);
    });
    if (seen.size > PAGE_DOCUMENT_LIMITS.nodes)
      problems.push({
        path: ['sections'],
        message: `A page holds at most ${String(PAGE_DOCUMENT_LIMITS.nodes)} sections, rows, columns and elements.`,
      });
    const popups = new Set(page.popups.map((each) => each.id));
    const sections = new Set(page.sections.map((section) => section.id));
    for (const { action, path } of actions) {
      if (action.type === 'popup' && !popups.has(action.popupId))
        problems.push({ path: [...path, 'popupId'], message: 'This page has no such popup.' });
      if (action.type === 'anchor' && !sections.has(action.sectionId))
        problems.push({ path: [...path, 'sectionId'], message: 'This page has no such section.' });
    }
    report(context, problems);
  });

const filePath = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/, {
    error: 'Use letters, numbers, dots, hyphens and underscores, with / between folders.',
  });

/**
 * One file of a code page or of a site's shared files: text kept in the document, or an
 * uploaded asset named by its file id.
 */
export const siteFile = z
  .discriminatedUnion('kind', [
    z.strictObject({
      path: filePath,
      kind: z.literal('text'),
      content: z.string().max(PAGE_DOCUMENT_LIMITS.file),
    }),
    z.strictObject({ path: filePath, kind: z.literal('asset'), fileId: publicId('file') }),
  ])
  .meta({ id: 'SiteFile' });
export type SiteFile = z.output<typeof siteFile>;

const codePage = z
  .strictObject({
    format: z.literal(PAGE_DOCUMENT_FORMAT),
    mode: z.literal('code'),
    settings: z.strictObject({ seo }),
    files: z.array(siteFile).min(1).max(PAGE_DOCUMENT_LIMITS.files),
  })
  .superRefine((page, context) => {
    const paths = page.files.map((file) => file.path.toLowerCase());
    paths.forEach((path, index) => {
      if (paths.indexOf(path) !== index)
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: 'Two files have this path.',
        });
    });
    const entry = page.files.find((file) => file.path === 'index.html');
    if (entry?.kind !== 'text')
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'A code page needs an index.html file.',
      });
  });

const withinSize = (document: unknown): boolean =>
  JSON.stringify(document).length <= PAGE_DOCUMENT_LIMITS.json;

/** A page, in the current format: a visual page or a code page. */
export const pageDocument = z
  .discriminatedUnion('mode', [visualPage, codePage])
  .refine(withinSize, { error: 'This page is too large to save. Remove some content.' })
  .meta({
    id: 'SitePageDocument',
    description:
      'A page in the current document format: a visual page of sections, rows, columns and elements, or a code page of files.',
  });
export type PageDocument = z.output<typeof pageDocument>;
export type VisualPageDocument = z.output<typeof visualPage>;
export type CodePageDocument = z.output<typeof codePage>;

/**
 * One step from each older format to the next. Format 1 is the first, so there is none
 * yet; a format 2 adds `1: (document) => …` here and nothing else changes for readers.
 */
const upgraders: Readonly<Record<number, (document: Record<string, unknown>) => unknown>> = {};

/** Why a stored document cannot be read by this release. */
export class PageDocumentFormatError extends Error {
  override readonly name = 'PageDocumentFormatError';
}

/**
 * A stored document of any format this release knows, as the current format. A document
 * written by a newer release is refused, never guessed at; so is one that names no format.
 */
export function upgradePageDocument(
  stored: unknown,
  steps: Readonly<Record<number, (document: Record<string, unknown>) => unknown>> = upgraders,
  current: number = PAGE_DOCUMENT_FORMAT,
): unknown {
  let document = stored;
  for (;;) {
    if (typeof document !== 'object' || document === null || Array.isArray(document))
      throw new PageDocumentFormatError('A page document is an object.');
    const { format } = document as { format?: unknown };
    if (typeof format !== 'number' || !Number.isInteger(format) || format < 1)
      throw new PageDocumentFormatError('A page document names its format.');
    if (format > current)
      throw new PageDocumentFormatError(
        `This page was saved by a newer release (format ${String(format)}).`,
      );
    if (format === current) return document;
    const step = steps[format];
    if (step === undefined)
      throw new PageDocumentFormatError(`No upgrade from format ${String(format)}.`);
    const next = step(document as Record<string, unknown>);
    const upgraded =
      typeof next === 'object' && next !== null ? (next as { format?: unknown }).format : undefined;
    // An upgrader that does not move the document forward would never end.
    if (typeof upgraded !== 'number' || upgraded <= format)
      throw new PageDocumentFormatError(`The upgrade from format ${String(format)} went nowhere.`);
    document = next;
  }
}

const emptySeo = {
  title: '',
  description: '',
  imageUrl: null,
  noIndex: false,
  canonicalUrl: null,
  meta: [],
};

/** A new visual page: no sections yet. */
export const EMPTY_PAGE_DOCUMENT: VisualPageDocument = {
  format: PAGE_DOCUMENT_FORMAT,
  mode: 'visual',
  settings: {
    seo: emptySeo,
    background: { color: null, imageUrl: null, size: 'cover', position: 'center', repeat: false },
    typography: { headingFont: null, bodyFont: null, textColor: null, linkColor: null },
    customCss: '',
    headCode: '',
    bodyCode: '',
  },
  sections: [],
  popups: [],
};

/** The saved sections and steps a document names, for whoever must check or remap them. */
export function pageDocumentReferences(document: PageDocument): {
  sectionIds: string[];
  stepIds: string[];
} {
  if (document.mode === 'code') return { sectionIds: [], stepIds: [] };
  const sectionIds = new Set<string>();
  const actions: { action: PageAction; path: (string | number)[] }[] = [];
  for (const section of document.sections) {
    if (section.type === 'saved_section') sectionIds.add(section.sectionId);
    else walkRows(section.rows, [], new Map(), actions, []);
  }
  for (const each of document.popups) walkRows(each.rows, [], new Map(), actions, []);
  const stepIds = new Set<string>();
  for (const { action } of actions) if (action.type === 'step') stepIds.add(action.stepId);
  return { sectionIds: [...sectionIds], stepIds: [...stepIds] };
}

/** The steps a saved section's own actions name. */
export function pageSectionStepIds(section: PageSection): string[] {
  const actions: { action: PageAction; path: (string | number)[] }[] = [];
  walkRows(section.rows, [], new Map(), actions, []);
  return [
    ...new Set(actions.flatMap(({ action }) => (action.type === 'step' ? [action.stepId] : []))),
  ];
}
