// Deleting a field for good. GoHighLevel's delete "permanently removes the field and any
// data stored in it" and "cannot be undone", so there is no trash to restore from: the
// reversible step is archiving, which this product already has. A delete is therefore made
// in two requests. The first names what would be lost and gives a confirmation that stands
// for exactly that; the second sends it back. A confirmation that no longer describes the
// field deletes nothing.
//
// Which templates and automations use a field is the automation module's to know (it
// reads their documents). The CRM can't import it; the server hands the reader over.
import { createHash } from 'node:crypto';
import {
  defineCommand,
  requireBusiness,
  runCommand,
  type ApiRoute,
  type CommandContext,
  type Command,
  type Invocation,
  type Route,
  type RouteRequest,
  type Services,
} from '@repo/commands';
import {
  contactFieldPaths,
  deleteField,
  deleteFieldInput,
  getFieldDeletion,
  parseInput,
  type FieldDefinition,
  type FieldDeletion,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  ValidationError,
} from '@repo/kernel';
import { asField, type FieldRow } from './fields.js';

/** What uses a field, by public id and name: templates, and automations that are not deleted. */
export interface FieldUses {
  readonly templates: readonly { readonly id: string; readonly name: string }[];
  readonly automations: readonly { readonly id: string; readonly name: string }[];
}

/**
 * Finds what uses any of these merge paths (`contact.custom.<key>`, `contact.<key>` and
 * so on), each written without braces.
 */
export type FieldUsesReader = (
  trx: DatabaseTransaction,
  paths: readonly string[],
) => Promise<FieldUses>;

export interface FieldDeletionOptions {
  readonly uses: FieldUsesReader;
}

/** Deleting takes away data of every record, so it needs what emptying the trash needs too. */
const ALSO = 'trash.purge';

const has = (invocation: Invocation, permission: 'fields.manage' | typeof ALSO): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has(permission);

/** How a field of this kind of object is written in a template or an automation. */
const OBJECT_HEADS: Readonly<Record<string, string>> = { deal: 'deal', company: 'company' };

/**
 * Every path the field, or a key a merged field left to it, can be written as: its merge
 * key, and the `<object>.custom.<key>` form automations store.
 */
function pathsOf(field: FieldDefinition, objectKind: string, aliases: readonly string[]): string[] {
  const keys = [field.key, ...aliases];
  if (objectKind === 'contact') return [...new Set(keys.flatMap(contactFieldPaths))];
  const head = OBJECT_HEADS[objectKind];
  const merge = field.mergeKey?.slice(0, field.mergeKey.lastIndexOf('.'));
  return keys.flatMap((key) => [
    ...(head === undefined ? [] : [`${head}.custom.${key}`]),
    ...(merge === undefined ? [] : [`${merge}.${key}`]),
  ]);
}

interface Found {
  readonly row: FieldRow;
  readonly deletion: FieldDeletion;
}

/** The field, held when asked, with everything its deletion would lose. */
async function find(
  trx: DatabaseTransaction,
  invocation: Invocation,
  fieldId: string,
  options: FieldDeletionOptions,
  lock: boolean,
): Promise<Found> {
  let query = trx
    .selectFrom('crm.field_definitions as f')
    .innerJoin('crm.object_types as o', (join) =>
      join.onRef('f.business_id', '=', 'o.business_id').onRef('f.object_type_id', '=', 'o.id'),
    )
    .selectAll('f')
    .select([
      'o.key as object_key',
      'o.kind as object_kind',
      'o.primary_field_id as object_primary_field_id',
    ])
    .where('f.id', '=', parsePublicId('field', fieldId) ?? '');
  // Held against an edit, and against a value being written: a writer of a value holds
  // the field's key until it commits, so the count below is the count at the delete.
  if (lock) query = query.forUpdate('f');
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Field', fieldId);
  const field = asField(row);
  const { values } = await trx
    .selectFrom('crm.field_values')
    .select((eb) => eb.fn.countAll<string>().as('values'))
    .where('field_id', '=', row.id)
    .executeTakeFirstOrThrow();
  const aliases = await trx
    .selectFrom('crm.field_key_aliases')
    .select('alias_key')
    .where('field_id', '=', row.id)
    .orderBy('alias_key')
    .execute();
  const merged = await trx
    .selectFrom('crm.field_definitions')
    .select('id')
    .where('merged_into_field_id', '=', row.id)
    .limit(1)
    .executeTakeFirst();
  const paths = pathsOf(
    field,
    row.object_kind,
    aliases.map((alias) => alias.alias_key),
  );
  const uses =
    paths.length === 0 ? { templates: [], automations: [] } : await options.uses(trx, paths);
  const lost = {
    values: Number(values),
    templates: uses.templates.map(({ id, name }) => ({ id, name })),
    automations: uses.automations.map(({ id, name }) => ({ id, name })),
  };
  return {
    row,
    deletion: {
      field: {
        id: field.id,
        objectKey: field.objectKey,
        key: field.key,
        label: field.label,
        mergeKey: field.mergeKey ?? null,
      },
      ...lost,
      canDelete:
        !row.is_system &&
        row.object_primary_field_id !== row.id &&
        !row.is_unique &&
        merged === undefined &&
        has(invocation, 'fields.manage') &&
        has(invocation, ALSO),
      // The field as it is saved, and each thing named above by its id: a rename of a
      // template changes nothing that would be lost, a new value or a new use does.
      confirmation: createHash('sha256')
        .update(
          JSON.stringify([
            field.id,
            field.revision,
            lost.values,
            lost.templates.map(({ id }) => id),
            lost.automations.map(({ id }) => id),
            merged !== undefined,
          ]),
        )
        .digest('hex'),
    },
  };
}

/** What deleting the field would lose: read by anyone who can read fields. */
export async function readFieldDeletion(
  trx: DatabaseTransaction,
  invocation: Invocation,
  fieldId: string,
  options: FieldDeletionOptions,
): Promise<FieldDeletion> {
  requireBusiness(invocation.context);
  return (await find(trx, invocation, fieldId, options, false)).deletion;
}

const refused = (code: string, message: string): ValidationError =>
  new ValidationError([{ path: '', code, message }]);

function requireAlso(command: CommandContext): void {
  if (has(command, ALSO)) return;
  throw new ForbiddenError(`Your role doesn't allow this: it needs ${ALSO}.`, ALSO);
}

const deletionInput = deleteFieldInput.extend(deleteField.params.shape);

export function deleteFieldCommand(
  options: FieldDeletionOptions,
): Command<typeof deletionInput, void> {
  return defineCommand({
    name: 'field.delete',
    permission: 'fields.manage',
    input: deletionInput,
    async handle(trx, input, command): Promise<void> {
      requireBusiness(command.context);
      requireAlso(command);
      const { row, deletion } = await find(trx, command, input.fieldId, options, true);
      if (row.is_system) throw refused('system_field', 'A system field can’t be deleted.');
      // The database holds both rules too (0128); these say so in words.
      if (row.object_primary_field_id === row.id)
        throw refused(
          'primary_field',
          'The primary field names each record, so it goes only with its object.',
        );
      if (row.is_unique)
        throw refused('unique_field', 'A unique field can’t be deleted. Make it not unique first.');
      // The fields merged into it are kept, archived, and still point at it.
      if (!deletion.canDelete)
        throw refused(
          'merged_fields',
          'Other fields were merged into this one, so it can’t be deleted.',
        );
      if (deletion.confirmation !== input.confirmation)
        throw new ConflictError(
          'This field, or what uses it, changed. Read what deleting it would lose again.',
        );
      // Its values and the keys merged fields left to it go with it (0005's cascades); a
      // proposal about it keeps its history without the field (0010).
      const gone = await trx
        .deleteFrom('crm.field_definitions')
        .where('id', '=', row.id)
        .returning('id')
        .execute();
      // The database's own rule for a system field hides the row from the delete.
      if (gone.length !== 1) throw refused('system_field', 'A system field can’t be deleted.');
      await command.emit({
        type: 'field.deleted',
        subject: { kind: 'field', id: row.id },
        payload: {
          key: row.key,
          objectKey: row.object_key,
          label: row.label,
          values: deletion.values,
          templates: deletion.templates.length,
          automations: deletion.automations.length,
        },
      });
    },
  });
}

/**
 * The field a path names, checked before the body is read: another business's field is
 * not found, whatever was sent with it (API isolation suite).
 */
async function fieldInPath(
  { invocation, params }: RouteRequest,
  services: Services,
): Promise<{ fieldId: string }> {
  requireBusiness(invocation.context);
  const parsed = parseInput(deleteField.params, params);
  await withTenant(services.db, invocation.context, async (trx) => {
    const row = await trx
      .selectFrom('crm.field_definitions')
      .select('id')
      .where('id', '=', parsePublicId('field', parsed.fieldId) ?? '')
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Field', parsed.fieldId);
  });
  return parsed;
}

/** The two routes of a field's deletion, for the server to register with its reader. */
export function createFieldDeletionRoutes(options: FieldDeletionOptions): readonly ApiRoute[] {
  const command = deleteFieldCommand(options);
  return [
    {
      endpoint: getFieldDeletion,
      run: async ({ invocation, params }, { db }) => {
        requireBusiness(invocation.context);
        const { fieldId } = parseInput(getFieldDeletion.params, params);
        return withTenant(db, invocation.context, (trx) =>
          readFieldDeletion(trx, invocation, fieldId, options),
        );
      },
    } satisfies Route<typeof getFieldDeletion>,
    {
      endpoint: deleteField,
      command,
      run: async (request, services) => {
        const parsed = await fieldInPath(request, services);
        await runCommand(
          services,
          command,
          { ...parseInput(deleteFieldInput, request.body), ...parsed },
          request.invocation,
        );
        return undefined;
      },
    } satisfies Route<typeof deleteField>,
  ];
}
