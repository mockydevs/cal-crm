import { requireBusiness, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  createNote,
  createNoteInput,
  listRecordNotes,
  updateNote,
  updateNoteInput,
  deleteNote,
  deleteNoteInput,
  parseInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import type { ActorNames } from '../activity/activity.js';
import { requireRecord } from '../records/access.js';
import {
  createNoteCommand,
  updateNoteCommand,
  deleteNoteCommand,
  requireNote,
  readNotes,
} from './notes.js';

export function noteRoutes(actorNames: ActorNames): readonly ApiRoute[] {
  const create = createNoteCommand(actorNames);
  const update = updateNoteCommand(actorNames);
  return [
    {
      endpoint: listRecordNotes,
      run: ({ invocation, params, query }, { db }) => {
        requireBusiness(invocation.context);
        const { id } = parseInput(listRecordNotes.params, params);
        const parsed = parseInput(listRecordNotes.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readNotes(trx, invocation, id, parsed, actorNames),
        );
      },
    } satisfies Route<typeof listRecordNotes>,
    {
      endpoint: createNote,
      command: create,
      async run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(createNote.params, params);
        await withTenant(services.db, invocation.context, (trx) => requireRecord(trx, parsed.id));
        return runCommand(
          services,
          create,
          { ...parseInput(createNoteInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof createNote>,
    {
      endpoint: updateNote,
      command: update,
      async run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(updateNote.params, params);
        await withTenant(services.db, invocation.context, async (trx) => {
          const record = await requireRecord(trx, parsed.id);
          await requireNote(trx, record.id, parsed.noteId);
        });
        return runCommand(
          services,
          update,
          { ...parseInput(updateNoteInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof updateNote>,
    {
      endpoint: deleteNote,
      command: deleteNoteCommand,
      async run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(deleteNote.params, params);
        await withTenant(services.db, invocation.context, async (trx) => {
          const record = await requireRecord(trx, parsed.id);
          await requireNote(trx, record.id, parsed.noteId);
        });
        return runCommand(
          services,
          deleteNoteCommand,
          { ...parseInput(deleteNoteInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof deleteNote>,
  ];
}
