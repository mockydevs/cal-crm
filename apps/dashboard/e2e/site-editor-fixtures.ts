// A stand-in for the part of the Sites API the page editor uses: a page with its versions,
// saving a draft with the version it started from (an autosave rewrites the page's one
// working draft in place, as the server does: packages/modules/sites/src/steps.ts),
// publishing with the page's problems, the signed preview link, whether the install serves
// public pages, the list of element types, and the business's forms and calendars. Every
// request is parsed with the contract's own schema before it is answered, and every answer
// with the schema it is promised under. It works on the sites the Sites stand-in holds
// (sites-fixtures.ts), so the funnel's page sees what the editor published.
import { expect, type Page, type Route } from '@playwright/test';
import {
  EMPTY_PAGE_DOCUMENT,
  pageElementTypes,
  publishSitePageInput,
  restoreSitePageInput,
  saveSitePageDraftInput,
  sitePage as sitePageSchema,
  sitePageElementList,
  sitePagePreview,
  sitePageRevisionInput,
  sitePublicStatus,
  sitePageVersionDetail,
  sitePageVersionList,
  type PageDocument,
  type PageElement,
  type Calendar,
  type SitePage,
  type SitePageProblem,
  type SitePublicStatus,
  type VisualPageDocument,
} from '@repo/contracts';
import { calendarOf } from './calendar-fixtures';
import { harbor } from './session';
import type { SitesApi } from './sites-fixtures';

const at = '2026-10-12T09:00:00.000Z';

export const editorForms = [
  { id: 'form_01h455vb4pex5vsknk084sn02q', name: 'Contact us', status: 'published' },
  { id: 'form_01h455vb4pex5vsknk084sn02r', name: 'Book a visit', status: 'draft' },
] as const;

export const editorCalendars: readonly Calendar[] = [
  calendarOf('cal_01h455vb4pex5vsknk084sn02q', 'Venue tours'),
  calendarOf('cal_01h455vb4pex5vsknk084sn02r', 'Tastings', { isActive: false, bookable: false }),
];

/**
 * What the server says a published page does not do yet, per element type: only what is
 * still true on a server that sends its page scripts (packages/modules/sites, elements.ts).
 */
const NOTES: Readonly<Record<string, string>> = {
  custom_code: 'Runs on a connected domain only.',
};

/** Whoever is signed in: the stand-in's own saves are theirs. */
const ME = 'Dana Brooks';

interface Version {
  readonly number: number;
  document: PageDocument;
  readonly createdAt: string;
  /** When it was last written: an autosave writes the working draft again in place. */
  updatedAt: string;
  readonly author: string;
  readonly restoredFrom: number | null;
  /** True while an autosave may still rewrite it: the working draft, or an earlier one. */
  draft: boolean;
  name: string | null;
}

/** An install that serves public pages and sends its page scripts. */
export const publicPagesOn: SitePublicStatus = {
  enabled: true,
  code: 'enabled',
  reason: null,
  baseUrl: 'https://crm.example/s',
  scripts: { countdown: true, popup: true },
};
/** One that serves none: the server's own sentence says what to set. */
export const publicPagesOff: SitePublicStatus = {
  enabled: false,
  code: 'no_public_secret',
  reason: 'Whoever runs the server sets PUBLIC_INTAKE_SECRET in its settings and restarts it.',
  baseUrl: null,
  scripts: { countdown: true, popup: true },
};

interface PageState {
  versions: Version[];
  revision: number;
  publishedVersion: number | null;
}

export interface SiteEditorApi {
  /** What each change was sent, in order: "METHOD /path" and the parsed body. */
  readonly sent: { readonly call: string; readonly body: unknown }[];
  /** Every request the editor made, in order: "METHOD /path". */
  readonly calls: string[];
  /** Answers the next request whose "METHOD /path" matches with a refusal, once. */
  refuse: (
    call: RegExp,
    refusal: {
      readonly status: number;
      readonly detail?: string;
      readonly errors?: readonly { path: string; code: string; message: string }[];
    },
  ) => void;
  /** Makes the next requests that match never arrive, until `restore` is called. */
  cut: (call: RegExp) => { restore: () => void };
  /** Saves a version as someone else would, behind the editor's back. */
  saveElsewhere: (pageId: string, document: VisualPageDocument, author?: string) => void;
  /** The newest saved document of a page. */
  documentOf: (pageId: string) => PageDocument;
  versionsOf: (pageId: string) => readonly Version[];
  /** How many times the page was written: every save moves it on by one. */
  revisionOf: (pageId: string) => number;
}

/** The elements of a visual page, containers' children included. */
function* elementsOf(document: VisualPageDocument): Generator<PageElement> {
  function* walk(node: PageElement): Generator<PageElement> {
    yield node;
    if (node.type === 'container') for (const child of node.children) yield* walk(child);
  }
  for (const holder of [...document.sections, ...document.popups]) {
    if (holder.type === 'saved_section') continue;
    for (const row of holder.rows)
      for (const column of row.columns) for (const child of column.children) yield* walk(child);
  }
}

/** A few of the server's own findings, enough to stop and to warn (checks.ts). */
function problemsOf(document: PageDocument): SitePageProblem[] {
  if (document.mode !== 'visual')
    return [
      {
        code: 'code_page',
        message: 'A code page cannot be published yet.',
        nodeId: null,
        blocking: true,
      },
    ];
  const found: SitePageProblem[] = [];
  if (document.sections.length === 0)
    found.push({
      code: 'empty_page',
      message: 'The page is empty. Add something to it first.',
      nodeId: null,
      blocking: true,
    });
  for (const element of elementsOf(document)) {
    if (element.type === 'image' && element.props.src === null)
      found.push({
        code: 'image_missing',
        message: 'This image has no picture yet.',
        nodeId: element.id,
        blocking: true,
      });
    if (element.type === 'form' && element.props.formId === null)
      found.push({
        code: 'form_missing',
        message: 'Choose a form for this form element.',
        nodeId: element.id,
        blocking: true,
      });
    if (element.type === 'calendar') {
      const chosen = editorCalendars.find((each) => each.id === element.props.calendarId);
      if (element.props.calendarId === null)
        found.push({
          code: 'calendar_missing',
          message: 'A calendar element has no calendar chosen. Choose one or remove it.',
          nodeId: element.id,
          blocking: true,
        });
      else if (chosen === undefined)
        found.push({
          code: 'calendar_gone',
          message: 'A calendar this page uses was deleted. Choose another.',
          nodeId: element.id,
          blocking: true,
        });
      else if (!chosen.isActive)
        found.push({
          code: 'calendar_inactive',
          message: 'A calendar this page uses is not active, so it takes no bookings.',
          nodeId: element.id,
          blocking: true,
        });
    }
    if (element.type === 'custom_code')
      found.push({
        code: 'custom_code',
        message: 'Custom code runs on a connected domain only.',
        nodeId: element.id,
        blocking: false,
      });
  }
  return found;
}

const problem = (
  route: Route,
  status: number,
  rest: { detail?: string; errors?: readonly unknown[] } = {},
): Promise<void> =>
  route.fulfill({
    status,
    contentType: 'application/problem+json',
    body: JSON.stringify({ type: 'about:blank', title: 'Refused', status, ...rest }),
  });

/**
 * Answers the page editor as the server does. `documents` gives the pages that do not
 * start empty, by page id; `liveBase` is where published pages answer, or null for an
 * install that serves none.
 */
export async function fakeSiteEditorApi(
  page: Page,
  sites: SitesApi,
  {
    documents = {},
    liveBase = 'https://crm.example/s',
    canManage = true,
    scripts = { countdown: true, popup: true },
  }: {
    readonly documents?: Readonly<Record<string, VisualPageDocument>>;
    readonly liveBase?: string | null;
    readonly canManage?: boolean;
    /** Which of its small page scripts the install has to send. */
    readonly scripts?: SitePublicStatus['scripts'];
  } = {},
): Promise<SiteEditorApi> {
  const states = new Map<string, PageState>();
  const refusals: { call: RegExp; refusal: Parameters<SiteEditorApi['refuse']>[1] }[] = [];
  const cuts = new Set<RegExp>();
  const stateOf = (pageId: string): PageState => {
    let state = states.get(pageId);
    if (state === undefined) {
      state = {
        versions: [
          {
            number: 1,
            document: documents[pageId] ?? EMPTY_PAGE_DOCUMENT,
            createdAt: at,
            updatedAt: at,
            author: ME,
            restoredFrom: null,
            // The page as it was created is a kept version: no autosave rewrites it.
            draft: false,
            name: null,
          },
        ],
        revision: 1,
        publishedVersion: null,
      };
      states.set(pageId, state);
    }
    return state;
  };
  const place = (pageId: string) => {
    for (const site of sites.sites)
      for (const step of site.steps)
        for (const each of step.pages) if (each.id === pageId) return { site, step, summary: each };
    throw new Error(`No page ${pageId} in the stand-in.`);
  };
  const newest = (state: PageState): Version => {
    const version = state.versions.at(-1);
    if (version === undefined) throw new Error('A page has a version.');
    return version;
  };
  /** Writes what the page now is into the site the Sites stand-in holds. */
  const sync = (pageId: string): void => {
    const { site, step } = place(pageId);
    const state = stateOf(pageId);
    const current = newest(state).number;
    const liveUrl =
      state.publishedVersion === null || liveBase === null
        ? null
        : `${liveBase}/k4v9x2m7q1w8e5r3t6y0u2i4/${step.path}`;
    sites.sites = sites.sites.map((each) =>
      each.id !== site.id
        ? each
        : {
            ...each,
            steps: each.steps.map((other) =>
              other.id !== step.id
                ? other
                : {
                    ...other,
                    liveUrl,
                    pages: other.pages.map((summary) =>
                      summary.id !== pageId
                        ? summary
                        : {
                            ...summary,
                            currentVersion: current,
                            publishedVersion: state.publishedVersion,
                            publishedAt: state.publishedVersion === null ? null : at,
                            hasUnpublishedChanges: state.publishedVersion !== current,
                          },
                    ),
                  },
            ),
          },
    );
  };
  const answer = (pageId: string): SitePage => {
    const { site, step, summary } = place(pageId);
    const state = stateOf(pageId);
    const version = newest(state);
    return sitePageSchema.parse({
      id: pageId,
      role: summary.role,
      weight: summary.weight,
      currentVersion: version.number,
      publishedVersion: state.publishedVersion,
      publishedAt: state.publishedVersion === null ? null : at,
      hasUnpublishedChanges: state.publishedVersion !== version.number,
      stepId: step.id,
      siteId: site.id,
      siteKind: site.kind,
      document: version.document,
      storedFormat: 1,
      problems: problemsOf(version.document),
      autosavedAt: version.draft ? version.updatedAt : null,
      liveUrl:
        state.publishedVersion === null || liveBase === null
          ? null
          : `${liveBase}/k4v9x2m7q1w8e5r3t6y0u2i4/${step.path}`,
      revision: state.revision,
      updatedAt: version.createdAt,
      canManage,
      canPublish: canManage,
    });
  };
  const api: SiteEditorApi = {
    sent: [],
    calls: [],
    refuse: (call, refusal) => {
      refusals.push({ call, refusal });
    },
    cut: (call) => {
      cuts.add(call);
      return {
        restore: () => {
          cuts.delete(call);
        },
      };
    },
    saveElsewhere: (pageId, document, author = 'Maya Okafor') => {
      const state = stateOf(pageId);
      state.versions.push({
        number: newest(state).number + 1,
        document,
        createdAt: '2026-10-12T10:30:00.000Z',
        updatedAt: '2026-10-12T10:30:00.000Z',
        author,
        restoredFrom: null,
        draft: false,
        name: null,
      });
      state.revision += 1;
      sync(pageId);
    },
    documentOf: (pageId) => newest(stateOf(pageId)).document,
    versionsOf: (pageId) => stateOf(pageId).versions,
    revisionOf: (pageId) => stateOf(pageId).revision,
  };

  await page.route('**/api/v1/forms?*', (route) =>
    route.fulfill({
      json: {
        items: editorForms.map((form) => ({
          ...form,
          hasUnpublishedChanges: false,
          submissionCount: 0,
          lastSubmissionAt: null,
          updatedAt: at,
        })),
        nextCursor: null,
        canManage: true,
      },
    }),
  );
  await page.route('**/api/v1/calendars?*', (route) =>
    route.fulfill({
      json: { items: editorCalendars, nextCursor: null, total: editorCalendars.length, canManage },
    }),
  );
  await page.route('**/api/v1/site-public-status', (route) =>
    route.fulfill({
      json: sitePublicStatus.parse(
        liveBase === null ? { ...publicPagesOff, scripts } : { ...publicPagesOn, scripts },
      ),
    }),
  );
  await page.route('**/api/v1/site-page-elements', (route) =>
    route.fulfill({
      json: sitePageElementList.parse({
        items: pageElementTypes.map((type) => ({
          type,
          rendering:
            type === 'custom_code'
              ? 'connected_domain'
              : type === 'form' || type === 'video'
                ? 'embed'
                : 'static',
          script: type === 'form',
          note: NOTES[type] ?? null,
        })),
      }),
    }),
  );
  await page.route(/\/s\/_preview\//, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="en"><head><title>Preview</title></head><body><main><h1>Preview of the saved page</h1></main></body></html>',
    }),
  );
  await page.route(/\/api\/v1\/site-pages\/[^/]+(?:\/.*)?$/, async (route) => {
    const request = route.request();
    expect(request.headers()['business-id']).toBe(harbor.id);
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const call = `${request.method()} ${path}`;
    api.calls.push(call);
    if ([...cuts].some((each) => each.test(call))) return route.abort('connectionfailed');
    const body: unknown = request.postData() === null ? undefined : request.postDataJSON();
    const refused = refusals.find((each) => each.call.test(call));
    if (refused !== undefined) {
      refusals.splice(refusals.indexOf(refused), 1);
      api.sent.push({ call, body });
      const { status, ...rest } = refused.refusal;
      return problem(route, status, rest);
    }
    const [, pageId = '', action, version] = path.split('/').filter((part) => part !== '');
    const state = stateOf(pageId);
    const json = (value: unknown): Promise<void> => route.fulfill({ json: value });
    const stale = (): Promise<void> =>
      problem(route, 409, { detail: 'Someone else changed it first. Reload and try again.' });

    if (action === undefined) return json(answer(pageId));
    if (action === 'draft') {
      const input = saveSitePageDraftInput.parse(body);
      api.sent.push({ call, body: input });
      const top = newest(state);
      if (input.baseVersion !== top.number) return stale();
      // An autosave may leave the version's number as it is: the revision says whether
      // someone else wrote in between.
      if (input.revision !== undefined && input.revision !== state.revision) return stale();
      const autosave = input.autosave === true;
      const written = new Date(Date.parse('2026-10-12T11:00:00.000Z') + state.revision * 1000);
      if (top.draft && top.author === ME) {
        // The same person, still editing: the working draft is written again in place. A
        // save on purpose keeps it as a version, under the name given.
        top.document = input.document;
        top.updatedAt = written.toISOString();
        top.draft = autosave;
        top.name = input.name ?? null;
      } else
        state.versions.push({
          number: top.number + 1,
          document: input.document,
          createdAt: written.toISOString(),
          updatedAt: written.toISOString(),
          author: ME,
          restoredFrom: null,
          draft: autosave,
          name: input.name ?? null,
        });
      state.revision += 1;
      sync(pageId);
      return json(answer(pageId));
    }
    if (action === 'publish') {
      const input = publishSitePageInput.parse(body);
      api.sent.push({ call, body: input });
      if (input.revision !== state.revision) return stale();
      const blocking = problemsOf(newest(state).document).filter((each) => each.blocking);
      if (blocking.length > 0)
        return problem(route, 422, {
          errors: blocking.map((each) => ({
            path: each.nodeId === null ? '/version' : `/document/${each.nodeId}`,
            code: each.code,
            message: each.message,
          })),
        });
      state.publishedVersion = input.version ?? newest(state).number;
      // What visitors are shown is a kept version: no autosave rewrites it afterwards.
      for (const each of state.versions)
        if (each.number === state.publishedVersion) each.draft = false;
      state.revision += 1;
      sync(pageId);
      return json(answer(pageId));
    }
    if (action === 'unpublish') {
      const input = sitePageRevisionInput.parse(body);
      api.sent.push({ call, body: input });
      if (input.revision !== state.revision) return stale();
      state.publishedVersion = null;
      state.revision += 1;
      sync(pageId);
      return json(answer(pageId));
    }
    if (action === 'preview')
      return json(
        sitePagePreview.parse({
          url: `/s/_preview/${'t'.repeat(70)}.${'s'.repeat(22)}?n=${String(api.calls.length)}`,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );
    const listed = (each: Version) => ({
      number: each.number,
      createdAt: each.createdAt,
      createdBy: { kind: 'user', name: each.author },
      restoredFrom: each.restoredFrom,
      current: each.number === newest(state).number,
      published: each.number === state.publishedVersion,
      kind: !each.draft ? 'saved' : each.number === newest(state).number ? 'draft' : 'checkpoint',
      name: each.name,
      updatedAt: each.updatedAt,
    });
    if (action === 'versions' && version === undefined)
      return json(sitePageVersionList.parse({ items: state.versions.toReversed().map(listed) }));
    if (action === 'versions') {
      const found = state.versions.find((each) => each.number === Number(version));
      if (found === undefined) return problem(route, 404);
      return json(
        sitePageVersionDetail.parse({
          ...listed(found),
          document: found.document,
          storedFormat: 1,
        }),
      );
    }
    if (action === 'restore') {
      const input = restoreSitePageInput.parse(body);
      api.sent.push({ call, body: input });
      if (input.revision !== state.revision) return stale();
      const found = state.versions.find((each) => each.number === input.version);
      if (found === undefined) return problem(route, 422);
      state.versions.push({
        number: newest(state).number + 1,
        document: found.document,
        createdAt: '2026-10-12T12:00:00.000Z',
        updatedAt: '2026-10-12T12:00:00.000Z',
        author: ME,
        restoredFrom: found.number,
        draft: false,
        name: null,
      });
      state.revision += 1;
      sync(pageId);
      return json(answer(pageId));
    }
    throw new Error(`The stand-in has no answer for ${call}.`);
  });
  return api;
}
