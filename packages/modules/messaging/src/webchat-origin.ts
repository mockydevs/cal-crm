// Which website a public web chat request comes from. The browser writes the Origin header
// and a page's scripts cannot change it, so it tells the widget's own sites from every
// other site. A client that is not a browser can send any Origin it likes: this check stops
// other websites embedding the widget, and nothing else.

/** The longest origin stored; messaging.webchat_sessions.origin has the same bound. */
export const MAX_ORIGIN_LENGTH = 255;

// Loopback hosts may use plain HTTP, for trying a widget on a developer's own machine.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// Characters the URL parser would silently drop, decode or reinterpret: whitespace and
// controls, a backslash (read as a slash), user information, a query, a fragment, percent
// escapes and wildcards. None belongs in an origin, so none is accepted.
const NOT_IN_AN_ORIGIN = /[\p{Cc}\s\\@?#%*]/u;
// A scheme, something that is not a slash, and at most one closing slash: no path.
const SHAPE = /^https?:\/\/[^/]+\/?$/i;

/**
 * The one stored form of a website's origin, as a browser writes it in the Origin header:
 * scheme, host in lowercase ASCII (an international name in its xn-- form) and the port
 * unless it is the scheme's own. Undefined for anything that is not exactly one origin:
 * a path, a query, user information, a wildcard, or plain HTTP outside loopback.
 *
 * No wildcard is supported. `https://*.example.com` would admit every subdomain anyone can
 * ever point somewhere, an abandoned one included; a widget lists its websites one by one.
 */
export function canonicalWebOrigin(input: string): string | undefined {
  if (input.length > MAX_ORIGIN_LENGTH || NOT_IN_AN_ORIGIN.test(input)) return undefined;
  if (!SHAPE.test(input) || !URL.canParse(input)) return undefined;
  const url = new URL(input);
  const secure = url.protocol === 'https:';
  if (!secure && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) return undefined;
  // A trailing dot names the same host to DNS but is another origin to a browser.
  if (url.hostname === '' || url.hostname.endsWith('.')) return undefined;
  if (url.username !== '' || url.password !== '' || url.pathname !== '/') return undefined;
  return url.origin.length > MAX_ORIGIN_LENGTH ? undefined : url.origin;
}

/**
 * The stored origin that a request's Origin header is exactly, or undefined. Nothing is
 * parsed or normalized: a browser already sends the one canonical form that
 * canonicalWebOrigin stores, so anything that differs by a letter is another website. A
 * missing header, a repeated one (an array) and the opaque origin "null" match nothing.
 * The value returned is the stored one, so a response never echoes what a caller sent.
 */
export function allowedOrigin(header: unknown, allowed: readonly string[]): string | undefined {
  if (typeof header !== 'string' || header === '' || header === 'null') return undefined;
  return allowed.find((origin) => origin === header);
}
