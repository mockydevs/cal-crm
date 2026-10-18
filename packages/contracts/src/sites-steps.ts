// Sites: a site's steps, their pages, the versions of a page, split tests and statistics.
// Saving a page stores a new version and never changes the live page; publishing makes a
// chosen version live.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { pageDocument, pageElementTypes } from './sites-document.js';
import { siteKinds, SITE_LIMITS, sitePageSummary, sitePath, siteStepSummary } from './sites.js';
import { timestamp } from './timestamps.js';

const revision = z.int().min(1).meta({
  description: 'The revision it was read at. A stale one returns 409 and changes nothing.',
});
const siteId = publicId('site');
const stepId = publicId('site_step');
const pageId = publicId('site_page');
const name = z
  .string()
  .trim()
  .min(1, { error: 'Give it a name.' })
  .max(120, { error: 'Use at most 120 characters.' });
const versionNumber = z.int().min(1);

/**
 * How long a page's working draft stays open: an autosave this many minutes or more after
 * the last one starts a new working draft, and the old one stays as a version.
 */
export const SITE_PAGE_AUTOSAVE_IDLE_MINUTES = 30;

export const siteStep = z
  .looseObject({
    ...siteStepSummary.shape,
    siteId,
    siteKind: z.enum(siteKinds),
    canManage: z.boolean(),
    canPublish: z.boolean(),
  })
  .meta({ id: 'SiteStep' });
export type SiteStep = z.output<typeof siteStep>;

export const createSiteStepInput = z
  .strictObject({
    name,
    path: sitePath,
    templateId: publicId('site_template').optional().meta({
      description: 'Start from a copy of this step template. Left out, the page is empty.',
    }),
  })
  .meta({ id: 'CreateSiteStepInput' });
export const updateSiteStepInput = z
  .strictObject({ revision, name: name.optional(), path: sitePath.optional() })
  .refine((input) => input.name !== undefined || input.path !== undefined, {
    error: 'Give a new name or path.',
  })
  .meta({ id: 'UpdateSiteStepInput' });
export const cloneSiteStepInput = z
  .strictObject({ name: name.optional(), path: sitePath.optional() })
  .meta({
    id: 'CloneSiteStepInput',
    description: 'Left out, the copy takes the name and path with "copy" added.',
  });
export const reorderSiteStepsInput = z
  .strictObject({
    revision,
    stepIds: z
      .array(stepId)
      .min(1)
      .max(SITE_LIMITS.steps)
      .refine((ids) => new Set(ids).size === ids.length, { error: 'Name each step once.' }),
  })
  .meta({
    id: 'ReorderSiteStepsInput',
    description: 'Every step of the funnel, in its new order. The revision is the site’s.',
  });

export const sitePageVersionKinds = ['saved', 'draft', 'checkpoint'] as const;
const versionAuthor = z.looseObject({
  kind: z.string(),
  name: z.string().nullable().meta({ description: 'Null for a kind with no name.' }),
});

/** Why a page cannot be published as it stands, or what a visitor would find missing. */
export const sitePageProblem = z
  .strictObject({
    code: z.string(),
    message: z.string().meta({ description: 'A plain sentence a person can act on.' }),
    nodeId: z.string().nullable().meta({
      description: 'The element of the document the problem is about, or null for the page.',
    }),
    blocking: z.boolean().meta({
      description: 'True: publishing is refused until it is fixed. False: a warning only.',
    }),
  })
  .meta({ id: 'SitePageProblem' });
export type SitePageProblem = z.output<typeof sitePageProblem>;

export const sitePage = z
  .looseObject({
    ...sitePageSummary.shape,
    stepId,
    siteId,
    siteKind: z.enum(siteKinds),
    // The newest saved version, in the current format.
    document: pageDocument,
    storedFormat: z.int().min(1).meta({
      description:
        'The format the newest version was written in. Lower than the document’s when it was upgraded on the way out.',
    }),
    problems: z.array(sitePageProblem).max(200).optional().meta({
      description:
        'What is wrong with the newest saved version, as publishing it would find. Publishing is refused with 422 while any is blocking.',
    }),
    autosavedAt: timestamp.nullable().optional().meta({
      description:
        'When the newest version is the working draft (autosaves rewrite it in place): the moment of its last autosave. Null when the newest version is a kept version, which no autosave changes.',
    }),
    liveUrl: z.string().nullable().optional().meta({
      description:
        "Where the page answers on this install's own address: set for a published control page, null for an unpublished page, for a variation (visitors are served the control) and on an install that serves no public page.",
    }),
    revision,
    updatedAt: timestamp,
    canManage: z.boolean(),
    canPublish: z.boolean(),
  })
  .meta({ id: 'SitePage' });
export type SitePage = z.output<typeof sitePage>;

export const saveSitePageDraftInput = z
  .strictObject({
    baseVersion: versionNumber.meta({
      description:
        'The version this edit started from: the page’s currentVersion when it was read. If the page has a newer one, the save is refused with 409.',
    }),
    document: pageDocument,
    autosave: z
      .boolean()
      .optional()
      .meta({
        description: `True: the editor saving by itself. A page has one working draft, which this rewrites in place: no version is added while the same person goes on editing. A new working draft (one more version) starts only when the newest version is a kept one (published, restored, saved on purpose, or the page as it was created), when someone else saved last, or after ${String(SITE_PAGE_AUTOSAVE_IDLE_MINUTES)} minutes without a save; what was there stays as a version. Needs revision. Left out or false: a version is kept on purpose, as before.`,
      }),
    revision: revision.optional().meta({
      description:
        'The page’s revision as it was read. Required with autosave, which may leave the version number as it is; checked whenever it is given. A stale one returns 409 and changes nothing.',
    }),
    name: z.string().trim().min(1).max(120).optional().meta({
      description:
        'A name for the version this save keeps ("Before the launch"). Not taken with autosave.',
    }),
  })
  .refine((input) => input.autosave !== true || input.revision !== undefined, {
    path: ['revision'],
    error: 'An autosave names the revision of the page it was made from.',
  })
  .refine((input) => input.autosave !== true || input.name === undefined, {
    path: ['name'],
    error: 'Only a version saved on purpose has a name.',
  })
  .meta({ id: 'SaveSitePageDraftInput' });
export const publishSitePageInput = z
  .strictObject({
    revision,
    version: versionNumber.optional().meta({
      description: 'The version to make live. Left out, the newest saved one.',
    }),
  })
  .meta({ id: 'PublishSitePageInput' });
export const sitePageRevisionInput = z
  .strictObject({ revision })
  .meta({ id: 'SitePageRevisionInput' });
export const restoreSitePageInput = z.strictObject({ revision, version: versionNumber }).meta({
  id: 'RestoreSitePageInput',
  description: 'Saves a copy of that version as the newest one. The live page does not change.',
});

export const sitePagePreview = z
  .looseObject({
    url: z.string().meta({
      description:
        "Shows the page's newest saved version, as a visitor would see it, to whoever holds the link until it runs out. Never cached, never listed by a search engine; it counts nothing.",
    }),
    expiresAt: timestamp,
  })
  .meta({ id: 'SitePagePreview' });
export type SitePagePreview = z.output<typeof sitePagePreview>;

/** Whether this install serves public pages, as a person is told before publishing. */
export const sitePublicStatus = z
  .looseObject({
    enabled: z.boolean().meta({
      description:
        'True: a published page answers on this install (its liveUrl) and a draft can be previewed. False: publishing is still recorded, but no visitor can reach the page.',
    }),
    code: z.enum(['enabled', 'no_public_secret']).meta({
      description:
        'enabled, or why not. no_public_secret: the install has no PUBLIC_INTAKE_SECRET, so it mounts none of its public surfaces (pages, forms, booking, chat).',
    }),
    reason: z.string().nullable().meta({
      description: 'A plain sentence for a person when not enabled; null when enabled.',
    }),
    baseUrl: z.string().nullable().meta({
      description:
        'Where sites answer on this install’s own address, before a site’s key (…/s). Null when not enabled.',
    }),
    scripts: z.strictObject({ countdown: z.boolean(), popup: z.boolean() }).meta({
      description:
        'Whether this install has its small page scripts to send: a countdown that ticks, and popups that open by themselves. False on a server built without them: a page then shows a countdown’s remaining time as it was when rendered, and a popup opens from a link only.',
    }),
  })
  .meta({ id: 'SitePublicStatus' });
export type SitePublicStatus = z.output<typeof sitePublicStatus>;

/** How one element type is shown on a published page. */
export const sitePageElementInfo = z
  .strictObject({
    type: z.enum(pageElementTypes),
    rendering: z.enum(['static', 'embed', 'connected_domain']).meta({
      description:
        "static: plain HTML and CSS, no script. embed: shown by the CRM's own script or in a frame (a form, a video). connected_domain: a tenant's own code, never shown on the install's shared address.",
    }),
    script: z.boolean().meta({ description: 'Whether showing it loads a script.' }),
    note: z.string().nullable().meta({
      description: 'What a published page does not do for this element yet, or null.',
    }),
  })
  .meta({ id: 'SitePageElementInfo' });
export const sitePageElementList = z
  .looseObject({ items: z.array(sitePageElementInfo) })
  .meta({ id: 'SitePageElementList', description: 'In the order the element panel lists them.' });
export type SitePageElementList = z.output<typeof sitePageElementList>;

export const sitePageVersion = z
  .looseObject({
    number: versionNumber,
    createdAt: timestamp,
    createdBy: versionAuthor,
    restoredFrom: versionNumber.nullable(),
    current: z.boolean(),
    published: z.boolean(),
    kind: z.enum(sitePageVersionKinds).optional().meta({
      description:
        'saved: kept on purpose (a save, a restore, a publish, the page as created) and never rewritten. draft: the working draft, which autosaves rewrite. checkpoint: an earlier working draft, kept as it was when a newer version began.',
    }),
    name: z.string().nullable().optional().meta({ description: 'The name it was saved under.' }),
    updatedAt: timestamp.optional().meta({
      description: 'When it was last written: for a draft or a checkpoint, its last autosave.',
    }),
  })
  .meta({ id: 'SitePageVersion' });
export const sitePageVersionList = z
  .looseObject({ items: z.array(sitePageVersion).max(SITE_LIMITS.versions + 1) })
  .meta({ id: 'SitePageVersionList', description: 'Newest first.' });
export type SitePageVersionList = z.output<typeof sitePageVersionList>;
export const sitePageVersionDetail = z
  .looseObject({ ...sitePageVersion.shape, document: pageDocument, storedFormat: z.int().min(1) })
  .meta({ id: 'SitePageVersionDetail' });
export type SitePageVersionDetail = z.output<typeof sitePageVersionDetail>;

export const createSiteVariationInput = z
  .strictObject({
    revision,
    copyControl: z.boolean().default(true).meta({
      description: 'Start the variation as a copy of the control page; false starts it empty.',
    }),
  })
  .meta({ id: 'CreateSiteVariationInput', description: 'The revision is the step’s.' });
export const setSiteSplitTestInput = z
  .strictObject({
    revision,
    active: z.boolean(),
    controlWeight: z.int().min(0).max(100).meta({
      description:
        'The control page’s share of visitors in percent; the variation gets the rest. Stored only for now: visitors are not shared yet.',
    }),
  })
  .meta({ id: 'SetSiteSplitTestInput' });
export const declareSiteWinnerInput = z.strictObject({ revision, pageId }).meta({
  id: 'DeclareSiteWinnerInput',
  description:
    'Ends the split test. The page named becomes the step’s control; the other page is deleted with its versions and statistics.',
});

const day = z.iso.date();
export const siteStatsQuery = z
  .strictObject({
    from: day
      .optional()
      .meta({ description: 'The first day, inclusive. Left out: 13 days before to.' }),
    to: day.optional().meta({ description: 'The last day, inclusive. Left out: today (UTC).' }),
  })
  .meta({ id: 'SiteStatsQuery' });
const counts = {
  views: z.int().min(0),
  uniqueViews: z.int().min(0),
  optIns: z.int().min(0),
  optInRate: z.number().min(0).meta({
    description: 'Opt-ins divided by unique views, from 0 to 1; 0 when there are no views.',
  }),
  orders: z.int().min(0).meta({ description: 'Reserved for the Stores phase.' }),
  orderQuantity: z.int().min(0),
  orderAmount: z.string().meta({ description: 'A decimal amount, as text.' }),
};
export const siteStats = z
  .looseObject({
    from: day,
    to: day,
    steps: z.array(
      z.looseObject({
        stepId,
        name: z.string(),
        ...counts,
        pages: z.array(
          z.looseObject({ pageId, role: z.enum(['control', 'variation']), ...counts }),
        ),
      }),
    ),
  })
  .meta({ id: 'SiteStats' });
export type SiteStats = z.output<typeof siteStats>;

const siteParams = z.strictObject({ id: siteId });
const stepParams = z.strictObject({ id: stepId });
const pageParams = z.strictObject({ id: pageId });
const group = 'Sites';

export const createSiteStep = defineEndpoint({
  operationId: 'createSiteStep',
  method: 'post',
  path: '/sites/{id}/steps',
  summary: 'Add a step to a funnel, or a page to a website',
  group,
  params: siteParams,
  body: createSiteStepInput,
  response: { status: 201, description: 'The new step, last in order.', schema: siteStep },
});
export const getSiteStep = defineEndpoint({
  operationId: 'getSiteStep',
  method: 'get',
  path: '/site-steps/{id}',
  summary: 'Read a step with its control and variation pages',
  group,
  params: stepParams,
  response: { status: 200, description: 'The step.', schema: siteStep },
});
export const updateSiteStep = defineEndpoint({
  operationId: 'updateSiteStep',
  method: 'patch',
  path: '/site-steps/{id}',
  summary: 'Rename a step or change its path',
  group,
  params: stepParams,
  body: updateSiteStepInput,
  response: { status: 200, description: 'The step after the change.', schema: siteStep },
});
export const deleteSiteStep = defineEndpoint({
  operationId: 'deleteSiteStep',
  method: 'delete',
  path: '/site-steps/{id}',
  summary: 'Delete a step with its pages, versions and statistics',
  group,
  params: stepParams,
  response: { status: 204, description: 'The step is gone.' },
});
export const cloneSiteStep = defineEndpoint({
  operationId: 'cloneSiteStep',
  method: 'post',
  path: '/site-steps/{id}/clone',
  summary: 'Copy a step within its site',
  group,
  params: stepParams,
  body: cloneSiteStepInput,
  response: {
    status: 201,
    description: 'The copy, placed last, unpublished, with no variation and no statistics.',
    schema: siteStep,
  },
});
export const reorderSiteSteps = defineEndpoint({
  operationId: 'reorderSiteSteps',
  method: 'put',
  path: '/sites/{id}/step-order',
  summary: 'Put a funnel’s steps in a new order',
  group,
  params: siteParams,
  body: reorderSiteStepsInput,
  response: {
    status: 200,
    description: 'The steps in their new order. A website’s pages have no order to change.',
    schema: z.looseObject({ items: z.array(siteStepSummary) }).meta({ id: 'SiteStepOrder' }),
  },
});
export const getSitePage = defineEndpoint({
  operationId: 'getSitePage',
  method: 'get',
  path: '/site-pages/{id}',
  summary: 'Read a page with its newest saved document',
  group,
  params: pageParams,
  response: { status: 200, description: 'The page.', schema: sitePage },
});
export const saveSitePageDraft = defineEndpoint({
  operationId: 'saveSitePageDraft',
  method: 'put',
  path: '/site-pages/{id}/draft',
  summary: 'Save a page: a kept version, or its working draft. The live page does not change',
  group,
  params: pageParams,
  body: saveSitePageDraftInput,
  response: { status: 200, description: 'The page at its new version.', schema: sitePage },
});
export const publishSitePage = defineEndpoint({
  operationId: 'publishSitePage',
  method: 'post',
  path: '/site-pages/{id}/publish',
  summary: 'Make a version of a page live',
  group,
  params: pageParams,
  body: publishSitePageInput,
  response: {
    status: 200,
    description:
      'The page, published: a control page now answers at its liveUrl. With a blocking problem (the page’s problems list) nothing is published and the answer is 422, each problem a plain sentence.',
    schema: sitePage,
  },
});
export const unpublishSitePage = defineEndpoint({
  operationId: 'unpublishSitePage',
  method: 'post',
  path: '/site-pages/{id}/unpublish',
  summary: 'Take a page off the web and keep its versions',
  group,
  params: pageParams,
  body: sitePageRevisionInput,
  response: { status: 200, description: 'The page, unpublished.', schema: sitePage },
});
export const getSitePagePreview = defineEndpoint({
  operationId: 'getSitePagePreview',
  method: 'get',
  path: '/site-pages/{id}/preview',
  summary: "Get a short-lived link that shows a page's newest saved version",
  group,
  params: pageParams,
  response: {
    status: 200,
    description:
      'The link and when it runs out. It changes nothing and is not kept: each call makes another. 409 on an install that serves no public page.',
    schema: sitePagePreview,
  },
});
export const getSitePublicStatus = defineEndpoint({
  operationId: 'getSitePublicStatus',
  method: 'get',
  path: '/site-public-status',
  summary: 'Read whether this install serves public pages, and if not, why',
  group,
  response: {
    status: 200,
    description: 'What to tell a person before they publish or preview.',
    schema: sitePublicStatus,
  },
});
export const listSitePageElements = defineEndpoint({
  operationId: 'listSitePageElements',
  method: 'get',
  path: '/site-page-elements',
  summary: 'List the element types a page may hold and how each is shown when published',
  group,
  response: { status: 200, description: 'The element types.', schema: sitePageElementList },
});
export const listSitePageVersions = defineEndpoint({
  operationId: 'listSitePageVersions',
  method: 'get',
  path: '/site-pages/{id}/versions',
  summary: 'List a page’s versions, newest first',
  group,
  params: pageParams,
  response: { status: 200, description: 'The versions kept.', schema: sitePageVersionList },
});
export const getSitePageVersion = defineEndpoint({
  operationId: 'getSitePageVersion',
  method: 'get',
  path: '/site-pages/{id}/versions/{version}',
  summary: 'Read one version of a page with its document',
  group,
  params: z.strictObject({ id: pageId, version: z.coerce.number().int().min(1) }),
  response: { status: 200, description: 'The version.', schema: sitePageVersionDetail },
});
export const restoreSitePageVersion = defineEndpoint({
  operationId: 'restoreSitePageVersion',
  method: 'post',
  path: '/site-pages/{id}/restore',
  summary: 'Save an older version again as the newest one',
  group,
  params: pageParams,
  body: restoreSitePageInput,
  response: { status: 200, description: 'The page at its new version.', schema: sitePage },
});
export const createSiteVariation = defineEndpoint({
  operationId: 'createSiteVariation',
  method: 'post',
  path: '/site-steps/{id}/variation',
  summary: 'Add a variation page to a funnel step',
  group,
  params: stepParams,
  body: createSiteVariationInput,
  response: { status: 201, description: 'The step with its two pages.', schema: siteStep },
});
export const setSiteSplitTest = defineEndpoint({
  operationId: 'setSiteSplitTest',
  method: 'put',
  path: '/site-steps/{id}/split-test',
  summary: 'Start or stop a step’s split test and set the share of each page',
  group,
  params: stepParams,
  body: setSiteSplitTestInput,
  response: {
    status: 200,
    description:
      'The step after the change. The switch and the shares are stored only: visitors are not shared between the pages yet, and the public address serves the control page to everyone.',
    schema: siteStep,
  },
});
export const declareSiteWinner = defineEndpoint({
  operationId: 'declareSiteWinner',
  method: 'post',
  path: '/site-steps/{id}/winner',
  summary: 'End a split test by keeping one page',
  group,
  params: stepParams,
  body: declareSiteWinnerInput,
  response: {
    status: 200,
    description: 'The step with the kept page as its control.',
    schema: siteStep,
  },
});
export const getSiteStats = defineEndpoint({
  operationId: 'getSiteStats',
  method: 'get',
  path: '/sites/{id}/stats',
  summary: 'Read page views and opt-ins per step for a range of days',
  group,
  params: siteParams,
  query: siteStatsQuery,
  response: { status: 200, description: 'One row per step, with its pages.', schema: siteStats },
});
export const resetSiteStats = defineEndpoint({
  operationId: 'resetSiteStats',
  method: 'post',
  path: '/sites/{id}/stats/reset',
  summary: 'Clear a site’s statistics',
  group,
  params: siteParams,
  response: { status: 204, description: 'Every count of the site is zero again.' },
});

export const siteStepEndpoints = [
  createSiteStep,
  getSiteStep,
  updateSiteStep,
  deleteSiteStep,
  cloneSiteStep,
  reorderSiteSteps,
  getSitePage,
  saveSitePageDraft,
  publishSitePage,
  unpublishSitePage,
  getSitePagePreview,
  getSitePublicStatus,
  listSitePageElements,
  listSitePageVersions,
  getSitePageVersion,
  restoreSitePageVersion,
  createSiteVariation,
  setSiteSplitTest,
  declareSiteWinner,
  getSiteStats,
  resetSiteStats,
] as const;
