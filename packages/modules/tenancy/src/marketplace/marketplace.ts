// The App Marketplace. The agency publishes apps; each business of the agency
// browses the listed ones, installs one with consent and uninstalls it. An install grants
// the app's requested scopes, and only when the installer holds every one of them: nobody
// delegates what they don't have, as with an API key.
import {
  defineCommand,
  requireAgency,
  requireBusiness,
  type Command,
  type CommandContext,
  type Grants,
} from '@repo/commands';
import {
  createMarketplaceAppInput,
  installMarketplaceApp,
  marketplaceAppStatuses,
  marketplaceCategories,
  uninstallMarketplaceApp,
  updateMarketplaceApp,
  updateMarketplaceAppInput,
  webhookEventsProblem,
  type AgencyMarketplaceApp,
  type ListMarketplaceAppsQuery,
  type MarketplaceApp,
  type MarketplaceAppDetail,
  type MarketplaceInstall,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type PublicIdKind,
  type TenantContext,
} from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import type { PeopleNames } from '../api-keys/api-keys.js';

const appColumns = [
  'app.id',
  'app.name',
  'app.tagline',
  'app.description',
  'app.developer',
  'app.website_url',
  'app.support_email',
  'app.icon_url',
  'app.categories',
  'app.scopes',
  'app.read_groups',
  'app.webhook_events',
  'app.status',
  'app.created_at',
  'app.updated_at',
] as const;

interface AppRow {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly developer: string;
  readonly website_url: string | null;
  readonly support_email: string | null;
  readonly icon_url: string | null;
  readonly categories: string[];
  readonly scopes: string[];
  readonly read_groups: string[];
  readonly webhook_events: string[];
  readonly status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** An app with this business's live install, if it has one. */
export interface InstalledAppRow extends AppRow {
  readonly install_id: string | null;
  readonly granted_scopes: string[] | null;
  readonly granted_read_groups: string[] | null;
  readonly installed_by: string | null;
  readonly installed_at: Date | null;
}

// What the table holds is what the commands wrote: the contracts' vocabularies.
const storedStatus = z.enum(marketplaceAppStatuses);
const storedCategories = z.array(z.enum(marketplaceCategories));

function appFields(row: AppRow) {
  return {
    id: toPublicId('marketplace_app', row.id),
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    developer: row.developer,
    websiteUrl: row.website_url,
    supportEmail: row.support_email,
    iconUrl: row.icon_url,
    categories: storedCategories.parse(row.categories),
    scopes: row.scopes,
    readGroups: row.read_groups,
    webhookEvents: row.webhook_events,
    status: storedStatus.parse(row.status),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The uuid a validated public id names. The contracts checked it, so it always parses. */
function uuidOf(kind: PublicIdKind, value: string, resource: string): string {
  const id = parsePublicId(kind, value);
  if (id === undefined) throw new NotFoundError(resource, value);
  return id;
}

function holds(grants: Grants, permission: string): boolean {
  if (grants === 'all') return true;
  const held: ReadonlySet<string> = grants;
  return held.has(permission);
}

/** The app's scopes the actor doesn't hold where it works. */
export const missingFrom = (grants: Grants, scopes: readonly string[]): string[] =>
  scopes.filter((scope) => !holds(grants, scope));

/** Whether the actor may install and uninstall apps where it works. */
export const mayInstall = (grants: Grants): boolean => holds(grants, 'apps.manage');

export function requirePublisher(context: TenantContext): { agencyId: string; userId: string } {
  const agencyId = requireAgency(context);
  if (context.actorKind === 'api_key' || context.userId === undefined)
    throw new ForbiddenError('Only a person can publish an app.');
  return { agencyId, userId: context.userId };
}

export function requireInstaller(context: TenantContext): { businessId: string; userId: string } {
  const businessId = requireBusiness(context);
  if (context.actorKind === 'api_key' || context.userId === undefined)
    throw new ForbiddenError('Only a person can install or uninstall an app.');
  return { businessId, userId: context.userId };
}

const containing = (text: string): string => `%${text.replaceAll(/[\\%_]/g, '\\$&')}%`;

// ---- The agency ----------------------------------------------------------------------

/** The agency's apps, by name, each with how many businesses have it installed now. */
export async function readAgencyApps(
  trx: DatabaseTransaction,
  context: TenantContext,
  appId?: string,
): Promise<AgencyMarketplaceApp[]> {
  const agencyId = requireAgency(context);
  let query = trx
    .selectFrom('tenancy.marketplace_apps as app')
    .select(appColumns)
    .select([
      'app.redirect_uris',
      'app.client_secret_prefix',
      'app.client_secret_set_at',
      'app.webhook_url',
      'app.webhook_secret_set_at',
    ])
    .select((eb) =>
      eb
        .selectFrom('tenancy.marketplace_installs as install')
        .select(eb.fn.countAll<string>().as('count'))
        .whereRef('install.agency_id', '=', 'app.agency_id')
        .whereRef('install.app_id', '=', 'app.id')
        .where('install.uninstalled_at', 'is', null)
        .as('install_count'),
    )
    .where('app.agency_id', '=', agencyId);
  if (appId !== undefined) query = query.where('app.id', '=', appId);
  const rows = await query.orderBy('app.name').orderBy('app.id').execute();
  return rows.map((row) => ({
    ...appFields(row),
    installCount: Number(row.install_count),
    redirectUris: row.redirect_uris,
    clientSecretPrefix: row.client_secret_prefix,
    clientSecretSetAt: row.client_secret_set_at?.toISOString() ?? null,
    webhookUrl: row.webhook_url,
    webhookSecretSetAt: row.webhook_secret_set_at?.toISOString() ?? null,
  }));
}

async function readAgencyApp(
  trx: DatabaseTransaction,
  context: TenantContext,
  appId: string,
): Promise<AgencyMarketplaceApp> {
  const [app] = await readAgencyApps(trx, context, appId);
  if (app === undefined)
    throw new NotFoundError('Marketplace app', toPublicId('marketplace_app', appId));
  return app;
}

/**
 * The app's columns from what was sent. Events need an address to go to, and each must be
 * of a group the app may read: a webhook never tells an app more than its token could read.
 */
function columnsOf(input: z.output<typeof createMarketplaceAppInput>) {
  if (input.webhookEvents.length > 0 && input.webhookUrl === null)
    throw new ValidationError([
      {
        path: '/webhookUrl',
        code: 'required',
        message: 'Give the address the events are sent to.',
      },
    ]);
  const problem = webhookEventsProblem(input.webhookEvents, input.readGroups);
  if (problem !== undefined)
    throw new ValidationError([{ path: '/webhookEvents', code: 'unreadable', message: problem }]);
  return {
    name: input.name,
    tagline: input.tagline,
    description: input.description,
    developer: input.developer,
    website_url: input.websiteUrl,
    support_email: input.supportEmail,
    icon_url: input.iconUrl,
    categories: [...input.categories],
    scopes: [...input.scopes],
    read_groups: [...input.readGroups],
    redirect_uris: [...input.redirectUris],
    webhook_url: input.webhookUrl,
    webhook_events: [...input.webhookEvents],
  };
}

/** Adds an app to the agency, as a draft that no business sees yet. */
export const createMarketplaceAppCommand = defineCommand({
  name: 'marketplace_app.create',
  permission: 'apps.manage',
  input: createMarketplaceAppInput,
  async handle(trx, input, command) {
    const { agencyId, userId } = requirePublisher(command.context);
    const { id } = await trx
      .insertInto('tenancy.marketplace_apps')
      .values({
        agency_id: agencyId,
        ...columnsOf(input),
        status: 'draft',
        created_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await command.emit({
      type: 'marketplace_app.created',
      subject: { kind: 'marketplace_app', id },
      payload: { name: input.name, status: 'draft' },
    });
    return readAgencyApp(trx, command.context, id);
  },
});

const updateInput = updateMarketplaceAppInput.extend(updateMarketplaceApp.params.shape);

/**
 * Saves the whole app. Listing it shows it to every business of the agency; delisting it
 * stops new installs and leaves the existing ones working until they're uninstalled.
 */
export const updateMarketplaceAppCommand = defineCommand({
  name: 'marketplace_app.update',
  permission: 'apps.manage',
  input: updateInput,
  async handle(trx, input, command) {
    const { agencyId } = requirePublisher(command.context);
    const id = uuidOf('marketplace_app', input.appId, 'Marketplace app');
    const before = await trx
      .selectFrom('tenancy.marketplace_apps')
      .select('status')
      .where('agency_id', '=', agencyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (before === undefined) throw new NotFoundError('Marketplace app', input.appId);
    await trx
      .updateTable('tenancy.marketplace_apps')
      .set({ ...columnsOf(input), status: input.status })
      .where('agency_id', '=', agencyId)
      .where('id', '=', id)
      .execute();
    const subject = { kind: 'marketplace_app', id };
    await command.emit({
      type: 'marketplace_app.updated',
      subject,
      payload: { name: input.name, status: input.status },
    });
    if (before.status !== input.status && input.status !== 'draft')
      await command.emit({
        type: `marketplace_app.${input.status}`,
        subject,
        payload: { name: input.name },
      });
    return readAgencyApp(trx, command.context, id);
  },
});

// ---- A business ----------------------------------------------------------------------

/** The business's apps query: each app with this business's live install, if any. */
function appsWithInstall(trx: DatabaseTransaction, businessId: string) {
  return trx
    .selectFrom('tenancy.marketplace_apps as app')
    .leftJoin('tenancy.marketplace_installs as install', (join) =>
      join
        .onRef('install.agency_id', '=', 'app.agency_id')
        .onRef('install.app_id', '=', 'app.id')
        .on('install.business_id', '=', businessId)
        .on('install.uninstalled_at', 'is', null),
    )
    .select(appColumns)
    .select([
      'install.id as install_id',
      'install.granted_scopes',
      'install.granted_read_groups',
      'install.installed_by',
      'install.installed_at',
    ]);
}

async function installersOf(
  trx: DatabaseTransaction,
  rows: readonly InstalledAppRow[],
  people: PeopleNames,
): Promise<ReadonlyMap<string, string>> {
  const installers = rows.flatMap((row) => row.installed_by ?? []);
  return installers.length === 0 ? new Map() : people(trx, installers);
}

function asInstall(
  row: InstalledAppRow,
  installers: ReadonlyMap<string, string>,
): MarketplaceInstall | null {
  if (row.install_id === null || row.installed_by === null || row.installed_at === null)
    return null;
  return {
    id: toPublicId('marketplace_install', row.install_id),
    appId: toPublicId('marketplace_app', row.id),
    grantedScopes: row.granted_scopes ?? [],
    grantedReadGroups: row.granted_read_groups ?? [],
    installedBy: installers.get(row.installed_by) ?? null,
    installedAt: row.installed_at.toISOString(),
  };
}

async function asApps(
  trx: DatabaseTransaction,
  rows: readonly InstalledAppRow[],
  people: PeopleNames,
): Promise<MarketplaceApp[]> {
  const installers = await installersOf(trx, rows, people);
  return rows.map((row) => ({ ...appFields(row), install: asInstall(row, installers) }));
}

/** The agency's listed apps, by name, found by text and category, with this business's installs. */
export async function readListedApps(
  trx: DatabaseTransaction,
  context: TenantContext,
  query: ListMarketplaceAppsQuery,
  people: PeopleNames,
): Promise<MarketplaceApp[]> {
  const businessId = requireBusiness(context);
  let found = appsWithInstall(trx, businessId)
    .where('app.agency_id', '=', context.agencyId)
    .where('app.status', '=', 'listed');
  if (query.q !== undefined && query.q !== '') {
    const like = containing(query.q);
    found = found.where((eb) =>
      eb.or([
        eb('app.name', 'ilike', like),
        eb('app.tagline', 'ilike', like),
        eb('app.developer', 'ilike', like),
      ]),
    );
  }
  if (query.category !== undefined)
    found = found.where(sql<boolean>`app.categories @> array[${query.category}]::text[]`);
  return asApps(trx, await found.orderBy('app.name').orderBy('app.id').execute(), people);
}

/** The apps installed in the business now, by name, delisted ones included. */
export async function readInstalledApps(
  trx: DatabaseTransaction,
  context: TenantContext,
  people: PeopleNames,
): Promise<MarketplaceApp[]> {
  const businessId = requireBusiness(context);
  const rows = await appsWithInstall(trx, businessId)
    .where('app.agency_id', '=', context.agencyId)
    .where('install.id', 'is not', null)
    .orderBy('app.name')
    .orderBy('app.id')
    .execute();
  return asApps(trx, rows, people);
}

/** An app the business may see: listed, or installed here. Anything else is not found. */
export async function visibleApp(
  trx: DatabaseTransaction,
  context: TenantContext,
  appId: string,
  lock: boolean,
): Promise<InstalledAppRow> {
  const businessId = requireBusiness(context);
  let query = appsWithInstall(trx, businessId)
    .where('app.agency_id', '=', context.agencyId)
    .where('app.id', '=', uuidOf('marketplace_app', appId, 'Marketplace app'))
    .where((eb) => eb.or([eb('app.status', '=', 'listed'), eb('install.id', 'is not', null)]));
  // An install waits for a delist that is under way, and is then refused by it.
  if (lock) query = query.forShare('app');
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Marketplace app', appId);
  return row;
}

/** One app, as the business sees it: what it asks for, and whether the reader can grant it. */
export async function readMarketplaceApp(
  trx: DatabaseTransaction,
  context: TenantContext,
  grants: Grants,
  appId: string,
  people: PeopleNames,
): Promise<MarketplaceAppDetail> {
  const row = await visibleApp(trx, context, appId, false);
  const [app] = await asApps(trx, [row], people);
  return {
    ...appFields(row),
    install: app?.install ?? null,
    missingScopes: missingFrom(grants, row.scopes),
    canInstall: mayInstall(grants),
  };
}

const alreadyInstalled = () => new ConflictError('This app is already installed here.');

/** A new install, as the business sees it. */
export interface NewInstall {
  readonly id: string;
  readonly grantedScopes: string[];
  readonly grantedReadGroups: string[];
  readonly installedAt: Date;
}

/**
 * Installs a listed app in the business, granting every scope it asks for, and makes the
 * install's app key, through which its access tokens act. The installer must
 * hold every scope: nobody delegates what they don't have.
 */
export async function installApp(
  trx: DatabaseTransaction,
  command: CommandContext,
  app: InstalledAppRow,
): Promise<NewInstall> {
  const { businessId, userId } = requireInstaller(command.context);
  if (app.install_id !== null) throw alreadyInstalled();
  if (app.status !== 'listed')
    throw new ConflictError('This app is no longer listed, so it can’t be installed.');
  const missing = missingFrom(command.permissions, app.scopes);
  const [first] = missing;
  if (first !== undefined)
    throw new ForbiddenError(
      `You can install an app only with permissions you have, and you don't have ${missing.join(', ')}.`,
      first,
    );
  const row = await trx
    .insertInto('tenancy.marketplace_installs')
    .values({
      business_id: businessId,
      agency_id: command.context.agencyId,
      app_id: app.id,
      granted_scopes: [...app.scopes],
      granted_read_groups: [...app.read_groups],
      installed_by: userId,
    })
    // Two installs at once: the second finds the first, as above.
    .onConflict((conflict) =>
      conflict.columns(['business_id', 'app_id']).where('uninstalled_at', 'is', null).doNothing(),
    )
    .returning(['id', 'granted_scopes', 'granted_read_groups', 'installed_at'])
    .executeTakeFirst();
  if (row === undefined) throw alreadyInstalled();
  await trx
    .insertInto('tenancy.api_keys')
    .values({
      agency_id: command.context.agencyId,
      business_id: businessId,
      name: app.name,
      scopes: row.granted_scopes,
      read_groups: row.granted_read_groups,
      created_by_user_id: userId,
      marketplace_install_id: row.id,
    })
    .execute();
  await command.emit({
    type: 'marketplace_app.installed',
    subject: { kind: 'marketplace_app', id: app.id },
    payload: {
      installId: row.id,
      name: app.name,
      grantedScopes: row.granted_scopes,
      grantedReadGroups: row.granted_read_groups,
    },
  });
  return {
    id: row.id,
    grantedScopes: row.granted_scopes,
    grantedReadGroups: row.granted_read_groups,
    installedAt: row.installed_at,
  };
}

/** Installs a listed app in the business, granting every scope it asks for. */
export function installMarketplaceAppCommand(
  people: PeopleNames,
): Command<typeof installMarketplaceApp.params, MarketplaceInstall> {
  return defineCommand({
    name: 'marketplace_app.install',
    permission: 'apps.manage',
    input: installMarketplaceApp.params,
    async handle(trx, input, command) {
      const { userId } = requireInstaller(command.context);
      const app = await visibleApp(trx, command.context, input.appId, true);
      const install = await installApp(trx, command, app);
      const names = await people(trx, [userId]);
      return {
        id: toPublicId('marketplace_install', install.id),
        appId: toPublicId('marketplace_app', app.id),
        grantedScopes: install.grantedScopes,
        grantedReadGroups: install.grantedReadGroups,
        installedBy: names.get(userId) ?? null,
        installedAt: install.installedAt.toISOString(),
      };
    },
  });
}

/**
 * Uninstalls an app from the business. The install stays, as history; its app key and
 * every token it was given stop working, in this transaction.
 */
export const uninstallMarketplaceAppCommand = defineCommand({
  name: 'marketplace_app.uninstall',
  permission: 'apps.manage',
  input: uninstallMarketplaceApp.params,
  async handle(trx, input, command) {
    const { businessId, userId } = requireInstaller(command.context);
    const row = await trx
      .updateTable('tenancy.marketplace_installs as install')
      .from('tenancy.marketplace_apps as app')
      .set({ uninstalled_at: sql<Date>`now()`, uninstalled_by: userId })
      .whereRef('app.agency_id', '=', 'install.agency_id')
      .whereRef('app.id', '=', 'install.app_id')
      .where('install.business_id', '=', businessId)
      .where(
        'install.id',
        '=',
        uuidOf('marketplace_install', input.installId, 'Marketplace install'),
      )
      .where('install.uninstalled_at', 'is', null)
      .returning(['install.id', 'install.app_id', 'app.name'])
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Marketplace install', input.installId);
    await trx
      .updateTable('tenancy.api_keys')
      .set({ revoked_at: sql<Date>`now()` })
      .where('business_id', '=', businessId)
      .where('marketplace_install_id', '=', row.id)
      .where('revoked_at', 'is', null)
      .execute();
    await trx
      .updateTable('tenancy.marketplace_oauth_tokens')
      .set({ revoked_at: sql<Date>`now()`, revoked_reason: 'uninstalled' })
      .where('business_id', '=', businessId)
      .where('install_id', '=', row.id)
      .where('revoked_at', 'is', null)
      .execute();
    await command.emit({
      type: 'marketplace_app.uninstalled',
      subject: { kind: 'marketplace_app', id: row.app_id },
      payload: { installId: row.id, name: row.name },
    });
    return undefined;
  },
});
