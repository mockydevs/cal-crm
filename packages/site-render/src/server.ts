// What the server sends with a rendered page: the policy that says what the page may load,
// and the tag that says which bytes it is. Kept apart from the renderer because both need
// the server's own hashing, which a browser does not have under the same name.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { PageScripts, RenderedPage } from './render.js';

export interface PolicyOptions {
  /**
   * Who may show the page in a frame. A live page: nobody. A preview of a draft: the
   * CRM's own address, so the editor can show it beside the page being edited.
   */
  readonly frameAncestors: 'none' | 'self';
}

/**
 * The Content-Security-Policy of one rendered page on an address tenants share. Nothing
 * is allowed that the page does not need: no script at all unless it shows a form, a
 * countdown that is running or a popup, or keeps how its visitor arrived, and then only
 * from this address, where the only
 * scripts are the CRM's own (`script-src 'self'`; a page names no inline script, and none
 * would run). Only the form's script calls anything, so only a page with a form may
 * connect. The one stylesheet, by its digest; pictures from this address
 * and from secure addresses; frames only from the video players the page uses. No form on
 * the page may post anywhere, and no base element may move its links.
 */
export function pagePolicy(
  page: Pick<RenderedPage, 'css' | 'needs'>,
  options: PolicyOptions,
): string {
  const digest = createHash('sha256').update(page.css, 'utf8').digest('base64');
  return [
    "default-src 'none'",
    ...(page.needs.forms || page.needs.scripts.length > 0 ? ["script-src 'self'"] : []),
    ...(page.needs.forms ? ["connect-src 'self'"] : []),
    `style-src 'sha256-${digest}'`,
    "img-src 'self' https:",
    ...(page.needs.media ? ["media-src 'self' https:"] : []),
    ...(page.needs.frames.length > 0 ? [`frame-src ${page.needs.frames.join(' ')}`] : []),
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors '${options.frameAncestors}'`,
  ].join('; ');
}

/** A strong validator for a page: the same bytes always carry the same tag. */
export function pageEtag(html: string): string {
  return `"${createHash('sha256').update(html, 'utf8').digest('base64url')}"`;
}

/** The small page scripts there are (runtime/), by the name the renderer knows each by. */
export const PAGE_SCRIPT_NAMES = ['arrival', 'countdown', 'popup'] as const;
export type PageScriptName = (typeof PAGE_SCRIPT_NAMES)[number];

/** One of the CRM's small page scripts, as the server sends it. */
export interface PageScriptFile {
  readonly name: PageScriptName;
  /**
   * What it is called where it is served: its name with the digest of its bytes, so the
   * address of a file never names other bytes and a browser may keep it for good.
   */
  readonly file: string;
  readonly body: Buffer;
  /** A strong validator of exactly these bytes. */
  readonly etag: string;
}

/**
 * The scripts the build step wrote next to this file (runtime/tools/build.ts), each that
 * is there: none in tests and in development before a build, and then pages name none.
 */
export function loadPageScripts(
  folder: URL = new URL('./runtime/', import.meta.url),
): readonly PageScriptFile[] {
  return PAGE_SCRIPT_NAMES.flatMap((name) => {
    let body: Buffer;
    try {
      body = readFileSync(new URL(`${name}.js`, folder));
    } catch {
      return [];
    }
    const digest = createHash('sha256').update(body).digest('hex');
    return [{ name, file: `${name}.${digest.slice(0, 16)}.js`, body, etag: `"${digest}"` }];
  });
}

/** Where each script is loaded from, for the renderer: the folder they are served under. */
export function pageScriptPaths(files: readonly PageScriptFile[], base: string): PageScripts {
  const paths: { arrival?: string; countdown?: string; popup?: string } = {};
  for (const each of files) paths[each.name] = `${base}/${each.file}`;
  return paths;
}
