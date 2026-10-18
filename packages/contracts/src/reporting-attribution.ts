// Where a contact came from: the words attribution is kept in, what a public page may say
// about the visit that led to it, and what a contact's page shows. A touch is one recorded
// interaction; the first never changes and the latest moves with each new one.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/**
 * The click ids a touch can hold, by the name each has in an address. A contact's page is
 * told which are held and never their values: a click id identifies one person's click to
 * an advertising platform, so it stays in the database, for the day a conversion is sent
 * back to that platform, and no response of the API carries it.
 */
export const clickIdNames = [
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'ctwa_clid',
  'ttclid',
  'li_fat_id',
] as const;
export type ClickIdName = (typeof clickIdNames)[number];

/**
 * The channel a touch came through, as GoHighLevel names them ("Session Source"). How one
 * is decided is the CRM module's rule (attribution/session-source.ts).
 */
export const sessionSources = [
  'paid_search',
  'paid_social',
  'social_media',
  'organic_search',
  'referral',
  'direct',
  'others',
  'crm_ui',
  'third_party',
] as const;
export type SessionSource = (typeof sessionSources)[number];

/** The kind of interaction that recorded a touch ("Medium"). */
export const attributionMediums = [
  'form',
  'calendar',
  'chat',
  'manual',
  'api',
  'import',
  'message',
  'automation',
  'assistant',
  'unknown',
] as const;
export type AttributionMedium = (typeof attributionMediums)[number];

/**
 * Every query parameter the CRM reads from a page's address to know how a visitor arrived:
 * campaign labels, ad ids, click ids and `source`. One list, held to the CRM module's own
 * reader (attribution/session-source.ts) and to the page script that keeps an arrival
 * between pages (packages/site-render/runtime/arrival.ts) by a test in each.
 */
export const ATTRIBUTION_PARAMETERS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'utm_keyword',
  'utm_matchtype',
  'matchtype',
  'campaign_id',
  'utm_id',
  'ad_group_id',
  'adgroup_id',
  'adset_id',
  'ad_id',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'ctwa_clid',
  'ttclid',
  'li_fat_id',
  'source',
] as const;

/** The longest of each thing a public page may say about a visit. */
export const ATTRIBUTION_LIMITS = {
  /** A campaign label, a click id or an ad id. */
  valueLength: 200,
  urlLength: 2000,
  domainLength: 255,
  /**
   * How long an arrival that was carried from page to page is believed, in days: the
   * longest click window an ad platform's setup names.
   */
  arrivalDays: 90,
} as const;

/**
 * How a visit began, when the page a lead is taken on is not the page the visitor landed
 * on: the address of that first page, with its query, the site they came to it from, and
 * when. Kept by the visitor's own browser tab and handed over by the CRM's own page script;
 * whatever a browser says, so the server reads it as it reads the page's own address, only
 * when it is on the same website as that page, and believes it for nothing but the
 * contact's attribution.
 */
export const publicArrival = z
  .strictObject({
    pageUrl: z
      .url({ protocol: /^https?$/ })
      .max(ATTRIBUTION_LIMITS.urlLength)
      .meta({ description: 'The page the visit began on, with its query.' }),
    referrer: z
      .url({ protocol: /^https?$/ })
      .max(ATTRIBUTION_LIMITS.urlLength)
      .optional()
      .meta({ description: 'The site the visitor came to that page from: its origin.' }),
    at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().meta({
      description:
        'When the visit began, in milliseconds since 1970, by the clock of the browser. One older than 90 days, or from the future, is not believed.',
    }),
  })
  .meta({ id: 'PublicArrival' });
export type PublicArrival = z.output<typeof publicArrival>;

/**
 * What a public page says about the visit that led to a booking or a chat: the address of
 * the page, with its query, and the address the visitor came from. Both are whatever the
 * browser says, so the server reads a fixed list of query parameters out of the first,
 * each bounded, keeps the page without its query, and keeps only the host of the second.
 */
export const publicVisit = z.strictObject({
  pageUrl: z
    .url({ protocol: /^https?$/ })
    .max(ATTRIBUTION_LIMITS.urlLength)
    .optional()
    .meta({ description: 'The page the visitor is on, with its query.' }),
  referrer: z
    .url({ protocol: /^https?$/ })
    .max(ATTRIBUTION_LIMITS.urlLength)
    .optional()
    .meta({ description: 'The address the visitor came from, as the browser gives it.' }),
  first: publicArrival.optional().meta({
    description:
      'How the visit began, when it began on another page of the same website. Used when the address of the page itself says nothing of how the visitor arrived.',
  }),
});
export type PublicVisit = z.output<typeof publicVisit>;

const label = z.string().nullable();

/**
 * One touch, as a contact's page shows it. Everything a visit did not say is null. It has
 * no field for a click id's value, only `clickIds`, the names of those held.
 */
export const contactAttribution = z
  .looseObject({
    touchedAt: timestamp,
    medium: z.enum(attributionMediums),
    sessionSource: z.enum(sessionSources),
    utmSource: label,
    utmMedium: label,
    utmCampaign: label,
    utmContent: label,
    utmTerm: label,
    matchType: label,
    campaignId: label,
    adGroupId: label,
    adId: label,
    referrerDomain: label,
    landingUrl: label.meta({ description: 'The page, without its query and fragment.' }),
    pageUrl: label.meta({
      description:
        'The page the interaction happened on, without its query. The same as landingUrl unless the visit began on another page and was carried here (arrivalCarried).',
    }),
    source: label.meta({
      description:
        'The lead source: one name for how they arrived, such as "Google Ads". Null for a touch that was not a visit to a page.',
      examples: ['Google Ads'],
    }),
    sourceRule: label.meta({
      description:
        'What decided the lead source: the key of a built-in rule (leadSourceKeys). The key stays when a name is reworded.',
      examples: ['google_ads'],
    }),
    arrivalCarried: z.boolean().optional().meta({
      description:
        'True when how the visitor arrived was handed on from the page the visit began on (landingUrl) to the page the lead was taken on (pageUrl).',
    }),
    clickIds: z.array(z.enum(clickIdNames)).meta({
      description:
        'Which click ids the touch holds, by name: what a screen shows instead of their values.',
    }),
  })
  .meta({ id: 'ContactAttribution' });
export type ContactAttribution = z.output<typeof contactAttribution>;

/** A contact's first and latest touch. Both null for a contact with none recorded. */
export const contactAttributions = z
  .looseObject({
    first: contactAttribution.nullable(),
    latest: contactAttribution.nullable().meta({
      description: 'The newest touch. The same as the first while there is only one.',
    }),
  })
  .meta({ id: 'ContactAttributions' });
export type ContactAttributions = z.output<typeof contactAttributions>;

export const getContactAttribution = defineEndpoint({
  operationId: 'getContactAttribution',
  method: 'get',
  path: '/contacts/{id}/attribution',
  summary: "Read a contact's first and latest attribution",
  group: 'Contacts',
  params: z.strictObject({ id: publicId('contact') }),
  response: {
    status: 200,
    description: 'Where the contact first came from, and where it last came from.',
    schema: contactAttributions,
  },
});

export const contactAttributionEndpoints = [getContactAttribution] as const;
