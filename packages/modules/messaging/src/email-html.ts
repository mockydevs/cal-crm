// Formatted email as it is allowed to be stored and sent: what a person wrote in the
// editor, or pasted, cleaned down to formatting. The HTML is parsed as a browser would
// parse it (parse5, the WHATWG algorithm), walked as a tree, and written out again from
// that tree by the serialiser below, so nothing reaches a mail app that the walk did not
// choose to keep: no script, no event handler, no style sheet, no form, no frame, no
// comment, and no address that is not http, https, mailto or tel.
//
// It is an allowlist. A tag it does not know is dropped and its text kept; the tags in
// DROPPED go with everything inside them. Merge fields such as {{contact.firstName}} are
// plain text here and pass through, also as a whole link address; the email is cleaned
// again once they are filled in (finalEmailHtml), so a contact's value can never become
// markup or a script address.
import { html as spec, parseFragment, type DefaultTreeAdapterTypes } from 'parse5';

type Node = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

/** Deeper than this, only the text is kept: no email is written sixty levels deep. */
export const EMAIL_HTML_MAX_DEPTH = 60;

const BLOCKS = [
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'center',
  'hr',
] as const;
const INLINES = [
  'span',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'strike',
  'del',
  'ins',
  'sub',
  'sup',
  'small',
  'code',
  'font',
  'a',
  'img',
  'br',
  'colgroup',
  'col',
] as const;

/** Every tag an email may hold. */
export const EMAIL_HTML_TAGS: ReadonlySet<string> = new Set<string>([...BLOCKS, ...INLINES]);

const VOID = new Set(['br', 'hr', 'img', 'col']);

/** Tags that go with everything inside them: their content is never text to show. */
const DROPPED = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'noscript',
  'noembed',
  'noframes',
  'template',
  'svg',
  'math',
  'head',
  'title',
  'link',
  'meta',
  'base',
  'input',
  'button',
  'select',
  'option',
  'optgroup',
  'textarea',
  'datalist',
  'audio',
  'video',
  'source',
  'track',
  'canvas',
  'map',
  'area',
  'dialog',
  'xmp',
  'plaintext',
  'listing',
]);

const size = /^\d{1,4}%?$/;
const colour = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20})$/i;
const horizontal = /^(?:left|right|center|justify)$/i;
const vertical = /^(?:top|middle|bottom|baseline)$/i;
const small = /^\d{1,3}$/;

const GLOBAL_ATTRIBUTES: Readonly<Record<string, RegExp>> = {
  align: horizontal,
  dir: /^(?:ltr|rtl|auto)$/i,
  lang: /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i,
  title: /^[^\p{Cc}]{0,300}$/u,
};

const TAG_ATTRIBUTES: Readonly<Record<string, Readonly<Record<string, RegExp>>>> = {
  img: { alt: /^[^\p{Cc}]{0,500}$/u, width: size, height: size, border: small },
  table: {
    width: size,
    border: small,
    cellpadding: small,
    cellspacing: small,
    bgcolor: colour,
    role: /^presentation$/i,
  },
  td: {
    colspan: small,
    rowspan: small,
    width: size,
    height: size,
    valign: vertical,
    bgcolor: colour,
  },
  th: {
    colspan: small,
    rowspan: small,
    width: size,
    height: size,
    valign: vertical,
    bgcolor: colour,
  },
  tr: { valign: vertical, bgcolor: colour },
  col: { span: small, width: size },
  colgroup: { span: small },
  font: { color: colour, face: /^[a-z0-9 ,'-]{1,200}$/i, size: /^[+-]?[1-7]$/ },
  ol: { start: /^-?\d{1,6}$/, type: /^[1aAiI]$/ },
  li: { value: /^-?\d{1,6}$/ },
};

/** The style properties an email may set. Nothing that positions, layers or loads. */
export const EMAIL_STYLE_PROPERTIES: ReadonlySet<string> = new Set([
  'color',
  'background-color',
  'font',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration',
  'text-indent',
  'text-transform',
  'vertical-align',
  'white-space',
  'word-break',
  'direction',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-style',
  'border-width',
  'border-radius',
  'border-collapse',
  'border-spacing',
  'width',
  'height',
  'max-width',
  'min-width',
  'display',
  'list-style-type',
]);

// A value is words, numbers, units and colours. No url(), no expression(), no escape, no
// comment, no at-rule: the characters those need are not in this set, and the only
// functions let through are the colour ones.
const STYLE_VALUE = /^[a-z0-9 .,%#()'"+-]{1,200}$/i;
const STYLE_FUNCTION = /([a-z-]+)\s*\(/gi;
const COLOUR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla']);
const DISPLAYS = /^(?:block|inline|inline-block|none|table|table-row|table-cell)$/i;

/** One style attribute with only the declarations an email may carry, or '' for none. */
export function cleanEmailStyle(style: string): string {
  const kept: string[] = [];
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration
      .slice(colon + 1)
      .trim()
      .replace(/\s*!important$/i, '');
    if (!EMAIL_STYLE_PROPERTIES.has(property) || !STYLE_VALUE.test(value)) continue;
    const functions = [...value.matchAll(STYLE_FUNCTION)].map((match) =>
      (match[1] ?? '').toLowerCase(),
    );
    if (functions.some((name) => !COLOUR_FUNCTIONS.has(name))) continue;
    if (property === 'display' && !DISPLAYS.test(value)) continue;
    kept.push(`${property}:${value}`);
  }
  return kept.join(';');
}

// One merge field and nothing else: a link whose whole address is filled in per contact.
const MERGE_ADDRESS = /^\{\{\s*[a-z][a-z_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\s*\}\}$/;
// Browsers ignore tabs and line breaks inside an address and leading control characters
// and spaces (the URL standard's parser), so "java\nscript:" is read as they would read it.
const asBrowsersRead = (address: string): string =>
  address.replace(/[\t\n\r]/g, '').replace(/^[\p{Cc}\s]+|[\p{Cc}\s]+$/gu, '');

/** A link's address as it may be kept, or undefined: http, https, mailto, tel, or one merge field. */
export function cleanEmailLink(address: string): string | undefined {
  const read = asBrowsersRead(address);
  if (MERGE_ADDRESS.test(read)) return read;
  return /^(?:https?:\/\/|mailto:|tel:)/i.test(read) ? read : undefined;
}

/**
 * An image's address as it may be kept: https, or a file in this install's public media
 * library (/m/…), which is given the install's own address when the email leaves. Not http
 * (mail apps block or warn about it), and never data: or cid:.
 */
export function cleanEmailImage(address: string): string | undefined {
  const read = asBrowsersRead(address);
  if (/^https:\/\//i.test(read)) return read;
  return /^\/m\/[A-Za-z0-9._~%/-]+$/.test(read) && !read.includes('..') ? read : undefined;
}

const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (text: string): string => escapeText(text).replace(/"/g, '&quot;');

const isElement = (node: Node): node is Element => 'tagName' in node;
const isText = (node: Node): node is DefaultTreeAdapterTypes.TextNode => node.nodeName === '#text';

function attributesOf(element: Element): string {
  const tag = element.tagName;
  const kept = new Map<string, string>();
  for (const { name, value } of element.attrs) {
    if (kept.has(name)) continue;
    if (name === 'style') {
      const style = cleanEmailStyle(value);
      if (style !== '') kept.set(name, style);
    } else if (tag === 'a' && name === 'href') {
      const link = cleanEmailLink(value);
      if (link !== undefined) kept.set(name, link);
    } else if (tag === 'img' && name === 'src') {
      const image = cleanEmailImage(value);
      if (image !== undefined) kept.set(name, image);
    } else {
      const rule = TAG_ATTRIBUTES[tag]?.[name] ?? GLOBAL_ATTRIBUTES[name];
      if (rule?.test(value) === true) kept.set(name, value);
    }
  }
  // A link opens outside the mail app's own frame and tells the site nothing of it.
  if (tag === 'a' && kept.has('href')) {
    kept.set('target', '_blank');
    kept.set('rel', 'noopener noreferrer');
  }
  return [...kept].map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');
}

function textOf(nodes: readonly Node[]): string {
  let text = '';
  for (const node of nodes) {
    if (isText(node)) text += node.value;
    else if (isElement(node) && !DROPPED.has(node.tagName)) text += textOf(node.childNodes);
  }
  return text;
}

function write(nodes: readonly Node[], depth: number): string {
  if (depth > EMAIL_HTML_MAX_DEPTH) return escapeText(textOf(nodes));
  let html = '';
  for (const node of nodes) {
    if (isText(node)) {
      html += escapeText(node.value);
      continue;
    }
    // Comments (and the conditional comments Outlook reads) and doctypes are not kept.
    if (!isElement(node)) continue;
    const tag = node.tagName;
    // Only HTML elements: SVG and MathML are where a parser's two readings can differ.
    if (node.namespaceURI !== spec.NS.HTML || DROPPED.has(tag)) continue;
    if (!EMAIL_HTML_TAGS.has(tag)) {
      html += write(node.childNodes, depth + 1);
      continue;
    }
    // An image with no address left shows nothing, and is not kept.
    if (
      tag === 'img' &&
      !node.attrs.some((each) => each.name === 'src' && cleanEmailImage(each.value) !== undefined)
    )
      continue;
    html += `<${tag}${attributesOf(node)}>`;
    if (!VOID.has(tag)) html += `${write(node.childNodes, depth + 1)}</${tag}>`;
  }
  return html;
}

/**
 * HTML cleaned for an email. Always a fragment: a pasted page's html, head and body tags
 * are not kept, only what the body holds. Cleaning what it returns returns the same.
 */
export function sanitizeEmailHtml(html: string): string {
  return write(parseFragment(html).childNodes, 0);
}

/** Whether cleaned HTML shows anything: some text, or an image. */
export function emailHtmlIsEmpty(html: string): boolean {
  const nodes = parseFragment(html).childNodes;
  const hasImage = (list: readonly Node[]): boolean =>
    list.some((node) => isElement(node) && (node.tagName === 'img' || hasImage(node.childNodes)));
  return textOf(nodes).trim() === '' && !hasImage(nodes);
}

const TEXT_BLOCKS = new Set<string>(BLOCKS);

/**
 * The plain-text part of a formatted email, written from its HTML: a block is a paragraph,
 * a list item a line with a dash, a link its words and its address, an image its
 * description. Merge fields are text and stay as they are.
 */
export function emailTextOf(html: string): string {
  const out: string[] = [];
  const walk = (nodes: readonly Node[], preformatted: boolean, depth: number): void => {
    for (const node of nodes) {
      if (isText(node)) {
        const text = preformatted ? node.value : node.value.replace(/\s+/g, ' ');
        // Words at the start of a line begin there, not after the space the markup left.
        out.push(!preformatted && (out.at(-1) ?? '\n').endsWith('\n') ? text.trimStart() : text);
        continue;
      }
      if (!isElement(node) || DROPPED.has(node.tagName) || depth > EMAIL_HTML_MAX_DEPTH) continue;
      const tag = node.tagName;
      if (tag === 'br') out.push('\n');
      else if (tag === 'hr') out.push('\n\n----------\n\n');
      else if (tag === 'img') {
        const alt = node.attrs.find((each) => each.name === 'alt')?.value.trim() ?? '';
        if (alt !== '') out.push(`[${alt}]`);
      } else if (tag === 'a') {
        const start = out.length;
        walk(node.childNodes, preformatted, depth + 1);
        const words = out.slice(start).join('').trim();
        const href = node.attrs.find((each) => each.name === 'href')?.value ?? '';
        const address = href.replace(/^mailto:|^tel:/i, '');
        if (address !== '' && address !== words) out.push(words === '' ? address : ` (${address})`);
      } else {
        const block = TEXT_BLOCKS.has(tag);
        const cell = tag === 'td' || tag === 'th';
        const line = tag === 'li' || tag === 'tr';
        if (block && !cell) out.push(line ? '\n' : '\n\n');
        if (tag === 'li') out.push('- ');
        walk(node.childNodes, preformatted || tag === 'pre', depth + 1);
        if (cell) out.push(' ');
        else if (block && !line) out.push('\n\n');
      }
    }
  };
  walk(parseFragment(html).childNodes, false, 0);
  return out
    .join('')
    .replaceAll(String.fromCharCode(160), ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * An email's HTML as it leaves, after its merge fields were filled in: cleaned once more,
 * so a filled-in address that is not a web, mail or phone address is gone, and images from
 * this install's media library (/m/…) are given the install's address. Without a public
 * address such an image has nowhere to load from and is not sent.
 */
export function finalEmailHtml(html: string, publicUrl: string | undefined): string {
  let origin: string | undefined;
  try {
    origin = publicUrl === undefined ? undefined : new URL(publicUrl).origin;
  } catch {
    origin = undefined;
  }
  const fragment = parseFragment(html);
  const place = (nodes: Node[], depth = 0): Node[] =>
    nodes.flatMap((node) => {
      if (!isElement(node) || depth > EMAIL_HTML_MAX_DEPTH) return [node];
      if (node.tagName === 'img') {
        const source = node.attrs.find((each) => each.name === 'src');
        if (source?.value.startsWith('/m/') === true) {
          if (origin === undefined) return [];
          source.value = `${origin}${source.value}`;
        }
      }
      node.childNodes = place(node.childNodes, depth + 1);
      return [node];
    });
  return write(place(fragment.childNodes), 0);
}

// What makes text unseen, as the styles this file keeps can say it. A mail app shows what
// is left; Google asks for "a clearly visible unsubscribe link in the message body"
// (support.google.com/a/answer/81126) and the FTC for a "clear and conspicuous" opt-out, so
// a link hidden by any of these does not count.
const ZERO = /^0(?:\.0+)?(?:px|pt|em|rem|%|vh|vw)?$/i;
const NAMED_COLOURS: Readonly<Record<string, string>> = {
  white: 'ffffff',
  black: '000000',
  transparent: 'transparent',
};

/** A colour as six hex digits, or 'transparent', or undefined when it cannot be read. */
function colourOf(value: string): string | undefined {
  const text = value.trim().toLowerCase();
  const named = NAMED_COLOURS[text];
  if (named !== undefined) return named;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(text)?.[1];
  if (hex !== undefined)
    return hex.length === 3 ? hex.replace(/./g, (digit) => digit + digit) : hex;
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(
    text,
  );
  if (rgb === null) return undefined;
  if (rgb[4] !== undefined && Number(rgb[4]) === 0) return 'transparent';
  return [rgb[1], rgb[2], rgb[3]]
    .map((part) => Math.min(255, Number(part)).toString(16).padStart(2, '0'))
    .join('');
}

/** Whether a font size is too small to read: under 6px, 5pt, 0.4em or 40%. */
function unreadableSize(value: string): boolean {
  const match = /^(\d*\.?\d+)(px|pt|em|rem|%)?$/i.exec(value.trim());
  if (match === null) return false;
  const size = Number(match[1]);
  const unit = (match[2] ?? 'px').toLowerCase();
  if (unit === 'px') return size < 6;
  if (unit === 'pt') return size < 5;
  if (unit === '%') return size < 40;
  return size < 0.4;
}

interface Seen {
  readonly hidden: boolean;
  readonly colour: string | undefined;
  readonly background: string;
}

function seenInside(element: Element, outer: Seen): Seen {
  let { hidden, colour, background } = outer;
  const attribute = (name: string) => element.attrs.find((each) => each.name === name)?.value;
  const bgcolor = attribute('bgcolor');
  if (bgcolor !== undefined) background = colourOf(bgcolor) ?? background;
  const fontColour = element.tagName === 'font' ? attribute('color') : undefined;
  if (fontColour !== undefined) colour = colourOf(fontColour) ?? colour;
  for (const declaration of (attribute('style') ?? '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (property === 'display' && value.toLowerCase() === 'none') hidden = true;
    else if (property === 'font-size' && (ZERO.test(value) || unreadableSize(value))) hidden = true;
    else if (property === 'font' && value.split(/[\s/]+/).some((part) => ZERO.test(part)))
      hidden = true;
    else if (['height', 'max-height', 'width', 'max-width'].includes(property) && ZERO.test(value))
      hidden = true;
    else if (property === 'color') colour = colourOf(value) ?? colour;
    else if (property === 'background-color') {
      const read = colourOf(value);
      if (read !== undefined && read !== 'transparent') background = read;
    }
  }
  return { hidden, colour, background };
}

const unseen = (seen: Seen): boolean =>
  seen.hidden || seen.colour === 'transparent' || seen.colour === seen.background;

/**
 * Whether cleaned HTML shows the reader an unsubscribe link: a link whose address holds
 * `marker` (no global flag), with words of its own, or the marker written out as text, in either case
 * neither hidden (display:none, no size, no height) nor written in the colour of what is
 * behind it (white on the white a mail app starts with, unless a background says
 * otherwise). An author's link that is not shown does not count: the standard line is
 * added instead.
 */
export function showsUnsubscribeLink(html: string, marker: RegExp): boolean {
  const walk = (nodes: readonly Node[], seen: Seen, depth: number): boolean =>
    nodes.some((node) => {
      if (isText(node)) return !unseen(seen) && marker.test(node.value);
      if (!isElement(node) || DROPPED.has(node.tagName) || depth > EMAIL_HTML_MAX_DEPTH)
        return false;
      const inner = seenInside(node, seen);
      if (inner.hidden) return false;
      const href =
        node.tagName === 'a' ? node.attrs.find((each) => each.name === 'href') : undefined;
      if (href !== undefined && marker.test(href.value))
        return !unseen(inner) && visibleText(node.childNodes, inner, depth + 1);
      return walk(node.childNodes, inner, depth + 1);
    });
  const visibleText = (nodes: readonly Node[], seen: Seen, depth: number): boolean =>
    nodes.some((node) => {
      if (isText(node)) return !unseen(seen) && node.value.trim() !== '';
      if (!isElement(node) || DROPPED.has(node.tagName) || depth > EMAIL_HTML_MAX_DEPTH)
        return false;
      const inner = seenInside(node, seen);
      return !inner.hidden && visibleText(node.childNodes, inner, depth + 1);
    });
  return walk(
    parseFragment(html).childNodes,
    { hidden: false, colour: undefined, background: 'ffffff' },
    0,
  );
}
