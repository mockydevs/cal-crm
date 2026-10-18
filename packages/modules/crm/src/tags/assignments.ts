import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import {
  assignRecordTag,
  assignRecordTagInput,
  removeRecordTag,
  recordTag,
  type RecordTag,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { asTag } from './tags.js';

import { requireRecord } from '../records/access.js';

export async function requireExistingTag(trx: DatabaseTransaction, tagId: string): Promise<string> {
  const row = await trx
    .selectFrom('crm.tags')
    .select('id')
    .where('id', '=', parsePublicId('tag', tagId) ?? '')
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Tag', tagId);
  return row.id;
}

function assignments(trx: DatabaseTransaction, recordId: string) {
  return trx
    .selectFrom('crm.record_tags as assignment')
    .innerJoin('crm.tags as tag', (join) =>
      join
        .onRef('tag.business_id', '=', 'assignment.business_id')
        .onRef('tag.id', '=', 'assignment.tag_id'),
    )
    .select([
      'tag.id',
      'tag.name',
      'tag.description',
      'tag.created_at',
      'tag.updated_at',
      'assignment.created_at as assigned_at',
      'assignment.source_kind',
      'assignment.source_id',
      'assignment.source_event_id',
    ])
    .where('assignment.record_id', '=', recordId)
    .orderBy('tag.name_key');
}

interface AssignmentRow {
  id: string;
  name: string;
  description: string;
  created_at: Date;
  updated_at: Date;
  assigned_at: Date;
  source_kind: string;
  source_id: string | null;
  source_event_id: string | null;
}
function present(row: AssignmentRow, invocation: Invocation): RecordTag {
  return recordTag.parse({
    tag: asTag(row),
    source: {
      kind: row.source_kind,
      eventId: row.source_event_id === null ? null : toPublicId('event', row.source_event_id),
      you:
        row.source_kind === 'user' &&
        row.source_id !== null &&
        row.source_id === invocation.context.userId,
    },
    createdAt: row.assigned_at.toISOString(),
  });
}

export async function readRecordTags(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
): Promise<{ items: RecordTag[]; canManage: boolean }> {
  requireBusiness(invocation.context);
  const record = await requireRecord(trx, id);
  return {
    items: (await assignments(trx, record.id).execute()).map((row) => present(row, invocation)),
    canManage:
      !record.trashed &&
      (invocation.permissions === 'all' || invocation.permissions.has('tags.manage')),
  };
}

// What an assistant may do with tags, kept here and in access.ts rather than by an autonomy
// rule: it puts an existing tag on a record and takes one off, as an automation does, and
// never creates, renames or deletes a tag.
const ASSISTANT_RULE =
  'An assistant applies and removes only tags that already exist; it never creates or changes one.';

export const assignRecordTagCommand = defineCommand({
  name: 'tag.assign',
  permission: 'tags.manage',
  input: assignRecordTagInput.extend(assignRecordTag.params.shape),
  ownAssistantRule: ASSISTANT_RULE,
  async handle(trx, input, command): Promise<RecordTag> {
    const businessId = requireBusiness(command.context);
    const record = await requireRecord(trx, input.id, true);
    const tagId = await requireExistingTag(trx, input.tagId);
    const existing = await assignments(trx, record.id)
      .where('tag.id', '=', tagId)
      .executeTakeFirst();
    if (existing !== undefined) return present(existing, command);
    const eventId = await command.emit({
      type: 'tag.assigned',
      subject: { kind: 'tag', id: tagId },
      records: [record.id],
      payload: { recordId: input.id, tagId: input.tagId },
    });
    await trx
      .insertInto('crm.record_tags')
      .values({
        business_id: businessId,
        record_id: record.id,
        tag_id: tagId,
        source_kind: command.context.actorKind,
        source_id: command.context.actorId ?? null,
        source_event_id: eventId,
      })
      .execute();
    return present(
      await assignments(trx, record.id).where('tag.id', '=', tagId).executeTakeFirstOrThrow(),
      command,
    );
  },
});

export const removeRecordTagCommand = defineCommand({
  name: 'tag.remove',
  permission: 'tags.manage',
  input: removeRecordTag.params,
  ownAssistantRule: ASSISTANT_RULE,
  async handle(trx, input, command): Promise<void> {
    requireBusiness(command.context);
    const record = await requireRecord(trx, input.id, true);
    const tagId = await requireExistingTag(trx, input.tagId);
    const removed = await trx
      .deleteFrom('crm.record_tags')
      .where('record_id', '=', record.id)
      .where('tag_id', '=', tagId)
      .returning('tag_id')
      .executeTakeFirst();
    if (removed !== undefined)
      await command.emit({
        type: 'tag.removed',
        subject: { kind: 'tag', id: tagId },
        records: [record.id],
        payload: { recordId: input.id, tagId: input.tagId },
      });
  },
});
