// What one Send email step has done (the action's Statistics tab), from what is already
// recorded: the step's runs (automation.step_runs) and the message each queued
// (messaging.messages and its dispatch row). Nothing measures opens, clicks or arrival in
// an inbox yet, so those are null and never a zero.
import type { WorkflowEmailSkipReason, WorkflowEmailStepStatistics } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId } from '@repo/kernel';
import { sql } from 'kysely';

// Why the outbound policy, or the step itself, sent nothing to a contact it was never
// going to send to. Anything else that stopped a send is a failure: something to fix.
const SKIPS: Readonly<Record<string, WorkflowEmailSkipReason>> = {
  consent_required: 'no_consent',
  consent_withdrawn: 'unsubscribed',
  do_not_contact: 'do_not_contact',
  no_email_address: 'no_email_address',
  recipient_changed: 'no_email_address',
  contact_inactive: 'contact_removed',
  timing_unknown: 'no_time_zone',
  sender_inactive: 'mailbox_unavailable',
  mailbox_unavailable: 'mailbox_unavailable',
  mailbox_use_disabled: 'mailbox_unavailable',
  mailbox_required: 'mailbox_unavailable',
  unsubscribe_unavailable: 'unsubscribe_unavailable',
};

const SUPPRESSIONS: Readonly<Record<string, WorkflowEmailSkipReason>> = {
  unsubscribe: 'unsubscribed',
  complaint: 'complained',
  hard_bounce: 'bounced_before',
  invalid: 'bounced_before',
};

/** Why a refusal is a skip, or undefined when it is a failure. */
export function emailSkipReason(
  code: string | null,
  detail: string | null,
): WorkflowEmailSkipReason | undefined {
  if (code === null) return undefined;
  if (code === 'suppressed') return SUPPRESSIONS[detail ?? ''] ?? 'suppressed';
  return SKIPS[code];
}

export interface EmailStepGroup {
  readonly runStatus: string;
  readonly runError: string | null;
  readonly messageStatus: string | null;
  readonly messageError: string | null;
  readonly messageDetail: string | null;
  readonly unsubscribed: boolean;
  readonly count: number;
}

type Counts = Pick<
  WorkflowEmailStepStatistics,
  | 'total'
  | 'waiting'
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'failed'
  | 'skipped'
  | 'unsubscribed'
  | 'opened'
  | 'clicked'
>;

/** The counts, from the step's visits grouped by how each ended. */
export function countEmailStep(groups: readonly EmailStepGroup[]): Counts {
  let total = 0;
  let waiting = 0;
  let sent = 0;
  let bounced = 0;
  let failed = 0;
  let unsubscribed = 0;
  const skipped = new Map<WorkflowEmailSkipReason, number>();
  const skip = (reason: WorkflowEmailSkipReason, count: number) =>
    skipped.set(reason, (skipped.get(reason) ?? 0) + count);
  for (const group of groups) {
    total += group.count;
    if (group.runStatus === 'failed' || group.messageStatus === null) {
      // The step stopped before or as it queued: no consent, no address, no template.
      const reason = emailSkipReason(group.runError, null);
      if (reason === undefined) failed += group.count;
      else skip(reason, group.count);
      continue;
    }
    if (group.unsubscribed) unsubscribed += group.count;
    if (['sent', 'delivered', 'read', 'bounced'].includes(group.messageStatus)) {
      sent += group.count;
      if (group.messageStatus === 'bounced') bounced += group.count;
    } else if (group.messageStatus === 'queued' || group.messageStatus === 'sending')
      waiting += group.count;
    else {
      // Refused as it was about to leave, or its delivery is not known.
      const reason =
        group.messageStatus === 'failed'
          ? emailSkipReason(group.messageError, group.messageDetail)
          : undefined;
      if (reason === undefined) failed += group.count;
      else skip(reason, group.count);
    }
  }
  const reasons = [...skipped]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return {
    total,
    waiting,
    sent,
    delivered: null,
    bounced,
    failed,
    skipped: { total: reasons.reduce((sum, each) => sum + each.count, 0), reasons },
    unsubscribed,
    opened: null,
    clicked: null,
  };
}

/**
 * One step's counts, across every version of the automation, for visits that began in the
 * range. A visit that was tried again counts once, as its last try; a step in a loop
 * counts each email it queued.
 */
export async function readEmailStepStatistics(
  trx: DatabaseTransaction,
  automation: string,
  step: string,
  range: { readonly from?: string | undefined; readonly to?: string | undefined },
): Promise<WorkflowEmailStepStatistics> {
  const automationId = parsePublicId('automation', automation);
  const found =
    automationId === undefined
      ? undefined
      : await trx
          .selectFrom('automation.automations')
          .select('id')
          .where('id', '=', automationId)
          .executeTakeFirst();
  if (found === undefined) throw new NotFoundError('automation', automation);
  const from = range.from === undefined ? null : new Date(range.from);
  const to = range.to === undefined ? null : new Date(range.to);
  const { rows } = await sql<{
    run_status: string;
    run_error: string | null;
    message_status: string | null;
    message_error: string | null;
    message_detail: string | null;
    unsubscribed: boolean;
    n: string;
  }>`
    with tries as (
      select r.id, r.business_id, r.enrolment_id, r.status, r.started_at,
        r.error ->> 'code' as run_error,
        first_value(r.status) over (
          partition by r.enrolment_id order by r.started_at desc, r.id desc) as last_status,
        case when r.output ->> 'messageId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (r.output ->> 'messageId')::uuid end as message_id
      from automation.step_runs r
      where r.automation_id = ${found.id}::uuid and r.step_key = ${step}
        and r.status in ('succeeded', 'failed') and r.input ->> 'type' = 'email.send'
        and (${from}::timestamptz is null or r.started_at >= ${from}::timestamptz)
        and (${to}::timestamptz is null or r.started_at < ${to}::timestamptz)
    ), visits as (
      -- One row for each email queued, and one for each run's last try that queued none.
      select distinct on (coalesce(t.message_id::text, t.enrolment_id::text || ':none'))
        t.status, t.run_error, t.message_id, t.business_id
      from tries t
      -- A try that failed and was followed by one that went on is not a visit of its own.
      where t.message_id is not null or t.last_status = 'failed'
      order by coalesce(t.message_id::text, t.enrolment_id::text || ':none'), t.started_at desc, t.id desc
    )
    select v.status as run_status, v.run_error,
      m.status as message_status, m.error_code as message_error, m.error_detail as message_detail,
      coalesce(d.unsubscribe_used_at is not null, false) as unsubscribed,
      count(*)::text as n
    from visits v
    left join messaging.messages m on m.business_id = v.business_id and m.id = v.message_id
    left join messaging.outbound_dispatch d on d.business_id = m.business_id and d.id = m.id
    group by 1, 2, 3, 4, 5, 6
  `.execute(trx);
  return {
    step,
    from: from?.toISOString() ?? null,
    to: to?.toISOString() ?? null,
    ...countEmailStep(
      rows.map((row) => ({
        runStatus: row.run_status,
        runError: row.run_error,
        messageStatus: row.message_status,
        messageError: row.message_error,
        messageDetail: row.message_detail,
        unsubscribed: row.unsubscribed,
        count: Number(row.n),
      })),
    ),
  };
}
