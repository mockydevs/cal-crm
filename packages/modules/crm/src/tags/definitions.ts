import { createHash } from 'node:crypto';
import { defineCommand, requireBusiness } from '@repo/commands';
import { updateTagInput, updateTag, type TagDefinition } from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction, type DB } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import type { Selectable } from 'kysely';
import { requireTagDesigner } from './access.js';
import { requireTagGroup } from './groups.js';
import { asTag } from './tags.js';

function asDefinition(row: Selectable<DB['crm.tags']>): TagDefinition {
  const groupId = row.group_id === null ? null : toPublicId('tag_group', row.group_id);
  const revision = createHash('sha256')
    .update(JSON.stringify({ id: row.id, name: row.name, description: row.description, groupId }))
    .digest('hex');
  return { ...asTag(row), groupId, revision };
}
export async function readTagDefinitions(trx: DatabaseTransaction): Promise<TagDefinition[]> {
  return (await trx.selectFrom('crm.tags').selectAll().orderBy('name_key').execute()).map(
    asDefinition,
  );
}
export const updateTagCommand = defineCommand({
  name: 'tag.update',
  permission: 'tags.configure',
  input: updateTagInput.extend(updateTag.params.shape),
  async handle(trx, input, command): Promise<TagDefinition> {
    requireBusiness(command.context);
    requireTagDesigner(command, 'tags.configure');
    const current = await trx
      .selectFrom('crm.tags')
      .selectAll()
      .where('id', '=', parsePublicId('tag', input.id) ?? '')
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) throw new NotFoundError('Tag', input.id);
    if (asDefinition(current).revision !== input.revision)
      throw new ConflictError('This tag changed. Reload the saved version before editing again.');
    const groupId = await requireTagGroup(trx, input.groupId);
    const saved = await trx
      .updateTable('crm.tags')
      .set({ name: input.name, description: input.description, group_id: groupId })
      .where('id', '=', current.id)
      .returningAll()
      .executeTakeFirstOrThrow()
      .catch(
        explainUniqueViolation({
          tags_name_key_unique: () =>
            new ValidationError([
              { path: '/name', code: 'taken', message: 'A tag with this name already exists.' },
            ]),
        }),
      );
    await command.emit({
      type: 'tag.updated',
      subject: { kind: 'tag', id: saved.id },
      payload: { name: saved.name, description: saved.description, groupId: input.groupId },
    });
    return asDefinition(saved);
  },
});
