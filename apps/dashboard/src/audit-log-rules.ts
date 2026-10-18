// What Settings → Audit Logs works out before it draws: what the filters ask `listAudit`
// for, and which records an entry can link to.
import type { AuditAction, AuditListEntry, AuditModule, AuditOutcome } from '@repo/contracts';

export interface AuditFilters {
  /** Whose changes: nobody in particular (''), `me`, or a membership id. */
  readonly member: string;
  readonly module: AuditModule | '';
  readonly action: AuditAction | '';
  /** The id of one record, as the API gives it. */
  readonly subject: string;
  /** The first and last day, each as YYYY-MM-DD, or '' for none. */
  readonly from: string;
  readonly to: string;
  /** `ok`: what changed something. The others: what was refused or failed. */
  readonly outcome: AuditOutcome;
}

export const noAuditFilters: AuditFilters = {
  member: '',
  module: '',
  action: '',
  subject: '',
  from: '',
  to: '',
  outcome: 'ok',
};

/** The start of a day chosen in a date field, where the reader is; `addDays` later. */
function startOfDay(value: string, addDays = 0): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + addDays);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Whether the range of days ends before it starts, which the server refuses. */
export function auditRangeBackwards(filters: AuditFilters): boolean {
  const from = startOfDay(filters.from);
  const to = startOfDay(filters.to);
  return from !== undefined && to !== undefined && to.getTime() < from.getTime();
}

export interface AuditQuery {
  readonly after?: string;
  readonly member?: string;
  readonly module?: AuditModule;
  readonly action?: AuditAction;
  readonly subject?: string;
  readonly from?: string;
  readonly before?: string;
  readonly outcome?: AuditOutcome;
}

/**
 * The log takes entries at or after `from` and before `before`, so the last day chosen is
 * included by asking for the day after it. `ok` is what a request without an outcome gets.
 */
export function auditQueryOf(filters: AuditFilters, after: string | undefined): AuditQuery {
  const from = startOfDay(filters.from);
  const before = startOfDay(filters.to, 1);
  const subject = filters.subject.trim().slice(0, 100);
  return {
    ...(filters.member === '' ? {} : { member: filters.member }),
    ...(filters.module === '' ? {} : { module: filters.module }),
    ...(filters.action === '' ? {} : { action: filters.action }),
    ...(subject === '' ? {} : { subject }),
    ...(from === undefined ? {} : { from: from.toISOString() }),
    ...(before === undefined ? {} : { before: before.toISOString() }),
    ...(filters.outcome === 'ok' ? {} : { outcome: filters.outcome }),
    ...(after === undefined ? {} : { after }),
  };
}

/** The four kinds of record the log looks up, and so knows to be there or gone. */
export type LinkedKind = 'contact' | 'company' | 'deal' | 'task';

/** Where an entry's record can be opened: only one of the four kinds, and only while it exists. */
export function recordPlace(
  record: AuditListEntry['record'],
): { readonly kind: LinkedKind; readonly id: string; readonly name: string | null } | undefined {
  if (record?.exists !== true || record.id === null) return undefined;
  const { kind, id, name } = record;
  return kind === 'contact' || kind === 'company' || kind === 'deal' || kind === 'task'
    ? { kind, id, name }
    : undefined;
}
