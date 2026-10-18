// Associations: named links between records of two objects, as GoHighLevel's Settings →
// Objects → Associations has them. Each is one of GoHighLevel's association labels: from one
// object to another (or to itself), a label on each side, and how many records each side may
// link. The system ones are the product's (deal↔contact, contact↔company, deal↔company):
// only their labels change.
import { actorKinds } from '@repo/kernel';
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { objectKey } from './objects.js';
import { timestamp } from './timestamps.js';

/** GoHighLevel: "up to 10 labels per object pair". */
export const MAX_ASSOCIATION_LABELS = 10;

/** GoHighLevel: "Each label supports up to 1,000 linked records per side". */
export const MAX_ASSOCIATION_LIMIT = 1000;

const label = z
  .string()
  .trim()
  .min(1, { error: 'Give the association a label.' })
  .max(60, { error: 'Use at most 60 characters.' });
const limit = z
  .int({ error: 'Use a whole number of records.' })
  .min(1, { error: 'Allow at least 1 record.' })
  .max(MAX_ASSOCIATION_LIMIT, {
    error: `Allow at most ${String(MAX_ASSOCIATION_LIMIT)} records.`,
  });

export const association = z
  .looseObject({
    id: publicId('link_type'),
    key: z.string(),
    fromObjectKey: objectKey,
    toObjectKey: objectKey,
    label: z.string().meta({ description: 'What a "to" record is to a "from" record.' }),
    reverseLabel: z.string().meta({ description: 'What a "from" record is to a "to" record.' }),
    description: z.string(),
    system: z.boolean().meta({
      description: "The product's own: only its labels change, and it can't be deleted.",
    }),
    allowsPrimary: z.boolean(),
    fromLimit: z.int().nullable().meta({
      description: 'How many "from" records one "to" record may have. Null for no limit.',
    }),
    toLimit: z.int().nullable().meta({
      description: 'How many "to" records one "from" record may have. Null for no limit.',
    }),
    source: z.enum(actorKinds),
    createdAt: timestamp,
  })
  .meta({ id: 'Association' });
export type Association = z.infer<typeof association>;

export const associationList = z
  .looseObject({ items: z.array(association), canManage: z.boolean() })
  .meta({ id: 'AssociationList' });
export type AssociationList = z.infer<typeof associationList>;

export const listAssociationsQuery = z
  .strictObject({
    objectKey: objectKey.optional().meta({ description: 'Only those touching this object.' }),
  })
  .meta({ id: 'ListAssociationsQuery' });

export const createAssociationInput = z
  .strictObject({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/, {
        error: 'Use a lowercase letter, then lowercase letters, numbers or underscores.',
      })
      .optional()
      .meta({ description: 'Left out, it is made from the objects and the label.' }),
    fromObjectKey: objectKey,
    toObjectKey: objectKey,
    label,
    reverseLabel: label.optional().meta({
      description: 'Left out, the label is used both ways (a single label).',
    }),
    description: z.string().trim().max(2000).default(''),
    fromLimit: limit,
    toLimit: limit,
  })
  .transform((input) => ({ ...input, reverseLabel: input.reverseLabel ?? input.label }))
  .meta({ id: 'CreateAssociationInput' });
export type CreateAssociationInput = z.infer<typeof createAssociationInput>;

export const updateAssociationInput = z
  .strictObject({
    label,
    reverseLabel: label,
    description: z.string().trim().max(2000).optional(),
    fromLimit: limit.optional(),
    toLimit: limit.optional(),
  })
  .meta({
    id: 'UpdateAssociationInput',
    description:
      'Labels, and the limits of an association a business made. Left out, a limit stays. A limit below what a record already has is refused.',
  });

export const associationIdInput = z.strictObject({ id: publicId('link_type') });

export const listAssociations = defineEndpoint({
  operationId: 'listAssociations',
  method: 'get',
  path: '/associations',
  group: 'Objects',
  summary: 'List associations, or those touching one object',
  query: listAssociationsQuery,
  response: { status: 200, description: 'The associations.', schema: associationList },
});
export const createAssociation = defineEndpoint({
  operationId: 'createAssociation',
  method: 'post',
  path: '/associations',
  group: 'Objects',
  summary: 'Create an association between two objects',
  body: createAssociationInput,
  response: { status: 201, description: 'The new association.', schema: association },
});
export const getAssociation = defineEndpoint({
  operationId: 'getAssociation',
  method: 'get',
  path: '/associations/{id}',
  group: 'Objects',
  summary: 'Read an association',
  params: associationIdInput,
  response: { status: 200, description: 'The association.', schema: association },
});
export const updateAssociation = defineEndpoint({
  operationId: 'updateAssociation',
  method: 'patch',
  path: '/associations/{id}',
  group: 'Objects',
  summary: "Change an association's labels and limits",
  params: associationIdInput,
  body: updateAssociationInput,
  response: { status: 200, description: 'The changed association.', schema: association },
});
export const deleteAssociation = defineEndpoint({
  operationId: 'deleteAssociation',
  method: 'delete',
  path: '/associations/{id}',
  group: 'Objects',
  summary: 'Delete an association a business made, with its links between records',
  params: associationIdInput,
  response: { status: 204, description: 'Deleted, with every link it made.' },
});

export const associationEndpoints = [
  listAssociations,
  createAssociation,
  getAssociation,
  updateAssociation,
  deleteAssociation,
] as const;
