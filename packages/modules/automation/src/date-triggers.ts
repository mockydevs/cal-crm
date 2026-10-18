// When a date trigger fires: at a time of day on a contact's date, in a time zone, moved by
// an offset before or after. Days, weeks, months and years of the offset move the date
// itself, so "3 days before at 08:00" is 08:00 on that day whatever the clocks did in
// between; hours and minutes then move the instant.
//
// The sweep is the worker's: each minute it asks, for every automation with a date trigger,
// which dates came round since it last looked (the trigger's cursor), and enrols the
// contacts that hold them. A contact is enrolled in a transaction of its own, with its runs
// held still as every enrolment has them, and a firing row says it was done: a sweep that
// died half way, or two at once, enrol a contact once.
import { randomUUID } from 'node:crypto';

import type { Services } from '@repo/commands';
import {
  addDuration,
  automationDocument,
  evaluateCondition,
  type AutomationDocument,
  type AutomationTrigger,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { sql, type RawBuilder } from 'kysely';

import { enrol, lockRecordRuns } from './enrolment.js';
import { contactValues } from './values.js';
import { dateOf, firingInstant, type DateRule } from './zoned-dates.js';

export { firingInstant, type DateRule } from './zoned-dates.js';

const DAY = 86_400_000;
// Time zones are within a day of UTC and a month's length varies by three days, so the
// dates that can fire in a stretch lie within this many days of the stretch moved back.
const SEARCH_DAYS = 5;

/**
 * The dates whose firing instant lies after `after` and no later than `through`, earliest
 * date first. Each is found by trying the dates near the stretch and keeping those that
 * fire in it, so a month's uneven length and a clock change cost nothing in exactness.
 */
export function datesFiringIn(
  rule: DateRule,
  timeZone: string,
  after: Date,
  through: Date,
): readonly string[] {
  if (through.getTime() <= after.getTime()) return [];
  const back = rule.direction === 'before' ? 1 : -1;
  const from = rule.offset === undefined ? after : addDuration(after, rule.offset, back);
  const to = rule.offset === undefined ? through : addDuration(through, rule.offset, back);
  if (from === undefined || to === undefined) return [];
  const first = Math.min(from.getTime(), to.getTime()) - SEARCH_DAYS * DAY;
  const last = Math.max(from.getTime(), to.getTime()) + SEARCH_DAYS * DAY;
  if (Number.isNaN(first) || Number.isNaN(last)) return [];
  const dates: string[] = [];
  for (let day = Math.floor(first / DAY) * DAY; day <= last; day += DAY) {
    const date = dateOf(new Date(day));
    if (date === undefined) continue;
    const instant = firingInstant(date, rule, timeZone)?.getTime();
    if (instant !== undefined && instant > after.getTime() && instant <= through.getTime())
      dates.push(date);
  }
  return dates;
}

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * The days of the year a date stands for when a trigger comes round every year: its own
 * month and day, and 29 February too on the 28th of a year without one, so a date kept on
 * a leap day still comes round.
 */
export function yearlyDays(
  date: string,
): readonly { readonly month: number; readonly day: number }[] {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  const own = { month, day };
  return month === 2 && day === 28 && !isLeapYear(year) ? [own, { month: 2, day: 29 }] : [own];
}

/** The time of day a date trigger fires at when it names none. */
export const DEFAULT_TRIGGER_TIME = '08:00';
/** How late a firing may still happen, after the worker was down; later ones are skipped. */
export const DATE_TRIGGER_CATCH_UP_MS = DAY;

type DateTrigger = Extract<AutomationTrigger, { type: 'date.reached' }>;

const isDateTrigger = (trigger: AutomationTrigger): trigger is DateTrigger =>
  trigger.type === 'date.reached';

const ruleOf = (trigger: DateTrigger): DateRule => ({
  offset: trigger.config.offset,
  direction: trigger.config.direction,
  time: trigger.config.time ?? DEFAULT_TRIGGER_TIME,
});

// Where a trigger's date is kept: a custom field's date or instant, or the contact's own.
type DateSource =
  | { readonly kind: 'date' | 'instant'; readonly fieldId: string }
  | { readonly kind: 'created' | 'updated' };

async function sourceOf(trx: DatabaseTransaction, path: string): Promise<DateSource | undefined> {
  if (path === 'contact.createdAt') return { kind: 'created' };
  if (path === 'contact.updatedAt') return { kind: 'updated' };
  const key = /^contact\.(?:custom\.)?([A-Za-z_][A-Za-z0-9_]*)$/.exec(path)?.[1];
  if (key === undefined) return undefined;
  // A key a merged field left behind reads the field that survived it, as values do.
  const { rows } = await sql<{ id: string; value_type: string }>`
    select field.id, field.value_type
    from crm.field_definitions field
    join crm.object_types type on type.id = field.object_type_id and type.kind = 'contact'
    where field.archived_at is null
      and (field.key = ${key} or field.id in (
        select alias.field_id from crm.field_key_aliases alias where alias.alias_key = ${key}))
    order by (field.key = ${key}) desc
    limit 1
  `.execute(trx);
  const [field] = rows;
  if (field?.value_type === 'date') return { kind: 'date', fieldId: field.id };
  if (field?.value_type === 'datetime') return { kind: 'instant', fieldId: field.id };
  return undefined;
}

/** A contact a trigger's date came round for, and the date on the contact's calendar. */
interface Firing {
  readonly triggerId: string;
  readonly recordId: string;
  readonly occurrence: string;
}

// The contacts that keep their dates in a time zone: everyone, or with the automation on
// each contact's own zone, those of that zone (the business's has those without one).
function inZone(zone: string, businessZone: string, byContact: boolean): RawBuilder<boolean> {
  if (!byContact) return sql<boolean>`true`;
  return zone === businessZone
    ? sql<boolean>`(contact.timezone is null or contact.timezone = ${zone})`
    : sql<boolean>`contact.timezone = ${zone}`;
}

async function dateFirings(
  trx: DatabaseTransaction,
  trigger: DateTrigger,
  fieldId: string,
  zones: readonly string[],
  businessZone: string,
  byContact: boolean,
  after: Date,
  through: Date,
): Promise<Firing[]> {
  const firings: Firing[] = [];
  for (const zone of zones)
    for (const date of datesFiringIn(ruleOf(trigger), zone, after, through)) {
      const days = sql.join(
        yearlyDays(date).map(
          ({ month, day }) =>
            sql`(extract(month from held.value_date) = ${month} and extract(day from held.value_date) = ${day})`,
        ),
        sql` or `,
      );
      // Every year from the year the field holds: a date ahead has no anniversary yet.
      const holds =
        trigger.config.repeat === 'never'
          ? sql<boolean>`held.value_date = ${date}::date`
          : sql<boolean>`held.value_date <= ${date}::date and (${days})`;
      const { rows } = await sql<{ id: string }>`
        select contact.id
        from crm.contacts contact
        join crm.field_values held on held.record_id = contact.id and held.field_id = ${fieldId}
        where contact.deleted_at is null and ${inZone(zone, businessZone, byContact)} and ${holds}
        order by contact.id
      `.execute(trx);
      for (const row of rows)
        firings.push({ triggerId: trigger.id, recordId: row.id, occurrence: date });
    }
  return firings;
}

// A date and time fires at its own instant, moved by the whole offset, once: it has no time
// of day to place in a zone, and no day of the year of its own.
async function instantFirings(
  trx: DatabaseTransaction,
  trigger: DateTrigger,
  source: Exclude<DateSource, { kind: 'date' }>,
  after: Date,
  through: Date,
): Promise<Firing[]> {
  const { offset, direction } = trigger.config;
  const sign = direction === 'before' ? -1 : 1;
  const back = sign === 1 ? -1 : 1;
  const from = offset === undefined ? after : addDuration(after, offset, back);
  const to = offset === undefined ? through : addDuration(through, offset, back);
  if (from === undefined || to === undefined) return [];
  const first = new Date(Math.min(from.getTime(), to.getTime()) - SEARCH_DAYS * DAY);
  const last = new Date(Math.max(from.getTime(), to.getTime()) + SEARCH_DAYS * DAY);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return [];
  const { rows } =
    source.kind === 'instant'
      ? await sql<{ id: string; at: Date }>`
          select contact.id, held.value_datetime as at
          from crm.contacts contact
          join crm.field_values held
            on held.record_id = contact.id and held.field_id = ${source.fieldId}
          where contact.deleted_at is null and held.value_datetime between ${first} and ${last}
          order by contact.id
        `.execute(trx)
      : await sql<{ id: string; at: Date }>`
          select contact.id, ${sql.ref(source.kind === 'created' ? 'contact.created_at' : 'contact.updated_at')} as at
          from crm.contacts contact
          where contact.deleted_at is null
            and ${sql.ref(source.kind === 'created' ? 'contact.created_at' : 'contact.updated_at')}
              between ${first} and ${last}
          order by contact.id
        `.execute(trx);
  const firings: Firing[] = [];
  for (const row of rows) {
    const instant = (offset === undefined ? row.at : addDuration(row.at, offset, sign))?.getTime();
    const occurrence = dateOf(row.at);
    if (
      instant !== undefined &&
      occurrence !== undefined &&
      instant > after.getTime() &&
      instant <= through.getTime()
    )
      firings.push({ triggerId: trigger.id, recordId: row.id, occurrence });
  }
  return firings;
}

interface Planned {
  readonly versionId: string;
  readonly document: AutomationDocument;
  /** The triggers this sweep looked through to now, whose cursors move when it is done. */
  readonly swept: readonly string[];
  readonly firings: readonly Firing[];
  /** Triggers that had not been swept for longer than a firing may be late. */
  readonly late: number;
}

// What one automation's date triggers have to fire now. It moves no cursor of a trigger it
// has firings for: that happens once they are done (finish).
async function plan(
  trx: DatabaseTransaction,
  businessId: string,
  automationId: string,
  now: Date,
): Promise<Planned | undefined> {
  const { rows } = await sql<{
    status: string;
    version_id: string;
    document: unknown;
    timezone: string;
  }>`
    select automation.status, version.id as version_id, version.document, business.timezone
    from automation.automations automation
    join automation.versions version on version.id = automation.published_version_id
    join tenancy.businesses business on business.id = automation.business_id
    where automation.id = ${automationId} and automation.status in ('active', 'paused')
  `.execute(trx);
  const [automation] = rows;
  if (automation === undefined) return undefined;
  const document = automationDocument.parse(automation.document);
  const triggers = document.triggers.filter(isDateTrigger);
  const ids = triggers.map((trigger) => trigger.id);
  // A trigger the published version no longer has keeps no cursor. The Task Reminder
  // trigger keeps its cursors here too (task-reminders.ts), so every trigger counts.
  await sql`
    delete from automation.trigger_cursors
    where automation_id = ${automationId}
      and not (trigger_id = any(${document.triggers.map((trigger) => trigger.id)}::text[]))
  `.execute(trx);
  const kept = await sql<{ trigger_id: string; swept_through: Date }>`
    select trigger_id, swept_through from automation.trigger_cursors
    where automation_id = ${automationId} and trigger_id = any(${ids}::text[])
  `.execute(trx);
  const cursors = new Map(kept.rows.map((row) => [row.trigger_id, row.swept_through]));
  const started = triggers.filter((trigger) => !cursors.has(trigger.id));
  // Publishing starts the clock: a trigger seen for the first time fires nothing behind it.
  for (const trigger of started)
    await sql`
      insert into automation.trigger_cursors (business_id, automation_id, trigger_id, swept_through)
      values (${businessId}, ${automationId}, ${trigger.id}, ${now})
      on conflict do nothing
    `.execute(trx);
  const known = triggers.filter((trigger) => cursors.has(trigger.id));
  // A paused automation's dates pass unfired; its cursors keep up, so resuming starts from then.
  if (automation.status === 'paused') {
    await moveCursors(trx, automationId, ids, now);
    return undefined;
  }
  const byContact = document.settings.timezone === 'contact';
  const zones = byContact
    ? [
        ...new Set([
          automation.timezone,
          ...(
            await sql<{ timezone: string }>`
              select distinct timezone from crm.contacts
              where deleted_at is null and timezone is not null
            `.execute(trx)
          ).rows.map((row) => row.timezone),
        ]),
      ]
    : [automation.timezone];
  const firings: Firing[] = [];
  let late = 0;
  for (const trigger of known) {
    const cursor = cursors.get(trigger.id) ?? now;
    const earliest = now.getTime() - DATE_TRIGGER_CATCH_UP_MS;
    if (cursor.getTime() < earliest) late += 1;
    const after = new Date(Math.max(cursor.getTime(), earliest));
    const source = await sourceOf(trx, trigger.config.field);
    if (source === undefined) continue;
    firings.push(
      ...(source.kind === 'date'
        ? await dateFirings(
            trx,
            trigger,
            source.fieldId,
            zones,
            automation.timezone,
            byContact,
            after,
            now,
          )
        : await instantFirings(trx, trigger, source, after, now)),
    );
  }
  return {
    versionId: automation.version_id,
    document,
    swept: known.map((trigger) => trigger.id),
    firings,
    late,
  };
}

// A cursor only ever moves forward, whichever of two sweeps writes last.
async function moveCursors(
  trx: DatabaseTransaction,
  automationId: string,
  triggerIds: readonly string[],
  now: Date,
): Promise<void> {
  if (triggerIds.length === 0) return;
  await sql`
    update automation.trigger_cursors
    set swept_through = greatest(swept_through, ${now})
    where automation_id = ${automationId} and trigger_id = any(${triggerIds}::text[])
  `.execute(trx);
}

/**
 * One contact's firing, in its own transaction: the contact's runs held still, the firing
 * written unless it is there already, then the trigger's condition and the enrolment by the
 * rules every enrolment keeps. True when a run was started.
 */
async function fire(
  trx: DatabaseTransaction,
  context: TenantContext,
  automationId: string,
  planned: Planned,
  firing: Firing,
  now: Date,
): Promise<boolean> {
  const businessId = context.businessId;
  if (businessId === undefined) return false;
  await lockRecordRuns(trx, firing.recordId);
  // Paused, deleted or republished since the sweep looked: the next sweep decides afresh.
  const current = await sql`
    select 1 from automation.automations
    where id = ${automationId} and status = 'active' and published_version_id = ${planned.versionId}
  `.execute(trx);
  if (current.rows.length === 0) return false;
  const written = await sql`
    insert into automation.trigger_firings
      (business_id, automation_id, trigger_id, record_id, occurrence, fired_at)
    values (${businessId}, ${automationId}, ${firing.triggerId}, ${firing.recordId},
      ${firing.occurrence}::date, ${now})
    on conflict do nothing
    returning 1
  `.execute(trx);
  if (written.rows.length === 0) return false;
  const trigger = planned.document.triggers.find((each) => each.id === firing.triggerId);
  if (trigger === undefined) return false;
  if (
    trigger.if !== undefined &&
    !evaluateCondition(trigger.if, await contactValues(trx, firing.recordId), now)
  )
    return false;
  const result = await enrol(
    trx,
    businessId,
    automationId,
    planned.versionId,
    firing.recordId,
    planned.document,
    {
      eventId: null,
      correlationId: context.correlationId,
      triggerId: trigger.id,
      state: { triggerId: trigger.id, date: firing.occurrence },
    },
  );
  return result.outcome === 'started';
}

// Firings are needed only while their stretch of time can be swept again: until the cursor
// has passed it. Two days is that, with the day a late firing is allowed.
const FIRINGS_KEPT_MS = 2 * DAY;

async function finish(
  trx: DatabaseTransaction,
  automationId: string,
  planned: Planned,
  now: Date,
): Promise<void> {
  await moveCursors(trx, automationId, planned.swept, now);
  if (planned.firings.length > 0)
    await sql`
      delete from automation.trigger_firings
      where automation_id = ${automationId}
        and fired_at < ${new Date(now.getTime() - FIRINGS_KEPT_MS)}
    `.execute(trx);
}

/** What a sweep did. */
export interface DateSweep {
  /** Runs started. */
  readonly enrolled: number;
  /** Triggers that had gone unswept for longer than a firing may be late. */
  readonly late: number;
}

const PAGE = 200;

/**
 * The worker's sweep of date triggers: every automation with one, each in its own business
 * as the system. `now` is there for tests, which move time; the worker never passes it.
 */
export async function sweepDateTriggers(
  services: Services,
  now: Date = new Date(),
): Promise<DateSweep> {
  let enrolled = 0;
  let late = 0;
  let after: string | null = null;
  for (;;) {
    const { rows } = await sql<{ agency_id: string; business_id: string; automation_id: string }>`
      select * from private.automations_with_timers(${after}::uuid, ${PAGE})
    `.execute(services.db);
    for (const row of rows) {
      const inBusiness = (): TenantContext => ({
        agencyId: row.agency_id,
        businessId: row.business_id,
        actorKind: 'system',
        correlationId: randomUUID(),
      });
      const planned = await withTenant(services.db, inBusiness(), (trx) =>
        plan(trx, row.business_id, row.automation_id, now),
      );
      if (planned === undefined) continue;
      late += planned.late;
      for (const firing of planned.firings) {
        const context = inBusiness();
        if (
          await withTenant(services.db, context, (trx) =>
            fire(trx, context, row.automation_id, planned, firing, now),
          )
        )
          enrolled += 1;
      }
      await withTenant(services.db, inBusiness(), (trx) =>
        finish(trx, row.automation_id, planned, now),
      );
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < PAGE) return { enrolled, late };
    after = last.automation_id;
  }
}
