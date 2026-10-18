// What the funnel's page and the page editor both work out about a page's place on the
// web: whether it is live, whether what is live is the newest saved version, what stands
// in the way of publishing it, and which element a refusal is about. Types only come from
// the contracts here, so the rules weigh nothing in a page that uses them.
import type { SitePageProblem } from '@repo/contracts';

/** Where a page stands: not on the web, on it as saved, or on it with newer changes waiting. */
export type PublishState = 'unpublished' | 'published' | 'changes';

export function publishStateOf(
  page: { readonly publishedVersion: number | null; readonly hasUnpublishedChanges: boolean },
  /** Whether the editor holds changes the server does not have yet. */
  unsaved = false,
): PublishState {
  if (page.publishedVersion === null) return 'unpublished';
  return page.hasUnpublishedChanges || unsaved ? 'changes' : 'published';
}

/** One thing in the way of a page, with the element it is about when there is one. */
export interface PageProblem {
  readonly message: string;
  readonly nodeId: string | null;
  /** True for something that stops a publish; false for a warning. */
  readonly blocking: boolean;
}

/** The element a refusal of the server is about: `/document/{nodeId}`, or none. */
export function nodeIdOfPath(path: string): string | null {
  const match = /^\/document\/([a-z0-9_-]{1,40})$/.exec(path);
  return match?.[1] ?? null;
}

/** The server's findings about a saved page as a list: what blocks first, in its own order. */
export function serverProblems(found: readonly SitePageProblem[] | undefined): PageProblem[] {
  const all = (found ?? []).map(({ message, nodeId, blocking }) => ({ message, nodeId, blocking }));
  return [...all.filter((each) => each.blocking), ...all.filter((each) => !each.blocking)];
}

/** A publish the server refused (422), as problems at their elements. */
export function refusedProblems(
  errors: readonly { readonly path: string; readonly message: string }[] | undefined,
): PageProblem[] {
  return (errors ?? []).map((error) => ({
    message: error.message,
    nodeId: nodeIdOfPath(error.path),
    blocking: true,
  }));
}

/** A page as an answer about it says where it stands: what publishing or saving returns. */
export interface PageStanding {
  readonly id: string;
  readonly role: string;
  readonly currentVersion: number;
  readonly publishedVersion: number | null;
  readonly publishedAt: string | null;
  readonly hasUnpublishedChanges: boolean;
  readonly liveUrl?: string | null | undefined;
}

interface SiteWithSteps<Page extends { readonly id: string }, Step> {
  readonly steps: readonly (Step & {
    readonly pages: readonly Page[];
    readonly liveUrl?: string | null | undefined;
  })[];
}

/**
 * A site as it is kept on screen, with one of its pages brought up to date from an answer
 * about that page: a publish, an unpublish or a save. The funnel's page shows the new
 * state at once, before the site is read again. Only the control page's answer says where
 * the step is live: visitors are served the control. A site without the page is returned
 * as it is.
 */
export function withPageStanding<
  Page extends { readonly id: string },
  Step,
  Kept extends SiteWithSteps<Page, Step>,
>(site: Kept, page: PageStanding): Kept {
  if (!site.steps.some((step) => step.pages.some((each) => each.id === page.id))) return site;
  return {
    ...site,
    steps: site.steps.map((step) =>
      step.pages.some((each) => each.id === page.id)
        ? {
            ...step,
            ...(page.role === 'control' && page.liveUrl !== undefined
              ? { liveUrl: page.liveUrl }
              : {}),
            pages: step.pages.map((each) =>
              each.id === page.id
                ? {
                    ...each,
                    currentVersion: page.currentVersion,
                    publishedVersion: page.publishedVersion,
                    publishedAt: page.publishedAt,
                    hasUnpublishedChanges: page.hasUnpublishedChanges,
                  }
                : each,
            ),
          }
        : step,
    ),
  };
}

/** Whether this install serves public pages, as the server says it (`getSitePublicStatus`). */
export interface PublicStatus {
  readonly enabled: boolean;
  readonly reason: string | null;
}

/**
 * Whether to say, before anyone publishes, that visitors cannot reach pages on this
 * install. Said only when the server says so: an answer that has not arrived, or a server
 * that has no such answer, says nothing.
 */
export const publicPagesOff = (status: PublicStatus | undefined): status is PublicStatus =>
  status !== undefined && !status.enabled;

/** How long before a preview link runs out a new one is asked for. */
export const PREVIEW_MARGIN_MS = 60_000;

/** How long from now a preview link is good for, less the margin; 0 when it has run out. */
export function previewLifeMs(expiresAt: string, now: number): number {
  const end = Date.parse(expiresAt);
  return Number.isNaN(end) ? 0 : Math.max(0, end - now - PREVIEW_MARGIN_MS);
}

/** The widths a page is previewed at: one inside each device's range of the published page. */
export const PREVIEW_WIDTHS = { desktop: 1280, tablet: 768, mobile: 360 } as const;
export type PreviewDevice = keyof typeof PREVIEW_WIDTHS;
