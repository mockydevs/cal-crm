// What the App Marketplace pages work out before they draw: the words for a category, a
// status, a permission and a webhook event, the moves each status has, which installed apps
// a search finds, and an app's form as the API takes it, checked by the API's own schema so
// the messages match the server's.
import type { I18n, MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import {
  createMarketplaceAppInput,
  updateMarketplaceAppInput,
  type AgencyMarketplaceApp,
  type AppWebhookEvent,
  type MarketplaceApp,
  type MarketplaceAppStatus,
  type MarketplaceCategory,
  type MarketplaceDeliveryStatus,
} from '@repo/contracts';
import type * as z from 'zod';
import { permissionNames } from './permission-names';

export const categoryNames: Readonly<Record<MarketplaceCategory, MessageDescriptor>> = {
  analytics: msg`Analytics`,
  calendars: msg`Calendars`,
  communication: msg`Communication`,
  marketing: msg`Marketing`,
  payments: msg`Payments`,
  productivity: msg`Productivity`,
  reporting: msg`Reporting`,
  sales: msg`Sales`,
  other: msg`Other`,
};

export const statusNames: Readonly<Record<MarketplaceAppStatus, MessageDescriptor>> = {
  draft: msg`Draft`,
  listed: msg`Listed`,
  delisted: msg`Delisted`,
};

/** What each webhook event tells, as the app's page and its form say it. */
export const eventNames: Readonly<
  Record<AppWebhookEvent | 'app.installed' | 'app.uninstalled', MessageDescriptor>
> = {
  'contact.created': msg`A contact is created`,
  'contact.updated': msg`A contact changes`,
  'tag.assigned': msg`A tag is added to a record`,
  'tag.removed': msg`A tag is taken off a record`,
  'deal.created': msg`An opportunity is created`,
  'deal.stage_changed': msg`An opportunity moves to another stage`,
  'deal.won': msg`An opportunity is won`,
  'deal.lost': msg`An opportunity is lost`,
  'appointment.booked': msg`An appointment is booked`,
  'appointment.rescheduled': msg`An appointment is moved`,
  'appointment.status_changed': msg`An appointment’s status changes`,
  'appointment.cancelled': msg`An appointment is cancelled`,
  'form.submitted': msg`A form is sent`,
  'message.received': msg`A message comes in`,
  'task.created': msg`A task is created`,
  'task.completed': msg`A task is done`,
  'note.created': msg`A note is added`,
  'invoice.paid': msg`An invoice is paid`,
  'payment.recorded': msg`A payment is recorded`,
  'app.installed': msg`The app is installed`,
  'app.uninstalled': msg`The app is uninstalled`,
};

/** An event in people's words; else its name. */
export function eventName(type: string, i18n: I18n): string {
  const name = (eventNames as Readonly<Record<string, MessageDescriptor>>)[type];
  return name === undefined ? type : i18n._(name);
}

export const deliveryStatusNames: Readonly<Record<MarketplaceDeliveryStatus, MessageDescriptor>> = {
  pending: msg`Waiting`,
  delivered: msg`Delivered`,
  failed: msg`Failed`,
};

/**
 * The address an app's developer sends a person to, to connect, with the values
 * the app fills in shown as placeholders.
 */
export function authorizationUrlOf(origin: string, clientId: string, redirectUri: string): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
  }).toString();
  return `${origin}/oauth/authorize?${query}${FILLED_IN_BY_THE_APP}`;
}

/** The parameters each request has its own values for, as placeholders. */
const FILLED_IN_BY_THE_APP =
  '&state={state}&code_challenge={S256 challenge}&code_challenge_method=S256';

/** A permission in people's words, as roles and API keys say it; else its key. */
export function scopeName(scope: string, i18n: I18n): string {
  const name = permissionNames[scope];
  return name === undefined ? scope : i18n._(name);
}

export interface StatusAction {
  readonly to: MarketplaceAppStatus;
  readonly label: MessageDescriptor;
}

const list: StatusAction = { to: 'listed', label: msg`List` };
const delist: StatusAction = { to: 'delisted', label: msg`Delist` };
const toDraft: StatusAction = { to: 'draft', label: msg`Back to draft` };

/** Where an app can go from where it is: listed for businesses, delisted, or a draft again. */
export function statusActions(status: MarketplaceAppStatus): readonly StatusAction[] {
  if (status === 'draft') return [list];
  return status === 'listed' ? [delist, toDraft] : [list, toDraft];
}

/** Whether an installed app is one the search finds, as the API finds listed ones. */
export function matchesApp(
  app: MarketplaceApp,
  q: string,
  category: MarketplaceCategory | undefined,
): boolean {
  if (category !== undefined && !app.categories.includes(category)) return false;
  const words = q.trim().toLocaleLowerCase();
  return [app.name, app.tagline, app.developer].some((text) =>
    text.toLocaleLowerCase().includes(words),
  );
}

/** What the app form holds: its text as typed, and what is ticked. */
export interface AppDraft {
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly developer: string;
  readonly websiteUrl: string;
  readonly supportEmail: string;
  readonly iconUrl: string;
  readonly categories: readonly MarketplaceCategory[];
  readonly scopes: readonly string[];
  readonly readGroups: readonly string[];
  /** One address a line, as the box shows them. */
  readonly redirectUris: string;
  readonly webhookUrl: string;
  readonly webhookEvents: readonly string[];
}

/** The form for a saved app, or for a new one. */
export function appDraftOf(app: AgencyMarketplaceApp | undefined): AppDraft {
  return {
    name: app?.name ?? '',
    tagline: app?.tagline ?? '',
    description: app?.description ?? '',
    developer: app?.developer ?? '',
    websiteUrl: app?.websiteUrl ?? '',
    supportEmail: app?.supportEmail ?? '',
    iconUrl: app?.iconUrl ?? '',
    categories: app?.categories ?? [],
    scopes: app?.scopes ?? [],
    readGroups: app?.readGroups ?? [],
    redirectUris: (app?.redirectUris ?? []).join('\n'),
    webhookUrl: app?.webhookUrl ?? '',
    webhookEvents: app?.webhookEvents ?? [],
  };
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');
/** An address left blank is none. */
const optionalOf = (value: unknown): string | null => {
  const text = textOf(value).trim();
  return text === '' ? null : text;
};

/** The addresses in the box: one a line, blank lines left out. */
export const redirectUrisOf = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** The form's fields by name, and what is ticked, as the API takes a new app. */
export function appInputOf(
  values: Readonly<Record<string, unknown>>,
  chosen: {
    readonly categories: readonly MarketplaceCategory[];
    readonly scopes: readonly string[];
    readonly readGroups: readonly string[];
    readonly webhookEvents: readonly string[];
  },
): z.ZodSafeParseResult<z.output<typeof createMarketplaceAppInput>> {
  return createMarketplaceAppInput.safeParse({
    name: textOf(values['name']),
    tagline: textOf(values['tagline']),
    description: textOf(values['description']),
    developer: textOf(values['developer']),
    websiteUrl: optionalOf(values['websiteUrl']),
    supportEmail: optionalOf(values['supportEmail']),
    iconUrl: optionalOf(values['iconUrl']),
    categories: chosen.categories,
    scopes: chosen.scopes,
    readGroups: chosen.readGroups,
    redirectUris: redirectUrisOf(textOf(values['redirectUris'])),
    webhookUrl: optionalOf(values['webhookUrl']),
    webhookEvents: chosen.webhookEvents,
  });
}

/** A saved app, whole, with another status: what listing, delisting or a draft again sends. */
export function statusChangeOf(
  app: AgencyMarketplaceApp,
  status: MarketplaceAppStatus,
): z.ZodSafeParseResult<z.output<typeof updateMarketplaceAppInput>> {
  return updateMarketplaceAppInput.safeParse({
    name: app.name,
    tagline: app.tagline,
    description: app.description,
    developer: app.developer,
    websiteUrl: app.websiteUrl,
    supportEmail: app.supportEmail,
    iconUrl: app.iconUrl,
    categories: app.categories,
    scopes: app.scopes,
    readGroups: app.readGroups,
    redirectUris: app.redirectUris,
    webhookUrl: app.webhookUrl,
    webhookEvents: app.webhookEvents,
    status,
  });
}
