// What Settings → External Tracking works out before it draws: the tag to copy, the websites
// typed in Settings, and a page's address in Troubleshoot.
import { trackedDomain } from '@repo/contracts';

/** Where the script is served on this CRM (apps/server/src/external-tracking.ts). */
export const SCRIPT_PATH = '/tracking/external-tracking.js';

/** The tag to paste before </body>, as GoHighLevel's: the script and the tracking id. */
export function scriptTag(origin: string, trackingId: string): string {
  return [
    '<script',
    `src="${origin}${SCRIPT_PATH}"`,
    `data-tracking-id="${trackingId}"></script>`,
  ].join(' ');
}

/**
 * The websites typed one a line or comma. An address is read for its host, so a pasted
 * https://shop.example.com/cart is shop.example.com. Each is listed once.
 */
export function readDomains(text: string): {
  readonly domains: readonly string[];
  readonly invalid: readonly string[];
} {
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const typed of text.split(/[\n,]/)) {
    const entry = typed.trim();
    if (entry === '') continue;
    const host =
      /^https?:\/\//i.test(entry) && URL.canParse(entry) ? new URL(entry).hostname : entry;
    const read = trackedDomain.safeParse(host);
    if (!read.success) invalid.push(entry);
    else if (!domains.includes(read.data)) domains.push(read.data);
  }
  return { domains, invalid };
}

export const pageAddress = (page: {
  readonly pageHost: string;
  readonly pagePath: string;
}): string => `${page.pageHost}${page.pagePath}`;
