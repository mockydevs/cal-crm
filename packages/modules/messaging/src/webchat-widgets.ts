// Managing web chat widgets: the team's side. A widget is a channel account of the webchat
// channel plus its public key, the websites that may show it, and what it says.
import {
  defineCommand,
  requireBusiness,
  requirePermission,
  runCommand,
  type ApiRoute,
  type Command,
  type Route,
} from '@repo/commands';
import {
  createWebchatWidget,
  DEFAULT_WEBCHAT_SETTINGS,
  listWebchatWidgets,
  parseInput,
  rotateWebchatWidgetKey,
  updateWebchatWidget,
  webchatWidget,
  webchatWidgetInput,
  webchatWidgetSettings,
  type WebchatWidget,
  type WebchatWidgetInput,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction, type Json } from '@repo/db';
import {
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type Issue,
  type TenantContext,
} from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { canonicalWebOrigin } from './webchat-origin.js';
import { newWidgetKey } from './webchat-token.js';
import { holdBusinessIfActive } from './webchat-locks.js';

/** Where the widget script is served, under the install's public address. */
export const WEBCHAT_SCRIPT_PATH = '/webchat/widget.js';

/**
 * The one line a website needs. The key and the address are the only variable parts: a
 * key is 32 characters of base64url and the address is the install's own, so neither can
 * close the attribute or the tag.
 */
export function embedSnippet(publicUrl: string, publicKey: string): string {
  const source = new URL(WEBCHAT_SCRIPT_PATH, publicUrl).toString();
  return `<script async src="${source}" data-widget-key="${publicKey}"></script>`;
}

/**
 * The websites as stored: each in its one canonical form, once. One that has no such form
 * (plain HTTP outside loopback, a trailing dot, a port that is none) is refused, with the
 * place in the list it was typed at.
 */
export function storedOrigins(typed: readonly string[]): string[] {
  const issues: Issue[] = [];
  const origins = new Set<string>();
  for (const [index, value] of typed.entries()) {
    const origin = canonicalWebOrigin(value);
    if (origin === undefined)
      issues.push({
        path: `/allowedOrigins/${String(index)}`,
        code: 'invalid_origin',
        message: 'Enter a secure website address, such as https://www.example.com.',
      });
    else origins.add(origin);
  }
  const [first, ...rest] = issues;
  if (first !== undefined) throw new ValidationError([first, ...rest]);
  return [...origins];
}

async function readWidgets(
  trx: DatabaseTransaction,
  publicUrl: string,
  id?: string,
): Promise<WebchatWidget[]> {
  let query = trx
    .selectFrom('messaging.webchat_widgets as widget')
    .innerJoin('messaging.channel_accounts as channel', (join) =>
      join
        .onRef('channel.id', '=', 'widget.id')
        .onRef('channel.business_id', '=', 'widget.business_id'),
    )
    .select([
      'widget.id',
      'channel.name',
      'channel.status',
      'widget.public_key',
      'widget.allowed_origins',
      'widget.settings',
      'widget.created_at',
      sql<Date>`greatest(widget.updated_at, channel.updated_at)`.as('updated_at'),
    ])
    .orderBy('widget.created_at')
    .orderBy('widget.id');
  if (id !== undefined) query = query.where('widget.id', '=', id);
  const rows = await query.execute();
  return rows.map((row) => {
    const stored = webchatWidgetSettings.safeParse({
      ...DEFAULT_WEBCHAT_SETTINGS,
      ...(typeof row.settings === 'object' && row.settings !== null && !Array.isArray(row.settings)
        ? row.settings
        : {}),
    });
    return webchatWidget.parse({
      id: toPublicId('webchat_widget', row.id),
      name: row.name,
      publicKey: row.public_key,
      enabled: row.status === 'active',
      allowedOrigins: row.allowed_origins,
      settings: stored.success ? stored.data : DEFAULT_WEBCHAT_SETTINGS,
      embedSnippet: embedSnippet(publicUrl, row.public_key),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  });
}

/** The business's widgets, oldest first. */
export function readWebchatWidgets(
  trx: DatabaseTransaction,
  publicUrl: string,
): Promise<WebchatWidget[]> {
  return readWidgets(trx, publicUrl);
}

async function readWidget(
  trx: DatabaseTransaction,
  publicUrl: string,
  id: string,
): Promise<WebchatWidget> {
  const [widget] = await readWidgets(trx, publicUrl, id);
  if (widget === undefined) throw new NotFoundError('web chat widget', id);
  return widget;
}

const asJson = (settings: WebchatWidgetInput['settings']) =>
  sql<Json>`${JSON.stringify(settings)}::jsonb`;

const withId = z.strictObject({ id: z.string(), widget: webchatWidgetInput });
const onlyId = z.strictObject({ id: z.string() });

export interface WebchatWidgetCommands {
  readonly create: Command<typeof webchatWidgetInput, WebchatWidget>;
  readonly update: Command<typeof withId, WebchatWidget>;
  readonly rotateKey: Command<typeof onlyId, WebchatWidget>;
}

/** The commands, given the install's public address for the snippet they return. */
export function createWebchatWidgetCommands(publicUrl: string): WebchatWidgetCommands {
  const create = defineCommand({
    name: 'webchat.create_widget',
    permission: 'webchat.manage',
    input: webchatWidgetInput,
    async handle(trx, input, command): Promise<WebchatWidget> {
      const businessId = requireBusiness(command.context);
      const origins = storedOrigins(input.allowedOrigins);
      const channel = await trx
        .insertInto('messaging.channel_accounts')
        .values({
          business_id: businessId,
          channel: 'webchat',
          name: input.name,
          status: input.enabled ? 'active' : 'paused',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('messaging.webchat_widgets')
        .values({
          business_id: businessId,
          id: channel.id,
          // From the system's random source. It is public from the moment it is embedded.
          public_key: newWidgetKey(),
          allowed_origins: origins,
          settings: asJson(input.settings),
        })
        .execute();
      await command.emit({
        type: 'webchat_widget.created',
        subject: { kind: 'webchat_widget', id: channel.id },
      });
      return readWidget(trx, publicUrl, channel.id);
    },
  });

  // The widget's row, held until the command ends, or not found. The business is taken
  // first: replacing a key ends sessions, and every writer of a session holds the business
  // before it (webchat-locks.ts).
  const locked = async (
    trx: DatabaseTransaction,
    context: TenantContext,
    publicId: string,
  ): Promise<string> => {
    await holdBusinessIfActive(trx, context);
    const id = parsePublicId('webchat_widget', publicId);
    const row =
      id === undefined
        ? undefined
        : await trx
            .selectFrom('messaging.webchat_widgets')
            .select('id')
            .where('id', '=', id)
            .forUpdate()
            .executeTakeFirst();
    if (row === undefined) throw new NotFoundError('web chat widget', publicId);
    return row.id;
  };

  const update = defineCommand({
    name: 'webchat.update_widget',
    permission: 'webchat.manage',
    input: withId,
    audit: ({ id, widget }) => ({ id, ...widget }),
    async handle(trx, { id: publicId, widget }, command): Promise<WebchatWidget> {
      requireBusiness(command.context);
      const origins = storedOrigins(widget.allowedOrigins);
      const id = await locked(trx, command.context, publicId);
      await trx
        .updateTable('messaging.channel_accounts')
        .set({ name: widget.name, status: widget.enabled ? 'active' : 'paused' })
        .where('id', '=', id)
        .where('channel', '=', 'webchat')
        .execute();
      await trx
        .updateTable('messaging.webchat_widgets')
        .set({ allowed_origins: origins, settings: asJson(widget.settings) })
        .where('id', '=', id)
        .execute();
      await command.emit({
        type: 'webchat_widget.updated',
        subject: { kind: 'webchat_widget', id },
        payload: { enabled: widget.enabled },
      });
      return readWidget(trx, publicUrl, id);
    },
  });

  const rotateKey = defineCommand({
    name: 'webchat.rotate_widget_key',
    permission: 'webchat.manage',
    input: onlyId,
    async handle(trx, { id: publicId }, command): Promise<WebchatWidget> {
      requireBusiness(command.context);
      const id = await locked(trx, command.context, publicId);
      await trx
        .updateTable('messaging.webchat_widgets')
        .set({ public_key: newWidgetKey() })
        .where('id', '=', id)
        .execute();
      // A key is replaced because it was misused. Whoever misused it may hold sessions, and
      // the new key is as public as the old one, so every open session ends with the old key.
      await trx
        .updateTable('messaging.webchat_sessions')
        .set({ ended_at: sql<Date>`clock_timestamp()` })
        .where('widget_id', '=', id)
        .where('ended_at', 'is', null)
        .execute();
      await command.emit({
        type: 'webchat_widget.key_rotated',
        subject: { kind: 'webchat_widget', id },
      });
      return readWidget(trx, publicUrl, id);
    },
  });

  return { create, update, rotateKey };
}

/** The admin API's routes for widgets. */
export function createWebchatRoutes(publicUrl: string): readonly ApiRoute[] {
  const commands = createWebchatWidgetCommands(publicUrl);
  const list = {
    endpoint: listWebchatWidgets,
    async run({ invocation }, services) {
      await requirePermission(
        services,
        { name: 'webchat.list_widgets', permission: 'webchat.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, async (trx) => ({
        data: await readWebchatWidgets(trx, publicUrl),
      }));
    },
  } satisfies Route<typeof listWebchatWidgets>;
  const create = {
    endpoint: createWebchatWidget,
    command: commands.create,
    run: ({ invocation, body }, services) =>
      runCommand(services, commands.create, body, invocation),
  } satisfies Route<typeof createWebchatWidget>;
  const update = {
    endpoint: updateWebchatWidget,
    command: commands.update,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        commands.update,
        {
          id: parseInput(updateWebchatWidget.params, params).id,
          widget: parseInput(updateWebchatWidget.body, body),
        },
        invocation,
      ),
  } satisfies Route<typeof updateWebchatWidget>;
  const rotate = {
    endpoint: rotateWebchatWidgetKey,
    command: commands.rotateKey,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        commands.rotateKey,
        parseInput(rotateWebchatWidgetKey.params, params),
        invocation,
      ),
  } satisfies Route<typeof rotateWebchatWidgetKey>;
  return [list, create, update, rotate];
}
