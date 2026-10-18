// Sites: templates, saved sections and the share bundle. A template is always a copy: using
// one makes new steps and pages, later edits to its source never reach it, and merge fields
// such as {{custom_values.phone}} stay as written so each business fills in its own.
// Templates that ship with the product, an agency's and a business's own are read through
// one list.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { pageDocument, pageSection } from './sites-document.js';
import { siteKinds, SITE_LIMITS, sitePath, site } from './sites.js';
import { timestamp } from './timestamps.js';

export const siteTemplateKinds = ['funnel', 'website', 'step', 'section'] as const;
export type SiteTemplateKind = (typeof siteTemplateKinds)[number];
/** Where a template comes from: the product, the agency ("Shared with me"), or this business. */
export const siteTemplateScopes = ['builtin', 'agency', 'business'] as const;

export const SITE_TEMPLATE_LIMITS = {
  /** Templates one business may save of its own. */
  templates: 500,
  tags: 20,
  colors: 12,
  page: 100,
  /** Saved sections one business may have. */
  sections: 200,
  /** Characters of a share bundle: under the size a request may carry. */
  bundle: 900_000,
} as const;

const revision = z.int().min(1).meta({
  description: 'The revision it was read at. A stale one returns 409 and changes nothing.',
});
const templateId = publicId('site_template');
const sectionId = publicId('site_section');
const name = z
  .string()
  .trim()
  .min(1, { error: 'Give it a name.' })
  .max(120, { error: 'Use at most 120 characters.' });
const label = z.string().trim().min(1).max(60);
const tags = z
  .array(z.string().trim().min(1).max(40))
  .max(SITE_TEMPLATE_LIMITS.tags)
  .refine((all) => new Set(all.map((tag) => tag.toLowerCase())).size === all.length, {
    error: 'Name each tag once.',
  });
const colors = z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(SITE_TEMPLATE_LIMITS.colors);

/** A saved section as a copy carries it, under the id the documents refer to it by. */
const carriedSection = z.strictObject({
  id: sectionId,
  name,
  scope: z.enum(['universal', 'global']),
  document: pageSection,
});
const carriedStep = z.strictObject({
  /** The step's id where it was copied from: what `step` actions in the documents name. */
  id: publicId('site_step'),
  name,
  path: sitePath,
  document: pageDocument,
});

/** What a template holds. Site settings that belong to one business are never in it. */
export const siteTemplateContent = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.enum(siteKinds),
      steps: z.array(carriedStep).min(1).max(SITE_LIMITS.steps),
      sections: z.array(carriedSection).max(SITE_TEMPLATE_LIMITS.sections),
    }),
    z.strictObject({
      kind: z.literal('step'),
      document: pageDocument,
      sections: z.array(carriedSection).max(SITE_TEMPLATE_LIMITS.sections),
    }),
    z.strictObject({ kind: z.literal('section'), section: pageSection }),
  ])
  .meta({ id: 'SiteTemplateContent' });
export type SiteTemplateContent = z.output<typeof siteTemplateContent>;

export const siteTemplateSummary = z
  .looseObject({
    id: templateId,
    kind: z.enum(siteTemplateKinds),
    scope: z.enum(siteTemplateScopes),
    name: z.string(),
    description: z.string(),
    category: z.string().nullable(),
    pageType: z.string().nullable(),
    tags: z.array(z.string()),
    colors: z.array(z.string()),
    previewFileId: publicId('file').nullable(),
    stepCount: z.int().min(0),
    uses: z.int().min(0).meta({
      description:
        'How often it was used. For a template that ships with the product: in this business.',
    }),
    favorite: z.boolean().meta({ description: 'Whether it is one of your favourites here.' }),
    canManage: z.boolean().meta({ description: 'Whether you may change or delete it.' }),
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'SiteTemplateSummary' });
export type SiteTemplateSummary = z.output<typeof siteTemplateSummary>;

export const siteTemplate = z
  .looseObject({ ...siteTemplateSummary.shape, content: siteTemplateContent })
  .meta({ id: 'SiteTemplate' });
export type SiteTemplate = z.output<typeof siteTemplate>;

const several = z.string().max(600).optional();
export const listSiteTemplatesQuery = z
  .strictObject({
    kind: z.enum(siteTemplateKinds),
    list: z.enum(['all', 'mine', 'shared', 'favorites']).default('all').meta({
      description:
        'all: every template you can use; mine: this business’s own; shared: the agency’s; favorites: yours.',
    }),
    category: several.meta({ description: 'One category, or several separated by commas.' }),
    type: several.meta({ description: 'One page type, or several separated by commas.' }),
    tag: several.meta({ description: 'One tag, or several separated by commas: any of them.' }),
    q: z.string().trim().max(120).optional().meta({ description: 'Any part of the name.' }),
    sort: z.enum(['recent', 'popular']).default('recent'),
    limit: z.coerce.number().int().min(1).max(SITE_TEMPLATE_LIMITS.page).default(24),
    after: z.string().max(600).optional(),
  })
  .meta({ id: 'ListSiteTemplatesQuery' });
export type ListSiteTemplatesQuery = z.output<typeof listSiteTemplatesQuery>;

const facet = z.array(z.looseObject({ value: z.string(), count: z.int().min(0) }));
export const siteTemplateList = z
  .looseObject({
    items: z.array(siteTemplateSummary),
    total: z.int(),
    next: z.string().nullable(),
    facets: z.looseObject({ categories: facet, types: facet, tags: facet }).meta({
      description:
        'What the filters offer, counted over the templates of this kind and list before the category, type, tag and search filters.',
    }),
    canManage: z.boolean(),
    canShare: z
      .boolean()
      .meta({ description: 'Whether you may save a template for the whole agency.' }),
  })
  .meta({ id: 'SiteTemplateList' });
export type SiteTemplateList = z.output<typeof siteTemplateList>;

const details = {
  description: z.string().max(2000),
  category: label.nullable(),
  pageType: label.nullable(),
  tags,
  colors,
  previewFileId: publicId('file').nullable(),
};
export const createSiteTemplateInput = z
  .strictObject({
    source: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('site'), siteId: publicId('site') }),
      z.strictObject({ type: z.literal('step'), stepId: publicId('site_step') }),
      z.strictObject({
        type: z.literal('section'),
        pageId: publicId('site_page'),
        sectionId: z
          .string()
          .max(40)
          .meta({ description: 'The section’s id in the page’s document.' }),
      }),
    ]),
    name,
    scope: z.enum(['business', 'agency']).default('business').meta({
      description: 'agency: for every business of the agency. It takes the sites.share permission.',
    }),
    description: details.description.default(''),
    category: details.category.default(null),
    pageType: details.pageType.default(null),
    tags: details.tags.default([]),
    colors: details.colors.default([]),
    previewFileId: details.previewFileId.default(null),
  })
  .meta({ id: 'CreateSiteTemplateInput' });
export const updateSiteTemplateInput = z
  .strictObject({
    revision,
    name: name.optional(),
    description: details.description.optional(),
    category: details.category.optional(),
    pageType: details.pageType.optional(),
    tags: details.tags.optional(),
    colors: details.colors.optional(),
    previewFileId: details.previewFileId.optional(),
  })
  .meta({ id: 'UpdateSiteTemplateInput' });
export const setSiteTemplateFavoriteInput = z
  .strictObject({ favorite: z.boolean() })
  .meta({ id: 'SetSiteTemplateFavoriteInput' });

// Saved sections ----------------------------------------------------------------------------

export const siteSection = z
  .looseObject({
    id: sectionId,
    siteId: publicId('site').nullable().meta({
      description: 'Null for a section of the whole business; a site for one of that site alone.',
    }),
    name: z.string(),
    document: pageSection,
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'SiteSection' });
export type SiteSection = z.output<typeof siteSection>;
export const siteSectionList = z
  .looseObject({ items: z.array(siteSection), canManage: z.boolean() })
  .meta({ id: 'SiteSectionList' });
export type SiteSectionList = z.output<typeof siteSectionList>;
export const listSiteSectionsQuery = z
  .strictObject({
    site: publicId('site').optional().meta({
      description: 'Also the sections of this site. Left out: the business’s own only.',
    }),
  })
  .meta({ id: 'ListSiteSectionsQuery' });
export const createSiteSectionInput = z
  .strictObject({ siteId: publicId('site').nullable().default(null), name, document: pageSection })
  .meta({ id: 'CreateSiteSectionInput' });
export const updateSiteSectionInput = z
  .strictObject({ revision, name, document: pageSection })
  .meta({ id: 'UpdateSiteSectionInput' });

// The share bundle ----------------------------------------------------------------------------

/** What a bundle carries: a funnel or website without anything that belongs to one business. */
export const siteBundlePayload = z
  .strictObject({
    type: z.literal('crm.site-bundle'),
    version: z.literal(1),
    agency: z.string().max(64).meta({ description: 'The agency it was exported in.' }),
    exportedAt: timestamp,
    name,
    content: siteTemplateContent,
  })
  .meta({ id: 'SiteBundlePayload' });
export type SiteBundlePayload = z.output<typeof siteBundlePayload>;

export const siteBundle = z
  .looseObject({
    bundle: z.string().meta({
      description:
        'The site, signed by this install. Hand it to POST /sites/import in another business of the same agency.',
    }),
  })
  .meta({ id: 'SiteBundle' });
export type SiteBundle = z.output<typeof siteBundle>;
export const importSiteInput = z
  .strictObject({
    bundle: z.string().min(1).max(SITE_TEMPLATE_LIMITS.bundle),
    name: name.optional().meta({ description: 'Left out, the name it was exported under.' }),
    folderId: publicId('site_folder').nullable().default(null),
  })
  .meta({ id: 'ImportSiteInput' });

const templateParams = z.strictObject({ id: templateId });
const sectionParams = z.strictObject({ id: sectionId });
const group = 'Sites';

export const listSiteTemplates = defineEndpoint({
  operationId: 'listSiteTemplates',
  method: 'get',
  path: '/site-templates',
  summary: 'List the templates of a kind, with what the filters offer',
  group,
  query: listSiteTemplatesQuery,
  response: { status: 200, description: 'A page of templates.', schema: siteTemplateList },
});
export const getSiteTemplate = defineEndpoint({
  operationId: 'getSiteTemplate',
  method: 'get',
  path: '/site-templates/{id}',
  summary: 'Read a template with its content',
  group,
  params: templateParams,
  response: { status: 200, description: 'The template.', schema: siteTemplate },
});
export const createSiteTemplate = defineEndpoint({
  operationId: 'createSiteTemplate',
  method: 'post',
  path: '/site-templates',
  summary: 'Save a site, a step or a section as a template',
  group,
  body: createSiteTemplateInput,
  response: {
    status: 201,
    description: 'The template: a copy, which later edits to its source do not change.',
    schema: siteTemplate,
  },
});
export const updateSiteTemplate = defineEndpoint({
  operationId: 'updateSiteTemplate',
  method: 'patch',
  path: '/site-templates/{id}',
  summary: 'Change a template’s name and how it is filed',
  group,
  params: templateParams,
  body: updateSiteTemplateInput,
  response: { status: 200, description: 'The template after the change.', schema: siteTemplate },
});
export const deleteSiteTemplate = defineEndpoint({
  operationId: 'deleteSiteTemplate',
  method: 'delete',
  path: '/site-templates/{id}',
  summary: 'Delete a template; sites made from it stay',
  group,
  params: templateParams,
  response: { status: 204, description: 'The template is gone.' },
});
export const setSiteTemplateFavorite = defineEndpoint({
  operationId: 'setSiteTemplateFavorite',
  method: 'put',
  path: '/site-templates/{id}/favorite',
  summary: 'Add a template to your favourites, or take it out',
  group,
  params: templateParams,
  body: setSiteTemplateFavoriteInput,
  response: {
    status: 200,
    description: 'The template as you now see it.',
    schema: siteTemplateSummary,
  },
});
export const listSiteSections = defineEndpoint({
  operationId: 'listSiteSections',
  method: 'get',
  path: '/site-sections',
  summary: 'List the saved sections pages may refer to',
  group,
  query: listSiteSectionsQuery,
  response: { status: 200, description: 'The sections, by name.', schema: siteSectionList },
});
export const createSiteSection = defineEndpoint({
  operationId: 'createSiteSection',
  method: 'post',
  path: '/site-sections',
  summary: 'Save a section for the business or for one site',
  group,
  body: createSiteSectionInput,
  response: { status: 201, description: 'The saved section.', schema: siteSection },
});
export const updateSiteSection = defineEndpoint({
  operationId: 'updateSiteSection',
  method: 'put',
  path: '/site-sections/{id}',
  summary: 'Change a saved section everywhere it is used',
  group,
  params: sectionParams,
  body: updateSiteSectionInput,
  response: { status: 200, description: 'The section after the change.', schema: siteSection },
});
export const deleteSiteSection = defineEndpoint({
  operationId: 'deleteSiteSection',
  method: 'delete',
  path: '/site-sections/{id}',
  summary: 'Delete a saved section no page refers to',
  group,
  params: sectionParams,
  response: {
    status: 204,
    description: 'The section is gone. One that a page’s newest or live version uses is refused.',
  },
});
export const exportSite = defineEndpoint({
  operationId: 'exportSite',
  method: 'post',
  path: '/sites/{id}/export',
  summary: 'Export a site as a signed bundle to share',
  group,
  params: z.strictObject({ id: publicId('site') }),
  response: { status: 200, description: 'The bundle.', schema: siteBundle },
});
export const importSite = defineEndpoint({
  operationId: 'importSite',
  method: 'post',
  path: '/sites/import',
  summary: 'Import a shared bundle as a new site',
  group,
  body: importSiteInput,
  response: { status: 201, description: 'The new site: a copy, unpublished.', schema: site },
});

export const siteTemplateEndpoints = [
  listSiteTemplates,
  getSiteTemplate,
  createSiteTemplate,
  updateSiteTemplate,
  deleteSiteTemplate,
  setSiteTemplateFavorite,
  listSiteSections,
  createSiteSection,
  updateSiteSection,
  deleteSiteSection,
  exportSite,
  importSite,
] as const;
