import { requireBusiness, type ApiRoute, type Route } from '@repo/commands';
import {
  getContactJourney,
  listRecordActivity,
  listRecordAutomationRuns,
  listAutomationStepRuns,
  parseInput,
  type ContactJourney,
} from '@repo/contracts';
import { ForbiddenError } from '@repo/kernel';

/** Compose existing authorised readers; this module never queries another module's tables. */
export function createContactJourneyRoute(routes: readonly ApiRoute[]): ApiRoute {
  return {
    endpoint: getContactJourney,
    async run({ invocation, params, query }, services): Promise<ContactJourney> {
      requireBusiness(invocation.context);
      const { id } = parseInput(getContactJourney.params, params);
      const input = parseInput(getContactJourney.query, query);
      const read = (
        operationId: string,
        parameters: Record<string, string>,
        filters: Record<string, string> = {},
      ) => {
        const route = routes.find((each) => each.endpoint.operationId === operationId);
        if (route === undefined) throw new Error(`Journey reader ${operationId} is not installed.`);
        return route.run(
          { invocation, params: parameters, query: filters, body: undefined },
          services,
        );
      };
      // Confirm contact visibility before asking for any linked evidence.
      await read('getContact', { id });
      const activity = listRecordActivity.response.schema.parse(
        await read(
          'listRecordActivity',
          { id },
          input.activityAfter === undefined ? {} : { after: input.activityAfter },
        ),
      );
      const notes = [
        'This is retained evidence visible to your role. Missing evidence does not establish why an action did not happen. Use the supplied cursors and workflow explanation tools for more evidence.',
      ];
      const items: ContactJourney['items'] = activity.items.map((data) => ({
        kind: 'activity',
        at: data.occurredAt,
        id: data.id,
        data,
      }));
      const coverage: ContactJourney['coverage'] = {
        activityAfter: activity.next,
        runsAfter: null,
        steps: [],
        omittedAutomations: 0,
        notes,
      };
      try {
        const runs = listRecordAutomationRuns.response.schema.parse(
          await read(
            'listRecordAutomationRuns',
            { id },
            input.runsAfter === undefined ? {} : { after: input.runsAfter },
          ),
        );
        coverage.runsAfter = runs.nextCursor;
        for (const data of runs.items)
          items.push({ kind: 'workflow_run', at: data.startedAt, id: data.id, data });
        const automationIds = [...new Set(runs.items.map((run) => run.automationId))];
        coverage.omittedAutomations = Math.max(0, automationIds.length - 5);
        for (const automationId of automationIds.slice(0, 5)) {
          const filters = {
            record: id,
            ...(input.from === undefined ? {} : { from: input.from }),
            ...(input.to === undefined ? {} : { to: input.to }),
          };
          const steps = listAutomationStepRuns.response.schema.parse(
            await read('listAutomationStepRuns', { id: automationId }, filters),
          );
          coverage.steps.push({ automationId, after: steps.nextCursor });
          for (const data of steps.items)
            items.push({
              kind: 'workflow_step',
              at: data.startedAt,
              id: data.id,
              automationId,
              data,
            });
        }
      } catch (error) {
        if (!(error instanceof ForbiddenError)) throw error;
        notes.push(
          'Some workflow evidence is unavailable for your role. This does not mean no workflow ran.',
        );
      }
      return {
        contactId: id,
        items: items
          .filter(
            (item) =>
              (input.from === undefined || Date.parse(item.at) >= Date.parse(input.from)) &&
              (input.to === undefined || Date.parse(item.at) < Date.parse(input.to)),
          )
          .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id)),
        coverage,
      };
    },
  } satisfies Route<typeof getContactJourney>;
}
