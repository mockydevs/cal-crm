import { createHash } from 'node:crypto';
import { defineProposable, type Proposable } from '@repo/commands';
import { validateAutomation } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, ValidationError } from '@repo/kernel';
import { readAutomation, type ReadSetup } from './drafts.js';
import { createLifecycleCommands } from './lifecycle.js';

async function testedDraft(
  trx: DatabaseTransaction,
  input: { id: string; baseDraftVersion: number },
) {
  const automation = await readAutomation(trx, input.id);
  if (automation.draftVersion !== input.baseDraftVersion)
    throw new ConflictError('The workflow draft changed. Read and test it again.');
  const passed = await trx
    .selectFrom('automation.test_runs')
    .select('id')
    .where('automation_id', '=', parsePublicId('automation', input.id) ?? '')
    .where('draft_revision', '=', automation.draftVersion)
    .where('status', '=', 'passed')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (passed === undefined)
    throw new ValidationError([
      {
        path: '/baseDraftVersion',
        code: 'test_required',
        message: 'Run a passing test of this draft before proposing publication.',
      },
    ]);
  return { automation, testId: passed.id };
}

export function createAutomationProposables(options: { setup: ReadSetup }): readonly Proposable[] {
  return [
    defineProposable({
      kind: 'automation_publish',
      command: createLifecycleCommands(options).publish,
      action: 'publish',
      agents: ['copilot'],
      subject: async (trx, input) => {
        const id = parsePublicId('automation', input.id);
        if (id === undefined) throw new NotFoundError('automation', input.id);
        await readAutomation(trx, input.id);
        return { automationId: id };
      },
      revision: async (trx, input) =>
        createHash('sha256')
          .update(JSON.stringify(await testedDraft(trx, input)))
          .digest('hex'),
      async present(trx, input, invocation) {
        const { automation } = await testedDraft(trx, input);
        const validation = validateAutomation(
          automation.draft,
          await options.setup(trx, invocation.context),
          { automationId: automation.id },
        );
        if (!validation.valid) {
          const [first, ...rest] = validation.errors;
          throw new ValidationError([
            first ?? {
              path: '/draft',
              code: 'invalid_draft',
              message: 'Fix the workflow draft before publishing it.',
            },
            ...rest,
          ]);
        }
        return {
          kind: 'crm_change',
          operationId: 'publishAutomation',
          name: automation.name,
          details: {
            automationId: automation.id,
            draftVersion: automation.draftVersion,
            changeSummary: input.changeSummary,
            workflow: automation.draft,
          },
        };
      },
      capture: () => Promise.resolve(undefined),
      result: (output) => ({ automationId: output.id }),
      undo: () => ({ impossible: 'live_configuration' }),
    }),
  ];
}
