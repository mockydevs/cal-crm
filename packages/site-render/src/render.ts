// A page document as static HTML and CSS: what a visitor is sent. A pure function of the
// document and its context, so the same page always renders to the same bytes. It writes no
// inline script and no inline style attribute: every look is a rule of the page's one
// stylesheet, which the page's policy names by its digest.
//
// A page is HTML and CSS, and reads and works with no script at all. Four things on a page
// may load one, each its own small file of the CRM's, and only a page that holds the thing
// names the file. A fifth is not the page's own but its site's: a site
// that takes leads anywhere may keep how a visitor arrived from page to page (`arrival`),
// and then every page of it names that one. The four:
// - a form is shown by the CRM's own form embed (one script tag, from the CRM's address);
// - a countdown is written with the time left as it is now, to the minute, and the moment
//   it ends; its script makes it tick and does at the end what the page was set to do;
// - a popup opens when a link on the page points at it (the :target rule); its script
//   opens one after a delay or when the visitor is about to leave, and makes any open
//   popup a dialog a keyboard and a screen reader can use.
// Custom code, and a page's or a site's head and body code, are never written here. They
// are a tenant's script and run only on a connected domain.
import type {
  PageAction,
  PageDocument,
  PageElement,
  PageRow,
  PageSection,
  PageText,
} from '@repo/contracts';

import { countdownStep, countdownText } from './countdown.js';
import { BASE_CSS, baseCss, Stylesheet, type CssContext } from './css.js';
import {
  attribute,
  classNames,
  cssColor,
  cssFont,
  cssNumber,
  cssUrl,
  escapeHtml,
  linkAddress,
  mediaAddress,
  mergeText,
  nodeId,
  styleText,
  type MergeValues,
} from './escape.js';
import { VIDEO_FRAME_ORIGINS, videoEmbedUrl } from './video.js';

/**
 * Where the CRM's own small page scripts are loaded from, as paths on the page's own
 * address: each is named on a page only when the page holds what it is for, and only when
 * it is given here. An address carries the digest of its file, so it never changes what
 * it names.
 */
export interface PageScripts {
  /** Keeps how the visitor arrived, from page to page of a site that takes leads. */
  readonly arrival?: string | undefined;
  /** Makes a countdown tick. */
  readonly countdown?: string | undefined;
  /** Opens popups by themselves and makes an open popup a proper dialog. */
  readonly popup?: string | undefined;
}

export interface RenderContext {
  /** Where the site answers, without a slash at the end: `/s/<key>` on the install's own address. */
  readonly siteBase: string;
  /** What the tab is called when the page's own SEO title is empty: the step's name. */
  readonly title: string;
  /** The page's own full address, for its canonical link and its social card. */
  readonly canonicalUrl?: string | undefined;
  readonly faviconUrl?: string | null | undefined;
  /** The language of the page, as the html element names it. */
  readonly lang?: string | undefined;
  /** Whether search engines may list the page. Never on the install's own address. */
  readonly index: boolean;
  /** A draft shown to its editor: custom code is named where it would run. */
  readonly preview?: boolean | undefined;
  /** The steps of the site a visitor can reach, by public id, as their paths. */
  readonly steps: ReadonlyMap<string, string>;
  /** The path of the funnel's next step, when there is one a visitor can reach. */
  readonly nextStepPath?: string | undefined;
  /** The saved sections the page refers to, by public id. */
  readonly sections: ReadonlyMap<string, PageSection>;
  /** The forms the page may show, by public id, as their public keys. */
  readonly forms: ReadonlyMap<string, string>;
  /** Where the form embed is loaded from, on the page's own address. */
  readonly formScriptUrl: string;
  /** The booking pages of the calendars the page may link to, by public id. */
  readonly calendars: ReadonlyMap<string, string>;
  /** What each merge field stands for. A field with no value shows nothing. */
  readonly mergeValues?: MergeValues | undefined;
  /** The CRM's small page scripts this server has to send. Left out: the page names none. */
  readonly scripts?: PageScripts | undefined;
  /**
   * The site keeps how a visitor arrived between its pages: given by whoever knows the
   * site, only for one that takes a lead somewhere (a form or a calendar on any page of it)
   * and has not switched this off. `site` names the site in the visitor's tab; `always`
   * keeps it also for a visitor whose browser sends the privacy signal. Left out, the page
   * names no such script.
   */
  readonly arrival?: { readonly site: string; readonly always: boolean } | undefined;
  /** The moment of rendering, in milliseconds: decides whether a countdown is over. */
  readonly now: number;
  /**
   * Which of the base rules the page's stylesheet holds. `used`: only those of the things
   * on the page, which is what a visitor is sent. `all` (when left out): every one, which
   * is what the editor's canvas starts from, since it draws what is not on the page yet.
   */
  readonly baseRules?: 'all' | 'used' | undefined;
}

/** What a page loads besides itself, for the policy it is served with. */
export interface PageNeeds {
  /** The form embed: one script of the CRM's own, which calls the CRM's own API. */
  readonly forms: boolean;
  /** The origins of the frames the page shows (video players). */
  readonly frames: readonly string[];
  /** A video file played by the page itself. */
  readonly media: boolean;
  /**
   * The CRM's own small scripts the page names, by their addresses, in the order of the
   * page's head. Empty for a page with no countdown running and no popup, on a site that
   * does not keep its visitors' arrival.
   */
  readonly scripts: readonly string[];
}

export interface RenderedPage {
  /** The whole document, from its doctype. */
  readonly html: string;
  /** The text of its one style element, exactly as the page holds it. */
  readonly css: string;
  readonly needs: PageNeeds;
}

interface State {
  readonly context: RenderContext;
  readonly css: CssContext;
  readonly sheet: Stylesheet;
  readonly popups: ReadonlySet<string>;
  readonly anchors: ReadonlySet<string>;
  readonly frames: Set<string>;
  /** What the page holds that a base rule is written for (css.ts, RULES). */
  readonly used: Set<string>;
  forms: boolean;
  media: boolean;
  /** The small scripts the page was found to need (PageScripts), by name. */
  readonly scripts: Set<keyof PageScripts>;
  /** The pictures written so far: the first is the one fetched before the others. */
  images: number;
  /**
   * Whether what is being written is in the page's first section, which is what a
   * visitor sees first: its pictures are fetched at once, the rest when scrolled to.
   */
  first: boolean;
}

const FORM_KEY = /^[A-Za-z0-9_-]{16,64}$/;
/** What names a site in a visitor's tab: its public key, and nothing an attribute could not hold. */
const SITE_KEY = /^[a-z0-9]{1,64}$/;
/** A script of ours, where the server serves them: a path on this address, nothing else. */
const SCRIPT_PATH = /^(\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,80}){1,6}\.js$/;
const PIXELS = 20_000;
/** One side of a picture in whole pixels, or undefined for anything else. */
const pixels = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= PIXELS
    ? value
    : undefined;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A class attribute, or nothing when no name is given. Each name is noted as used. */
function classes(state: State, ...names: readonly string[]): string {
  const given = names.filter((name) => name !== '');
  for (const name of given) state.used.add(name);
  return given.length === 0 ? '' : attribute('class', given.join(' '));
}

/** An opening link tag, noted as a link on the page. */
function anchor(state: State, attributes: string): string {
  state.used.add('link');
  return `<a${attributes}>`;
}

/** Where an action leads, as the attributes of a link, or undefined when it leads nowhere. */
function linkAttributes(action: PageAction | undefined, state: State): string | undefined {
  const { context } = state;
  if (action === undefined) return undefined;
  switch (action.type) {
    case 'none':
      return undefined;
    case 'url': {
      const href = linkAddress(action.href, context.siteBase, context.mergeValues);
      if (href === undefined) return undefined;
      return (
        attribute('href', href) +
        (action.newTab
          ? attribute('target', '_blank') + attribute('rel', 'noopener noreferrer')
          : '')
      );
    }
    case 'next_step':
      return context.nextStepPath === undefined
        ? undefined
        : attribute('href', `${context.siteBase}/${context.nextStepPath}`);
    case 'step': {
      const path = context.steps.get(action.stepId);
      return path === undefined ? undefined : attribute('href', `${context.siteBase}/${path}`);
    }
    case 'popup':
      return state.popups.has(action.popupId) ? attribute('href', `#${action.popupId}`) : undefined;
    case 'anchor':
      return state.anchors.has(action.sectionId)
        ? attribute('href', `#${action.sectionId}`)
        : undefined;
  }
}

function runs(text: PageText, state: State): string {
  return text
    .map((run) => {
      // A line break in the text is a line break on the page.
      let html = escapeHtml(mergeText(run.text, state.context.mergeValues)).replaceAll(
        '\n',
        '<br>',
      );
      if (html === '') return '';
      if (run.bold === true) html = `<strong>${html}</strong>`;
      if (run.italic === true) html = `<em>${html}</em>`;
      if (run.underline === true) html = `<u>${html}</u>`;
      if (run.strike === true) html = `<s>${html}</s>`;
      const color = cssColor(run.color);
      let look = '';
      if (color !== undefined) {
        const name = state.sheet.name();
        state.sheet.rule(`.${name}`, [`color:${color}`]);
        look = classes(state, name);
      }
      const link = linkAttributes(run.link, state);
      if (link !== undefined) return `${anchor(state, look + link)}${html}</a>`;
      return look === '' ? html : `<span${look}>${html}</span>`;
    })
    .join('');
}

const level = (value: unknown): string =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6
    ? String(value)
    : '2';

function countdown(
  node: Extract<PageElement, { type: 'countdown' }>,
  /** Its class attribute, asked for only once it is known to have something to say. */
  shown: () => string,
  state: State,
): string {
  const { endsAt, whenOver } = node.props;
  const end = endsAt === null ? Number.NaN : Date.parse(endsAt);
  if (!Number.isFinite(end)) return '';
  const text = whenOver.type === 'text' ? mergeText(whenOver.text, state.context.mergeValues) : '';
  const href =
    whenOver.type === 'url'
      ? linkAddress(whenOver.href, state.context.siteBase, state.context.mergeValues)
      : undefined;
  if (state.context.now < end) {
    const date = new Date(end);
    const clock = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
    const written = `${String(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ''} ${String(date.getUTCFullYear())}, ${clock} UTC`;
    // What the end does is written on the element, for the script that is there when it
    // comes: the same three outcomes this function writes once the end has passed.
    const over =
      text !== ''
        ? attribute('data-cd', 'text') + attribute('data-cd-text', text)
        : href !== undefined
          ? attribute('data-cd', 'url') + attribute('data-cd-href', href)
          : attribute('data-cd', 'hide');
    // The link the script writes at the end is styled as every link of the page is.
    if (href !== undefined) state.used.add('link');
    state.scripts.add('countdown');
    // The time left as it is now, to the minute: true for as long as this page is kept,
    // which is until the minute turns (pageChangesAt). A timer is not read out each time
    // it changes (ARIA: role timer is a live region that is off unless asked for).
    return (
      `<p${shown()}${over}><span role="timer">${countdownText(end - state.context.now, false)}</span> left, ` +
      `ends <time${attribute('datetime', date.toISOString())}>${written}</time></p>`
    );
  }
  if (text !== '') return `<p${shown()}>${escapeHtml(text)}</p>`;
  if (href !== undefined)
    return `<p${shown()}>${anchor(state, attribute('href', href))}Continue</a></p>`;
  return '';
}

function video(node: Extract<PageElement, { type: 'video' }>, state: State): string {
  const { props } = node;
  const own = classNames(node.customClass);
  if (props.source === 'file') {
    const src = mediaAddress(props.url, state.context.siteBase, state.context.mergeValues);
    if (src === undefined) return '';
    state.media = true;
    state.used.add('media');
    const name = state.sheet.own(node, state.css);
    return (
      `<video${classes(state, 'vf', name, own)}${attribute('src', src)}` +
      // A video nobody can start must start itself; one that starts itself must be silent.
      (props.controls || !props.autoplay ? ' controls' : '') +
      (props.autoplay ? ' autoplay' : '') +
      (props.muted || props.autoplay ? ' muted' : '') +
      (props.loop ? ' loop' : '') +
      ' playsinline preload="metadata"></video>'
    );
  }
  const src = videoEmbedUrl(props);
  if (src === undefined) return '';
  state.frames.add(VIDEO_FRAME_ORIGINS[props.source]);
  state.used.add('media');
  const name = state.sheet.own(node, state.css);
  // The frame itself is the element: it keeps its own shape (css.ts, `.vd`).
  return (
    `<iframe${classes(state, 'vd', name, own)}${attribute('src', src)} title="Video"` +
    ' loading="lazy" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen' +
    ' referrerpolicy="strict-origin-when-cross-origin"></iframe>'
  );
}

function element(node: PageElement, state: State): string {
  const { context, sheet } = state;
  const own = classNames(node.customClass);
  /** The node's own rules, under a class of the sheet's choosing: none without a look. */
  const look = (extra: readonly string[] = []): string => sheet.own(node, state.css, extra);
  switch (node.type) {
    case 'headline':
    case 'sub_headline': {
      const name = look();
      const tag = `h${level(node.props.level)}`;
      const kind = node.type === 'headline' ? 'hl' : 'sh';
      state.used.add('text');
      return `<${tag}${classes(state, kind, name, own)}>${runs(node.props.text, state)}</${tag}>`;
    }
    case 'paragraph': {
      const name = look();
      state.used.add('text');
      return `<p${classes(state, 'pg', name, own)}>${runs(node.props.text, state)}</p>`;
    }
    case 'bullet_list': {
      const name = look();
      const tag = node.props.marker === 'number' ? 'ol' : 'ul';
      const marker =
        node.props.marker === 'check' ? 'ls-check' : node.props.marker === 'none' ? 'ls-none' : '';
      // A list without markers is still a list to whoever has it read out.
      const role = marker === '' ? '' : ' role="list"';
      if (marker !== '') state.used.add('ls-mark');
      state.used.add('text');
      const items = node.props.items.map((item) => `<li>${runs(item, state)}</li>`).join('');
      return `<${tag}${classes(state, 'ls', marker, name, own)}${role}>${items}</${tag}>`;
    }
    case 'image': {
      const src = mediaAddress(node.props.src, context.siteBase, context.mergeValues);
      if (src === undefined) return '';
      const name = look();
      state.images += 1;
      state.used.add('media').add('image');
      // What a visitor sees first is fetched at once, and the first picture of all before
      // anything else; a picture further down waits until it is scrolled to.
      const fetch = !state.first
        ? ' loading="lazy"'
        : state.images === 1
          ? ' fetchpriority="high"'
          : '';
      // The picture's own size, when the document knows it: the browser works out the
      // shape from the two and keeps the picture's place before it has loaded, while the
      // stylesheet still decides how wide it is shown (`img{height:auto}` keeps the shape).
      const width = pixels(node.props.width);
      const height = pixels(node.props.height);
      const size =
        width === undefined || height === undefined
          ? ''
          : attribute('width', String(width)) + attribute('height', String(height));
      const image =
        `<img${classes(state, 'im', name, own)}${attribute('src', src)}` +
        attribute('alt', mergeText(node.props.alt, context.mergeValues)) +
        `${size}${fetch} decoding="async">`;
      const link = linkAttributes(node.props.action, state);
      return link === undefined ? image : `${anchor(state, link)}${image}</a>`;
    }
    case 'video':
      return video(node, state);
    case 'button': {
      const name = look();
      const label = escapeHtml(mergeText(node.props.label, context.mergeValues));
      const sub = escapeHtml(mergeText(node.props.subLabel, context.mergeValues));
      // The label is the button's own text; only a second line is an element of its own.
      const inner = `${label}${sub === '' ? '' : `<span${classes(state, 'bs')}>${sub}</span>`}`;
      const link = linkAttributes(node.props.action, state);
      return link === undefined
        ? `<span${classes(state, 'bt', name, own)}>${inner}</span>`
        : `${anchor(state, classes(state, 'bt', name, own) + link)}${inner}</a>`;
    }
    case 'divider': {
      const thickness = cssNumber(node.props.thickness, 1, 50) ?? '1';
      const line = ['solid', 'dashed', 'dotted'].includes(node.props.line)
        ? node.props.line
        : 'solid';
      const color = cssColor(node.props.color) ?? 'currentColor';
      const name = look([`border-top:${thickness}px ${line} ${color}`]);
      return `<hr${classes(state, 'dv', name, own)}>`;
    }
    case 'form': {
      const key = node.props.formId === null ? undefined : context.forms.get(node.props.formId);
      if (key === undefined || !FORM_KEY.test(key)) return '';
      const name = look();
      state.forms = true;
      return (
        `<div${classes(state, 'fm', name, own)}>` +
        `<script async${attribute('src', context.formScriptUrl)}${attribute('data-form-key', key)}></script>` +
        '<noscript>This form needs JavaScript to be shown.</noscript></div>'
      );
    }
    case 'calendar': {
      const url =
        node.props.calendarId === null ? undefined : context.calendars.get(node.props.calendarId);
      const href = linkAddress(url, context.siteBase);
      if (href === undefined) return '';
      const name = look();
      const label =
        typeof node.props.label === 'string'
          ? mergeText(node.props.label, context.mergeValues).trim()
          : '';
      return `${anchor(state, classes(state, 'bt', name, own) + attribute('href', href))}${escapeHtml(label === '' ? 'Book a time' : label)}</a>`;
    }
    case 'countdown': {
      // Its rules are written only when it has something to say.
      return countdown(
        node,
        () => {
          state.used.add('text');
          return classes(state, 'cd', look(), own);
        },
        state,
      );
    }
    case 'custom_code':
      // A tenant's markup and script: never written on an address tenants share.
      if (context.preview !== true) return '';
      state.used.add('text');
      return `<p${classes(state, 'cc')}>Custom code runs on your connected domain.</p>`;
    case 'container': {
      const gap = cssNumber(node.props.gap, 0, 200) ?? '0';
      // No gap is what a container has before any rule.
      const name = look(gap === '0' ? [] : [`gap:${gap}px`]);
      const direction = node.props.direction === 'horizontal' ? 'k-h' : 'k-v';
      const children = node.children.map((child) => element(child, state)).join('');
      return `<div${classes(state, 'kt', direction, name, own)}>${children}</div>`;
    }
  }
}

function rows(list: readonly PageRow[], state: State): string {
  return list
    .map((row) => {
      const rowName = state.sheet.own(row, state.css);
      const columns = row.columns
        .map((column) => {
          const span = cssNumber(column.props.span, 1, 12) ?? '12';
          const name = state.sheet.own(column, state.css, [`flex:${span} 1 0%`]);
          const children = column.children.map((child) => element(child, state)).join('');
          return `<div${classes(state, 'cl', name, classNames(column.customClass))}>${children}</div>`;
        })
        .join('');
      return `<div${classes(state, 'rw', rowName, classNames(row.customClass))}>${columns}</div>`;
    })
    .join('');
}

const WIDTHS = new Set(['wide', 'medium', 'small']);

function section(given: PageSection, anchor: string | undefined, state: State): string {
  const name = state.sheet.own(given, state.css);
  // As wide as it says, by a class of the section itself: `full` is what a section is.
  const width = WIDTHS.has(given.props.width) ? `sc-${given.props.width}` : '';
  const id = anchor === undefined ? '' : attribute('id', anchor);
  return (
    `<section${id}${classes(state, 'sc', width, name, classNames(given.customClass))}>` +
    `${rows(given.rows, state)}</section>`
  );
}

function pageRules(document: Extract<PageDocument, { mode: 'visual' }>, state: State): void {
  const { background, typography } = document.settings;
  const body: string[] = [];
  const color = cssColor(background.color);
  if (color !== undefined) body.push(`background-color:${color}`);
  const image = mediaAddress(background.imageUrl, state.css.siteBase, state.css.mergeValues);
  if (image !== undefined) {
    body.push(`background-image:${cssUrl(image)}`);
    if (['cover', 'contain', 'auto'].includes(background.size))
      body.push(`background-size:${background.size}`);
    if (['center', 'top', 'bottom', 'left', 'right'].includes(background.position))
      body.push(`background-position:${background.position}`);
    body.push(`background-repeat:${background.repeat ? 'repeat' : 'no-repeat'}`);
  }
  const font = cssFont(typography.bodyFont);
  if (font !== undefined) body.push(`font-family:${font}`);
  const text = cssColor(typography.textColor);
  if (text !== undefined) body.push(`color:${text}`);
  state.sheet.rule('body', body);
  const heading = cssFont(typography.headingFont);
  if (heading !== undefined) state.sheet.rule('h1,h2,h3,h4,h5,h6', [`font-family:${heading}`]);
  const link = cssColor(typography.linkColor);
  if (link !== undefined) state.sheet.rule('a:not(.bt)', [`color:${link}`]);
}

/** The names a page's own meta tags may not take: the page writes those itself. */
const RESERVED_META = new Set(['viewport', 'description', 'robots', 'googlebot', 'referrer']);
const META_NAME = /^[A-Za-z0-9:_.-]{1,100}$/;
const PROPERTY_META = /^(og|article|fb|music|video|book|profile):/;

function head(
  document: Extract<PageDocument, { mode: 'visual' }>,
  context: RenderContext,
  css: string,
  scripts: readonly { readonly src: string; readonly attributes: string }[],
): string {
  const { seo } = document.settings;
  const merge = (text: string): string => mergeText(text, context.mergeValues);
  const title = merge(seo.title).trim() || context.title;
  const description = merge(seo.description).trim();
  // A canonical address the page chose is used only if it is a secure web address.
  const chosen = linkAddress(seo.canonicalUrl, context.siteBase);
  const own = linkAddress(context.canonicalUrl, context.siteBase);
  const canonical =
    chosen?.startsWith('https://') === true
      ? chosen
      : own !== undefined && /^https?:\/\//i.test(own)
        ? own
        : undefined;
  const image = mediaAddress(seo.imageUrl, context.siteBase, context.mergeValues);
  const absoluteImage = image?.startsWith('https://') === true ? image : undefined;
  const favicon = linkAddress(context.faviconUrl, context.siteBase);
  const meta = (key: 'name' | 'property', name: string, content: string): string =>
    `<meta${attribute(key, name)}${attribute('content', content)}>`;
  const lines = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
  ];
  if (description !== '') lines.push(meta('name', 'description', description));
  if (canonical !== undefined) lines.push(`<link rel="canonical"${attribute('href', canonical)}>`);
  if (!context.index || seo.noIndex) lines.push('<meta name="robots" content="noindex">');
  lines.push(meta('property', 'og:type', 'website'), meta('property', 'og:title', title));
  if (description !== '') lines.push(meta('property', 'og:description', description));
  if (canonical !== undefined) lines.push(meta('property', 'og:url', canonical));
  if (absoluteImage !== undefined) {
    lines.push(meta('property', 'og:image', absoluteImage));
    lines.push(meta('name', 'twitter:card', 'summary_large_image'));
  }
  for (const each of seo.meta) {
    if (!META_NAME.test(each.name) || RESERVED_META.has(each.name.toLowerCase())) continue;
    lines.push(
      meta(PROPERTY_META.test(each.name) ? 'property' : 'name', each.name, merge(each.content)),
    );
  }
  if (favicon?.startsWith('https://') === true)
    lines.push(`<link rel="icon"${attribute('href', favicon)}>`);
  lines.push(`<style>${css}</style>`);
  // After the stylesheet, and deferred: fetched beside the page and run once it is
  // parsed, so no script of ours ever holds up what a visitor reads.
  for (const each of scripts)
    lines.push(`<script defer${attribute('src', each.src)}${each.attributes}></script>`);
  return lines.join('\n');
}

/**
 * The page as a whole document, or undefined for a page this renderer cannot show: a code
 * page, whose files are served as they are once code mode exists.
 */
export function renderPage(
  document: PageDocument,
  context: RenderContext,
): RenderedPage | undefined {
  if (document.mode !== 'visual') return undefined;
  const sheet = new Stylesheet();
  const resolved = document.sections.flatMap((each) => {
    if (each.type === 'section') return [{ id: each.id, section: each }];
    const saved = context.sections.get(each.sectionId);
    // A saved section that is gone leaves nothing behind; publishing refuses it earlier.
    return saved === undefined ? [] : [{ id: each.id, section: saved }];
  });
  const state: State = {
    context,
    css: { siteBase: context.siteBase, mergeValues: context.mergeValues },
    sheet,
    popups: new Set(document.popups.flatMap((popup) => nodeId(popup.id) ?? [])),
    anchors: new Set(resolved.flatMap((each) => nodeId(each.id) ?? [])),
    frames: new Set(),
    used: new Set(),
    forms: false,
    media: false,
    scripts: new Set(),
    images: 0,
    first: true,
  };
  pageRules(document, state);
  const main = resolved
    .map((each, index) => {
      state.first = index === 0;
      return section(each.section, state.anchors.has(each.id) ? each.id : undefined, state);
    })
    .join('\n');
  // A popup is shut until a visitor opens it: nothing in one is seen first.
  state.first = false;
  const popups = document.popups
    .flatMap((popup) => {
      if (!state.popups.has(popup.id)) return [];
      const name = sheet.own(popup, state.css);
      const width = ['small', 'medium', 'large'].includes(popup.props.width)
        ? popup.props.width
        : 'medium';
      state.scripts.add('popup');
      // When it opens by itself, for the script: after some seconds, or as the visitor
      // leaves; and whether again on every page view. A draft shown to its editor opens
      // every time, so looking at it leaves nothing behind in the browser.
      const { trigger } = popup.props;
      const delay = cssNumber(popup.props.delaySeconds, 0, 3600) ?? '0';
      const again = context.preview === true || popup.props.frequency === 'always';
      const opens =
        trigger === 'delay'
          ? attribute('data-pt', 'delay') + attribute('data-pd', delay)
          : trigger === 'exit'
            ? attribute('data-pt', 'exit')
            : '';
      // Two elements for the one popup: what dims the page behind it, and its box. It can
      // take the focus itself (tabindex -1), for a popup with nothing in it to focus.
      return [
        `<div${classes(state, 'pp')}${attribute('id', popup.id)} role="dialog" aria-modal="true"` +
          `${attribute('aria-label', popup.name)} tabindex="-1"${opens}${opens !== '' && again ? attribute('data-pf', 'always') : ''}>` +
          `<div${classes(state, 'pb', `pw-${width}`, name)}>` +
          `${rows(popup.rows, state)}${anchor(state, `${classes(state, 'px')} href="#_" aria-label="Close"`)}&times;</a></div></div>`,
      ];
    })
    .join('\n');
  const css = styleText(
    [
      context.baseRules === 'used' ? baseCss(state.used) : BASE_CSS,
      sheet.toString(),
      document.settings.customCss,
    ]
      .filter((part) => part !== '')
      .join('\n'),
  );
  // Only a script the server has, and only at an address that is a path of ours.
  const { arrival } = context;
  if (arrival !== undefined && SITE_KEY.test(arrival.site)) state.scripts.add('arrival');
  const tags = (['arrival', 'countdown', 'popup'] as const).flatMap((name) => {
    const src = context.scripts?.[name];
    if (!state.scripts.has(name) || typeof src !== 'string' || !SCRIPT_PATH.test(src)) return [];
    // The arrival's script is told which site this is, and whether the privacy signal
    // of a visitor's browser is passed over (runtime/arrival.ts).
    const attributes =
      name === 'arrival' && arrival !== undefined
        ? attribute('data-site', arrival.site) + (arrival.always ? ' data-gpc="keep"' : '')
        : '';
    return [{ src, attributes }];
  });
  const scripts = tags.map((each) => each.src);
  const html = [
    '<!doctype html>',
    `<html${attribute('lang', /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(context.lang ?? '') ? (context.lang ?? 'en') : 'en')}>`,
    '<head>',
    head(document, context, css, tags),
    '</head>',
    '<body>',
    `<main>${main === '' ? '' : `\n${main}\n`}</main>`,
    ...(popups === '' ? [] : [popups]),
    '</body>',
    '</html>',
    '',
  ].join('\n');
  return {
    html,
    css,
    needs: { forms: state.forms, frames: [...state.frames].sort(), media: state.media, scripts },
  };
}

/** Every element of some rows, containers' children included, in the order of the page. */
function* elementsOf(list: readonly PageRow[]): Generator<PageElement> {
  function* walk(node: PageElement): Generator<PageElement> {
    yield node;
    if (node.type === 'container') for (const child of node.children) yield* walk(child);
  }
  for (const row of list)
    for (const column of row.columns) for (const child of column.children) yield* walk(child);
}

/**
 * Every element a visual page shows, in its own sections, its popups and the saved
 * sections given, for whoever checks a page before it is published.
 */
export function* pageElements(
  document: PageDocument,
  sections: ReadonlyMap<string, PageSection> = new Map(),
): Generator<PageElement> {
  if (document.mode !== 'visual') return;
  for (const each of document.sections) {
    const found = each.type === 'section' ? each : sections.get(each.sectionId);
    if (found !== undefined) yield* elementsOf(found.rows);
  }
  for (const popup of document.popups) yield* elementsOf(popup.rows);
}

/**
 * The first moment after `now` at which the same page would be written differently, in
 * milliseconds, or undefined when it never would: a countdown is written with the time
 * left to the minute, so it is written anew when the minute turns, and another way once
 * it has ended. Whoever keeps a rendered page keeps it no longer than this.
 */
export function pageChangesAt(
  document: PageDocument,
  sections: ReadonlyMap<string, PageSection>,
  now: number,
): number | undefined {
  let first: number | undefined;
  for (const node of pageElements(document, sections)) {
    if (node.type !== 'countdown' || node.props.endsAt === null) continue;
    const end = Date.parse(node.props.endsAt);
    if (!Number.isFinite(end) || end <= now) continue;
    const next = Math.min(end, now + countdownStep(end - now, false));
    if (first === undefined || next < first) first = next;
  }
  return first;
}
