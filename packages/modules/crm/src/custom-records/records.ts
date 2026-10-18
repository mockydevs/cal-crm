// Records of custom objects, as GoHighLevel's objects records API keeps them: each is a
// registry row of kind custom with its crm.custom_records row, named by its object's primary
// field, which the database copies into the title. Values are set through the field
// command, so a new record's are checked as any change of a field is, its primary field's
// included. A record deleted goes to the trash, keeping its unique values so that a restore
// can't clash; a purge frees them with the rest of it.
import {
  defineCommand,
  requireBusiness,
  type Command,
  type CommandContext,
  type Invocation,
} from '@repo/commands';
import {
  createCustomRecordInput,
  customRecordParams,
  customRecordsParams,
  fieldOption,
  updateCustomRecordInput,
  type ContactPerson,
  type CustomRecord,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toPublicId,
  ValidationError,
  type Issue,
  type TenantContext,
} from '@repo/kernel';
import { sql, type NotNull } from 'kysely';
import * as z from 'zod';

import { asChoiceKeys } from '../contacts/create-fields.js';
import { ownerRevisionOf, requireRevision } from '../contacts/details.js';
import { memberOf } from '../contacts/people.js';
import type { DealPeopleOptions } from '../deals/details.js';
import { asField } from '../fields/fields.js';
import { uuidOf } from '../records/public-ids.js';
import { readRecordField } from '../fields/value-read.js';
import { validateFieldValue } from '../fields/value-validation.js';
import {
  primaryName,
  requireValueDefinition,
  setRecordFieldCommand,
} from '../fields/value-writes.js';

/** Who is on the team and what people are called: the server's, for a record's owner. */
export type RecordPeople = DealPeopleOptions | undefined;

/** A live custom object, as the records under it need it. */
export interface LiveObject {
  readonly id: string;
  readonly key: string;
  readonly singular_label: string;
  readonly primary_field_id: string;
}

/**
 * The custom object a path names, not being deleted. A standard object's key names none
 * here: its records have their own pages. Held FOR SHARE when a record is made under it, so
 * the object's delete waits for the new record, which its purge then removes.
 */
export async function liveObject(
  trx: DatabaseTransaction,
  key: string,
  hold = false,
): Promise<LiveObject> {
  let query = trx
    .selectFrom('crm.object_types')
    .select(['id', 'key', 'singular_label', 'primary_field_id'])
    .where('key', '=', key)
    .where('kind', '=', 'custom')
    .where('archived_at', 'is', null)
    // Every custom object has its primary field (0128 holds it); only a standard one lacks it.
    .$narrowType<{ primary_field_id: NotNull }>();
  if (hold) query = query.forShare();
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Object', key);
  return row;
}

const recordColumns = [
  'id',
  'object_type_id',
  'title',
  'owner_user_id',
  'deleted_at',
  'created_at',
  'updated_at',
] as const;
export interface RecordRow {
  readonly id: string;
  readonly object_type_id: string;
  readonly title: string;
  readonly owner_user_id: string | null;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** How each of these owners is shown: their membership now, their name, and whether it is you. */
async function ownersOf(
  trx: DatabaseTransaction,
  context: TenantContext,
  people: RecordPeople,
  rows: readonly RecordRow[],
): Promise<(userId: string) => ContactPerson> {
  const ids = [
    ...new Set(rows.flatMap((row) => (row.owner_user_id === null ? [] : [row.owner_user_id]))),
  ];
  const memberships =
    people === undefined || ids.length === 0
      ? new Map<string, string>()
      : await people.assignees.memberships(trx, context, ids);
  const names =
    people === undefined || ids.length === 0 ? undefined : await people.actorNames.user?.(trx, ids);
  return (userId) => ({
    membershipId: memberships.get(userId) ?? null,
    name: names?.get(userId) ?? null,
    you: context.actorKind === 'user' && userId === context.userId,
  });
}

const mayManage = (invocation: Invocation): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has('records.manage');

/** A record of the object as the API shows it, its owner named by `ownerOf`. */
function present(
  invocation: Invocation,
  object: Pick<LiveObject, 'key'>,
  ownerOf: (userId: string) => ContactPerson,
  row: RecordRow,
): CustomRecord {
  return {
    id: toPublicId('custom', row.id),
    objectKey: object.key,
    name: row.title,
    owner: row.owner_user_id === null ? null : ownerOf(row.owner_user_id),
    ownerRevision: ownerRevisionOf(row.owner_user_id),
    trashedAt: row.deleted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    canManage: mayManage(invocation),
  };
}

/** These records of the object, as the API shows them. */
export async function presentRecords(
  trx: DatabaseTransaction,
  invocation: Invocation,
  people: RecordPeople,
  object: Pick<LiveObject, 'key'>,
  rows: readonly RecordRow[],
): Promise<CustomRecord[]> {
  const ownerOf = await ownersOf(trx, invocation.context, people, rows);
  return rows.map((row) => present(invocation, object, ownerOf, row));
}

/** A record of the object, in the trash or not; one of another object is not found here. */
async function recordOf(
  trx: DatabaseTransaction,
  object: LiveObject,
  id: string,
  lock: boolean,
): Promise<RecordRow> {
  let query = trx
    .selectFrom('crm.custom_records')
    .select(recordColumns)
    .where('id', '=', uuidOf('custom', id))
    .where('object_type_id', '=', object.id);
  // As a company's trash takes its row: the change and the trash wait for each other.
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Record', id);
  return row;
}

export async function readCustomRecord(
  trx: DatabaseTransaction,
  invocation: Invocation,
  people: RecordPeople,
  key: string,
  id: string,
): Promise<CustomRecord> {
  requireBusiness(invocation.context);
  const object = await liveObject(trx, key);
  const row = await recordOf(trx, object, id, false);
  return present(invocation, object, await ownersOf(trx, invocation.context, people, [row]), row);
}

/** The user an owner names, or none: someone off the team is refused where it was named. */
async function ownerFrom(
  trx: DatabaseTransaction,
  command: CommandContext,
  people: RecordPeople,
  owner: string | null,
): Promise<string | null> {
  if (owner === null) return null;
  if (people === undefined)
    throw new ValidationError([
      {
        path: '/owner',
        code: 'unavailable_member',
        message: 'Choose someone on this business or agency team.',
      },
    ]);
  return memberOf(people, trx, command, owner, '/owner');
}

const storedOptions = z.array(fieldOption).catch([]);

/** A value as the field command takes it: a choice named by its label becomes its key. */
function asGiven(
  valueType: string,
  options: unknown,
  value: z.output<typeof createCustomRecordInput>['fields'][string],
): string | boolean | string[] | Readonly<Record<string, string>> {
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  return asChoiceKeys(valueType, storedOptions.parse(options), value);
}

/** Checks or sets a field's value, saying a refusal by the field it was given for. */
async function forField<T>(name: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    const move = (issue: Issue): Issue => ({
      ...issue,
      path: `/fields/${name}${issue.path.replace(/^\/value/, '')}`,
    });
    const [first, ...rest] = error.issues;
    throw new ValidationError([move(first), ...rest.map(move)]);
  }
}

const createInput = createCustomRecordInput.extend(customRecordsParams.shape);
const updateInput = updateCustomRecordInput.extend(customRecordParams.shape);

export interface CustomRecordCommands {
  readonly create: Command<typeof createInput, CustomRecord>;
  readonly update: Command<typeof updateInput, CustomRecord>;
  readonly trash: Command<typeof customRecordParams, CustomRecord>;
  readonly restore: Command<typeof customRecordParams, CustomRecord>;
}

/** The commands on a custom object's records. `people` names owners, as a deal's are. */
export function customRecordCommands(people: RecordPeople): CustomRecordCommands {
  const setTrashed = async (
    trx: DatabaseTransaction,
    input: z.output<typeof customRecordParams>,
    command: CommandContext,
    trashed: boolean,
  ): Promise<CustomRecord> => {
    requireBusiness(command.context);
    const object = await liveObject(trx, input.key);
    const row = await recordOf(trx, object, input.id, true);
    if ((row.deleted_at !== null) !== trashed) {
      await trx
        .updateTable('crm.custom_records')
        .set({ deleted_at: trashed ? sql<Date>`now()` : null })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: trashed ? 'record.trashed' : 'record.restored',
        subject: { kind: 'custom', id: row.id },
        records: [row.id],
        payload: { objectKey: object.key },
      });
    }
    return readCustomRecord(trx, command, people, input.key, input.id);
  };

  return {
    create: defineCommand({
      name: 'record.create',
      permission: 'records.manage',
      input: createInput,
      async handle(trx, input, command): Promise<CustomRecord> {
        const businessId = requireBusiness(command.context);
        const object = await liveObject(trx, input.key, true);
        const definitions = await trx
          .selectFrom('crm.field_definitions')
          .select(['id', 'key', 'value_type', 'options', 'archived_at'])
          .where('object_type_id', '=', object.id)
          .where('merged_into_field_id', 'is', null)
          .execute();
        const named = Object.entries(input.fields).map(([name, value]) => ({
          name,
          value,
          definition: definitions.find((each) => each.key === name && each.archived_at === null),
        }));
        const given = named.flatMap(({ definition, ...each }) =>
          definition === undefined ? [] : [{ ...each, definition }],
        );
        const unknown: Issue[] = named
          .filter((each) => each.definition === undefined)
          .map((each) => ({
            path: `/fields/${each.name}`,
            code: 'unknown_field',
            message: `This is not a field of ${object.singular_label}. Name a field by its key.`,
          }));
        const [first, ...rest] = unknown;
        if (first !== undefined) throw new ValidationError([first, ...rest]);
        const primary = asField(
          await requireValueDefinition(
            trx,
            object.id,
            toPublicId('field', object.primary_field_id),
          ),
        );
        const main = given.find((each) => each.definition.id === object.primary_field_id);
        // Setting other fields' values is a permission of its own, as it is on a contact.
        if (
          given.some((each) => each !== main) &&
          command.permissions !== 'all' &&
          !command.permissions.has('fields.values')
        )
          throw new ForbiddenError(
            "Your role doesn't allow setting field values: it needs fields.values.",
            'fields.values',
          );
        const title = await forField(primary.key, async () =>
          primaryName(
            primary,
            await validateFieldValue(trx, primary, main?.value ?? null, null, businessId),
            '/value',
          ),
        );
        const owner = await ownerFrom(trx, command, people, input.owner);
        const { id } = await trx
          .insertInto('crm.records')
          .values({ business_id: businessId, kind: 'custom', object_type_id: object.id })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('crm.custom_records')
          .values({
            business_id: businessId,
            id,
            object_type_id: object.id,
            // The primary field's value, which the database keeps it as from now on.
            title,
            owner_user_id: owner,
            created_by_kind: command.context.actorKind,
            created_by_id: command.context.actorId ?? null,
          })
          .execute();
        await command.emit({
          type: 'record.created',
          subject: { kind: 'custom', id },
          records: [id],
          payload: { objectKey: object.key },
        });
        const record = toPublicId('custom', id);
        // The primary field first, then the rest in the order given.
        const ordered = [...given].sort((a, b) => Number(b === main) - Number(a === main));
        for (const { name, value, definition } of ordered) {
          const fieldId = toPublicId('field', definition.id);
          const current = await readRecordField(trx, command, record, fieldId);
          await forField(name, () =>
            setRecordFieldCommand.handle(
              trx,
              {
                id: record,
                fieldId,
                value: asGiven(definition.value_type, definition.options, value),
                revision: current.revision,
              },
              command,
            ),
          );
        }
        return readCustomRecord(trx, command, people, input.key, record);
      },
    }),
    update: defineCommand({
      name: 'record.update',
      permission: 'records.manage',
      input: updateInput,
      async handle(trx, input, command): Promise<CustomRecord> {
        requireBusiness(command.context);
        const object = await liveObject(trx, input.key);
        const row = await recordOf(trx, object, input.id, true);
        if (row.deleted_at !== null)
          throw new ConflictError('Restore this record before changing it.');
        requireRevision("This record's owner", ownerRevisionOf(row.owner_user_id), input.revision);
        const owner = await ownerFrom(trx, command, people, input.owner);
        if (owner !== row.owner_user_id) {
          await trx
            .updateTable('crm.custom_records')
            .set({ owner_user_id: owner })
            .where('id', '=', row.id)
            .execute();
          await command.emit({
            type: 'record.updated',
            subject: { kind: 'custom', id: row.id },
            records: [row.id],
            payload: { objectKey: object.key, changed: ['owner'] },
          });
        }
        return readCustomRecord(trx, command, people, input.key, input.id);
      },
    }),
    trash: defineCommand({
      name: 'record.trash',
      permission: 'records.manage',
      input: customRecordParams,
      handle: (trx, input, command) => setTrashed(trx, input, command, true),
    }),
    restore: defineCommand({
      name: 'record.restore',
      permission: 'records.manage',
      input: customRecordParams,
      handle: (trx, input, command) => setTrashed(trx, input, command, false),
    }),
  };
}
