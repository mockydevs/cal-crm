// The rules of Settings → Domains & URL Redirects that need no screen: what the two
// dialogs send, checked first with the API's own schemas (packages/contracts
// sites-domains.ts) so that what is said under a box is what the server would say, and
// where a refusal of a redirect belongs among the dialog's boxes.
import {
  createSiteDomainInput,
  createSiteRedirectInput,
  updateSiteRedirectInput,
  type SiteRedirect,
} from '@repo/contracts';
import type * as z from 'zod';
import { issuesOf, rejection, type Issue, type Rejection } from './problems';

/**
 * Where someone without a domain is sent to get one. Nothing in the product buys or
 * transfers a domain (owner, 2026-10-11): this is a plain link to a registrar's own site.
 */
export const REGISTRAR_URL = 'https://www.cloudflare.com/products/registrar/';
export const REGISTRAR_NAME = 'Cloudflare Registrar';

/** The page's two views, named as GoHighLevel's tabs. */
export type DomainsView = 'domains' | 'redirects';

type Checked<Body> =
  { readonly ok: true; readonly body: Body } | { readonly ok: false; readonly problem: Rejection };

/** What "Connect a domain" sends: the host name as typed, any case and space forgiven. */
export function checkedHostname(typed: string): Checked<z.output<typeof createSiteDomainInput>> {
  const checked = createSiteDomainInput.safeParse({ hostname: typed });
  return checked.success
    ? { ok: true, body: checked.data }
    : { ok: false, problem: rejection(issuesOf(checked.error)) };
}

/** A redirect as its dialog holds it: every box a text, and one box for each kind of target. */
export interface RedirectDraft {
  readonly domainId: string;
  readonly path: string;
  readonly targetType: 'site' | 'url';
  readonly siteId: string;
  readonly url: string;
  readonly status: '301' | '302';
}
export type RedirectField = keyof RedirectDraft;

/** The dialog's boxes for a redirect being changed, or for a new one on `firstDomainId`. */
export function redirectDraftOf(
  redirect: SiteRedirect | undefined,
  firstDomainId: string,
): RedirectDraft {
  if (redirect === undefined) {
    return {
      domainId: firstDomainId,
      path: '/',
      targetType: 'url',
      siteId: '',
      url: '',
      status: '301',
    };
  }
  return {
    domainId: redirect.domainId,
    path: redirect.path,
    targetType: redirect.target.type,
    siteId: redirect.target.type === 'site' ? redirect.target.siteId : '',
    url: redirect.target.type === 'url' ? redirect.target.url : '',
    status: redirect.status === 302 ? '302' : '301',
  };
}

/** Whether Save has enough to send: a domain, a path, and the target of the chosen kind. */
export function redirectReady(draft: RedirectDraft): boolean {
  const target = draft.targetType === 'site' ? draft.siteId : draft.url.trim();
  return draft.domainId !== '' && draft.path.trim() !== '' && target !== '';
}

const boxes: Readonly<Record<string, RedirectField>> = {
  '/domainId': 'domainId',
  '/path': 'path',
  '/target': 'targetType',
  '/target/type': 'targetType',
  '/target/siteId': 'siteId',
  '/target/url': 'url',
  '/status': 'status',
};

/**
 * A refusal of a redirect, sorted into the dialog's boxes: the first reason for each. The
 * target is one value to the API and two boxes here, so its pointers are read whole.
 */
export function redirectRejection(issues: readonly Issue[]): Rejection {
  const fields: Record<string, string> = {};
  let form: string | undefined;
  for (const issue of issues) {
    const box = boxes[issue.path];
    if (box !== undefined) fields[box] ??= issue.message;
    else if (issue.path === '' || issue.path === '/') form ??= issue.message;
  }
  return { fields, form };
}

export type RedirectBody =
  z.output<typeof createSiteRedirectInput> | z.output<typeof updateSiteRedirectInput>;

/**
 * What Save sends: a new redirect without `revision`, a change with it. A change never
 * moves a redirect to another domain, so it carries none.
 */
export function checkedRedirect(
  draft: RedirectDraft,
  revision: number | undefined,
): Checked<RedirectBody> {
  const rest = {
    path: draft.path.trim(),
    target:
      draft.targetType === 'site'
        ? { type: 'site', siteId: draft.siteId }
        : { type: 'url', url: draft.url.trim() },
    status: Number(draft.status),
  };
  const checked =
    revision === undefined
      ? createSiteRedirectInput.safeParse({ domainId: draft.domainId, ...rest })
      : updateSiteRedirectInput.safeParse({ revision, ...rest });
  return checked.success
    ? { ok: true, body: checked.data }
    : { ok: false, problem: redirectRejection(issuesOf(checked.error)) };
}

/** A redirect's own address, as someone types it: the host name, then the path. */
export function redirectAddress(redirect: Pick<SiteRedirect, 'hostname' | 'path'>): string {
  return `${redirect.hostname}${redirect.path}`;
}
