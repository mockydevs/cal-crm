// "Modify contact engagement score": the step adds points to the contact's score or subtracts
// them, through the CRM's own command. The change is keyed by the step's visit, so a visit
// changes the score once however often its job runs.
import type { CommandContext } from '@repo/commands';
import type { ScoreCalculation } from '@repo/contracts';
import { toPublicId } from '@repo/kernel';
import { modifyContactScoreCommand } from '@repo/module-crm';

import { runActionCommand } from './actions-command.js';

/** The record the run is on, and which visit to the step this is. */
interface ScoredRecord {
  readonly id: string;
}
interface Visit {
  readonly enrolmentId: string;
  readonly stepKey: string;
  readonly sequence: number;
}

export interface ScoreStepConfig {
  readonly calculation: ScoreCalculation;
  readonly points: number;
}

/** Changes the contact's score; gives the score after, and what to say about it. */
export async function modifyStepScore(
  command: CommandContext,
  record: ScoredRecord,
  config: ScoreStepConfig,
  visit: Visit,
): Promise<{ readonly output: { readonly score: number | null }; readonly explanation: string }> {
  const changed = await runActionCommand(command, modifyContactScoreCommand, {
    id: toPublicId('contact', record.id),
    calculation: config.calculation,
    points: config.points,
    key: `${visit.enrolmentId}:${visit.stepKey}:${String(visit.sequence)}`,
  });
  const score = String(changed.score ?? 0);
  return {
    output: { score: changed.score },
    explanation: changed.changed
      ? `The contact's engagement score is now ${score}.`
      : `This visit already changed the score; it is ${score}.`,
  };
}
