// The worker task that starts automations from one stored event. The events.events
// trigger (migration pending) queues it only when the business has a subscription for the
// event's type, so businesses without automations pay nothing.
import {
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  type TaskReference,
} from '@repo/commands';
import { ForbiddenError } from '@repo/kernel';
import * as z from 'zod';

import { matchEvent } from './enrolment.js';
import { contactValues } from './values.js';

export const matchEventReference = {
  name: 'automations.match_event',
  data: z.strictObject({ eventId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

/**
 * Matching one event as a command, so what it ends is told of through the command layer:
 * a run a stop condition ends emits automation.run.stopped, caused by the event that
 * stopped it, in the transaction that ends it. Only the engine runs it.
 */
export const matchEventCommand = defineCommand({
  name: 'automation.match_event',
  permission: 'automations.manage',
  input: matchEventReference.data,
  async handle(trx, input, command) {
    if (command.context.actorKind !== 'system')
      throw new ForbiddenError('Only the automation engine matches events.');
    requireBusiness(command.context);
    const matched = await matchEvent(
      trx,
      command.context,
      input.eventId,
      contactValues,
      undefined,
      (event) => command.emit(event),
    );
    return {
      enrolled: matched.enrolled.length,
      exited: matched.exited.length,
      woken: matched.woken?.length ?? 0,
      moved: matched.moved?.length ?? 0,
    };
  },
});

export const matchEventTask = defineTask({
  ...matchEventReference,
  async run(data, { invocation, services }) {
    await runCommand(services, matchEventCommand, data, invocation);
  },
});
