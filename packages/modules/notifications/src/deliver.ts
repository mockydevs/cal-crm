// The one place a notification is written. Everything that tells someone something goes
// through deliver: the job that reads an event, the job at a task's due time, and the
// automation step that notifies the team.
import type { NotificationKind } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { sql } from 'kysely';

import { recipientsOf, shortened, type Cause } from './rules.js';

/**
 * The most unread notifications one person holds in a business. Beyond it nothing more is
 * written for them until they read some: a run of events, or an automation in a loop,
 * cannot bury a person or fill the table. Two jobs at once may each see the last place
 * free, so the number is a ceiling to within the jobs running, not an exact count.
 */
export const UNREAD_CEILING = 500;

/** The longest title and the longest words a notification holds (migration 0056). */
export const TITLE_LENGTH = 300;
export const BODY_LENGTH = 1000;

/** What a notification is about: a kind the dashboard has a page for, and its id. */
export type Subject =
  | {
      readonly kind: 'conversation' | 'task' | 'form' | 'appointment' | 'automation';
      readonly id: string;
    }
  | { readonly kind: 'ai_settings' | 'calendar_connections' };

export interface Notice {
  readonly kind: NotificationKind;
  /** Whom it might be for. deliver leaves out whoever caused it, and who must not get it. */
  readonly recipients: readonly (string | null | undefined)[];
  /** What it is made from, once per person: a job that runs again adds nothing. */
  readonly sourceKey: string;
  /** What it repeats, if anything: one unread notification per person and key. */
  readonly collapseKey?: string | undefined;
  /** The event behind it, when there is one. */
  readonly eventId?: string | undefined;
  readonly cause: Cause;
  readonly subject: Subject;
  /** The contact, company or deal it concerns. One that is gone by now is left out. */
  readonly recordId?: string | null | undefined;
  /** The subject's own name: never a contact's. */
  readonly title?: string | null | undefined;
  /** Only for automation.notice. */
  readonly body?: string | null | undefined;
}

/**
 * Writes the notice for each person it is for, and gives the ids of those it was written
 * for. A person is left out when they caused it, no longer belong where it happened (or
 * can no longer sign in), turned the kind off, already have it from this source, already
 * have one unread under its collapse key, or are at the ceiling of unread notifications.
 *
 * One statement, so the checks and the write see the same rows. Two jobs writing the same
 * notice at once meet at the unique index: the second waits for the first to commit, then
 * adds nothing.
 */
export async function deliver(
  trx: DatabaseTransaction,
  context: TenantContext,
  notice: Notice,
): Promise<string[]> {
  const people = recipientsOf(notice.recipients, notice.cause);
  if (people.length === 0) return [];
  const { agencyId, businessId } = context;
  const business = businessId ?? null;
  const subjectId = 'id' in notice.subject ? notice.subject.id : null;
  // Where the person's unread ones are counted: this business, or the agency as a whole.
  // (Preferences are kept per business, so about the agency there is none to turn off:
  // no row of theirs has a null business.)
  const here =
    businessId === undefined
      ? sql<boolean>`unread.business_id is null`
      : sql<boolean>`unread.business_id = ${businessId}`;
  const told = await sql<{ user_id: string }>`
    insert into notifications.notifications
      (agency_id, business_id, user_id, kind, source_key, collapse_key, event_id, actor_kind,
       actor_id, subject_kind, subject_id, record_id, title, body)
    select ${agencyId}, ${business}::uuid, person.user_id, ${notice.kind}, ${notice.sourceKey},
           ${notice.collapseKey ?? null}, ${notice.eventId ?? null}::uuid, ${notice.cause.kind},
           ${notice.cause.id}::uuid, ${notice.subject.kind}, ${subjectId}::uuid,
           (select record.id from crm.records record
            where record.business_id = ${business}::uuid and record.id = ${notice.recordId ?? null}::uuid),
           ${shortened(notice.title, TITLE_LENGTH)}, ${shortened(notice.body, BODY_LENGTH)}
    from unnest(${people}::uuid[]) as person (user_id)
    where exists (
        select 1 from tenancy.memberships member
        join auth.users account on account.id = member.user_id
        where member.user_id = person.user_id and member.agency_id = ${agencyId}
          and (member.business_id is null or member.business_id = ${business}::uuid)
          and account.disabled_at is null)
      and not exists (
        select 1 from notifications.preferences preference
        where preference.business_id = ${business}::uuid and preference.user_id = person.user_id
          and preference.kind = ${notice.kind} and not preference.in_app)
      and (select count(*) from (
             select 1 from notifications.notifications unread
             where unread.user_id = person.user_id and ${here} and unread.read_at is null
             limit ${UNREAD_CEILING}) held) < ${UNREAD_CEILING}
    on conflict do nothing
    returning user_id
  `.execute(trx);
  return told.rows.map((row) => row.user_id);
}
