// A node's style as CSS. The document's style is a closed set of properties with checked
// values; each one is read here by name and written by this file, so no value of a document
// is ever copied into a stylesheet as it stands.
import { cssColor, cssFont, cssNumber, cssUrl, mediaAddress, type MergeValues } from './escape.js';

/** The widest screen each narrower device's overrides apply to, in CSS pixels. */
export const BREAKPOINTS = { tablet: 1024, mobile: 640 } as const;

export const DEVICE_QUERIES = {
  desktop: `(min-width:${String(BREAKPOINTS.tablet + 1)}px)`,
  tablet: `(min-width:${String(BREAKPOINTS.mobile + 1)}px) and (max-width:${String(BREAKPOINTS.tablet)}px)`,
  mobile: `(max-width:${String(BREAKPOINTS.mobile)}px)`,
} as const;

const SHADOWS: Readonly<Record<string, string>> = {
  none: 'none',
  small: '0 1px 2px rgba(0,0,0,.12)',
  medium: '0 4px 12px rgba(0,0,0,.15)',
  large: '0 12px 32px rgba(0,0,0,.2)',
};
const ALIGN: Readonly<Record<string, string>> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
};
const UNITS = new Set(['px', '%', 'vw', 'vh']);

type Bag = Readonly<Record<string, unknown>>;
const bag = (value: unknown): Bag | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Bag) : undefined;

const oneOf = (value: unknown, allowed: readonly string[]): string | undefined =>
  typeof value === 'string' && allowed.includes(value) ? value : undefined;

function length(value: unknown): string | undefined {
  const given = bag(value);
  const amount = cssNumber(given?.['value'], 0, 10_000);
  const unit = given?.['unit'];
  return amount !== undefined && typeof unit === 'string' && UNITS.has(unit)
    ? `${amount}${unit}`
    : undefined;
}

function edges(property: string, value: unknown, out: string[]): void {
  const given = bag(value);
  if (given === undefined) return;
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const amount = cssNumber(given[side], -1000, 1000);
    if (amount !== undefined) out.push(`${property}-${side}:${amount}px`);
  }
}

export interface CssContext {
  readonly siteBase: string;
  readonly mergeValues?: MergeValues | undefined;
}

/** The declarations of one style, in a fixed order, each from a value that passed its check. */
export function declarations(style: unknown, context: CssContext): string[] {
  const given = bag(style);
  const out: string[] = [];
  if (given === undefined) return out;
  const put = (property: string, value: string | undefined, unit = ''): void => {
    if (value !== undefined) out.push(`${property}:${value}${unit}`);
  };
  edges('margin', given['margin'], out);
  edges('padding', given['padding'], out);
  put('background-color', cssColor(given['backgroundColor']));
  const image = mediaAddress(given['backgroundImageUrl'], context.siteBase, context.mergeValues);
  if (image !== undefined) {
    out.push(`background-image:${cssUrl(image)}`, 'background-position:center');
    out.push('background-repeat:no-repeat');
  }
  put('background-size', oneOf(given['backgroundSize'], ['cover', 'contain', 'auto']));
  put('color', cssColor(given['textColor']));
  put('font-family', cssFont(given['fontFamily']));
  put('font-size', cssNumber(given['fontSize'], 1, 400), 'px');
  put('font-weight', cssNumber(given['fontWeight'], 100, 900));
  put('line-height', cssNumber(given['lineHeight'], 0.5, 5));
  put('letter-spacing', cssNumber(given['letterSpacing'], -10, 50), 'px');
  put('text-align', oneOf(given['textAlign'], ['left', 'center', 'right', 'justify']));
  put(
    'text-transform',
    oneOf(given['textTransform'], ['none', 'uppercase', 'lowercase', 'capitalize']),
  );
  put('border-width', cssNumber(given['borderWidth'], 0, 50), 'px');
  put('border-style', oneOf(given['borderStyle'], ['none', 'solid', 'dashed', 'dotted']));
  put('border-color', cssColor(given['borderColor']));
  put('border-radius', cssNumber(given['borderRadius'], 0, 1000), 'px');
  const shadow = given['shadow'];
  put('box-shadow', typeof shadow === 'string' ? SHADOWS[shadow] : undefined);
  put('width', length(given['width']));
  put('max-width', length(given['maxWidth']));
  put('min-height', length(given['minHeight']));
  put('opacity', cssNumber(given['opacity'], 0, 1));
  const align = given['align'];
  put('align-self', typeof align === 'string' ? ALIGN[align] : undefined);
  return out;
}

const DEVICES = ['desktop', 'tablet', 'mobile'] as const;

interface Parts {
  readonly base: string[];
  readonly tablet: string[];
  readonly mobile: string[];
  readonly hidden: readonly (typeof DEVICES)[number][];
}

/**
 * The rules of a page, gathered while it is rendered: the base rules of every node, then
 * the tablet's overrides, then the phone's, so a narrower screen's value wins, then what
 * each device hides.
 */
export class Stylesheet {
  readonly #base: string[] = [];
  readonly #tablet: string[] = [];
  readonly #mobile: string[] = [];
  readonly #hidden: Record<'desktop' | 'tablet' | 'mobile', string[]> = {
    desktop: [],
    tablet: [],
    mobile: [],
  };
  /** The class each look was first written under (see `own`). */
  readonly #looks = new Map<string, string>();
  #count = 0;

  /** A class name no document chose: the next in the order the page is walked. */
  name(): string {
    this.#count += 1;
    return `e${String(this.#count)}`;
  }

  rule(selector: string, parts: readonly string[]): void {
    if (parts.length > 0) this.#base.push(`${selector}{${parts.join(';')}}`);
  }

  #parts(node: unknown, context: CssContext, extra: readonly string[]): Parts {
    const given = bag(node);
    const responsive = bag(given?.['responsive']);
    const hidden = bag(given?.['hidden']);
    return {
      base: [...extra, ...declarations(given?.['style'], context)],
      tablet: declarations(responsive?.['tablet'], context),
      mobile: declarations(responsive?.['mobile'], context),
      hidden: DEVICES.filter((device) => hidden?.[device] === true),
    };
  }

  #write(name: string, parts: Parts): void {
    const selector = `.${name}`;
    this.rule(selector, parts.base);
    if (parts.tablet.length > 0) this.#tablet.push(`${selector}{${parts.tablet.join(';')}}`);
    if (parts.mobile.length > 0) this.#mobile.push(`${selector}{${parts.mobile.join(';')}}`);
    for (const device of parts.hidden) this.#hidden[device].push(selector);
  }

  /**
   * A node's own style, its overrides on narrower screens, and where it is hidden, as the
   * rules of the class given.
   */
  node(name: string, node: unknown, context: CssContext, extra: readonly string[] = []): void {
    this.#write(name, this.#parts(node, context, extra));
  }

  /**
   * The same, under a class of this sheet's own choosing, which is returned: empty for a
   * node with no look of its own, so a page carries no class that no rule is written for.
   */
  own(node: unknown, context: CssContext, extra: readonly string[] = []): string {
    const parts = this.#parts(node, context, extra);
    if (parts.base.length + parts.tablet.length + parts.mobile.length + parts.hidden.length === 0)
      return '';
    // Nodes that look the same share one class and one set of rules: a page of sixty
    // cards alike carries one card's rules, not sixty.
    const look = JSON.stringify([parts.base, parts.tablet, parts.mobile, parts.hidden]);
    const shared = this.#looks.get(look);
    if (shared !== undefined) return shared;
    const name = this.name();
    this.#looks.set(look, name);
    this.#write(name, parts);
    return name;
  }

  toString(): string {
    const out = [...this.#base];
    if (this.#tablet.length > 0)
      out.push(`@media (max-width:${String(BREAKPOINTS.tablet)}px){${this.#tablet.join('')}}`);
    if (this.#mobile.length > 0)
      out.push(`@media (max-width:${String(BREAKPOINTS.mobile)}px){${this.#mobile.join('')}}`);
    for (const device of DEVICES) {
      const selectors = this.#hidden[device];
      if (selectors.length > 0)
        out.push(
          `@media ${DEVICE_QUERIES[device]}{${selectors.join(',')}{display:none!important}}`,
        );
    }
    return out.join('\n');
  }
}

/**
 * What every page starts from: a small reset, the layout, and each element's bare look.
 * Each rule is listed with what must be on a page for the rule to do anything there: a
 * class the renderer writes, or `text` (a heading, a paragraph or a list), `media` (a
 * picture, a video or a frame), `image` or `link`. Empty: every page.
 */
const RULES: readonly (readonly [use: string, rule: string])[] = [
  ['', '*,*::before,*::after{box-sizing:border-box}'],
  ['', 'html{-webkit-text-size-adjust:100%;text-size-adjust:100%}'],
  [
    '',
    'body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:16px;line-height:1.5;color:#1d2a24;background-color:#ffffff;overflow-wrap:break-word}',
  ],
  ['text', 'h1,h2,h3,h4,h5,h6,p,ul,ol{margin:0 0 16px}'],
  ['text', 'h1,h2,h3,h4,h5,h6{line-height:1.2}'],
  ['media', 'img,video,iframe{max-width:100%}'],
  ['image', 'img{height:auto;display:block}'],
  // A section is the grid that holds its rows in one column, as wide as the section says
  // and in its middle: no element is written for that alone.
  [
    'sc',
    '.sc{display:grid;grid-template-columns:minmax(0,1fr);align-content:start;justify-content:center;padding:32px 16px}',
  ],
  ['sc-wide', '.sc-wide{grid-template-columns:minmax(0,1280px)}'],
  ['sc-medium', '.sc-medium{grid-template-columns:minmax(0,960px)}'],
  ['sc-small', '.sc-small{grid-template-columns:minmax(0,640px)}'],
  ['rw', '.rw{display:flex;gap:24px}'],
  ['rw', '.rw+.rw{margin-top:24px}'],
  ['cl', '.cl{display:flex;flex-direction:column;min-width:0}'],
  ['kt', '.kt{display:flex}'],
  ['k-v', '.k-v{flex-direction:column}'],
  ['k-h', '.k-h{flex-direction:row;flex-wrap:wrap}'],
  [
    'bt',
    '.bt{display:inline-block;padding:12px 24px;border-radius:6px;background-color:#1d2a24;color:#ffffff;font-weight:600;text-align:center;text-decoration:none}',
  ],
  ['link', '.bt:focus-visible,a:focus-visible{outline:3px solid currentColor;outline-offset:2px}'],
  ['bs', '.bs{display:block;font-size:.8em;font-weight:400}'],
  ['dv', '.dv{border:0;width:100%;margin:16px 0}'],
  ['ls-mark', '.ls-check,.ls-none{list-style:none;padding-left:0}'],
  ['ls-check', '.ls-check>li::before{content:"\\2713\\a0"}'],
  // A video's frame keeps its shape by itself: no element is written around it.
  ['vd', '.vd{position:relative;display:block;width:100%;aspect-ratio:16/9;border:0}'],
  ['vf', '.vf{width:100%;display:block}'],
  [
    'pp',
    '.pp{display:none;position:fixed;inset:0;z-index:1000;align-items:center;justify-content:center;padding:16px;background-color:rgba(0,0,0,.6);overflow:auto;outline:0}',
  ],
  // Open when a link points at it, with no script at all; or when the page's popup script
  // says so (`on`).
  ['pp', '.pp:target,.pp.on{display:flex}'],
  [
    'pp',
    '.pb{position:relative;width:100%;padding:32px 24px;border-radius:8px;background-color:#ffffff}',
  ],
  ['pw-small', '.pw-small{max-width:400px}'],
  ['pw-medium', '.pw-medium{max-width:640px}'],
  ['pw-large', '.pw-large{max-width:960px}'],
  [
    'pp',
    '.px{position:absolute;top:8px;right:12px;font-size:24px;line-height:1;text-decoration:none;color:inherit}',
  ],
  ['cc', '.cc{padding:16px;border:1px dashed currentColor;font-size:14px}'],
  [
    'rw',
    `@media (max-width:${String(BREAKPOINTS.mobile)}px){.rw{flex-direction:column}.rw>.cl{flex:0 0 auto}}`,
  ],
  ['sc', `@media (max-width:${String(BREAKPOINTS.mobile)}px){.sc{padding:24px 16px}}`],
];

/**
 * Rules no published page uses. The editor's canvas draws a section's rows inside an
 * element of its own and a video as a labelled box, and styles both with these.
 */
const CANVAS_RULES: readonly string[] = [
  '.sw{margin:0 auto;width:100%}',
  '.sw-wide{max-width:1280px}',
  '.sw-medium{max-width:960px}',
  '.sw-small{max-width:640px}',
  '.vd>iframe{position:absolute;inset:0;width:100%;height:100%;border:0}',
];

/** Every base rule there is: what the editor's canvas starts from. */
export const BASE_CSS = [...RULES.map(([, rule]) => rule), ...CANVAS_RULES].join('\n');

/** The base rules of a page on which only these things are found (see RULES). */
export const baseCss = (used: ReadonlySet<string>): string =>
  RULES.flatMap(([use, rule]) => (use === '' || used.has(use) ? [rule] : [])).join('\n');
