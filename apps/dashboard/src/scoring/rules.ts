// What Settings → Manage Scoring works out before it draws: a rule as its dialog holds it and
// back as the API takes it, which rules a search finds, and which of them a page shows.
// Every choice comes from the contract's own lists, never one kept here.
import {
  appointmentStatuses,
  scoreEmailEvents,
  scoreReplyChannels,
  scoreTagChanges,
  SCORING_LIMITS,
  type ScoreCalculation,
  type ScoreRule,
  type ScoreRuleAction,
  type ScoreRuleInput,
  type ScoreRuleWhenInput,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';

/** What the server said, or the page's own words when no answer came. */
export const saidBy = (error: unknown, fallback: string): string =>
  error instanceof ApiError
    ? (error.problem.errors?.[0]?.message ?? error.problem.detail ?? error.message)
    : fallback;

/** A rule as the dialog holds it: every box has a value, used or not; '' is "any". */
export interface RuleDraft {
  readonly action: ScoreRuleAction;
  readonly event: (typeof scoreEmailEvents)[number];
  readonly channel: (typeof scoreReplyChannels)[number] | '';
  readonly formId: string;
  readonly status: (typeof appointmentStatuses)[number];
  readonly change: (typeof scoreTagChanges)[number];
  readonly tagId: string;
  readonly hasTagId: string;
  readonly calculation: ScoreCalculation;
  readonly points: string;
}

export const emptyDraft: RuleDraft = {
  action: 'email_event',
  event: 'bounced',
  channel: '',
  formId: '',
  status: 'confirmed',
  change: 'added',
  tagId: '',
  hasTagId: '',
  calculation: 'add',
  points: '1',
};

/** The dialog's boxes for a saved rule. */
export function draftOf(rule: ScoreRule): RuleDraft {
  const { when } = rule;
  const base: RuleDraft = {
    ...emptyDraft,
    action: when.action,
    hasTagId: rule.hasTagId ?? '',
    calculation: rule.calculation,
    points: String(rule.points),
  };
  switch (when.action) {
    case 'email_event':
      return { ...base, event: when.event };
    case 'contact_replied':
      return { ...base, channel: when.channel ?? '' };
    case 'form_submitted':
      return { ...base, formId: when.formId ?? '' };
    case 'appointment_status':
      return { ...base, status: when.status };
    case 'contact_tag':
      return { ...base, change: when.change, tagId: when.tagId };
    case 'appointment_booked':
    case 'payment_received':
    case 'trigger_link_clicked':
    case 'contact_changed':
      return base;
  }
}

function whenOf(draft: RuleDraft): ScoreRuleWhenInput {
  switch (draft.action) {
    case 'email_event':
      return { action: draft.action, event: draft.event };
    case 'contact_replied':
      return { action: draft.action, channel: draft.channel === '' ? null : draft.channel };
    case 'form_submitted':
      return { action: draft.action, formId: draft.formId === '' ? null : draft.formId };
    case 'appointment_status':
      return { action: draft.action, status: draft.status };
    case 'contact_tag':
      return { action: draft.action, change: draft.change, tagId: draft.tagId };
    case 'appointment_booked':
    case 'payment_received':
    case 'trigger_link_clicked':
    case 'contact_changed':
      return { action: draft.action };
  }
}

/** Whole points within the limit, as the box holds them, or undefined. */
export function pointsOf(text: string): number | undefined {
  if (!/^\d+$/.test(text.trim())) return undefined;
  const points = Number(text.trim());
  return points >= 1 && points <= SCORING_LIMITS.points ? points : undefined;
}

/** What keeps a rule from being saved. */
export type Missing = 'tag' | 'tag_deleted' | 'form_deleted' | 'has_tag_deleted' | 'points';

/**
 * What is missing before the rule can be saved: the tag of a tag rule, another tag or form in
 * place of one that was deleted (`deleted` holds their ids), or the points.
 */
export function missingOf(
  draft: RuleDraft,
  deleted: ReadonlySet<string> = new Set(),
): Missing | undefined {
  if (draft.action === 'contact_tag') {
    if (draft.tagId === '') return 'tag';
    if (deleted.has(draft.tagId)) return 'tag_deleted';
  }
  if (draft.action === 'form_submitted' && deleted.has(draft.formId)) return 'form_deleted';
  if (deleted.has(draft.hasTagId)) return 'has_tag_deleted';
  return pointsOf(draft.points) === undefined ? 'points' : undefined;
}

/** The rule as the API takes it; call it only when nothing is missing. */
export function bodyOf(draft: RuleDraft): ScoreRuleInput {
  return {
    when: whenOf(draft),
    hasTagId: draft.hasTagId === '' ? null : draft.hasTagId,
    calculation: draft.calculation,
    points: pointsOf(draft.points) ?? 1,
  };
}

/** The rules whose sentence holds every word searched for, whatever its capitals. */
export function searched<Rule>(
  rules: readonly Rule[],
  search: string,
  sentence: (rule: Rule) => string,
): Rule[] {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rules];
  return rules.filter((rule) => {
    const text = sentence(rule).toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** The rules one page shows, from page 0; the last page when it asks for one past it. */
export function pageOf<Rule>(
  rules: readonly Rule[],
  page: number,
  size: number,
): { readonly items: Rule[]; readonly page: number } {
  const last = Math.max(0, Math.ceil(rules.length / size) - 1);
  const shown = Math.min(Math.max(0, page), last);
  return { items: rules.slice(shown * size, shown * size + size), page: shown };
}
