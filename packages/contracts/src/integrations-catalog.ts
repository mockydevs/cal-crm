// The catalogue of Settings → Integrations, in code and versioned with it, as the automation
// catalogue is. Two kinds of entry:
//
// - a connection made on this page: a provider the install's own code calls with the
//   business's credentials, kept in integrations.connections. Each one the server can
//   connect is described by its provider (the integrations module); none ships yet, so an
//   install lists only those its code registers;
// - a connection that lives on a page of its own and keeps its own tables (Google Calendar,
//   mailboxes, the phone system, email verification, AI models, apps and API keys). Its card
//   shows the status that module reads and its Manage button opens that page.
//
// The names and descriptions here are the API's words; the dashboard says them in the
// reader's language.
import * as z from 'zod';

import type { Permission } from './permissions.js';

/** The chips above the grid, in their order; a category with no card is not drawn. */
export const integrationCategories = [
  'calendar_email',
  'phone_messaging',
  'ai',
  'lead_intake',
  'payments_accounting',
  'ecommerce',
  'productivity',
  'forms',
  'developers',
] as const;
export type IntegrationCategory = (typeof integrationCategories)[number];

/**
 * Keys under /integrations/{key} that are not providers: Google Calendar's own routes have
 * been at /integrations/google since before this page, and Google redirects to the address
 * operators registered there.
 */
export const reservedIntegrationKeys = ['google'] as const;

/** A provider's key: the catalogue's, and the second part of its vault purpose. */
export const integrationKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, { error: 'Not an integration.', abort: true })
  .refine((key) => !(reservedIntegrationKeys as readonly string[]).includes(key), {
    error: 'Not an integration.',
  })
  .meta({ description: 'The integration’s key.', examples: ['slack'] });

/** How a business connects a provider on this page. */
export const integrationAuthKinds = ['oauth2', 'api_key'] as const;
export type IntegrationAuthKind = (typeof integrationAuthKinds)[number];

/** The pages that keep their own connections, as the dashboard names them. */
export const integrationPages = [
  'calendar_connections',
  'email_services',
  'phone_system',
  'email_verification',
  'ai_models',
  'apps_and_api_keys',
] as const;
export type IntegrationPage = (typeof integrationPages)[number];

/** What an install's operator reads to set an integration up, in the project's docs. */
export const OPERATOR_SETTINGS_GUIDE = 'docs/HOSTING.md#51-what-you-set';

export interface ElsewhereIntegration {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly category: IntegrationCategory;
  readonly page: IntegrationPage;
  /** What the page itself needs to change anything; its Manage button is for those who hold it. */
  readonly permission: Permission;
  /** Where the operator learns what the install needs for it; null when it needs nothing. */
  readonly operatorGuide: string | null;
}

/** The connections that live on pages of their own, in the order the grid shows them. */
export const elsewhereIntegrations: readonly ElsewhereIntegration[] = [
  {
    key: 'google_calendar',
    name: 'Google Calendar',
    description:
      'Two-way sync for each team member: bookings go into their calendar, and busy time keeps slots free.',
    category: 'calendar_email',
    page: 'calendar_connections',
    permission: 'appointments.manage',
    operatorGuide: OPERATOR_SETTINGS_GUIDE,
  },
  {
    key: 'mailboxes',
    name: 'Email Services',
    description: 'Connect any mailbox to send from it and read its replies into Conversations.',
    category: 'calendar_email',
    page: 'email_services',
    permission: 'mailboxes.manage',
    operatorGuide: OPERATOR_SETTINGS_GUIDE,
  },
  {
    key: 'emailable',
    name: 'Email Verification',
    description: 'Check email addresses with Emailable before anything is sent to them.',
    category: 'calendar_email',
    page: 'email_verification',
    permission: 'email.verification.manage',
    operatorGuide: OPERATOR_SETTINGS_GUIDE,
  },
  {
    key: 'twilio',
    name: 'Phone System',
    description: 'Text messages and calls through your own Twilio account.',
    category: 'phone_messaging',
    page: 'phone_system',
    permission: 'sms.manage',
    operatorGuide: OPERATOR_SETTINGS_GUIDE,
  },
  {
    key: 'ai_models',
    name: 'AI Models',
    description: 'Your own keys for Anthropic, OpenAI or a model server of your own.',
    category: 'ai',
    page: 'ai_models',
    permission: 'ai.manage',
    operatorGuide: OPERATOR_SETTINGS_GUIDE,
  },
  {
    key: 'apps_and_api_keys',
    name: 'Apps and API keys',
    description:
      'Keys for your own code, Zapier, Make or n8n, and the marketplace apps you installed.',
    category: 'developers',
    page: 'apps_and_api_keys',
    permission: 'apps.manage',
    operatorGuide: null,
  },
];

/**
 * What a module reads of its own connections for the grid, in the business it is asked in:
 * how many are working, how many need someone, and the account's name when there is one.
 */
export interface IntegrationReading {
  readonly connected: number;
  readonly attention: number;
  /** The one account's name, such as a Twilio account's; null with none or several. */
  readonly label: string | null;
}

/** Nothing connected: what a module reads where it has no rows. */
export const noIntegrationReading: IntegrationReading = { connected: 0, attention: 0, label: null };
