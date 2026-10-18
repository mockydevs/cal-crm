import type { Tag, TagConfiguration } from '@repo/contracts';

/** A complete configuration reply for existing tag-list browser fixtures. */
export function configurationOf(
  items: readonly Pick<Tag, 'id' | 'name' | 'description' | 'createdAt' | 'updatedAt'>[],
): TagConfiguration {
  return {
    items: items.map((item) => ({ ...item, groupId: null, revision: 'a'.repeat(64) })),
    groups: [],
    rules: { creation: 'admins', suggestSimilar: true, revision: 'a'.repeat(64) },
    canManage: true,
    canCreate: true,
  };
}
