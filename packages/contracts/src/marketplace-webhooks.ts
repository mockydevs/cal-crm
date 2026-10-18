// Webhooks to installed apps. The agency gives an app an https address and the events it
// wants; each event belongs to a read group, and an app may want only events it may read.
// What is sent is thin: the event, its time, the app, the install, the business and the
// subject's id. The app reads the record itself, with its access token.
import * as z from 'zod';

import type { ApiKeyReadGroup } from './api-keys.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/**
 * The events an app may subscribe to, each with the read group it belongs to. They are the
 * events automations start from, under the names the event log gives them.
 */
export const appWebhookEventGroups = {
  'contact.created': 'Contacts',
  'contact.updated': 'Contacts',
  'tag.assigned': 'Tags',
  'tag.removed': 'Tags',
  'deal.created': 'Deals',
  'deal.stage_changed': 'Deals',
  'deal.won': 'Deals',
  'deal.lost': 'Deals',
  'appointment.booked': 'Calendars',
  'appointment.rescheduled': 'Calendars',
  'appointment.status_changed': 'Calendars',
  'appointment.cancelled': 'Calendars',
  'form.submitted': 'Forms',
  'message.received': 'Inbox',
  'task.created': 'Tasks',
  'task.completed': 'Tasks',
  'note.created': 'Notes',
  'invoice.paid': 'Quotes and invoices',
  'payment.recorded': 'Payments',
} as const satisfies Readonly<Record<string, ApiKeyReadGroup>>;
export type AppWebhookEvent = keyof typeof appWebhookEventGroups;
export const appWebhookEvents = Object.keys(appWebhookEventGroups) as AppWebhookEvent[];

/** Every app with a webhook gets these, whether or not it subscribed. */
export const appLifecycleEvents = ['app.installed', 'app.uninstalled'] as const;

/** What the event log calls the two lifecycle events. */
export const appLifecycleEventTypes = {
  'marketplace_app.installed': 'app.installed',
  'marketplace_app.uninstalled': 'app.uninstalled',
} as const;

export const MAX_WEBHOOK_EVENTS = 64;

/** The events chosen, each once, each of a group the app may read. */
export function webhookEventsProblem(
  events: readonly string[],
  readGroups: readonly string[],
): string | undefined {
  for (const event of events) {
    const group = (appWebhookEventGroups as Readonly<Record<string, string>>)[event];
    if (group !== undefined && !readGroups.includes(group))
      return `To send ${event}, let the app read ${group}.`;
  }
  return undefined;
}

export const webhookEvent = z.enum(appWebhookEvents as [AppWebhookEvent, ...AppWebhookEvent[]]);

/**
 * The body every delivery sends, as JSON. The delivery's id, the same on every attempt, is
 * in the X-CRM-Delivery header.
 */
export const appWebhookBody = z
  .looseObject({
    type: z.string().meta({ examples: ['contact.created', 'app.installed'] }),
    occurredAt: timestamp,
    appId: publicId('marketplace_app'),
    installId: publicId('marketplace_install'),
    businessId: publicId('business'),
    subject: z
      .looseObject({ kind: z.string(), id: z.string() })
      .nullable()
      .meta({ description: 'The record it happened to, by its public id.' }),
  })
  .meta({ id: 'AppWebhookBody' });
export type AppWebhookBody = z.output<typeof appWebhookBody>;

export const appWebhookSecret = z
  .looseObject({
    secret: z.string().meta({ description: 'Shown once. Only the worker can open it again.' }),
    setAt: timestamp,
  })
  .meta({ id: 'AppWebhookSecret' });
export type AppWebhookSecret = z.output<typeof appWebhookSecret>;

export const marketplaceDeliveryStatuses = ['pending', 'delivered', 'failed'] as const;
export type MarketplaceDeliveryStatus = (typeof marketplaceDeliveryStatuses)[number];

export const marketplaceDelivery = z
  .looseObject({
    id: publicId('marketplace_delivery'),
    eventType: z.string(),
    business: z.looseObject({ id: publicId('business'), name: z.string() }),
    status: z.enum(marketplaceDeliveryStatuses),
    attempts: z.int().min(0),
    lastStatus: z.int().nullable().meta({ description: 'The HTTP status the app last answered.' }),
    lastError: z.string().nullable().meta({ description: 'Why the last attempt failed.' }),
    lastAttemptAt: timestamp.nullable(),
    nextAttemptAt: timestamp.nullable(),
    deliveredAt: timestamp.nullable(),
    createdAt: timestamp,
  })
  .meta({ id: 'MarketplaceDelivery' });
export type MarketplaceDelivery = z.output<typeof marketplaceDelivery>;

export const listMarketplaceDeliveriesQuery = z
  .strictObject({
    status: z.enum(marketplaceDeliveryStatuses).optional(),
  })
  .meta({ id: 'ListMarketplaceDeliveriesQuery' });

export const marketplaceDeliveryList = z.looseObject({ items: z.array(marketplaceDelivery) }).meta({
  id: 'MarketplaceDeliveryList',
  description: 'The app’s latest 50 deliveries across the agency’s businesses, newest first.',
});

const group = 'App Marketplace';
const appParams = z.strictObject({ appId: publicId('marketplace_app') });

export const generateAppWebhookSecret = defineEndpoint({
  operationId: 'generateAppWebhookSecret',
  method: 'post',
  path: '/agency/marketplace/apps/{appId}/webhook-secret',
  group,
  summary: 'Generate the secret the app’s webhooks are signed with, replacing the one it had',
  params: appParams,
  response: {
    status: 201,
    description: 'The new secret, shown this once.',
    schema: appWebhookSecret,
  },
});
export const listMarketplaceDeliveries = defineEndpoint({
  operationId: 'listMarketplaceDeliveries',
  method: 'get',
  path: '/agency/marketplace/apps/{appId}/deliveries',
  group,
  summary: 'List the app’s latest webhook deliveries',
  params: appParams,
  query: listMarketplaceDeliveriesQuery,
  response: { status: 200, description: 'The deliveries.', schema: marketplaceDeliveryList },
});
export const redeliverMarketplaceWebhook = defineEndpoint({
  operationId: 'redeliverMarketplaceWebhook',
  method: 'post',
  path: '/agency/marketplace/deliveries/{deliveryId}/redeliver',
  group,
  summary: 'Send a webhook delivery again',
  params: z.strictObject({ deliveryId: publicId('marketplace_delivery') }),
  response: {
    status: 200,
    description: 'The delivery, waiting to be sent again.',
    schema: marketplaceDelivery,
  },
});

export const marketplaceWebhookEndpoints = [
  generateAppWebhookSecret,
  listMarketplaceDeliveries,
  redeliverMarketplaceWebhook,
] as const;
