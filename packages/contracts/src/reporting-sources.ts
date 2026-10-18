// The catalogue of what a report can ask: for each source its measures, its dimensions, the
// dates a range can be read by, and the fields a condition can name. The query engine
// compiles nothing that is not listed here, and the builder offers nothing else. Stage 1
// has four sources; the rest of the plan's table (emails, forms, payments, ads…) join this
// list as they are built.
import { appointmentSources } from './appointments.js';
import { appointmentStatuses } from './calendar-events.js';
import { contactTypes } from './contact-attributes.js';
import { contactSources } from './contact-details.js';
import type { Permission } from './permissions.js';
import { attributionMediums, sessionSources } from './reporting-attribution.js';

export const reportSourceKeys = [
  'contacts',
  'opportunities',
  'appointments',
  'attribution',
] as const;
export type ReportSourceKey = (typeof reportSourceKeys)[number];

/**
 * What a measure's value is: a whole number, or money. Money is never added across
 * currencies: its value is one decimal amount for each currency.
 */
export type ReportMeasureKind = 'count' | 'money';

export interface ReportMeasureSpec {
  readonly label: string;
  readonly kind: ReportMeasureKind;
  readonly description: string;
  /**
   * False for a measure that cannot be added up from parts, such as distinct contacts: a
   * contact with touches in two groups is one contact in the total. Its "Other" row is empty.
   */
  readonly additive: boolean;
}

/**
 * What a dimension's values are:
 * - `text`: free text of the business's own (a UTM campaign, a source);
 * - `choice`: one of a fixed list of keys (`choices`);
 * - `reference`: something of the business, named by its public id (a pipeline, a stage, a
 *   calendar, a tag, a lost reason) or a team member by membership id;
 * - `weekday`: the day of the week of the query's date, 1 (Monday) to 7 (Sunday).
 */
export type ReportDimensionKind = 'text' | 'choice' | 'reference' | 'weekday';

export const reportReferences = [
  'member',
  'tag',
  'pipeline',
  'stage',
  'lost_reason',
  'calendar',
] as const;
export type ReportReference = (typeof reportReferences)[number];

export interface ReportDimensionSpec {
  readonly label: string;
  readonly kind: ReportDimensionKind;
  readonly choices?: readonly string[];
  readonly reference?: ReportReference;
  /** True for the contact's attribution: read from its first or latest touch, as the query says. */
  readonly attribution?: true;
  /** True when one row can be in several groups (a contact with two tags is counted in both). */
  readonly multiple?: true;
}

export interface ReportSourceSpec {
  readonly label: string;
  readonly description: string;
  /** What a reader needs beside `reports.view`. Null for none. */
  readonly permission: Permission | null;
  readonly measures: Readonly<Record<string, ReportMeasureSpec>>;
  /** Every dimension can be grouped by and filtered on, except a weekday (group only). */
  readonly dimensions: Readonly<Record<string, ReportDimensionSpec>>;
  /** Fields a condition can name that are not dimensions. */
  readonly numberFilters: readonly string[];
  readonly dateProperties: Readonly<Record<string, { readonly label: string }>>;
  readonly defaultDate: string;
  /** Which touches `attribution` may ask for; the first is the default. */
  readonly attribution: readonly ('first' | 'latest' | 'all')[];
}

const text = (label: string): ReportDimensionSpec => ({ label, kind: 'text' });
const touch = (spec: ReportDimensionSpec): ReportDimensionSpec => ({ ...spec, attribution: true });

/** Where a contact came from, by its first or latest touch. The same on every source. */
const attributionDimensions = {
  // The lead source's name: text, since an address can choose it (source=).
  leadSource: touch(text('Lead source')),
  sessionSource: touch({ label: 'Session source', kind: 'choice', choices: sessionSources }),
  medium: touch({ label: 'Medium', kind: 'choice', choices: attributionMediums }),
  utmSource: touch(text('UTM source')),
  utmMedium: touch(text('UTM medium')),
  utmCampaign: touch(text('UTM campaign')),
  utmContent: touch(text('UTM content')),
  utmTerm: touch(text('UTM term')),
  campaignId: touch(text('Campaign ID')),
  referrerDomain: touch(text('Referrer')),
  landingPage: touch(text('Landing page')),
} as const satisfies Readonly<Record<string, ReportDimensionSpec>>;

const count = (label: string, description: string): ReportMeasureSpec => ({
  label,
  kind: 'count',
  description,
  additive: true,
});

export const reportSources = {
  contacts: {
    label: 'Contacts',
    description:
      'Contacts that are not in the trash. A lead is a contact, on the day it was added.',
    permission: null,
    measures: { count: count('Contacts', 'How many contacts.') },
    dimensions: {
      createdSource: { label: 'Created by', kind: 'choice', choices: contactSources },
      source: text('Source'),
      type: { label: 'Type', kind: 'choice', choices: contactTypes },
      owner: { label: 'Owner', kind: 'reference', reference: 'member' },
      tag: { label: 'Tag', kind: 'reference', reference: 'tag', multiple: true },
      ...attributionDimensions,
    },
    numberFilters: [],
    dateProperties: { created: { label: 'Created on' } },
    defaultDate: 'created',
    attribution: ['first', 'latest'],
  },
  opportunities: {
    label: 'Opportunities',
    description:
      "Opportunities that are not in the trash. Attribution is their primary contact's. Revenue is the value of the won ones, not money received.",
    permission: null,
    measures: {
      count: count('Opportunities', 'How many opportunities.'),
      value: {
        label: 'Value',
        kind: 'money',
        description:
          'The sum of their values, for each currency. One without a value adds nothing.',
        additive: true,
      },
      averageValue: {
        label: 'Average value',
        kind: 'money',
        description: 'The sum over the opportunities that have a value, for each currency.',
        additive: true,
      },
    },
    dimensions: {
      status: { label: 'Status', kind: 'choice', choices: ['open', 'won', 'lost'] },
      pipeline: { label: 'Pipeline', kind: 'reference', reference: 'pipeline' },
      stage: { label: 'Stage', kind: 'reference', reference: 'stage' },
      owner: { label: 'Owner', kind: 'reference', reference: 'member' },
      source: text('Source'),
      lostReason: { label: 'Lost reason', kind: 'reference', reference: 'lost_reason' },
      ...attributionDimensions,
    },
    numberFilters: ['value'],
    dateProperties: {
      created: { label: 'Created on' },
      statusChanged: { label: 'Status changed on' },
      closed: { label: 'Closed on' },
    },
    defaultDate: 'created',
    attribution: ['first', 'latest'],
  },
  appointments: {
    label: 'Appointments',
    description:
      "Appointments, as they are now: one moved or cancelled since is counted where and as it is today. Attribution is the contact's.",
    permission: null,
    measures: { count: count('Appointments', 'How many appointments.') },
    dimensions: {
      status: { label: 'Status', kind: 'choice', choices: appointmentStatuses },
      calendar: { label: 'Calendar', kind: 'reference', reference: 'calendar' },
      assignee: { label: 'Team member', kind: 'reference', reference: 'member' },
      bookingSource: { label: 'Channel', kind: 'choice', choices: appointmentSources },
      weekday: { label: 'Day of the week', kind: 'weekday' },
      ...attributionDimensions,
    },
    numberFilters: [],
    dateProperties: {
      starts: { label: 'Takes place on' },
      created: { label: 'Booked on' },
      cancelled: { label: 'Cancelled on' },
    },
    defaultDate: 'starts',
    attribution: ['first', 'latest'],
  },
  attribution: {
    label: 'Attribution',
    description:
      'Touches: each recorded interaction of a contact that is not in the trash (a form, a booking, a chat, being added by hand or by an integration).',
    permission: null,
    measures: {
      touches: count('Touches', 'How many touches.'),
      contacts: {
        label: 'Contacts',
        kind: 'count',
        description: 'How many different contacts the touches are of.',
        additive: false,
      },
    },
    dimensions: attributionDimensions,
    numberFilters: [],
    dateProperties: { touched: { label: 'Touched on' } },
    defaultDate: 'touched',
    attribution: ['all', 'first', 'latest'],
  },
} as const satisfies Readonly<Record<ReportSourceKey, ReportSourceSpec>>;

/** A source's catalogue entry, by its key. */
export const reportSource = (key: ReportSourceKey): ReportSourceSpec => reportSources[key];

/** The names of the days of the week, by the key a weekday dimension gives: 1 is Monday. */
export const reportWeekdays = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;
