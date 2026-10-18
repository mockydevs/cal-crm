import { createHash } from 'node:crypto';
import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import {
  createTagGroupInput,
  updateTagGroupInput,
  updateTagGroup,
  type TagGroup,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction, type DB } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import type { Selectable } from 'kysely';
import { canConfigureTags, requireTagDesigner } from './access.js';

const uniqueErrors = explainUniqueViolation({
  tag_groups_name_unique_idx: () =>
    new ValidationError([
      { path: '/name', code: 'taken', message: 'A group with this name already exists.' },
    ]),
});

export async function requireTagGroup(
  trx: DatabaseTransaction,
  groupId: string | null | undefined,
): Promise<string | null> {
  if (groupId === undefined || groupId === null) return null;
  const id = parsePublicId('tag_group', groupId) ?? '';
  const group = await trx
    .selectFrom('crm.tag_groups')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (group === undefined)
    throw new ValidationError([
      { path: '/groupId', code: 'invalid_group', message: 'Choose a group in this business.' },
    ]);
  return group.id;
}

function asGroup(row: Selectable<DB['crm.tag_groups']>): TagGroup {
  const data = {
    id: toPublicId('tag_group', row.id),
    name: row.name,
    description: row.description,
  };
  return { ...data, revision: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
}

export async function readTagGroups(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<{ items: TagGroup[]; canManage: boolean }> {
  requireBusiness(invocation.context);
  const rows = await trx
    .selectFrom('crm.tag_groups')
    .selectAll()
    .orderBy('position')
    .orderBy('id')
    .execute();
  return { items: rows.map(asGroup), canManage: canConfigureTags(invocation) };
}

export const createTagGroupCommand = defineCommand({
  name: 'tag_group.create',
  permission: 'tags.configure',
  input: createTagGroupInput,
  async handle(trx, input, command): Promise<TagGroup> {
    const businessId = requireBusiness(command.context);
    requireTagDesigner(command, 'tags.configure');
    const row = await trx
      .insertInto('crm.tag_groups')
      .values({ business_id: businessId, name: input.name, description: input.description })
      .returningAll()
      .executeTakeFirstOrThrow()
      .catch(uniqueErrors);
    await command.emit({
      type: 'tag_group.created',
      subject: { kind: 'tag_group', id: row.id },
      payload: { name: row.name, description: row.description },
    });
    return asGroup(row);
  },
});

export const updateTagGroupCommand = defineCommand({
  name: 'tag_group.update',
  permission: 'tags.configure',
  input: updateTagGroupInput.extend(updateTagGroup.params.shape),
  async handle(trx, input, command): Promise<TagGroup> {
    requireBusiness(command.context);
    requireTagDesigner(command, 'tags.configure');
    const current = await trx
      .selectFrom('crm.tag_groups')
      .selectAll()
      .where('id', '=', parsePublicId('tag_group', input.groupId) ?? '')
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) throw new NotFoundError('Tag group', input.groupId);
    if (asGroup(current).revision !== input.revision)
      throw new ConflictError('This group changed. Reload the saved version before editing again.');
    const saved = await trx
      .updateTable('crm.tag_groups')
      .set({ name: input.name, description: input.description })
      .where('id', '=', current.id)
      .returningAll()
      .executeTakeFirstOrThrow()
      .catch(uniqueErrors);
    await command.emit({
      type: 'tag_group.updated',
      subject: { kind: 'tag_group', id: saved.id },
      payload: { name: saved.name, description: saved.description },
    });
    return asGroup(saved);
  },
});
