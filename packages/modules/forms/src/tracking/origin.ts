// Which website a tracking request comes from. A browser sets the Origin header and a page
// cannot forge it, so the script on one website cannot report for another; a program that is
// not a browser can send any, and for that there are the limiter and the view token.
//
// While the business lists no websites, any secure one is taken, as GoHighLevel's script
// answers anywhere it is pasted. Once it lists some, a request must come from one of them or
// a subdomain of one. The page a request names must be on the same website.
import { canonicalWebOrigin } from '@repo/module-messaging';

/** The origin a request is admitted as, or undefined. Never the header's own text. */
export function admittedOrigin(
  header: unknown,
  allowedDomains: readonly string[],
): string | undefined {
  if (typeof header !== 'string' || header === '' || header === 'null') return undefined;
  const origin = canonicalWebOrigin(header);
  if (origin === undefined) return undefined;
  if (allowedDomains.length === 0) return origin;
  const host = new URL(origin).hostname;
  return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))
    ? origin
    : undefined;
}

/** The page's host and path, when its address is on the admitted website; never its query. */
export function pageOfOrigin(
  pageUrl: string,
  origin: string,
): { readonly host: string; readonly path: string } | undefined {
  if (!URL.canParse(pageUrl)) return undefined;
  const url = new URL(pageUrl);
  if (url.origin !== origin) return undefined;
  return { host: url.hostname, path: url.pathname };
}
