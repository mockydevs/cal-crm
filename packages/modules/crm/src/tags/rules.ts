import { createHash } from 'node:crypto';
import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import { updateTagRulesInput, type TagRules } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, ForbiddenError } from '@repo/kernel';
import { canConfigureTags, isPersonsAssistant, requireTagDesigner } from './access.js';

function asRules(creation: string, suggestSimilar: boolean): TagRules {
  const data = {
    creation: creation === 'everyone' ? ('everyone' as const) : ('admins' as const),
    suggestSimilar,
  };
  return { ...data, revision: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
}

export async function readTagRules(trx: DatabaseTransaction): Promise<TagRules> {
  const row = await trx
    .selectFrom('crm.settings')
    .select(['tag_creation', 'suggest_similar_tags'])
    .executeTakeFirst();
  return asRules(row?.tag_creation ?? 'admins', row?.suggest_similar_tags ?? true);
}

/** Hold the saved policy stable until this creation commits. Missing settings fail closed. */
export async function requireTagCreation(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<void> {
  const row = await trx
    .selectFrom('crm.settings')
    .select('tag_creation')
    .forShare()
    .executeTakeFirst();
  // The in-app assistant creates one exactly where the person it works for could.
  const configures =
    canConfigureTags(invocation) ||
    (isPersonsAssistant(invocation) &&
      (invocation.permissions === 'all' || invocation.permissions.has('tags.configure')));
  if (row?.tag_creation !== 'everyone' && !configures)
    throw new ForbiddenError(
      'Only someone who configures tags may create them under these rules.',
      'tags.configure',
    );
}

export const updateTagRulesCommand = defineCommand({
  name: 'tag_rules.update',
  permission: 'tags.configure',
  input: updateTagRulesInput,
  async handle(trx, input, command): Promise<TagRules> {
    const businessId = requireBusiness(command.context);
    requireTagDesigner(command, 'tags.configure');
    await trx
      .insertInto('crm.settings')
      .values({ business_id: businessId })
      .onConflict((conflict) => conflict.column('business_id').doNothing())
      .execute();
    const current = await trx
      .selectFrom('crm.settings')
      .selectAll()
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (asRules(current.tag_creation, current.suggest_similar_tags).revision !== input.revision)
      throw new ConflictError(
        'These rules changed. Reload the saved version before editing again.',
      );
    await trx
      .updateTable('crm.settings')
      .set({ tag_creation: input.creation, suggest_similar_tags: input.suggestSimilar })
      .where('business_id', '=', businessId)
      .execute();
    await command.emit({
      type: 'tag_rules.updated',
      subject: { kind: 'business', id: businessId },
      payload: { creation: input.creation, suggestSimilar: input.suggestSimilar },
    });
    return asRules(input.creation, input.suggestSimilar);
  },
});
