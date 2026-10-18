// Sites: funnels and websites, their folders and their settings. A funnel is an ordered
// list of steps; a website is the same thing without the order and without split tests.
// This file is what the lists and the site's own page read: it holds no page document, so a
// list does not carry that schema (see sites-document.ts, sites-steps.ts).
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

export const siteKinds = ['funnel', 'website'] as const;
export type SiteKind = (typeof siteKinds)[number];
const kind = z.enum(siteKinds);

export const SITE_LIMITS = {
  /** Funnels and websites one business may have, together. */
  sites: 500,
  /** Folders of one kind. */
  folders: 100,
  /** Steps of a funnel, or pages of a website. */
  steps: 100,
  /** Response headers a site adds. */
  headers: 20,
  /** The most rows a page of a list holds. */
  page: 100,
  /** Versions a page keeps. The live one is never dropped. */
  versions: 30,
} as const;

const revision = z.int().min(1).meta({
  description: 'The revision it was read at. A stale one returns 409 and changes nothing.',
});
const siteId = publicId('site');
const folderId = publicId('site_folder');
const name = z
  .string()
  .trim()
  .min(1, { error: 'Give it a name.' })
  .max(120, { error: 'Use at most 120 characters.' });

/**
 * Where the CRM serves a site's published pages on its own address, before any domain is
 * connected: `/s/{publicKey}` is the site's first step (a funnel) or its home page (a
 * website), and `/s/{publicKey}/{path}` the step at that path. A draft is shown at
 * `/s/_preview/{token}` to whoever holds a link someone signed in asked for.
 */
export const SITE_PAGE_PATH = '/s';
export const SITE_PREVIEW_PAGE_PATH = '/s/_preview';

/** 24 to 64 lowercase letters and digits. Public: it is in the address of every page of the site. */
export const sitePublicKey = z.string().regex(/^[a-z0-9]{24,64}$/);

/**
 * Proof that someone signed in asked to see a page's draft: which page, until when, and a
 * keyed digest of both, made by the server. It is in the address of the preview.
 */
export const sitePreviewToken = z.string().regex(/^[A-Za-z0-9_-]{70}\.[A-Za-z0-9_-]{22}$/);

const liveUrl = z.string().nullable().optional();

/** One part of an address, or several with / between: offers/spring. */
export const sitePath = z
  .string()
  .max(200)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\/[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, {
    error: 'Use lowercase letters, numbers and hyphens, with / between parts.',
  });

// Folders -----------------------------------------------------------------------------------

export const siteFolder = z
  .looseObject({
    id: folderId,
    kind,
    name: z.string(),
    siteCount: z.int().min(0),
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'SiteFolder' });
export type SiteFolder = z.output<typeof siteFolder>;
export const siteFolderList = z
  .looseObject({ items: z.array(siteFolder).max(SITE_LIMITS.folders), canManage: z.boolean() })
  .meta({ id: 'SiteFolderList' });
export type SiteFolderList = z.output<typeof siteFolderList>;
export const listSiteFoldersQuery = z.strictObject({ kind }).meta({ id: 'ListSiteFoldersQuery' });
export const createSiteFolderInput = z
  .strictObject({ kind, name })
  .meta({ id: 'CreateSiteFolderInput' });
export const updateSiteFolderInput = z
  .strictObject({ name, revision })
  .meta({ id: 'UpdateSiteFolderInput' });

// Sites -------------------------------------------------------------------------------------

/** A page of a step as lists show it: which version is live, and whether a newer one waits. */
export const sitePageSummary = z
  .looseObject({
    id: publicId('site_page'),
    role: z.enum(['control', 'variation']),
    weight: z.int().min(0).max(100).meta({
      description:
        "The share of the step's visitors this page is to get while a split test runs, in percent. Stored only: visitors are not shared between pages yet, and the public address serves the control page to everyone.",
    }),
    currentVersion: z.int().min(1),
    publishedVersion: z.int().min(1).nullable(),
    publishedAt: timestamp.nullable(),
    hasUnpublishedChanges: z.boolean(),
  })
  .meta({ id: 'SitePageSummary' });
export type SitePageSummary = z.output<typeof sitePageSummary>;

export const siteStepSummary = z
  .looseObject({
    id: publicId('site_step'),
    name: z.string(),
    path: z.string(),
    position: z.int().min(0),
    splitTest: z.boolean().meta({
      description:
        'Whether a split test is switched on for the step. Stored only: until visitors are shared between pages, every visitor is served the control page.',
    }),
    liveUrl: liveUrl.meta({
      description:
        "Where the step answers on this install's own address, while its control page is published. Null while that page is not published (the address answers 404) and on an install that serves no public page.",
    }),
    pages: z.array(sitePageSummary).min(1).max(2),
    revision,
    updatedAt: timestamp,
  })
  .meta({ id: 'SiteStepSummary' });
export type SiteStepSummary = z.output<typeof siteStepSummary>;

const siteDomainRef = z.looseObject({
  id: publicId('site_domain'),
  hostname: z.string(),
  verified: z.boolean(),
});

export const siteSummary = z
  .looseObject({
    id: siteId,
    kind,
    name: z.string(),
    folderId: folderId.nullable(),
    stepCount: z.int().min(0),
    domain: siteDomainRef.nullable(),
    path: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'SiteSummary' });
export type SiteSummary = z.output<typeof siteSummary>;

export const siteSorts = ['updated', 'name'] as const;
export const listSitesQuery = z
  .strictObject({
    kind,
    folder: z
      .union([folderId, z.literal('none')])
      .optional()
      .meta({ description: 'Only the sites in this folder, or "none" for those in no folder.' }),
    q: z
      .string()
      .trim()
      .max(120)
      .optional()
      .meta({ description: 'Finds sites by any part of their name.' }),
    sort: z.enum(siteSorts).default('updated').meta({
      description: 'updated: newest change first (the Recent view); name: by name (the List view).',
    }),
    limit: z.coerce.number().int().min(1).max(SITE_LIMITS.page).default(15),
    after: z
      .string()
      .max(600)
      .optional()
      .meta({ description: 'Start after the previous page: its next, exactly as it was given.' }),
  })
  .meta({ id: 'ListSitesQuery' });
export type ListSitesQuery = z.output<typeof listSitesQuery>;

export const siteList = z
  .looseObject({
    items: z.array(siteSummary),
    total: z.int().meta({ description: 'How many sites match the filters, on every page.' }),
    next: z.string().nullable(),
    canManage: z.boolean(),
  })
  .meta({ id: 'SiteList' });
export type SiteList = z.output<typeof siteList>;

const headerName = z
  .string()
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/, { error: 'Use the name of a response header.' })
  .refine(
    (value) =>
      ![
        'set-cookie',
        'content-length',
        'transfer-encoding',
        'connection',
        'host',
        'content-encoding',
        'location',
      ].includes(value.toLowerCase()),
    { error: 'The server sets this header itself.' },
  );
export const siteSecurityHeader = z.strictObject({
  name: headerName,
  value: z
    .string()
    .min(1)
    .max(4000)
    .regex(/^[^\r\n]*$/, { error: 'Keep the value on one line.' }),
});

const webAddress = z
  .string()
  .max(2000)
  .regex(/^https?:\/\/[^\s]+$/, { error: 'Use a web address starting with http:// or https://.' });
const trackingCode = z.string().max(50_000);

/**
 * Whether a site's pages keep how a visitor arrived (the ad's labels and click id in the
 * address of the first page, and the site they came from) from one page to the next, so a
 * form on a later step, or a booking, is still named after the ad. Kept in the visitor's
 * own browser tab until the tab closes: no cookie, and nothing is sent before they send a
 * form or book.
 */
export const siteKeepArrival = ['always', 'unless_opted_out', 'never'] as const;
export type SiteKeepArrival = (typeof siteKeepArrival)[number];
const keepArrival = z.enum(siteKeepArrival).meta({
  description:
    'unless_opted_out (what a site starts with): kept, except for a visitor whose browser sends the Global Privacy Control signal. always: kept for every visitor. never: not kept. Only the pages of a site with a form or a calendar on a published page load anything for it.',
});

export const site = z
  .looseObject({
    ...siteSummary.shape,
    publicKey: sitePublicKey.optional().meta({
      description:
        'Names the site in its address on this install: /s/{publicKey}. It never changes.',
    }),
    liveUrl: liveUrl.meta({
      description:
        "The site's own address on this install, with no domain connected: a funnel's first step, or a website's home page (the page at path home or index, else the first one added). Null while that page is not published and on an install that serves no public page.",
    }),
    faviconUrl: z.string().nullable(),
    headCode: z.string(),
    bodyCode: z.string(),
    chatWidgetId: publicId('webchat_widget').nullable(),
    paymentLive: z.boolean().meta({ description: 'Kept for the Stores phase.' }),
    requireCard: z.boolean().meta({ description: 'Kept for the Stores phase.' }),
    optimizeImages: z.boolean(),
    lazyCustomCode: z.boolean(),
    privacyFonts: z.boolean(),
    autoSchema: z.boolean(),
    keepArrival,
    securityHeaders: z.array(siteSecurityHeader).max(SITE_LIMITS.headers),
    steps: z.array(siteStepSummary).max(SITE_LIMITS.steps).meta({
      description: "A funnel's steps in order; a website's pages in the order they were added.",
    }),
    originTemplateId: publicId('site_template').nullable(),
    revision,
    canManage: z.boolean(),
    canPublish: z.boolean(),
    canShare: z.boolean(),
  })
  .meta({ id: 'Site' });
export type Site = z.output<typeof site>;

export const createSiteInput = z
  .strictObject({
    kind,
    name,
    folderId: folderId.nullable().default(null),
    templateId: publicId('site_template').optional().meta({
      description:
        'Start from a copy of this funnel or website template. Left out, the site starts with one empty step.',
    }),
  })
  .meta({ id: 'CreateSiteInput' });

export const updateSiteInput = z
  .strictObject({
    revision,
    name: name.optional(),
    folderId: folderId.nullable().optional(),
    domainId: publicId('site_domain').nullable().optional(),
    path: z.union([sitePath, z.literal('')]).optional(),
    faviconUrl: webAddress.nullable().optional(),
    headCode: trackingCode.optional(),
    bodyCode: trackingCode.optional(),
    chatWidgetId: publicId('webchat_widget').nullable().optional(),
    paymentLive: z.boolean().optional(),
    requireCard: z.boolean().optional(),
    optimizeImages: z.boolean().optional(),
    lazyCustomCode: z.boolean().optional(),
    privacyFonts: z.boolean().optional(),
    autoSchema: z.boolean().optional(),
    keepArrival: keepArrival.optional(),
  })
  .meta({
    id: 'UpdateSiteInput',
    description: 'Only the settings named change. The revision is the site’s.',
  });

export const cloneSiteInput = z
  .strictObject({ name: name.optional() })
  .meta({ id: 'CloneSiteInput', description: 'Left out, the copy is named "<name> (copy)".' });

export const setSiteSecurityHeadersInput = z
  .strictObject({
    revision,
    headers: z
      .array(siteSecurityHeader)
      .max(SITE_LIMITS.headers)
      .refine(
        (headers) =>
          new Set(headers.map((header) => header.name.toLowerCase())).size === headers.length,
        { error: 'Name each header once.' },
      ),
  })
  .meta({
    id: 'SetSiteSecurityHeadersInput',
    description: 'The whole list, replacing what was there.',
  });

const siteParams = z.strictObject({ id: siteId });
const folderParams = z.strictObject({ id: folderId });
const group = 'Sites';

export const listSites = defineEndpoint({
  operationId: 'listSites',
  method: 'get',
  path: '/sites',
  summary: 'List funnels or websites',
  group,
  query: listSitesQuery,
  response: { status: 200, description: 'A page of the list.', schema: siteList },
});
export const createSite = defineEndpoint({
  operationId: 'createSite',
  method: 'post',
  path: '/sites',
  summary: 'Create a funnel or a website, blank or from a template',
  group,
  body: createSiteInput,
  response: { status: 201, description: 'The new site.', schema: site },
});
export const getSite = defineEndpoint({
  operationId: 'getSite',
  method: 'get',
  path: '/sites/{id}',
  summary: 'Read a funnel or website with its steps and settings',
  group,
  params: siteParams,
  response: { status: 200, description: 'The site.', schema: site },
});
export const updateSite = defineEndpoint({
  operationId: 'updateSite',
  method: 'patch',
  path: '/sites/{id}',
  summary: 'Change a site’s name, folder, domain, path or settings',
  group,
  params: siteParams,
  body: updateSiteInput,
  response: { status: 200, description: 'The site after the change.', schema: site },
});
export const deleteSite = defineEndpoint({
  operationId: 'deleteSite',
  method: 'delete',
  path: '/sites/{id}',
  summary: 'Delete a site for good, with its steps, pages, versions and statistics',
  group,
  params: siteParams,
  response: { status: 204, description: 'The site is gone.' },
});
export const cloneSite = defineEndpoint({
  operationId: 'cloneSite',
  method: 'post',
  path: '/sites/{id}/clone',
  summary: 'Copy a site with its steps and pages',
  group,
  params: siteParams,
  body: cloneSiteInput,
  response: {
    status: 201,
    description: 'The copy: unpublished, with no domain and no statistics.',
    schema: site,
  },
});
export const setSiteSecurityHeaders = defineEndpoint({
  operationId: 'setSiteSecurityHeaders',
  method: 'put',
  path: '/sites/{id}/security-headers',
  summary: 'Replace the response headers a site adds',
  group,
  params: siteParams,
  body: setSiteSecurityHeadersInput,
  response: { status: 200, description: 'The site after the change.', schema: site },
});
export const listSiteFolders = defineEndpoint({
  operationId: 'listSiteFolders',
  method: 'get',
  path: '/site-folders',
  summary: 'List the folders of funnels or of websites',
  group,
  query: listSiteFoldersQuery,
  response: { status: 200, description: 'The folders, by name.', schema: siteFolderList },
});
export const createSiteFolder = defineEndpoint({
  operationId: 'createSiteFolder',
  method: 'post',
  path: '/site-folders',
  summary: 'Create a folder',
  group,
  body: createSiteFolderInput,
  response: { status: 201, description: 'The new folder.', schema: siteFolder },
});
export const updateSiteFolder = defineEndpoint({
  operationId: 'updateSiteFolder',
  method: 'patch',
  path: '/site-folders/{id}',
  summary: 'Rename a folder',
  group,
  params: folderParams,
  body: updateSiteFolderInput,
  response: { status: 200, description: 'The folder after the change.', schema: siteFolder },
});
export const deleteSiteFolder = defineEndpoint({
  operationId: 'deleteSiteFolder',
  method: 'delete',
  path: '/site-folders/{id}',
  summary: 'Delete a folder and leave its sites, outside any folder',
  group,
  params: folderParams,
  response: { status: 204, description: 'The folder is gone; its sites are not.' },
});

export const siteEndpoints = [
  listSites,
  createSite,
  getSite,
  updateSite,
  deleteSite,
  cloneSite,
  setSiteSecurityHeaders,
  listSiteFolders,
  createSiteFolder,
  updateSiteFolder,
  deleteSiteFolder,
] as const;
