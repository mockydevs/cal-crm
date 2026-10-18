// Settings → External Tracking, as GoHighLevel names it: one script a business pastes into
// every page of a website it runs elsewhere. The script reports page views, and the forms the
// website's visitors send; a form that gives an email address or a phone number makes or
// finds the contact, and the visitor's earlier page views are linked to it.
//
// The tracking id is public, like a form's key: it tells the script which business it
// reports to and authenticates nothing. Whoever reads a website's source sees it.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { ATTRIBUTION_LIMITS, publicArrival } from './reporting-attribution.js';
import { timestamp } from './timestamps.js';

export const TRACKING_LIMITS = {
  /** The most websites the script may be limited to. */
  allowedDomains: 50,
  domainLength: 253,
  /** The most fields of one form the script sends, and their sizes. */
  fields: 50,
  fieldNameLength: 100,
  fieldLabelLength: 200,
  fieldValueLength: 1000,
  formNameLength: 200,
  titleLength: 300,
  /** How many of the latest events Troubleshoot shows. */
  recentEvents: 50,
  /** How many pages Troubleshoot lists, most recently seen first. */
  pages: 100,
  /** The days Troubleshoot counts a page's views over: what raw events are kept for. */
  days: 30,
} as const;

/** `tk_` and 32 lowercase letters and digits, as GoHighLevel's tracking ids are. */
export const trackingId = z
  .string()
  .regex(/^tk_[a-z0-9]{32}$/)
  .meta({ description: 'The tracking id the script names.', examples: ['tk_' + 'a1'.repeat(16)] });

/**
 * Whether returning visitors are recognised by a random id the script keeps in the
 * website's own storage: always; unless their browser sends the Global Privacy Control
 * signal; or never. A form a visitor sends is captured either way.
 */
export const visitorIdentifications = ['always', 'unless_opted_out', 'never'] as const;
export type VisitorIdentification = (typeof visitorIdentifications)[number];

/** A website's host: lowercase letters, digits, hyphens and dots, as DNS has them. */
export const trackedDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(TRACKING_LIMITS.domainLength)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/,
    'Enter a website’s domain, such as example.com.',
  )
  .meta({ examples: ['example.com'] });

export const externalTracking = z
  .looseObject({
    trackingId,
    pageViews: z.boolean().meta({ description: 'Whether page views are recorded.' }),
    formCapture: z
      .boolean()
      .meta({ description: 'Whether forms sent on the website make or find contacts.' }),
    allowedDomains: z.array(z.string()).meta({
      description:
        'The websites the script answers on; a subdomain of one is the same website. Empty: any website.',
    }),
    visitorIds: z.enum(visitorIdentifications),
    revision: z.int().min(1),
  })
  .meta({ id: 'ExternalTracking', description: "The business's external tracking." });
export type ExternalTracking = z.output<typeof externalTracking>;

export const updateExternalTrackingInput = z.strictObject({
  pageViews: z.boolean(),
  formCapture: z.boolean(),
  allowedDomains: z
    .array(trackedDomain)
    .max(TRACKING_LIMITS.allowedDomains)
    .refine((domains) => new Set(domains).size === domains.length, 'List each website once.'),
  visitorIds: z.enum(visitorIdentifications),
  /** The revision the change was made to: an older one is refused, nothing is overwritten. */
  revision: z.int().min(1),
});
export type UpdateExternalTrackingInput = z.input<typeof updateExternalTrackingInput>;

export const regenerateTrackingIdInput = z.strictObject({ revision: z.int().min(1) });

export const trackingEventKinds = ['page_view', 'form_submission'] as const;
export type TrackingEventKind = (typeof trackingEventKinds)[number];

export const trackingActivity = z
  .looseObject({
    lastEventAt: timestamp.nullable().meta({
      description: 'When the script last reported anything. Null: it has never been heard from.',
    }),
    events: z
      .array(
        z.looseObject({
          receivedAt: timestamp,
          kind: z.enum(trackingEventKinds),
          pageHost: z.string(),
          pagePath: z.string(),
          pageTitle: z.string().nullable(),
          formName: z.string().nullable(),
          contactId: publicId('contact').nullable().meta({
            description: 'The contact the event belongs to; null while the visitor is unknown.',
          }),
        }),
      )
      .meta({ description: 'The latest events, newest first.' }),
    pages: z
      .array(
        z.looseObject({
          pageHost: z.string(),
          pagePath: z.string(),
          pageViews: z.int().min(0),
          formSubmissions: z.int().min(0),
          lastSeenAt: timestamp,
        }),
      )
      .meta({ description: 'The pages heard from in the last 30 days, last seen first.' }),
  })
  .meta({ id: 'TrackingActivity', description: 'What the script has reported lately.' });
export type TrackingActivity = z.output<typeof trackingActivity>;

const group = 'External tracking';

export const getExternalTracking = defineEndpoint({
  operationId: 'getExternalTracking',
  method: 'get',
  path: '/external-tracking',
  group,
  summary: "Read the business's tracking id and what the script does",
  response: { status: 200, description: 'The external tracking.', schema: externalTracking },
});
export const updateExternalTracking = defineEndpoint({
  operationId: 'updateExternalTracking',
  method: 'put',
  path: '/external-tracking',
  group,
  summary: 'Change what the tracking script records and where it answers',
  body: updateExternalTrackingInput,
  response: { status: 200, description: 'The external tracking.', schema: externalTracking },
});
export const regenerateTrackingId = defineEndpoint({
  operationId: 'regenerateTrackingId',
  method: 'post',
  path: '/external-tracking/regenerate',
  group,
  summary: 'Give the business a new tracking id; the old one stops working at once',
  body: regenerateTrackingIdInput,
  response: { status: 200, description: 'The external tracking.', schema: externalTracking },
});
export const getExternalTrackingActivity = defineEndpoint({
  operationId: 'getExternalTrackingActivity',
  method: 'get',
  path: '/external-tracking/activity',
  group,
  summary: 'Read the latest events the script reported, and each page last seen',
  response: { status: 200, description: 'The activity.', schema: trackingActivity },
});

// What the script sends. Every value is whatever a browser said: bounded here, and read by
// the server only for what it is for.

const pageFields = {
  /** The page, as the browser has its address. Only campaign parameters of the query are read. */
  pageUrl: z.url({ protocol: /^https?$/ }).max(ATTRIBUTION_LIMITS.urlLength),
  title: z.string().max(TRACKING_LIMITS.titleLength).optional(),
  /** The page the visitor came from; only its host is kept. */
  referrer: z
    .url({ protocol: /^https?$/ })
    .max(ATTRIBUTION_LIMITS.urlLength)
    .optional(),
  /** The random id the script keeps for a returning visitor; left out when it keeps none. */
  visitorId: z.uuid().optional(),
  /** The random id of the browser tab's visit. */
  sessionId: z.uuid(),
  /** How the visit began, when it began on another page of the same website. */
  first: publicArrival.optional(),
  deviceType: z.enum(['desktop', 'tablet', 'mobile']).optional(),
};

export const publicTrackingField = z.strictObject({
  name: z.string().min(1).max(TRACKING_LIMITS.fieldNameLength),
  label: z.string().max(TRACKING_LIMITS.fieldLabelLength).optional(),
  value: z.string().max(TRACKING_LIMITS.fieldValueLength),
});
export type PublicTrackingField = z.output<typeof publicTrackingField>;

/** A view token: a moment and a keyed digest, as a form's render token is. */
export const trackingViewToken = z.string().regex(/^[0-9]{13}\.[A-Za-z0-9_-]{43}$/);

export const publicTrackingEvent = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('page_view'), ...pageFields }),
    z.strictObject({
      type: z.literal('form_submission'),
      ...pageFields,
      /** What the page view answered: proof the page was shown, and when. */
      viewToken: trackingViewToken,
      /** Chosen by the script for each sent form, so a request sent twice is stored once. */
      clientSubmissionId: z.uuid(),
      formName: z.string().min(1).max(TRACKING_LIMITS.formNameLength),
      fields: z.array(publicTrackingField).max(TRACKING_LIMITS.fields),
    }),
  ])
  .meta({ id: 'PublicTrackingEvent' });
export type PublicTrackingEvent = z.output<typeof publicTrackingEvent>;

/** The whole answer: a view token for a page view, and nothing about any contact. */
export const publicTrackingReceipt = z
  .strictObject({
    status: z.literal('received'),
    viewToken: trackingViewToken.optional(),
  })
  .meta({ id: 'PublicTrackingReceipt' });
export type PublicTrackingReceipt = z.output<typeof publicTrackingReceipt>;

export const postPublicTrackingEvent = defineEndpoint({
  audience: 'public',
  operationId: 'postPublicTrackingEvent',
  method: 'post',
  path: '/public/tracking/{trackingId}/events',
  summary: 'Report a page view or a form sent on a website the script is on',
  group: 'Public tracking',
  params: z.strictObject({ trackingId }),
  body: publicTrackingEvent,
  response: {
    status: 200,
    description: 'Received. The same answer whether or not anything was recorded.',
    schema: publicTrackingReceipt,
  },
});

/** Every endpoint of Settings → External Tracking. */
export const externalTrackingEndpoints = [
  getExternalTracking,
  updateExternalTracking,
  regenerateTrackingId,
  getExternalTrackingActivity,
] as const;

/**
 * The script's own: served by the public transport, not the signed-in API, and so not in
 * its reference, as the public forms' are not.
 */
export const publicTrackingEndpoints = [postPublicTrackingEvent] as const;
