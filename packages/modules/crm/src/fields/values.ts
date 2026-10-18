import { requireBusiness, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  getRecordFields,
  setRecordField,
  setRecordFieldInput,
  confirmRecordField,
  confirmRecordFieldInput,
  parseInput,
  type RecordFields,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { sql } from 'kysely';
import { actorKinds } from '@repo/kernel';
import { requireRecord } from '../records/access.js';
import { asField } from './fields.js';
import type { ActorNames } from '../activity/activity.js';
import { presentValue } from './value-presenter.js';
import {
  setRecordFieldCommand,
  confirmRecordFieldCommand,
  requireValueDefinition,
} from './value-writes.js';

/** Read values without coercing exact numeric strings or date-only values through JS dates. */
export function recordFieldRoutes(actorNames: ActorNames): readonly ApiRoute[] {
  return [
    {
      endpoint: getRecordFields,
      async run({ invocation, params }, { db }): Promise<RecordFields> {
        requireBusiness(invocation.context);
        const { id } = parseInput(getRecordFields.params, params);
        return withTenant(db, invocation.context, async (trx) => {
          const record = await requireRecord(trx, id);
          const definitions = await trx
            .selectFrom('crm.field_definitions as f')
            .innerJoin('crm.object_types as o', (join) =>
              join
                .onRef('o.business_id', '=', 'f.business_id')
                .onRef('o.id', '=', 'f.object_type_id'),
            )
            .innerJoin('crm.field_folders as d', (join) =>
              join.onRef('d.business_id', '=', 'f.business_id').onRef('d.id', '=', 'f.folder_id'),
            )
            .selectAll('f')
            .select(['o.key as object_key', 'o.kind as object_kind'])
            .where('f.object_type_id', '=', record.objectTypeId)
            .where('f.merged_into_field_id', 'is', null)
            // Folders in their order, and each folder's fields in theirs.
            .orderBy('d.position')
            .orderBy('d.created_at')
            .orderBy('d.id')
            .orderBy('f.position')
            .orderBy('f.id')
            .execute();
          const rows = await trx
            .selectFrom('crm.field_values')
            .selectAll()
            .select(sql<string | null>`value_date::text`.as('date_text'))
            .where('record_id', '=', record.id)
            .execute();
          const saved = new Map(rows.map((row) => [row.field_id, row]));
          const wanted = new Map<keyof ActorNames, Set<string>>();
          for (const row of rows) {
            const kind = actorKinds.find((kind) => kind === row.source_kind);
            if (row.source_id !== null && kind !== undefined) {
              const ids = wanted.get(kind) ?? new Set<string>();
              ids.add(row.source_id);
              wanted.set(kind, ids);
            }
            if (row.confirmed_by_id !== null) {
              const ids = wanted.get('user') ?? new Set<string>();
              ids.add(row.confirmed_by_id);
              wanted.set('user', ids);
            }
          }
          const names = new Map<string, string>();
          for (const [kind, ids] of wanted) {
            const lookup = actorNames[kind];
            if (lookup === undefined) continue;
            for (const [actorId, name] of await lookup(trx, [...ids]))
              names.set(`${kind}:${actorId}`, name);
          }
          const canManage =
            !record.trashed &&
            (invocation.permissions === 'all' || invocation.permissions.has('fields.values'));
          return {
            canManage,
            canConfirm:
              canManage &&
              invocation.context.actorKind === 'user' &&
              invocation.context.userId !== undefined &&
              invocation.context.actorId === invocation.context.userId,
            items: definitions.flatMap((definition) => {
              const row = saved.get(definition.id);
              if (definition.archived_at !== null && row === undefined) return [];
              return [presentValue(asField(definition), row, invocation, names)];
            }),
          };
        });
      },
    } satisfies Route<typeof getRecordFields>,
    {
      endpoint: setRecordField,
      command: setRecordFieldCommand,
      run: async ({ invocation, params, body }, services) => {
        requireBusiness(invocation.context);
        const parsed = parseInput(setRecordField.params, params);
        await withTenant(services.db, invocation.context, async (trx) => {
          const record = await requireRecord(trx, parsed.id);
          await requireValueDefinition(trx, record.objectTypeId, parsed.fieldId);
        });
        return runCommand(
          services,
          setRecordFieldCommand,
          { ...parseInput(setRecordFieldInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof setRecordField>,
    {
      endpoint: confirmRecordField,
      command: confirmRecordFieldCommand,
      run: async ({ invocation, params, body }, services) => {
        requireBusiness(invocation.context);
        const parsed = parseInput(confirmRecordField.params, params);
        await withTenant(services.db, invocation.context, async (trx) => {
          const record = await requireRecord(trx, parsed.id);
          await requireValueDefinition(trx, record.objectTypeId, parsed.fieldId);
        });
        return runCommand(
          services,
          confirmRecordFieldCommand,
          { ...parseInput(confirmRecordFieldInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof confirmRecordField>,
  ];
}
