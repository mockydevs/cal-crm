// A record's files: documents uploaded to the record, and the files of its file upload
// fields. crm.record_files ties each file to its record (and its field); the bytes and the
// file's own row are the files service's, reached through RecordFileStore. A file upload
// field's value (crm.field_values) is the list of its files, rewritten from
// crm.record_files whenever one is added or deleted, by this module alone.
import type { Readable } from 'node:stream';

import {
  defineCommand,
  requireBusiness,
  type Command,
  type CommandContext,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  documentFormats,
  publicId,
  recordId,
  type DocumentFormat,
  type FieldDefinition,
  type RecordFile,
  type StoredFile,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import * as z from 'zod';

import { requireRecord } from '../records/access.js';
import { asField } from '../fields/fields.js';
import { requireValueDefinition } from '../fields/value-writes.js';

/** What a record's files need of the files service. */
export interface RecordFileStore {
  /** The largest upload taken, in bytes. */
  readonly maxBytes: number;
  receive(body: Readable): Promise<{ readonly upload: string; discard(): Promise<void> }>;
  /** Checks and stores a received upload's bytes, before any row is held. */
  stageDocument(
    services: Services,
    upload: string,
    document: { readonly filename: string; readonly formats: readonly DocumentFormat[] },
  ): Promise<{ readonly id: string; discard(): Promise<void> }>;
  /** Keeps a staged document, in the command's transaction, once. */
  keepStaged(
    trx: DatabaseTransaction,
    command: CommandContext,
    stagedId: string,
    keep: {
      readonly formats: readonly DocumentFormat[];
      /** Always record_file: a record's files are linked only through their record. */
      readonly purpose: 'record_file';
    },
  ): Promise<StoredFile>;
  /** A signed link to a file the invocation can see, as a path under the API's address. */
  link(
    services: Services,
    invocation: Invocation,
    fileId: string,
    lifetime: { readonly seconds: number; readonly purpose?: 'record_file' },
  ): Promise<{ path: string; expiresAt: string }>;
}

const granted = (
  command: Pick<CommandContext, 'permissions'>,
  permission: 'fields.values',
): boolean => command.permissions === 'all' || command.permissions.has(permission);

/** A field's files are its value: changing them needs what changing any value needs. */
export function requireValues(command: Pick<CommandContext, 'permissions'>): void {
  if (!granted(command, 'fields.values'))
    throw new ForbiddenError(
      "Your role can't change field values: a field's files need fields.values.",
      'fields.values',
    );
}

/** A field that holds its limit already. */
export const fieldFull = (limit: number): ValidationError =>
  new ValidationError([
    {
      path: '/field',
      code: 'field_full',
      message:
        limit === 1
          ? 'This field holds one file. Delete it to upload another.'
          : `This field holds at most ${String(limit)} files. Delete one to upload another.`,
    },
  ]);

/** The file upload field a file goes in or comes out of, held for the change when said. */
export async function fileField(
  trx: DatabaseTransaction,
  objectTypeId: string,
  fieldId: string,
  lock = true,
): Promise<FieldDefinition> {
  const definition = asField(await requireValueDefinition(trx, objectTypeId, fieldId, lock));
  if (definition.valueType !== 'file')
    throw new ValidationError([
      {
        path: '/field',
        code: 'not_a_file_field',
        message: 'Choose a file upload field to put a file in.',
      },
    ]);
  if (definition.archived) throw new ConflictError('Restore this field before changing its value.');
  return definition;
}

/**
 * Rewrites a file upload field's value on a record from the files it holds, oldest first,
 * as the command's actor's: no value once the last file is gone. Emits the field change
 * the value's source names, as setting any value does.
 */
async function rewriteFieldValue(
  trx: DatabaseTransaction,
  command: CommandContext,
  record: { readonly id: string; readonly kind: string },
  publicRecordId: string,
  definition: FieldDefinition,
): Promise<void> {
  const businessId = requireBusiness(command.context);
  const fieldId = parsePublicId('field', definition.id) ?? '';
  const files = await trx
    .selectFrom('crm.record_files')
    .select('file_id')
    .where('record_id', '=', record.id)
    .where('field_id', '=', fieldId)
    .orderBy('created_at')
    .orderBy('file_id')
    .execute();
  const eventId = await command.emit({
    type: files.length === 0 ? 'field.value_cleared' : 'field.value_set',
    subject: { kind: record.kind, id: record.id },
    records: [record.id],
    payload: { recordId: publicRecordId, fieldId: definition.id },
  });
  if (files.length === 0) {
    await trx
      .deleteFrom('crm.field_values')
      .where('record_id', '=', record.id)
      .where('field_id', '=', fieldId)
      .execute();
    return;
  }
  const values = {
    value_options: files.map((file) => file.file_id),
    source_kind: command.context.actorKind,
    source_id: command.context.actorId ?? null,
    source_event_id: eventId,
    updated_at: new Date(),
    confidence: null,
    confirmed_at: null,
    confirmed_by_id: null,
  };
  await trx
    .insertInto('crm.field_values')
    .values({
      business_id: businessId,
      record_id: record.id,
      field_id: fieldId,
      value_type: 'file',
      ...values,
    })
    .onConflict((conflict) =>
      conflict.columns(['business_id', 'record_id', 'field_id']).doUpdateSet(values),
    )
    .execute();
}

export const attachRecordFileInput = z.strictObject({
  id: recordId,
  field: publicId('field').optional(),
  /** A document the files service has checked and stored, waiting to be kept. */
  staged: z.uuid(),
});

export const removeRecordFileInput = z.strictObject({ id: recordId, fileId: publicId('file') });

/** Adding a file to a record, and deleting one. */
export interface RecordFileCommands {
  readonly attach: Command<typeof attachRecordFileInput, RecordFile>;
  readonly remove: Command<typeof removeRecordFileInput, void>;
}

/** The commands that add a file to a record and delete one, with the files service. */
export function createRecordFileCommands(store: RecordFileStore): RecordFileCommands {
  const attach = defineCommand({
    name: 'record.file.attach',
    permission: 'files.upload',
    input: attachRecordFileInput,
    // A file's name can say whose it is; the log keeps where it went.
    audit: ({ id, field }) => ({ id, ...(field === undefined ? {} : { field }) }),
    async handle(trx, input, command): Promise<RecordFile> {
      const businessId = requireBusiness(command.context);
      // Held, so two uploads to one field count each other's files; refused in the trash.
      const record = await requireRecord(trx, input.id, true);
      let definition: FieldDefinition | undefined;
      if (input.field !== undefined) {
        requireValues(command);
        definition = await fileField(trx, record.objectTypeId, input.field);
        const limit = definition.files?.limit ?? 1;
        const held = await trx
          .selectFrom('crm.record_files')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('record_id', '=', record.id)
          .where('field_id', '=', parsePublicId('field', definition.id) ?? '')
          .executeTakeFirstOrThrow();
        if (Number(held.count) >= limit) throw fieldFull(limit);
      }
      const stored = await store.keepStaged(trx, command, input.staged, {
        formats: definition?.files?.formats ?? documentFormats,
        purpose: 'record_file',
      });
      const fileId = parsePublicId('file', stored.id) ?? '';
      const link = await trx
        .insertInto('crm.record_files')
        .values({
          business_id: businessId,
          file_id: fileId,
          record_id: record.id,
          field_id:
            definition === undefined ? null : (parsePublicId('field', definition.id) ?? null),
          created_by_kind: command.context.actorKind,
          created_by_id: command.context.actorId ?? null,
        })
        .returning('created_at')
        .executeTakeFirstOrThrow();
      if (definition !== undefined)
        await rewriteFieldValue(trx, command, record, input.id, definition);
      else
        await command.emit({
          type: 'record.file_added',
          subject: { kind: record.kind, id: record.id },
          records: [record.id],
          payload: {
            recordId: input.id,
            fileId: stored.id,
            contentType: stored.contentType,
            size: stored.size,
          },
        });
      return {
        id: stored.id,
        filename: stored.filename,
        contentType: stored.contentType,
        size: stored.size,
        createdAt: link.created_at.toISOString(),
        folder: 'internal',
        field: definition === undefined ? null : { id: definition.id, label: definition.label },
        addedBy: {
          kind: command.context.actorKind,
          name: null,
          you:
            command.context.actorKind === 'user' &&
            command.context.userId !== undefined &&
            command.context.actorId === command.context.userId,
        },
        removable: true,
      };
    },
  });

  const remove = defineCommand({
    name: 'record.file.remove',
    permission: 'files.upload',
    input: removeRecordFileInput,
    async handle(trx, input, command): Promise<void> {
      requireBusiness(command.context);
      const record = await requireRecord(trx, input.id, true);
      const fileId = parsePublicId('file', input.fileId) ?? '';
      // The record is held above, so no other change to its files runs meanwhile.
      const link = await trx
        .selectFrom('crm.record_files')
        .select(['field_id'])
        .where('record_id', '=', record.id)
        .where('file_id', '=', fileId)
        .executeTakeFirst();
      if (link === undefined) throw new NotFoundError('File', input.fileId);
      let definition: FieldDefinition | undefined;
      if (link.field_id !== null) {
        requireValues(command);
        definition = await fileField(trx, record.objectTypeId, toPublicId('field', link.field_id));
      }
      await trx
        .deleteFrom('crm.record_files')
        .where('record_id', '=', record.id)
        .where('file_id', '=', fileId)
        .execute();
      // The file goes with its link: the database marks it deleted, and its bytes are
      // removed once this commits.
      if (definition !== undefined)
        await rewriteFieldValue(trx, command, record, input.id, definition);
      else
        await command.emit({
          type: 'record.file_removed',
          subject: { kind: record.kind, id: record.id },
          records: [record.id],
          payload: { recordId: input.id, fileId: input.fileId },
        });
    },
  });

  return { attach, remove };
}
