// Publishing a form as something an assistant proposes and a person confirms. The in-app
// assistant builds a draft freely; making it live is a proposal that holds this module's
// own publish command, which runs through the command layer as whoever applies it, with
// their permission and every check the command has.
//
//   * a draft that cannot be published is not proposed: its problems are the answer;
//   * a proposal is made on the form as it stood. Any save since makes it stale, and Apply
//     refuses rather than publish something the person did not see;
//   * applying it answers with the form's own page and the one line a website needs;
//   * undoing it takes the form back to a draft, when it was a draft before. A form that
//     was already live has no draft to go back to, and says so.
import { defineProposable, type Proposable } from '@repo/commands';
import { toPublicId, ValidationError } from '@repo/kernel';

import { readFormRevision, readFormState, type FormCommands } from './forms.js';

/** The commands an assistant may propose about a form, given the module's own commands. */
export function createFormProposables(commands: FormCommands): readonly Proposable[] {
  return [
    defineProposable({
      kind: 'form_publish',
      command: commands.publish,
      agents: ['copilot'],
      subject: async (trx, { id }) => ({ formId: (await readFormRevision(trx, id)).id }),
      revision: async (trx, { id }) => (await readFormRevision(trx, id)).revision,
      async present(trx, { id }, invocation) {
        const form = await readFormState(trx, invocation, id);
        const [first, ...rest] = form.problems;
        // What stops the form being published, said now, to whoever asked to publish it.
        if (first !== undefined) throw new ValidationError([first, ...rest]);
        return {
          kind: 'form_publish',
          formId: toPublicId('form', form.id),
          name: form.name,
          // A block of text asks nothing.
          questions: (form.draft?.fields ?? []).filter((field) => field.type !== 'content').length,
          consents: form.draft?.consents.length ?? 0,
          republish: form.status === 'published',
        };
      },
      capture: async (trx, { id }) => (await readFormRevision(trx, id)).status,
      result: (form) => ({
        formId: form.id,
        hostedUrl: form.hostedUrl,
        embedSnippet: form.embedSnippet,
        publicKey: form.publicKey,
      }),
      undo: (before, form) =>
        before === 'published'
          ? { impossible: 'published_before' }
          : { kind: 'form_unpublish', input: { id: form.id, revision: form.revision } },
    }),
    // Never proposed: only the way back from a publish that was applied.
    defineProposable({
      kind: 'form_unpublish',
      command: commands.unpublish,
      // The command names no delegation, so no assistant runs it by itself. An assistant
      // that undid its own publish would be held to the rule for publishing.
      action: 'publish',
      agents: [],
      subject: async (trx, { id }) => ({ formId: (await readFormRevision(trx, id)).id }),
      revision: async (trx, { id }) => (await readFormRevision(trx, id)).revision,
      async present(trx, { id }) {
        const form = await readFormRevision(trx, id);
        return { kind: 'form_unpublish', formId: toPublicId('form', form.id), name: form.name };
      },
      capture: () => Promise.resolve(undefined),
      result: (form) => ({ formId: form.id }),
      undo: () => ({ impossible: 'unpublished' }),
    }),
  ];
}
