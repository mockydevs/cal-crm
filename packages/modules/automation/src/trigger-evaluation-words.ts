// The words a kept reason, and a run's ending, are told in: made from what was recorded and
// nothing else. No database here, so each sentence can be read and tested on its own.
import type { AutomationRunList, AutomationTriggerEvaluationReason } from '@repo/contracts';
import * as z from 'zod';

const shown = (value: unknown): string =>
  value === null || value === undefined
    ? 'nothing'
    : Array.isArray(value)
      ? value.length === 0
        ? 'nothing'
        : value.map((each) => shown(each)).join(', ')
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);

/** A reason in words, made from the reason and what was compared, and nothing else. */
export function explainEvaluation(
  reason: AutomationTriggerEvaluationReason,
  detail: Readonly<Record<string, unknown>>,
): string {
  switch (reason) {
    case 'filter_mismatch':
      // The two filters by how the lead arrived, in the words the builder uses for them.
      if (detail['filter'] === 'sources')
        return detail['actual'] === null || detail['actual'] === undefined
          ? `The trigger starts only for a lead source of ${shown(detail['expected'])}, and nothing was recorded of how this lead arrived.`
          : `The trigger starts only for a lead source of ${shown(detail['expected'])}, and this lead's source was ${shown(detail['actual'])}.`;
      if (detail['filter'] === 'sessionSources')
        return `The trigger starts only for a session source of ${shown(detail['expected'])}, and this lead's was ${shown(detail['actual'])}.`;
      return detail['filter'] === 'event'
        ? `The trigger listens for ${shown(detail['expected'])}, and the event was ${shown(detail['actual'])}.`
        : `The trigger's ${shown(detail['filter'])} filter wanted ${shown(detail['expected'])}, and the event had ${shown(detail['actual'])}.`;
    case 'condition_false': {
      const values = z.record(z.string(), z.unknown()).safeParse(detail['values']);
      const compared = values.success
        ? Object.entries(values.data).map(([path, value]) => `${path} was ${shown(value)}`)
        : [];
      return compared.length === 0
        ? "The trigger's condition did not hold for the record."
        : `The trigger's condition did not hold for the record: ${compared.join('; ')}.`;
    }
    case 'already_enrolled':
      return detail['queued'] === true
        ? 'The record was already in this workflow, so it goes through again once that run ends, reading the record as it is then.'
        : 'The record was already in this workflow, and is in it once at a time.';
    case 'reentry_not_allowed':
      return 'The record has been through this workflow before, and it takes a record once (re-entry is off).';
    case 'paused':
      return 'The workflow was paused, so it started for nobody.';
    case 'contact_missing':
      return 'The event was about no record, so there was nobody to start for.';
    case 'stopped_by_rule':
      if (detail['rule'] === 'contact_trashed')
        return 'The contact is in the trash, and a contact in the trash starts no workflow.';
      return detail['rule'] === 'imported_contact'
        ? 'The contact was made by an import, and an imported contact starts no workflow by having been created.'
        : `A rule stopped it (${shown(detail['rule'])}).`;
    case 'refused_loop':
      if (detail['cause'] === 'own_change')
        return "The change was made by this workflow's own run for the record, or by a run that run led to, so it did not start the workflow again.";
      if (detail['cause'] === 'run_limit')
        return `The workflow had already started ${shown(detail['starts'])} times for the record in the last ${shown(detail['windowMinutes'])} minutes, the most it may, so it was not started: something keeps starting it, such as a loop through another app.`;
      return 'Starting it would have led back to a workflow that led to this event, so it was not started.';
  }
}

type RunSummary = AutomationRunList['items'][number];

/** Why a run that is over ended, in words, from its status and the reason it kept. */
export function endingWords(run: RunSummary, failedAt: string | undefined): string | null {
  const reason = run.exitReason;
  switch (run.status) {
    case 'running':
    case 'waiting':
      return null;
    case 'completed':
      return 'It completed: it reached the end of its path.';
    case 'failed':
      return failedAt === undefined
        ? `It failed (${reason ?? 'no reason kept'}).`
        : `It failed at the step "${failedAt}" (${reason ?? 'no reason kept'}).`;
    case 'cancelled':
      return reason === 'automation_deleted'
        ? 'It was cancelled when the workflow was deleted.'
        : `It was cancelled (${reason ?? 'no reason kept'}).`;
    case 'exited':
      if (reason?.startsWith('stop:') === true)
        return `One of the workflow's stop conditions ended it (${reason.slice(5)}).`;
      if (reason?.startsWith('removed:') === true)
        return 'A step that removes records from workflows ended it.';
      if (reason === 'contact_trashed')
        return 'The contact was moved to the trash, which ended it.';
      return `It was ended early (${reason ?? 'no reason kept'}).`;
  }
}
