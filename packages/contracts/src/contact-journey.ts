import * as z from 'zod';
import { activityEntry } from './activity.js';
import { automationRunSummary } from './automations-api.js';
import { automationStepRunEntry } from './automations-manage.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

export const contactJourneyEntry = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('activity'),
    at: timestamp,
    id: z.string(),
    data: activityEntry,
  }),
  z.looseObject({
    kind: z.literal('workflow_run'),
    at: timestamp,
    id: z.string(),
    data: automationRunSummary,
  }),
  z.looseObject({
    kind: z.literal('workflow_step'),
    at: timestamp,
    id: z.string(),
    automationId: publicId('automation'),
    data: automationStepRunEntry,
  }),
]);
export const contactJourney = z
  .looseObject({
    contactId: publicId('contact'),
    items: z.array(contactJourneyEntry).max(350),
    coverage: z.looseObject({
      activityAfter: publicId('event').nullable(),
      runsAfter: publicId('automation_enrolment').nullable(),
      steps: z
        .array(
          z.looseObject({
            automationId: publicId('automation'),
            after: publicId('automation_step_run').nullable(),
          }),
        )
        .max(5),
      omittedAutomations: z.int().min(0),
      notes: z.array(z.string()),
    }),
  })
  .meta({
    id: 'ContactJourney',
    description:
      'Chronological retained evidence. Missing evidence never establishes why an action did not happen.',
  });
export type ContactJourney = z.output<typeof contactJourney>;

export const getContactJourney = defineEndpoint({
  operationId: 'getContactJourney',
  method: 'get',
  path: '/contacts/{id}/journey',
  group: 'Contacts',
  summary: 'Follow a contact’s recorded customer journey and workflow execution',
  params: z.strictObject({ id: publicId('contact') }),
  query: z
    .strictObject({
      from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(),
      activityAfter: publicId('event').optional(),
      runsAfter: publicId('automation_enrolment').optional(),
    })
    .superRefine((value, context) => {
      if (
        value.from !== undefined &&
        value.to !== undefined &&
        Date.parse(value.from) >= Date.parse(value.to)
      )
        context.addIssue({
          code: 'custom',
          path: ['to'],
          message: 'The end must be after the start.',
        });
    }),
  response: {
    status: 200,
    description: 'Bounded event, workflow run and step evidence, with cursors and coverage limits.',
    schema: contactJourney,
  },
});
