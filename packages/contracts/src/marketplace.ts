// The App Marketplace. The agency publishes apps: a listing, and the permissions
// the app asks for. A business browses the listed ones, installs one with consent and
// uninstalls it. An install grants the requested scopes its installer holds, and no others.
// The limits match tenancy.marketplace_apps and tenancy.marketplace_installs (0112).
import * as z from 'zod';

import { apiKeyScopes, apiKeySelectableReadGroups } from './api-keys.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { permissions } from './permissions.js';
import { MAX_WEBHOOK_EVENTS, webhookEvent } from './marketplace-webhooks.js';
import { timestamp } from './timestamps.js';

/** What an app is about, for the marketplace's filter. The words are the dashboard's. */
export const marketplaceCategories = [
  'analytics',
  'calendars',
  'communication',
  'marketing',
  'payments',
  'productivity',
  'reporting',
  'sales',
  'other',
] as const;
export type MarketplaceCategory = (typeof marketplaceCategories)[number];

/** draft: the agency's eyes only. listed: its businesses see and install it. delisted: no new installs. */
export const marketplaceAppStatuses = ['draft', 'listed', 'delisted'] as const;
export type MarketplaceAppStatus = (typeof marketplaceAppStatuses)[number];

export const MARKETPLACE_LIMITS = {
  name: 80,
  tagline: 140,
  description: 5000,
  developer: 80,
  categories: 5,
} as const;

const https = z
  .url({ protocol: /^https$/, error: 'Use an address that starts with https://.' })
  .max(2048, { error: 'Use at most 2,048 characters.' });
/** http is for this computer only, for development (RFC 8252 section 7.3). */
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?([/?]|$)/;
const absolute = z.url({ protocol: /^https?$/ });

/**
 * Whether an address can take an app's authorization codes: https, or http on
 * this computer; absolute, with no fragment (RFC 6749 section 3.1.2) and no user name.
 * Read without a URL parser of our own: the contracts run anywhere.
 */
export function isRedirectUri(value: string): boolean {
  return (
    value.length <= 2048 &&
    absolute.safeParse(value).success &&
    !value.includes('#') &&
    !/^[a-z]+:\/\/[^/?]*@/i.test(value) &&
    (value.startsWith('https://') || LOOPBACK.test(value))
  );
}

export const MAX_REDIRECT_URIS = 10;

const redirectUri = z.string().trim().refine(isRedirectUri, {
  error:
    'Use an https:// address without a # part, or http://localhost for testing on your computer.',
});

const scope = z.enum(permissions).refine((key) => apiKeyScopes.includes(key), {
  error: 'An app can ask only for what an API key may hold.',
});

export const marketplaceAppInput = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1, { error: 'Give the app a name.' })
      .max(MARKETPLACE_LIMITS.name, { error: 'Use at most 80 characters.' }),
    tagline: z
      .string()
      .trim()
      .max(MARKETPLACE_LIMITS.tagline, { error: 'Use at most 140 characters.' })
      .default(''),
    description: z
      .string()
      .max(MARKETPLACE_LIMITS.description, { error: 'Use at most 5,000 characters.' })
      .default(''),
    developer: z
      .string()
      .trim()
      .min(1, { error: 'Say who makes the app.' })
      .max(MARKETPLACE_LIMITS.developer, { error: 'Use at most 80 characters.' }),
    websiteUrl: https.nullable().default(null),
    supportEmail: z.email({ error: 'Use an email address.' }).max(320).nullable().default(null),
    iconUrl: https.nullable().default(null),
    categories: z
      .array(z.enum(marketplaceCategories))
      .max(MARKETPLACE_LIMITS.categories, { error: 'Choose at most 5 categories.' })
      .refine((items) => new Set(items).size === items.length, {
        error: 'Choose each category once.',
      })
      .default([]),
    scopes: z
      .array(scope)
      .refine((items) => new Set(items).size === items.length, {
        error: 'Name each permission once.',
      })
      .default([])
      .meta({ description: 'The permissions the app asks a business for: API key scopes.' }),
    readGroups: z
      .array(z.enum(apiKeySelectableReadGroups))
      .refine((items) => new Set(items).size === items.length, {
        error: 'Name each group once.',
      })
      .default([])
      .meta({
        description: 'What the app may read, by the API reference’s groups. It reads nothing else.',
      }),
    redirectUris: z
      .array(redirectUri)
      .max(MAX_REDIRECT_URIS, { error: 'List at most 10 redirect addresses.' })
      .refine((items) => new Set(items).size === items.length, {
        error: 'List each redirect address once.',
      })
      .default([])
      .meta({
        description:
          'Where the app may receive authorization codes. A request must name one exactly.',
      }),
    webhookUrl: https.nullable().default(null).meta({
      description:
        'Where the app hears of events: app.installed, app.uninstalled and those it subscribes to.',
    }),
    webhookEvents: z
      .array(webhookEvent)
      .max(MAX_WEBHOOK_EVENTS)
      .refine((items) => new Set(items).size === items.length, {
        error: 'Choose each event once.',
      })
      .default([])
      .meta({
        description:
          'The events the app subscribes to. Each belongs to a read group the app must be able to read.',
      }),
  })
  .meta({ id: 'MarketplaceAppInput' });

export const createMarketplaceAppInput = marketplaceAppInput.meta({
  id: 'CreateMarketplaceAppInput',
  description: 'A new app starts as a draft: only the agency sees it until it is listed.',
});
export const updateMarketplaceAppInput = marketplaceAppInput
  .extend({ status: z.enum(marketplaceAppStatuses) })
  .meta({
    id: 'UpdateMarketplaceAppInput',
    description:
      'The whole app. Listing it shows it to every business of the agency; delisting it stops new installs and leaves existing ones working.',
  });

const appFields = {
  id: publicId('marketplace_app'),
  name: z.string(),
  tagline: z.string(),
  description: z.string(),
  developer: z.string(),
  websiteUrl: z.string().nullable(),
  supportEmail: z.string().nullable(),
  iconUrl: z.string().nullable(),
  categories: z.array(z.enum(marketplaceCategories)),
  scopes: z.array(z.string()),
  readGroups: z.array(z.string()),
  webhookEvents: z
    .array(z.string())
    .meta({ description: 'The events the app is told of in a business that installs it.' }),
  status: z.enum(marketplaceAppStatuses),
  createdAt: timestamp,
  updatedAt: timestamp,
};

export const agencyMarketplaceApp = z
  .looseObject({
    ...appFields,
    installCount: z.int().min(0).meta({ description: 'Businesses that have it installed now.' }),
    redirectUris: z.array(z.string()),
    clientSecretPrefix: z
      .string()
      .nullable()
      .meta({ description: "The start of the app's client secret, or null when it has none." }),
    clientSecretSetAt: timestamp.nullable(),
    webhookUrl: z.string().nullable(),
    webhookSecretSetAt: timestamp
      .nullable()
      .meta({ description: 'When the webhook signing secret was made, or null when it has none.' }),
  })
  .meta({ id: 'AgencyMarketplaceApp' });
export type AgencyMarketplaceApp = z.output<typeof agencyMarketplaceApp>;

export const marketplaceInstall = z
  .looseObject({
    id: publicId('marketplace_install'),
    appId: publicId('marketplace_app'),
    grantedScopes: z.array(z.string()),
    grantedReadGroups: z.array(z.string()),
    installedBy: z
      .string()
      .nullable()
      .meta({ description: "Who installed it. Null when they're gone, or you can't see them." }),
    installedAt: timestamp,
  })
  .meta({ id: 'MarketplaceInstall' });
export type MarketplaceInstall = z.output<typeof marketplaceInstall>;

export const marketplaceApp = z
  .looseObject({
    ...appFields,
    install: marketplaceInstall
      .nullable()
      .meta({ description: "This business's live install of the app, or null." }),
  })
  .meta({ id: 'MarketplaceApp' });
export type MarketplaceApp = z.output<typeof marketplaceApp>;

export const marketplaceAppDetail = marketplaceApp
  .extend({
    missingScopes: z.array(z.string()).meta({
      description:
        "The app's permissions the caller doesn't hold: while there are any, they can't install it.",
    }),
    canInstall: z
      .boolean()
      .meta({ description: 'Whether the caller may install or uninstall apps here.' }),
  })
  .meta({ id: 'MarketplaceAppDetail' });
export type MarketplaceAppDetail = z.output<typeof marketplaceAppDetail>;

export const listMarketplaceAppsQuery = z
  .strictObject({
    q: z
      .string()
      .trim()
      .max(200, { error: 'Use at most 200 characters.' })
      .optional()
      .meta({ description: 'Finds apps by any part of their name, line or developer.' }),
    category: z.enum(marketplaceCategories).optional(),
  })
  .meta({ id: 'ListMarketplaceAppsQuery' });
export type ListMarketplaceAppsQuery = z.output<typeof listMarketplaceAppsQuery>;

export const marketplaceAppList = z
  .looseObject({ items: z.array(marketplaceApp), canInstall: z.boolean() })
  .meta({ id: 'MarketplaceAppList', description: 'The listed apps, by name.' });
export const agencyMarketplaceAppList = z
  .looseObject({ items: z.array(agencyMarketplaceApp) })
  .meta({ id: 'AgencyMarketplaceAppList', description: 'Every app of the agency, by name.' });
export const installedMarketplaceAppList = z
  .looseObject({ items: z.array(marketplaceApp), canInstall: z.boolean() })
  .meta({
    id: 'InstalledMarketplaceAppList',
    description: 'The apps this business has installed, by name, delisted ones included.',
  });

const group = 'App Marketplace';
const appParams = z.strictObject({ appId: publicId('marketplace_app') });

export const listAgencyMarketplaceApps = defineEndpoint({
  operationId: 'listAgencyMarketplaceApps',
  method: 'get',
  path: '/agency/marketplace/apps',
  group,
  summary: "List the agency's apps, drafts included",
  response: { status: 200, description: "The agency's apps.", schema: agencyMarketplaceAppList },
});
export const createMarketplaceApp = defineEndpoint({
  operationId: 'createMarketplaceApp',
  method: 'post',
  path: '/agency/marketplace/apps',
  group,
  summary: 'Add an app to the agency, as a draft',
  body: createMarketplaceAppInput,
  response: { status: 201, description: 'The new draft.', schema: agencyMarketplaceApp },
});
export const updateMarketplaceApp = defineEndpoint({
  operationId: 'updateMarketplaceApp',
  method: 'put',
  path: '/agency/marketplace/apps/{appId}',
  group,
  summary: 'Change an app, and list or delist it',
  params: appParams,
  body: updateMarketplaceAppInput,
  response: { status: 200, description: 'The saved app.', schema: agencyMarketplaceApp },
});
export const listMarketplaceApps = defineEndpoint({
  operationId: 'listMarketplaceApps',
  method: 'get',
  path: '/marketplace/apps',
  group,
  summary: 'Browse the listed apps, with this business’s installs',
  query: listMarketplaceAppsQuery,
  response: { status: 200, description: 'The listed apps.', schema: marketplaceAppList },
});
export const getMarketplaceApp = defineEndpoint({
  operationId: 'getMarketplaceApp',
  method: 'get',
  path: '/marketplace/apps/{appId}',
  group,
  summary: 'Read an app: what it asks for, and whether it is installed here',
  params: appParams,
  response: {
    status: 200,
    description: 'The app, if it is listed or installed here.',
    schema: marketplaceAppDetail,
  },
});
export const installMarketplaceApp = defineEndpoint({
  operationId: 'installMarketplaceApp',
  method: 'post',
  path: '/marketplace/apps/{appId}/install',
  group,
  summary: 'Install a listed app in this business, granting what it asks for',
  params: appParams,
  response: {
    status: 201,
    description: 'The install, with the permissions it was granted.',
    schema: marketplaceInstall,
  },
});
export const listInstalledMarketplaceApps = defineEndpoint({
  operationId: 'listInstalledMarketplaceApps',
  method: 'get',
  path: '/marketplace/installs',
  group,
  summary: 'List the apps installed in this business',
  response: {
    status: 200,
    description: 'The installed apps.',
    schema: installedMarketplaceAppList,
  },
});
export const uninstallMarketplaceApp = defineEndpoint({
  operationId: 'uninstallMarketplaceApp',
  method: 'delete',
  path: '/marketplace/installs/{installId}',
  group,
  summary: 'Uninstall an app from this business',
  params: z.strictObject({ installId: publicId('marketplace_install') }),
  response: { status: 204, description: 'Uninstalled: the app has no grant here any more.' },
});

export const marketplaceEndpoints = [
  listAgencyMarketplaceApps,
  createMarketplaceApp,
  updateMarketplaceApp,
  listMarketplaceApps,
  getMarketplaceApp,
  installMarketplaceApp,
  listInstalledMarketplaceApps,
  uninstallMarketplaceApp,
] as const;
