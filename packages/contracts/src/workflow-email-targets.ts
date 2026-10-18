import * as z from 'zod';
import { automationKey } from './automations-values.js';
import { publicId } from './ids.js';

/** Content operations name their scope; a draft edit never implicitly changes pinned versions. */
export const workflowEmailTarget = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('draft'),
    automation: publicId('automation'),
    step: automationKey,
    baseDraftVersion: z.int().min(1),
  }),
  z.strictObject({
    scope: z.literal('published'),
    automation: publicId('automation'),
    step: automationKey,
    version: publicId('automation_version'),
    contentRevision: z.int().min(1),
  }),
]);

export type WorkflowEmailTarget = z.output<typeof workflowEmailTarget>;
