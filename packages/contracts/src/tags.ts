// Tags: labels for grouping and filtering, never state (DATABASE.md section 6.3). The
// limits match crm.tags.
import * as z from 'zod';
import { actorKinds } from '@repo/kernel';

import { defineEndpoint } from './endpoints.js';
import { publicId, recordId } from './ids.js';
import { timestamp } from './timestamps.js';

export const updateTagRulesInput = z
  .strictObject({
    creation: z.enum(['admins', 'everyone']),
    suggestSimilar: z.boolean(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .meta({ id: 'UpdateTagRulesInput' });

export const createTagGroupInput = z
  .strictObject({
    name: z.string().trim().min(1, { error: 'Give the group a name.' }).max(60),
    description: z.string().trim().max(500).default(''),
  })
  .meta({ id: 'CreateTagGroupInput' });
export const tagGroup = createTagGroupInput
  .extend({
    id: publicId('tag_group'),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .meta({ id: 'TagGroup' });
export type TagGroup = z.output<typeof tagGroup>;
export const tagGroupList = z
  .strictObject({
    items: z.array(tagGroup),
    canManage: z.boolean(),
  })
  .meta({ id: 'TagGroupList' });
export const getTagGroups = defineEndpoint({
  operationId: 'getTagGroups',
  method: 'get',
  path: '/tag-groups',
  summary: 'List tag groups',
  group: 'Tags',
  response: { status: 200, description: 'The business tag groups.', schema: tagGroupList },
});
export const createTagGroup = defineEndpoint({
  operationId: 'createTagGroup',
  method: 'post',
  path: '/tag-groups',
  summary: 'Create a tag group',
  group: 'Tags',
  body: createTagGroupInput,
  response: { status: 201, description: 'The new group.', schema: tagGroup },
});
export const updateTagGroupInput = createTagGroupInput
  .extend({
    revision: tagGroup.shape.revision,
  })
  .meta({ id: 'UpdateTagGroupInput' });
export const updateTagGroup = defineEndpoint({
  operationId: 'updateTagGroup',
  method: 'put',
  path: '/tag-groups/{groupId}',
  summary: 'Edit a tag group',
  group: 'Tags',
  params: z.strictObject({ groupId: publicId('tag_group') }),
  body: updateTagGroupInput,
  response: { status: 200, description: 'The saved group.', schema: tagGroup },
});

export const tag = z
  .looseObject({
    id: publicId('tag'),
    name: z.string().meta({ examples: ['Hot lead'] }),
    description: z.string().meta({ examples: ['Asked for a quote in the last week.'] }),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'Tag', description: 'A label for grouping and filtering records.' });

export type Tag = z.infer<typeof tag>;

export const createTagInput = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1, { error: 'Give the tag a name.' })
      .max(60, { error: 'Use at most 60 characters.' })
      .meta({
        description:
          'Names that differ only in case, spaces, hyphens or underscores are the same tag.',
        examples: ['Hot lead'],
      }),
    description: z
      .string()
      .max(500, { error: 'Use at most 500 characters.' })
      .default('')
      .meta({ description: 'What the tag means, for people and the assistant.' }),
    groupId: publicId('tag_group').nullable().optional(),
  })
  .meta({ id: 'CreateTagInput' });

export type CreateTagInput = z.input<typeof createTagInput>;

export const tagList = z
  .looseObject({ items: z.array(tag) })
  .meta({ id: 'TagList', description: "The business's tags, by name." });

export const createTag = defineEndpoint({
  operationId: 'createTag',
  method: 'post',
  path: '/tags',
  summary: 'Create a tag',
  group: 'Tags',
  body: createTagInput,
  response: { status: 201, description: 'The new tag.', schema: tag },
});

export const listTags = defineEndpoint({
  operationId: 'listTags',
  method: 'get',
  path: '/tags',
  summary: 'List the tags',
  group: 'Tags',
  response: { status: 200, description: "The business's tags, by name.", schema: tagList },
});

export const tagRules = updateTagRulesInput.meta({ id: 'TagRules' });
export type TagRules = z.output<typeof tagRules>;
export const tagDefinition = tag
  .extend({
    groupId: publicId('tag_group').nullable(),
    revision: tagGroup.shape.revision,
  })
  .meta({ id: 'TagDefinition' });
export type TagDefinition = z.output<typeof tagDefinition>;
export const tagConfiguration = z
  .strictObject({
    items: z.array(tagDefinition),
    groups: z.array(tagGroup),
    rules: tagRules,
    canManage: z.boolean(),
    canCreate: z.boolean(),
  })
  .meta({ id: 'TagConfiguration' });
export type TagConfiguration = z.output<typeof tagConfiguration>;
export const getTagConfiguration = defineEndpoint({
  operationId: 'getTagConfiguration',
  method: 'get',
  path: '/tag-configuration',
  summary: 'Read tags, groups and creation rules',
  group: 'Tags',
  response: {
    status: 200,
    description: 'The business tag configuration and capabilities.',
    schema: tagConfiguration,
  },
});
export const updateTagRules = defineEndpoint({
  operationId: 'updateTagRules',
  method: 'put',
  path: '/tag-rules',
  summary: 'Change the tag creation and suggestion rules',
  group: 'Tags',
  body: updateTagRulesInput,
  response: { status: 200, description: 'The saved tag rules.', schema: tagRules },
});
export const updateTagInput = createTagInput
  .extend({
    groupId: publicId('tag_group').nullable(),
    revision: tagGroup.shape.revision,
  })
  .meta({ id: 'UpdateTagInput' });
export const updateTag = defineEndpoint({
  operationId: 'updateTag',
  method: 'put',
  path: '/tags/{id}',
  summary: 'Edit a tag definition',
  group: 'Tags',
  params: z.strictObject({ id: publicId('tag') }),
  body: updateTagInput,
  response: { status: 200, description: 'The saved tag definition.', schema: tagDefinition },
});

export const assignRecordTagInput = z.strictObject({}).meta({ id: 'AssignRecordTagInput' });
export const recordTag = z
  .strictObject({
    tag,
    source: z.strictObject({
      kind: z.enum(actorKinds),
      eventId: publicId('event').nullable(),
      you: z.boolean(),
    }),
    createdAt: timestamp,
  })
  .meta({ id: 'RecordTag' });
export type RecordTag = z.output<typeof recordTag>;
export const recordTagList = z
  .strictObject({ items: z.array(recordTag), canManage: z.boolean() })
  .meta({ id: 'RecordTagList' });
export const getRecordTags = defineEndpoint({
  operationId: 'getRecordTags',
  method: 'get',
  path: '/records/{id}/tags',
  summary: 'Read a record’s tags and their sources',
  group: 'Tags',
  params: z.strictObject({ id: recordId }),
  response: { status: 200, description: 'Tags assigned to this record.', schema: recordTagList },
});
export const assignRecordTag = defineEndpoint({
  operationId: 'assignRecordTag',
  method: 'put',
  path: '/records/{id}/tags/{tagId}',
  summary: 'Assign an existing tag',
  group: 'Tags',
  params: z.strictObject({ id: recordId, tagId: publicId('tag') }),
  body: assignRecordTagInput,
  response: {
    status: 200,
    description: 'The assignment, including its original source.',
    schema: recordTag,
  },
});
export const removeRecordTag = defineEndpoint({
  operationId: 'removeRecordTag',
  method: 'delete',
  path: '/records/{id}/tags/{tagId}',
  summary: 'Remove a tag from a record',
  group: 'Tags',
  params: assignRecordTag.params,
  response: { status: 204, description: 'The record no longer has this tag.' },
});
