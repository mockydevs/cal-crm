// Declared trigger outputs come from the immutable event that enrolled this record, and so
// does how the lead arrived (trigger.attribution.*): the touch that event's form submission
// or booking recorded, which is never rewritten. A run reads the same arrival for as long as
// it lives, wherever the contact's latest attribution moves meanwhile. A run a form
// submission started also reads that submission (trigger.answers.*, trigger.pageUrl), which
// is never changed either.
import { withDealClosePlace } from './deal-close-place.js';
import {
  automationDocument,
  isAttributionPath,
  isSubmissionPath,
  type ConditionValues,
  type AutomationTriggerType,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { isUuidV7, toPublicId, type PublicIdKind } from '@repo/kernel';

import { arrivalOf, hasArrival, readEventTouch, touchValues } from './attribution-values.js';
import { NO_SUBMISSION, readSubmissionValues } from './submission-values.js';
import { ARRIVAL, eventPassesTrigger } from './triggers.js';

const subjectOutputs: Partial<
  Record<
    AutomationTriggerType,
    {
      readonly kind: PublicIdKind;
      readonly key: string;
    }
  >
> = {
  'form.submitted': { kind: 'form_submission', key: 'submissionId' },
  'message.received': { kind: 'message', key: 'messageId' },
  'appointment.booked': { kind: 'appointment', key: 'appointmentId' },
  'appointment.status_changed': { kind: 'appointment', key: 'appointmentId' },
  'deal.stage_changed': { kind: 'deal', key: 'dealId' },
  'deal.closed': { kind: 'deal', key: 'dealId' },
  'trigger_link.clicked': { kind: 'trigger_link', key: 'linkId' },
  'quote.sent': { kind: 'sales_document', key: 'documentId' },
  'quote.accepted': { kind: 'sales_document', key: 'documentId' },
  'quote.declined': { kind: 'sales_document', key: 'documentId' },
  'invoice.issued': { kind: 'sales_document', key: 'documentId' },
  'invoice.sent': { kind: 'sales_document', key: 'documentId' },
  'invoice.paid': { kind: 'sales_document', key: 'documentId' },
  'payment.recorded': { kind: 'payment', key: 'paymentId' },
};

/** What the run's trigger declares as its outputs, and nothing else: trigger.<key>. */
export async function triggerValues(
  trx: DatabaseTransaction,
  recordId: string,
  enrolmentId: string,
): Promise<ConditionValues> {
  const values = await runTriggerValues(trx, recordId, enrolmentId);
  return Object.fromEntries(
    Object.entries(values).filter(([path]) => !isAttributionPath(path) && !isSubmissionPath(path)),
  );
}

/**
 * Everything a run reads under trigger.*: its trigger's declared outputs, and how its lead
 * arrived (trigger.attribution.*), every leaf of which is there, empty when nothing is
 * known; and, for a run a form submission started, what was sent (trigger.answers.<key>,
 * trigger.pageUrl).
 */
export async function runTriggerValues(
  trx: DatabaseTransaction,
  recordId: string,
  enrolmentId: string,
): Promise<ConditionValues> {
  const row = await trx
    .selectFrom('automation.enrolments as run')
    .innerJoin('automation.versions as version', 'version.id', 'run.version_id')
    .innerJoin('events.events as event', 'event.id', 'run.trigger_event_id')
    .innerJoin('crm.timeline_entries as timeline', (join) =>
      join
        .onRef('timeline.event_id', '=', 'event.id')
        .onRef('timeline.record_id', '=', 'run.record_id'),
    )
    .select([
      'run.trigger_key',
      'version.document',
      'event.type',
      'event.payload',
      'event.subject_kind',
      'event.subject_id',
    ])
    .where('run.id', '=', enrolmentId)
    .where('run.record_id', '=', recordId)
    .executeTakeFirst();
  // Every trigger.attribution.* path is there, and empty, for a run nothing arrived with:
  // one another automation started, or one whose event recorded no touch.
  const nothing = { ...touchValues('trigger', undefined), ...NO_SUBMISSION };
  if (row === undefined) return nothing;
  const document = automationDocument.parse(row.document);
  const trigger = document.triggers.find((candidate) => candidate.id === row.trigger_key);
  if (trigger === undefined) return nothing;
  const stored = await withDealClosePlace(
    trx,
    row,
    typeof row.payload === 'object' && row.payload !== null && !Array.isArray(row.payload)
      ? row.payload
      : {},
  );
  // The touch of the run's own event: read by the event's subject, so it is the same
  // however many touches the contact has had since.
  const touch = hasArrival(row.type) ? await readEventTouch(trx, row, [recordId]) : undefined;
  // And the submission itself, read by the same subject.
  const arrived = { ...touchValues('trigger', touch), ...(await readSubmissionValues(trx, row)) };
  // The trigger's filters by arrival are judged with the touch, as they were at the match.
  const payload = hasArrival(row.type) ? { ...stored, [ARRIVAL]: arrivalOf(touch) } : stored;
  if (!eventPassesTrigger(trigger, row.type, payload)) return arrived;
  // A run that ended: which run, why, and for a failed one the step it failed at, so the
  // automation its ending starts can say what happened.
  if (trigger.type === 'automation.run_ended') {
    const { reason, step } = payload;
    return {
      ...nothing,
      ...(row.subject_kind === 'automation_run' && isUuidV7(row.subject_id)
        ? { 'trigger.runId': toPublicId('automation_enrolment', row.subject_id) }
        : {}),
      ...(typeof reason === 'string' ? { 'trigger.reason': reason } : {}),
      ...(typeof step === 'string' ? { 'trigger.step': step } : {}),
    };
  }
  const output = subjectOutputs[trigger.type];
  if (output?.kind !== row.subject_kind || !isUuidV7(row.subject_id)) return arrived;
  return { ...arrived, [`trigger.${output.key}`]: toPublicId(output.kind, row.subject_id) };
}
