// Everything a page document holds is data, and reaches a page only through this file.
// The contract (packages/contracts/src/sites-document.ts) already refuses what does not
// belong; the renderer checks again, because a stored row is older than the code that
// reads it and a renderer must be safe on its own.

/**
 * Text as HTML text or as the value of a double-quoted attribute. The five characters that
 * can end either are written as references; a NUL, which HTML does not allow, as U+FFFD.
 */
export function escapeHtml(value: string): string {
  return value.replaceAll('\u0000', '�').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** One attribute, double-quoted and escaped; a name is ours, never a document's. */
export const attribute = (name: string, value: string): string => ` ${name}="${escapeHtml(value)}"`;

const MERGE_TOKEN = /^\{\{([a-z][a-z0-9_.]{0,126})\}\}$/;
const MERGE_TOKENS = /\{\{([a-z][a-z0-9_.]{0,126})\}\}/g;
/** Nothing an address may hold: white space, control characters, quotes, angle brackets. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const UNSAFE_IN_ADDRESS = /[\s\u0000-\u001f\u007f<>"'`\\]/;
const LINK = /^(https?:\/\/|mailto:|tel:)/i;
const SECURE = /^https:\/\//i;
/** A path on the site: one slash, then anything but a second one. */
const SITE_PATH = /^\/(?!\/)/;

export type MergeValues = ReadonlyMap<string, string>;

/** Text with its merge fields filled in. A field with no value shows nothing. */
export function mergeText(text: string, values: MergeValues | undefined): string {
  return text.replace(MERGE_TOKENS, (_token, key: string) => values?.get(key) ?? '');
}

/** An address that is one merge field, as the value it stands for; any other, as it is. */
function merged(value: string, values: MergeValues | undefined): string | undefined {
  const token = MERGE_TOKEN.exec(value);
  return token === null ? value : values?.get(token[1] ?? '');
}

/**
 * Where a link goes, or undefined for anything a link may not be: only the web, mail, a
 * phone, a path on this site and a place on this page. `javascript:`, `data:` and every
 * other scheme are refused, as is an address with a character that could end an attribute.
 */
export function linkAddress(
  value: unknown,
  siteBase: string,
  values?: MergeValues,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const address = merged(value, values);
  if (address === undefined || address === '' || address.length > 2000) return undefined;
  if (UNSAFE_IN_ADDRESS.test(address)) return undefined;
  if (LINK.test(address) || address.startsWith('#')) return address;
  return SITE_PATH.test(address) ? `${siteBase}${address}` : undefined;
}

/** Where a picture or a video file is read from: a secure web address or a path on this site. */
export function mediaAddress(
  value: unknown,
  siteBase: string,
  values?: MergeValues,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const address = merged(value, values);
  if (address === undefined || address === '' || address.length > 2000) return undefined;
  if (UNSAFE_IN_ADDRESS.test(address)) return undefined;
  if (SECURE.test(address)) return address;
  return SITE_PATH.test(address) ? `${siteBase}${address}` : undefined;
}

const NODE_ID = /^[a-z0-9_-]{1,40}$/;
/** A node's id where the page itself shows it (an anchor, a popup), or undefined. */
export const nodeId = (value: unknown): string | undefined =>
  typeof value === 'string' && NODE_ID.test(value) ? value : undefined;

const CLASS_NAMES = /^[A-Za-z_][A-Za-z0-9_-]{0,63}( [A-Za-z_][A-Za-z0-9_-]{0,63}){0,9}$/;
/** A node's own class names, for the page's custom CSS to style, or nothing. */
export const classNames = (value: unknown): string =>
  typeof value === 'string' && CLASS_NAMES.test(value) ? value : '';

const COLOR = /^(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|transparent)$/;
export const cssColor = (value: unknown): string | undefined =>
  typeof value === 'string' && COLOR.test(value) ? value : undefined;

const FONT = /^[A-Za-z0-9][A-Za-z0-9 -]{0,79}$/;
/** A font by name, quoted, with the system's own as what is used when it is not there. */
export const cssFont = (value: unknown): string | undefined =>
  typeof value === 'string' && FONT.test(value) ? `"${value}",system-ui,sans-serif` : undefined;

/** A number within its bounds, written plainly; anything else is no value at all. */
export function cssNumber(value: unknown, min: number, max: number): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    return undefined;
  return String(Math.round(value * 1000) / 1000);
}

/**
 * An address inside a stylesheet. It is already free of quotes, backslashes and white
 * space; a bracket is written as its escape so nothing can end the url() early.
 */
export const cssUrl = (address: string): string =>
  `url("${address.replace(/[()]/g, (bracket) => (bracket === '(' ? '%28' : '%29'))}")`;

/**
 * A stylesheet as the text of a style element. Nothing in it may start a tag, so no
 * stylesheet can end its own element: "<" is written as the escape CSS reads as "<". A
 * browser's parser turns a carriage return into a line feed and a NUL into U+FFFD before
 * the policy's digest is checked, so both are written that way here: the text is then
 * exactly what the browser will hash.
 */
export const styleText = (css: string): string =>
  css.replaceAll('<', '\\3c ').replace(/\r\n?/g, '\n').replaceAll('\u0000', '�');
