import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  createCustomRecord,
  createCustomRecordInput,
  getCustomRecord,
  listCustomRecords,
  parseInput,
  restoreCustomRecord,
  trashCustomRecord,
  updateCustomRecord,
  updateCustomRecordInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import { readCustomRecordList } from './list.js';
import {
  customRecordCommands,
  liveObject,
  readCustomRecord,
  type RecordPeople,
} from './records.js';

/** A custom object's records. `people` names their owners, as a deal list's are named. */
export function createCustomRecordRoutes(people: RecordPeople): readonly ApiRoute[] {
  const commands = customRecordCommands(people);
  return [
    {
      endpoint: listCustomRecords,
      run: ({ invocation, params, query }, { db }) => {
        const { key } = parseInput(listCustomRecords.params, params);
        const parsed = parseInput(listCustomRecords.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readCustomRecordList(trx, invocation, people, key, parsed),
        );
      },
    } satisfies Route<typeof listCustomRecords>,
    {
      endpoint: createCustomRecord,
      command: commands.create,
      async run({ invocation, params, body }, services) {
        const { key } = parseInput(createCustomRecord.params, params);
        // Visibility precedes body validation, so another business's object reveals nothing.
        await withTenant(services.db, invocation.context, (trx) => liveObject(trx, key));
        return runCommand(
          services,
          commands.create,
          { ...parseInput(createCustomRecordInput, body), key },
          invocation,
        );
      },
    } satisfies Route<typeof createCustomRecord>,
    {
      endpoint: getCustomRecord,
      run: ({ invocation, params }, { db }) => {
        const { key, id } = parseInput(getCustomRecord.params, params);
        return withTenant(db, invocation.context, (trx) =>
          readCustomRecord(trx, invocation, people, key, id),
        );
      },
    } satisfies Route<typeof getCustomRecord>,
    {
      endpoint: updateCustomRecord,
      command: commands.update,
      async run({ invocation, params, body }, services) {
        const parsed = parseInput(updateCustomRecord.params, params);
        await withTenant(services.db, invocation.context, (trx) =>
          readCustomRecord(trx, invocation, people, parsed.key, parsed.id),
        );
        return runCommand(
          services,
          commands.update,
          { ...parseInput(updateCustomRecordInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof updateCustomRecord>,
    {
      endpoint: trashCustomRecord,
      command: commands.trash,
      run: ({ invocation, params }, services) =>
        runCommand(
          services,
          commands.trash,
          parseInput(trashCustomRecord.params, params),
          invocation,
        ),
    } satisfies Route<typeof trashCustomRecord>,
    {
      endpoint: restoreCustomRecord,
      command: commands.restore,
      run: ({ invocation, params }, services) =>
        runCommand(
          services,
          commands.restore,
          parseInput(restoreCustomRecord.params, params),
          invocation,
        ),
    } satisfies Route<typeof restoreCustomRecord>,
  ];
}
