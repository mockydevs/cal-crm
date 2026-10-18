// Tags: labels for grouping and filtering, never state.
import { defineCommand, requireBusiness } from '@repo/commands';
import { createTagInput, type Tag } from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import { toPublicId, ValidationError } from '@repo/kernel';
import { isPersonsAssistant, requireTagDesigner } from './access.js';
import { requireTagGroup } from './groups.js';
import { requireTagCreation } from './rules.js';

import { countTagsCreated } from './counts.js';

const columns = ['id', 'name', 'description', 'created_at', 'updated_at'] as const;

interface TagRow {
  id: string;
  name: string;
  description: string;
  created_at: Date;
  updated_at: Date;
}

/** A tag as the API shows it. */
export function asTag(row: TagRow): Tag {
  return {
    id: toPublicId('tag', row.id),
    name: row.name,
    description: row.description,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const createTagCommand = defineCommand({
  name: 'tag.create',
  permission: 'tags.manage',
  input: createTagInput,
  // The in-app assistant may make a tag for the person it works for, held to the rule for
  // building drafts. The command layer refuses every other assistant, at any level.
  delegation: { action: 'build_draft' },
  async handle(trx, input, command): Promise<Tag> {
    const { context } = command;
    // Automations and every other assistant only apply tags that exist. The in-app
    // assistant is the exception: a person asked it to, and it is held to that person's
    // own role and to the business's rules for who may create a tag, as they are.
    if (!isPersonsAssistant(command)) requireTagDesigner(command, 'tags.manage');
    requireBusiness(context);
    await requireTagCreation(trx, command);
    const groupId = await requireTagGroup(trx, input.groupId);
    const row = await trx
      .insertInto('crm.tags')
      .values({
        business_id: requireBusiness(context),
        name: input.name,
        description: input.description,
        group_id: groupId,
        created_by_kind: context.actorKind,
        created_by_id: context.actorId ?? null,
      })
      .returning(columns)
      .executeTakeFirstOrThrow()
      .catch(
        explainUniqueViolation({
          // Names that differ only in case, spaces, hyphens or underscores are the same tag.
          tags_name_key_unique: () =>
            new ValidationError([
              { path: '/name', code: 'taken', message: 'A tag with this name already exists.' },
            ]),
        }),
      );
    await command.emit({
      type: 'tag.created',
      subject: { kind: 'tag', id: row.id },
      payload: { name: row.name, description: row.description },
    });
    command.enqueue(countTagsCreated, { tagId: row.id });
    return asTag(row);
  },
});

/** The tags of the transaction's business, by name. */
export async function readTags(trx: DatabaseTransaction): Promise<Tag[]> {
  const rows = await trx.selectFrom('crm.tags').select(columns).orderBy('name_key').execute();
  return rows.map(asTag);
}
