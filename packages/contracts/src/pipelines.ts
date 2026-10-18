import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

const name = z.string().trim().min(1, { error: 'Give it a name.' }).max(80);
const description = z.string().max(2000);
/** How a pipeline draws its stages' colours: not at all, as a dot, or as a tint. */
export const pipelineColorStyles = ['none', 'dot', 'tint'] as const;
export type PipelineColorStyle = (typeof pipelineColorStyles)[number];

/** A chance of winning, in whole percent. */
export const probability = z.int().min(0).max(100);

// A pipeline's settings. Each is optional in a save: left out, a new entry gets the
// default and an existing one keeps what it has, so a screen that does not know a setting
// cannot erase it.
const showInFunnel = z.boolean().optional().meta({
  description: "Whether the dashboard's funnel chart shows it. A new one is shown.",
});
const showInPie = z.boolean().optional().meta({
  description: "Whether the dashboard's stage distribution chart shows it. A new one is shown.",
});
const stageInput = z.strictObject({
  id: publicId('stage').optional(),
  name,
  description,
  archived: z.boolean(),
  probability: probability
    .nullable()
    .optional()
    .meta({
      description:
        'The chance, in percent, that a deal in this stage is won. Null: none set. Used unless the pipeline says deals carry their own.',
      examples: [40],
    }),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/, { error: 'Give the colour as #rrggbb in lower case.' })
    .nullable()
    .optional()
    .meta({ description: 'Null: no colour.', examples: ['#12b76a'] }),
  showInFunnel,
  showInPie,
});
const pipelineInput = z.strictObject({
  id: publicId('pipeline').optional(),
  name,
  description,
  archived: z.boolean(),
  dealProbability: z.boolean().optional().meta({
    description:
      "Whether each deal of the pipeline carries its own probability (the deal's probability), instead of taking its stage's. A new pipeline takes its stages'.",
  }),
  colorStyle: z.enum(pipelineColorStyles).optional().meta({
    description: "How the stages' colours are drawn. A new pipeline draws none.",
  }),
  showInFunnel,
  showInPie,
  updatedAt: timestamp.optional().meta({
    description:
      'When the pipeline or one of its stages last changed. Answered by the server; ignored in a save, so what was read can be sent back.',
  }),
  stages: z.array(stageInput).max(100),
});
export const savePipelinesInput = z
  .strictObject({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    items: z.array(pipelineInput).max(100),
  })
  .superRefine(({ items }, context) => {
    const ids = new Set<string>();
    for (const [index, pipeline] of items.entries()) {
      for (const [path, id] of [
        [['items', index, 'id'], pipeline.id],
        ...pipeline.stages.map(
          (stage, stageIndex) => [['items', index, 'stages', stageIndex, 'id'], stage.id] as const,
        ),
      ] as const) {
        if (id === undefined) continue;
        if (ids.has(id))
          context.addIssue({ code: 'custom', path: [...path], message: 'Use each ID only once.' });
        ids.add(id);
      }
    }
  })
  .meta({
    id: 'SavePipelinesInput',
    description:
      'The complete ordered configuration, including archived entries. Omit IDs only for new entries. Stale revisions return 409.',
  });
export type SavePipelinesInput = z.infer<typeof savePipelinesInput>;

const stage = stageInput.extend({ id: publicId('stage') }).loose();
export const pipeline = pipelineInput
  .extend({ id: publicId('pipeline'), stages: z.array(stage) })
  .loose()
  .meta({ id: 'Pipeline' });
export type Pipeline = z.infer<typeof pipeline>;
export const pipelineConfiguration = z
  .looseObject({
    items: z.array(pipeline),
    revision: z.string(),
    canManage: z.boolean(),
  })
  .meta({ id: 'PipelineConfiguration' });
export type PipelineConfiguration = z.infer<typeof pipelineConfiguration>;
export const getPipelines = defineEndpoint({
  operationId: 'getPipelines',
  method: 'get',
  path: '/pipelines',
  group: 'Pipelines',
  summary: 'Read the ordered pipelines and stages, including archived entries',
  response: {
    status: 200,
    description: 'The configuration and its revision.',
    schema: pipelineConfiguration,
  },
});
const pipelineParams = z.strictObject({ id: publicId('pipeline') });
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const configurationRevision = revision.meta({
  description: "The configuration's revision as you read it. A stale one returns 409.",
});

export const movePipelineInput = z
  .strictObject({
    position: z.int().min(1).max(100).meta({
      description:
        'The place the pipeline takes in the list, counted from 1. Past the end is the end.',
    }),
    revision: configurationRevision,
  })
  .meta({ id: 'MovePipelineInput' });
export const duplicatePipelineInput = z
  .strictObject({
    name: name.optional().meta({
      description:
        'The name of the copy. Left out, the pipeline\'s name with "(copy)", and a number when that is taken.',
    }),
    revision: configurationRevision,
  })
  .meta({ id: 'DuplicatePipelineInput' });
export const deletePipelineInput = z
  .strictObject({ revision: configurationRevision })
  .meta({ id: 'DeletePipelineInput' });

/** The commands' inputs: what a request's body holds, with the id from its path. */
export const movePipelineCommandInput = movePipelineInput.extend(pipelineParams.shape);
export const duplicatePipelineCommandInput = duplicatePipelineInput.extend(pipelineParams.shape);
export const deletePipelineCommandInput = deletePipelineInput.extend(pipelineParams.shape);

const answered = (status: 200 | 201, description: string) =>
  ({ status, description, schema: pipelineConfiguration }) as const;

export const movePipeline = defineEndpoint({
  operationId: 'movePipeline',
  method: 'post',
  path: '/pipelines/{id}/move',
  group: 'Pipelines',
  summary: 'Move one pipeline to a position in the list',
  params: pipelineParams,
  body: movePipelineInput,
  response: answered(200, 'The configuration in its new order, and its new revision.'),
});
export const duplicatePipeline = defineEndpoint({
  operationId: 'duplicatePipeline',
  method: 'post',
  path: '/pipelines/{id}/duplicate',
  group: 'Pipelines',
  summary: 'Copy a pipeline with its stages and settings, and none of its deals',
  params: pipelineParams,
  body: duplicatePipelineInput,
  response: answered(
    201,
    'The configuration with the copy placed after the pipeline it was made from. Archived stages are not copied.',
  ),
});
export const deletePipeline = defineEndpoint({
  operationId: 'deletePipeline',
  method: 'delete',
  path: '/pipelines/{id}',
  group: 'Pipelines',
  summary: 'Delete a pipeline that holds no deal and never held one',
  params: pipelineParams,
  body: deletePipelineInput,
  response: answered(
    200,
    'The configuration without it. A pipeline that holds a deal, in the trash too, or that a deal ever passed through, returns 409: archive it instead.',
  ),
});

/** The opportunity settings of a business. */
export const opportunitySettingsValues = z.strictObject({
  allowDifferentOwners: z.boolean().meta({
    description:
      'GoHighLevel\'s "Allow different owners for contacts and its opportunities". Kept as chosen; see the endpoint for what it changes.',
  }),
  opportunityOwnerFollowsContact: z.boolean().meta({
    description:
      "When a deal's owner changes, the new owner is made a follower of the deal's primary contact.",
  }),
  contactOwnerFollowsOpportunity: z.boolean().meta({
    description:
      "When a contact's owner changes, the new owner is made a follower of the open deals the contact is the primary contact of.",
  }),
});
export const updateOpportunitySettingsInput = opportunitySettingsValues
  .extend({
    revision: revision.meta({
      description: "The settings' revision as you read it. A stale one returns 409.",
    }),
  })
  .meta({ id: 'UpdateOpportunitySettingsInput' });
export const opportunitySettings = opportunitySettingsValues
  .extend({ revision, canManage: z.boolean() })
  .loose()
  .meta({ id: 'OpportunitySettings' });
export type OpportunitySettings = z.infer<typeof opportunitySettings>;

export const getOpportunitySettings = defineEndpoint({
  operationId: 'getOpportunitySettings',
  method: 'get',
  path: '/opportunity-settings',
  group: 'Pipelines',
  summary: "Read the business's opportunity settings",
  response: { status: 200, description: 'The settings.', schema: opportunitySettings },
});
export const updateOpportunitySettings = defineEndpoint({
  operationId: 'updateOpportunitySettings',
  method: 'put',
  path: '/opportunity-settings',
  group: 'Pipelines',
  summary: "Change the business's opportunity settings",
  body: updateOpportunitySettingsInput,
  response: {
    status: 200,
    description:
      'The settings as saved. They apply to owner changes from then on; nobody is made a follower for changes made before.',
    schema: opportunitySettings,
  },
});

export const pipelineSettingEndpoints = [
  movePipeline,
  duplicatePipeline,
  deletePipeline,
  getOpportunitySettings,
  updateOpportunitySettings,
] as const;

export const savePipelines = defineEndpoint({
  operationId: 'savePipelines',
  method: 'put',
  path: '/pipelines',
  group: 'Pipelines',
  summary: 'Save pipelines and stages without deleting their history',
  body: savePipelinesInput,
  response: {
    status: 200,
    description: 'The saved configuration and its new revision.',
    schema: pipelineConfiguration,
  },
});
