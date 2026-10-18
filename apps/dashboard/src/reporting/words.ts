// Reporting's words for what the API names by key: GoHighLevel's names for the session
// sources, the appointment statuses and channels, the range presets, the kinds of widget
// and the operators of a condition. A key this dashboard has no words for yet is shown
// readable, never hidden.
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { useLingui } from '@lingui/react/macro';
import type { ReportWidgetKind } from '@repo/contracts';
import type { RangeChoice } from '../reporting-search';
import type { ModelWords } from './result-model';

type Words = Readonly<Record<string, MessageDescriptor>>;

const sessionSources: Words = {
  paid_search: msg`Paid Search`,
  paid_social: msg`Paid Social`,
  social_media: msg`Social Media`,
  organic_search: msg`Organic Search`,
  referral: msg`Referral`,
  direct: msg`Direct Traffic`,
  others: msg`Others`,
  crm_ui: msg`CRM UI`,
  third_party: msg`Third-Party`,
};

const mediums: Words = {
  form: msg`Form`,
  calendar: msg`Calendar`,
  chat: msg`Chat`,
  manual: msg`Added by hand`,
  api: msg`API`,
  import: msg`Import`,
  message: msg`Message`,
  automation: msg`Automation`,
  assistant: msg`Assistant`,
  unknown: msg`Unknown`,
};

const appointmentStatuses: Words = {
  booked: msg`Booked`,
  confirmed: msg`Confirmed`,
  cancelled: msg`Cancelled`,
  no_show: msg`No Show`,
  completed: msg`Showed`,
  invalid: msg`Invalid`,
};

const channels: Words = {
  booking_page: msg`Booking page`,
  user: msg`Team member`,
  ai_agent: msg`AI agent`,
  automation: msg`Automation`,
  api: msg`API`,
  import: msg`Import`,
};

const dealStatuses: Words = { open: msg`Open`, won: msg`Won`, lost: msg`Lost` };
const contactTypes: Words = { lead: msg`Lead`, customer: msg`Customer` };
const createdSources: Words = {
  user: msg`Team member`,
  api: msg`API`,
  form: msg`Form`,
  booking: msg`Booking`,
  import: msg`Import`,
  email: msg`Email`,
  sms: msg`SMS`,
  webchat: msg`Web chat`,
  automation: msg`Automation`,
  assistant: msg`Assistant`,
  unknown: msg`Unknown`,
};

/** The words for a dimension's choices, by the dimension's key and the source it is on. */
function choiceWords(dimension: string, source: string | undefined): Words | undefined {
  switch (dimension) {
    case 'sessionSource':
      return sessionSources;
    case 'medium':
      return mediums;
    case 'bookingSource':
      return channels;
    case 'createdSource':
      return createdSources;
    case 'type':
      return contactTypes;
    case 'status':
      return source === 'appointments' ? appointmentStatuses : dealStatuses;
    default:
      return undefined;
  }
}

const presets: Readonly<Record<RangeChoice, MessageDescriptor>> = {
  today: msg`Today`,
  yesterday: msg`Yesterday`,
  last_7_days: msg`Last 7 days`,
  last_30_days: msg`Last 30 days`,
  last_90_days: msg`Last 90 days`,
  this_week: msg`This week`,
  last_week: msg`Last week`,
  this_month: msg`This month`,
  last_month: msg`Last month`,
  this_quarter: msg`This quarter`,
  last_quarter: msg`Last quarter`,
  this_year: msg`This year`,
  last_year: msg`Last year`,
  last_12_months: msg`Last 12 months`,
  custom: msg`Custom range`,
};

const kinds: Readonly<Record<ReportWidgetKind, MessageDescriptor>> = {
  stat: msg`Number`,
  line: msg`Line`,
  area: msg`Area`,
  bar: msg`Bar`,
  hbar: msg`Horizontal bar`,
  donut: msg`Donut`,
  table: msg`Table`,
  funnel: msg`Funnel`,
  text: msg`Text`,
};

const operators: Words = {
  is: msg`Is`,
  is_not: msg`Is not`,
  contains: msg`Contains`,
  not_contains: msg`Does not contain`,
  any_of: msg`Is any of`,
  all_of: msg`Is all of`,
  none_of: msg`Is none of`,
  is_empty: msg`Is empty`,
  is_not_empty: msg`Is not empty`,
  gt: msg`Is more than`,
  gte: msg`Is at least`,
  lt: msg`Is less than`,
  lte: msg`Is at most`,
  between: msg`Is between`,
};

/** A key as words, when there are none of our own: no_show as "No show". */
export function readable(key: string): string {
  const text = key.replace(/[._]/g, ' ').trim();
  return text === '' ? key : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export interface ReportWords extends ModelWords {
  readonly sessionSource: (key: string | null) => string;
  readonly medium: (key: string) => string;
  readonly appointmentStatus: (key: string) => string;
  readonly channel: (key: string) => string;
  readonly preset: (choice: RangeChoice) => string;
  readonly kind: (kind: ReportWidgetKind) => string;
  readonly operator: (operator: string) => string;
  /** One of a dimension's choices, on a source. */
  readonly choice: (dimension: string, choice: string, source?: string) => string;
}

export function useReportWords(): ReportWords {
  const { t, i18n } = useLingui();
  const from = (words: Words | undefined, key: string): string => {
    const found = words !== undefined && Object.hasOwn(words, key) ? words[key] : undefined;
    return found === undefined ? readable(key) : i18n._(found);
  };
  return {
    other: t`Other`,
    none: t`Not set`,
    total: t`Total`,
    previous: (label) => t`${label}, period before`,
    weekOf: (day) => t`Week of ${day}`,
    sessionSource: (key) => (key === null ? t`No touch recorded` : from(sessionSources, key)),
    medium: (key) => from(mediums, key),
    appointmentStatus: (key) => from(appointmentStatuses, key),
    channel: (key) => from(channels, key),
    preset: (choice) => i18n._(presets[choice]),
    kind: (kind) => i18n._(kinds[kind]),
    operator: (operator) => from(operators, operator),
    choice: (dimension, choice, source) => from(choiceWords(dimension, source), choice),
  };
}
