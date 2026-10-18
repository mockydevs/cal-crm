// Sites: the domains a business connects and the redirects on them. Connecting is one DNS
// record that points the host at this install; checking that record is also the proof the
// business controls the name. Certificates and serving belong to the publishing phase: this
// file only records the domain and what the check found.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

export const SITE_DOMAIN_LIMITS = {
  /** Domains one business may connect. */
  domains: 50,
  /** Redirects one business may have. */
  redirects: 500,
} as const;

const revision = z.int().min(1).meta({
  description: 'The revision it was read at. A stale one returns 409 and changes nothing.',
});
const domainId = publicId('site_domain');
const redirectId = publicId('site_redirect');

const HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** A host name as typed: any case and surrounding space are forgiven. */
export const siteHostname = z
  .string()
  .trim()
  .toLowerCase()
  .min(4)
  .max(253)
  .regex(HOSTNAME, { error: 'Enter a domain name, such as www.example.com.' });

/** The one DNS record to add at the domain's DNS provider. */
export const siteDomainRecord = z
  .looseObject({
    type: z.enum(['CNAME', 'A']),
    host: z.string().meta({
      description: 'The name of the record at the DNS provider: @ for the domain itself.',
      examples: ['www'],
    }),
    value: z.string().meta({ description: 'What the record must point at.' }),
  })
  .meta({ id: 'SiteDomainRecord' });

export const siteDomain = z
  .looseObject({
    id: domainId,
    hostname: z.string(),
    record: siteDomainRecord.nullable().meta({
      description:
        'The record to add. Null when this install has not been told the address its sites answer at.',
    }),
    verification: z.looseObject({
      status: z.enum(['pending', 'verified', 'failed']),
      error: z.string().nullable(),
      checkedAt: timestamp.nullable(),
      verifiedAt: timestamp.nullable(),
    }),
    certificateStatus: z.enum(['none', 'pending', 'issued', 'failed']).meta({
      description: 'Written by the publishing phase. None until a certificate has been asked for.',
    }),
    wwwRedirect: z.boolean(),
    defaultStepId: publicId('site_step').nullable().meta({
      description: 'The step that answers at the bare domain.',
    }),
    notFoundStepId: publicId('site_step').nullable(),
    siteCount: z.int().min(0).meta({ description: 'Sites linked to this domain.' }),
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'SiteDomain' });
export type SiteDomain = z.output<typeof siteDomain>;
export const siteDomainList = z
  .looseObject({ items: z.array(siteDomain), canManage: z.boolean() })
  .meta({ id: 'SiteDomainList' });
export type SiteDomainList = z.output<typeof siteDomainList>;

export const createSiteDomainInput = z
  .strictObject({ hostname: siteHostname })
  .meta({ id: 'CreateSiteDomainInput' });
export const updateSiteDomainInput = z
  .strictObject({
    revision,
    wwwRedirect: z.boolean().optional(),
    defaultStepId: publicId('site_step').nullable().optional(),
    notFoundStepId: publicId('site_step').nullable().optional(),
  })
  .meta({ id: 'UpdateSiteDomainInput' });

const redirectPath = z
  .string()
  .max(500)
  .regex(/^\/[^\s?#]*$/, { error: 'Start the path with / and leave out any ? or #.' });
const webAddress = z
  .string()
  .max(2000)
  .regex(/^https?:\/\/[^\s]+$/, { error: 'Use a web address starting with http:// or https://.' });
const target = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('site'), siteId: publicId('site') }),
  z.strictObject({ type: z.literal('url'), url: webAddress }),
]);

export const siteRedirect = z
  .looseObject({
    id: redirectId,
    domainId,
    hostname: z.string(),
    path: z.string(),
    target: z.discriminatedUnion('type', [
      z.looseObject({
        type: z.literal('site'),
        siteId: publicId('site'),
        siteName: z.string(),
        siteKind: z.enum(['funnel', 'website']),
      }),
      z.looseObject({ type: z.literal('url'), url: z.string() }),
    ]),
    status: z.union([z.literal(301), z.literal(302)]),
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'SiteRedirect' });
export type SiteRedirect = z.output<typeof siteRedirect>;
export const siteRedirectList = z
  .looseObject({ items: z.array(siteRedirect), canManage: z.boolean() })
  .meta({ id: 'SiteRedirectList' });
export type SiteRedirectList = z.output<typeof siteRedirectList>;

const status = z.union([z.literal(301), z.literal(302)]);
export const createSiteRedirectInput = z
  .strictObject({ domainId, path: redirectPath, target, status: status.default(301) })
  .meta({ id: 'CreateSiteRedirectInput' });
export const updateSiteRedirectInput = z
  .strictObject({ revision, path: redirectPath, target, status })
  .meta({ id: 'UpdateSiteRedirectInput' });

const domainParams = z.strictObject({ id: domainId });
const redirectParams = z.strictObject({ id: redirectId });
const group = 'Sites';

export const listSiteDomains = defineEndpoint({
  operationId: 'listSiteDomains',
  method: 'get',
  path: '/site-domains',
  summary: 'List the domains connected for sites',
  group,
  response: { status: 200, description: 'The domains, by name.', schema: siteDomainList },
});
export const createSiteDomain = defineEndpoint({
  operationId: 'createSiteDomain',
  method: 'post',
  path: '/site-domains',
  summary: 'Connect a domain you own',
  group,
  body: createSiteDomainInput,
  response: {
    status: 201,
    description: 'The domain, not yet verified, with the DNS record to add.',
    schema: siteDomain,
  },
});
export const getSiteDomain = defineEndpoint({
  operationId: 'getSiteDomain',
  method: 'get',
  path: '/site-domains/{id}',
  summary: 'Read a domain',
  group,
  params: domainParams,
  response: { status: 200, description: 'The domain.', schema: siteDomain },
});
export const updateSiteDomain = defineEndpoint({
  operationId: 'updateSiteDomain',
  method: 'patch',
  path: '/site-domains/{id}',
  summary: 'Choose a domain’s default page, its not-found page and its www redirect',
  group,
  params: domainParams,
  body: updateSiteDomainInput,
  response: { status: 200, description: 'The domain after the change.', schema: siteDomain },
});
export const verifySiteDomain = defineEndpoint({
  operationId: 'verifySiteDomain',
  method: 'post',
  path: '/site-domains/{id}/verify',
  summary: 'Check a domain’s DNS record now',
  group,
  params: domainParams,
  response: {
    status: 200,
    description: 'The domain with what the check found: verified, or failed with the reason.',
    schema: siteDomain,
  },
});
export const deleteSiteDomain = defineEndpoint({
  operationId: 'deleteSiteDomain',
  method: 'delete',
  path: '/site-domains/{id}',
  summary: 'Disconnect a domain; its sites stay, without a domain',
  group,
  params: domainParams,
  response: { status: 204, description: 'The domain and its redirects are gone.' },
});
export const listSiteRedirects = defineEndpoint({
  operationId: 'listSiteRedirects',
  method: 'get',
  path: '/site-redirects',
  summary: 'List URL redirects',
  group,
  response: {
    status: 200,
    description: 'The redirects, by domain and path.',
    schema: siteRedirectList,
  },
});
export const createSiteRedirect = defineEndpoint({
  operationId: 'createSiteRedirect',
  method: 'post',
  path: '/site-redirects',
  summary: 'Redirect an address on a domain to a site or a web address',
  group,
  body: createSiteRedirectInput,
  response: { status: 201, description: 'The redirect.', schema: siteRedirect },
});
export const updateSiteRedirect = defineEndpoint({
  operationId: 'updateSiteRedirect',
  method: 'patch',
  path: '/site-redirects/{id}',
  summary: 'Change a redirect',
  group,
  params: redirectParams,
  body: updateSiteRedirectInput,
  response: { status: 200, description: 'The redirect after the change.', schema: siteRedirect },
});
export const deleteSiteRedirect = defineEndpoint({
  operationId: 'deleteSiteRedirect',
  method: 'delete',
  path: '/site-redirects/{id}',
  summary: 'Delete a redirect',
  group,
  params: redirectParams,
  response: { status: 204, description: 'The redirect is gone.' },
});

export const siteDomainEndpoints = [
  listSiteDomains,
  createSiteDomain,
  getSiteDomain,
  updateSiteDomain,
  verifySiteDomain,
  deleteSiteDomain,
  listSiteRedirects,
  createSiteRedirect,
  updateSiteRedirect,
  deleteSiteRedirect,
] as const;
