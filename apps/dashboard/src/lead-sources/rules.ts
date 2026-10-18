// What Settings → Lead Sources works out about a rule before it draws: a rule as its editor
// holds it and back as the API takes it, which operators and what kind of value each fact
// takes (the contract's own vocabulary, never a list kept here), a rule read as a sentence,
// the order after a move, the limits, where the server's refusals belong, and whether a
// rule being written would match a link that was checked.
import {
  createLeadSourceRuleInput,
  LEAD_SOURCE_RULE_LIMITS,
  leadSourceChoiceLabel,
  leadSourceFactNames,
  leadSourceFacts,
  leadSourceKeys,
  leadSourceOperatorLabels,
  leadSourceOperatorOperand,
  leadSourceOperatorsOf,
  matchesLeadSourceCondition,
  type CreateLeadSourceRuleInput,
  type LeadSourceCondition,
  type LeadSourceFact,
  type LeadSourceFactKind,
  type LeadSourceOperator,
  type LeadSourcePreview,
  type LeadSourceRule,
} from '@repo/contracts';
import { platformsOf } from '../click-id-platforms';
import type { Issue } from '../problems';

/** One condition as its row holds it: every box has a value, used or not. */
export interface ConditionDraft {
  readonly fact: LeadSourceFact;
  /** The parameter's name, for the fact that reads any parameter of the address. */
  readonly name: string;
  readonly op: LeadSourceOperator;
  /** What "is", "is not", "contains" and "starts with" compare with. */
  readonly value: string;
  /** What "is one of" lists. */
  readonly values: readonly string[];
}

export interface FieldWriteDraft {
  readonly fieldId: string;
  readonly value: string;
}

/** A rule as its editor holds it. */
export interface RuleDraft {
  readonly name: string;
  readonly enabled: boolean;
  readonly conditions: readonly ConditionDraft[];
  /** The Source the rule gives; empty when it names none. */
  readonly source: string;
  readonly tagIds: readonly string[];
  readonly fieldWrites: readonly FieldWriteDraft[];
}

export const factInfo = (
  fact: LeadSourceFact,
): {
  readonly kind: LeadSourceFactKind;
  readonly label: string;
  readonly description: string;
  readonly choices?: readonly string[];
} => leadSourceFacts[fact];

/** The facts a condition can read, in the order the contract offers them. */
export const factChoices: readonly LeadSourceFact[] = leadSourceFactNames;

/** What a condition's value box is: nothing, one of a list, several of a list, words, a list of words. */
export type ValueControl = 'none' | 'choice' | 'choices' | 'text' | 'texts';

export function valueControl(condition: Pick<ConditionDraft, 'fact' | 'op'>): ValueControl {
  const operand = leadSourceOperatorOperand[condition.op];
  if (operand === 'none') return 'none';
  const listed = factInfo(condition.fact).choices !== undefined;
  if (operand === 'values') return listed ? 'choices' : 'texts';
  return listed ? 'choice' : 'text';
}

/** A first condition, as a new rule starts with: nothing chosen that could be wrong. */
export const emptyCondition = (): ConditionDraft => ({
  fact: 'utm_campaign',
  name: '',
  op: 'contains',
  value: '',
  values: [],
});

export const emptyRule = (): RuleDraft => ({
  name: '',
  enabled: true,
  conditions: [emptyCondition()],
  source: '',
  tagIds: [],
  fieldWrites: [],
});

/**
 * The row after another fact is chosen: its operator stays when the new fact takes it,
 * else it is the first the fact takes; what was typed stays only where it can still mean
 * something (words stay words; a choice of one list is not a choice of another).
 */
export function withFact(condition: ConditionDraft, fact: LeadSourceFact): ConditionDraft {
  const operators = leadSourceOperatorsOf(fact);
  const op = operators.includes(condition.op) ? condition.op : (operators[0] ?? 'is');
  const wordsBefore = factInfo(condition.fact).choices === undefined;
  const wordsAfter = factInfo(fact).choices === undefined;
  const keep = wordsBefore && wordsAfter;
  return {
    fact,
    name: factInfo(fact).kind === 'parameter' ? condition.name : '',
    op,
    value: keep ? condition.value : '',
    values: keep ? condition.values : [],
  };
}

/** The row after another operator is chosen: a single value and a list hand over to each other. */
export function withOperator(condition: ConditionDraft, op: LeadSourceOperator): ConditionDraft {
  const before = leadSourceOperatorOperand[condition.op];
  const after = leadSourceOperatorOperand[op];
  if (after === 'values' && before === 'value' && condition.values.length === 0)
    return {
      ...condition,
      op,
      values: condition.value.trim() === '' ? [] : [condition.value.trim()],
    };
  if (after === 'value' && before === 'values' && condition.value.trim() === '')
    return { ...condition, op, value: condition.values[0] ?? '' };
  return { ...condition, op };
}

/** A list of words as people type one: separated by commas or new lines. */
export const listOf = (typed: string): string[] =>
  typed
    .split(/[\n,]/)
    .map((word) => word.trim())
    .filter((word) => word !== '');

/** A condition as the API takes it: only what its fact and operator use. */
export function conditionOf(draft: ConditionDraft): LeadSourceCondition {
  const operand = leadSourceOperatorOperand[draft.op];
  return {
    fact: draft.fact,
    ...(factInfo(draft.fact).kind === 'parameter' ? { name: draft.name.trim() } : {}),
    op: draft.op,
    ...(operand === 'value' ? { value: draft.value.trim() } : {}),
    ...(operand === 'values'
      ? { values: draft.values.map((value) => value.trim()).filter((value) => value !== '') }
      : {}),
  };
}

export const conditionDraftOf = (condition: LeadSourceCondition): ConditionDraft => ({
  fact: condition.fact,
  name: condition.name ?? '',
  op: condition.op,
  value: condition.value ?? '',
  values: condition.values ?? [],
});

export const ruleDraftOf = (
  rule: Pick<
    LeadSourceRule,
    'name' | 'enabled' | 'conditions' | 'source' | 'tagIds' | 'fieldWrites'
  >,
): RuleDraft => ({
  name: rule.name,
  enabled: rule.enabled,
  conditions: rule.conditions.map(conditionDraftOf),
  source: rule.source ?? '',
  tagIds: rule.tagIds,
  fieldWrites: rule.fieldWrites.map(({ fieldId, value }) => ({ fieldId, value })),
});

/** What a save sends for a rule: the whole rule, as the API's own schema takes it. */
export interface RuleBody {
  readonly name: string;
  readonly enabled: boolean;
  readonly conditions: LeadSourceCondition[];
  readonly source: string | null;
  readonly tagIds: string[];
  readonly fieldWrites: FieldWriteDraft[];
}

export function ruleBodyOf(draft: RuleDraft): RuleBody {
  const source = draft.source.trim();
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    conditions: draft.conditions.map(conditionOf),
    source: source === '' ? null : source,
    tagIds: [...draft.tagIds],
    fieldWrites: draft.fieldWrites.map(({ fieldId, value }) => ({ fieldId, value: value.trim() })),
  };
}

export type RuleCheck =
  | { readonly ok: true; readonly body: CreateLeadSourceRuleInput }
  | { readonly ok: false; readonly issues: Issue[] };

/** The rule checked by the API's own schema before it is sent: the same sentences, sooner. */
export function checkRule(draft: RuleDraft): RuleCheck {
  const parsed = createLeadSourceRuleInput.safeParse(ruleBodyOf(draft));
  if (parsed.success) return { ok: true, body: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: `/${issue.path.map(String).join('/')}`,
      message: issue.message,
    })),
  };
}

/** What is wrong with a rule, sorted to where its editor shows it. */
export interface RuleProblems {
  readonly name?: string;
  readonly source?: string;
  readonly tagIds?: string;
  /** By the condition's place, then by its box: fact, name, op, value. */
  readonly conditions: Readonly<Record<number, Readonly<Record<string, string>>>>;
  /** What is wrong with the conditions as a list. */
  readonly conditionList?: string;
  readonly fieldWrites: Readonly<Record<number, Readonly<Record<string, string>>>>;
  readonly fieldWriteList?: string;
  /** Anything that names no box. */
  readonly form?: string;
}

export const noRuleProblems: RuleProblems = { conditions: {}, fieldWrites: {} };

/** The API's issues (JSON pointers) sorted for the editor: the first for each box. */
export function ruleProblemsOf(issues: readonly Issue[]): RuleProblems {
  const found: {
    name?: string;
    source?: string;
    tagIds?: string;
    conditionList?: string;
    fieldWriteList?: string;
    form?: string;
  } = {};
  const conditions: Record<number, Record<string, string>> = {};
  const fieldWrites: Record<number, Record<string, string>> = {};
  const rowOf = (
    rows: Record<number, Record<string, string>>,
    place: string | undefined,
    box: string | undefined,
    message: string,
    fallback: string,
  ): boolean => {
    const index = Number(place);
    if (place === undefined || !Number.isInteger(index)) return false;
    const row = (rows[index] ??= {});
    // "values" is shown in the same box as "value": a row has one value box.
    const key = box === undefined ? fallback : box === 'values' ? 'value' : box;
    row[key] ??= message;
    return true;
  };
  for (const issue of issues) {
    const [first, place, box] = issue.path.replace(/^\//, '').split('/');
    if (first === 'name') found.name ??= issue.message;
    else if (first === 'source') found.source ??= issue.message;
    else if (first === 'tagIds') found.tagIds ??= issue.message;
    else if (first === 'conditions') {
      if (!rowOf(conditions, place, box, issue.message, 'value'))
        found.conditionList ??= issue.message;
    } else if (first === 'fieldWrites') {
      if (!rowOf(fieldWrites, place, box, issue.message, 'value'))
        found.fieldWriteList ??= issue.message;
    } else found.form ??= issue.message;
  }
  return { ...found, conditions, fieldWrites };
}

/** Whether nothing is wrong. */
export const isClean = (problems: RuleProblems): boolean =>
  problems.name === undefined &&
  problems.source === undefined &&
  problems.tagIds === undefined &&
  problems.conditionList === undefined &&
  problems.fieldWriteList === undefined &&
  problems.form === undefined &&
  Object.keys(problems.conditions).length === 0 &&
  Object.keys(problems.fieldWrites).length === 0;

export const canAddRule = (count: number): boolean => count < LEAD_SOURCE_RULE_LIMITS.rules;
export const canAddCondition = (draft: Pick<RuleDraft, 'conditions'>): boolean =>
  draft.conditions.length < LEAD_SOURCE_RULE_LIMITS.conditions;
export const canAddFieldWrite = (draft: Pick<RuleDraft, 'fieldWrites'>): boolean =>
  draft.fieldWrites.length < LEAD_SOURCE_RULE_LIMITS.fieldWrites;

/** The ids in their order after the one at `index` moves up (-1) or down (+1); undefined at an end. */
export function movedOrder(
  ids: readonly string[],
  index: number,
  by: -1 | 1,
): string[] | undefined {
  const to = index + by;
  const moving = ids[index];
  const other = ids[to];
  if (moving === undefined || other === undefined) return undefined;
  const next = [...ids];
  next[index] = other;
  next[to] = moving;
  return next;
}

/** The ids after one is dropped on another's place; undefined when nothing moves. */
export function droppedOrder(
  ids: readonly string[],
  movingId: string,
  ontoId: string,
): string[] | undefined {
  const from = ids.indexOf(movingId);
  const to = ids.indexOf(ontoId);
  if (from === -1 || to === -1 || from === to) return undefined;
  const next = ids.filter((id) => id !== movingId);
  next.splice(to, 0, movingId);
  return next;
}

/** The name a copy of a rule starts with, cut to what a name may hold. */
export function copyName(name: string, suffix: string): string {
  const room = LEAD_SOURCE_RULE_LIMITS.nameLength - suffix.length;
  return `${name.slice(0, Math.max(room, 0)).trimEnd()}${suffix}`;
}

/** What the page needs to say a rule in words. */
export interface SentenceWords {
  /** A session source's or a medium's own name, by its key. */
  readonly choice: (fact: LeadSourceFact, value: string) => string;
  readonly tagName: (id: string) => string;
  readonly fieldName: (id: string) => string;
  /** "has a Google click ID" and "has no Google click ID", from the fact's label. */
  readonly has: (label: string) => string;
  readonly hasNo: (label: string) => string;
  /** "address parameter promo", from the parameter's name. */
  readonly parameter: (name: string) => string;
  /** Joins a list of choices: "Google Ads or Facebook Ads". */
  readonly either: (values: readonly string[]) => string;
  readonly quoted: (value: string) => string;
}

/** A lead source key as people read it; any other value as it is. */
const leadSourceName = (value: string): string => {
  const key = leadSourceKeys.find((each) => each === value);
  return key === undefined ? value : leadSourceChoiceLabel(key);
};

/** What a chosen value of a listed fact is called. */
export function choiceName(fact: LeadSourceFact, value: string, words: SentenceWords): string {
  return fact === 'lead_source' ? leadSourceName(value) : words.choice(fact, value);
}

/** One condition in words: "UTM campaign contains “spring”". */
export function conditionPhrase(condition: ConditionDraft, words: SentenceWords): string {
  const info = factInfo(condition.fact);
  if (info.kind === 'presence')
    return condition.op === 'is_empty' ? words.hasNo(info.label) : words.has(info.label);
  const subject = info.kind === 'parameter' ? words.parameter(condition.name.trim()) : info.label;
  const operator = leadSourceOperatorLabels[condition.op];
  const said = (value: string): string =>
    info.choices === undefined
      ? words.quoted(value.trim())
      : choiceName(condition.fact, value, words);
  const operand = leadSourceOperatorOperand[condition.op];
  if (operand === 'none') return `${subject} ${operator}`;
  if (operand === 'values')
    return `${subject} ${operator} ${words.either(condition.values.map(said))}`;
  return `${subject} ${operator} ${said(condition.value)}`;
}

export interface RuleSentence {
  /** Each condition in words: all must hold. */
  readonly when: readonly string[];
  /** The Source the rule gives, when it names one. */
  readonly source: string | undefined;
  /** The names of the tags it adds. */
  readonly tags: readonly string[];
  /** The fields it fills: the field's name and the text. */
  readonly fills: readonly { readonly field: string; readonly value: string }[];
}

/** A rule read as a sentence: when these hold, it does these. */
export function ruleSentence(rule: RuleDraft, words: SentenceWords): RuleSentence {
  const source = rule.source.trim();
  return {
    when: rule.conditions.map((condition) => conditionPhrase(condition, words)),
    source: source === '' ? undefined : source,
    tags: rule.tagIds.map(words.tagName),
    fills: rule.fieldWrites.map((write) => ({
      field: words.fieldName(write.fieldId),
      value: write.value.trim(),
    })),
  };
}

/**
 * What a trial reads of the server's answer to "Check a link". `sourceRule` is the built-in
 * rule that fits the address, whatever rule of the business named the lead.
 */
export type TrialReading = Pick<
  LeadSourcePreview,
  'sourceRule' | 'sessionSource' | 'facts' | 'clickIds'
>;

/**
 * What each fact is for a link that was checked: the server's own reading of the address
 * (its answer to "Check a link"), and for the page's parts the address itself. A link is
 * tried as a form on that very page would take it, as the server tries the saved rules.
 * Null for what the visit does not say; a click id that is there reads as "yes".
 */
export function trialFacts(
  preview: TrialReading,
  address: string,
): (condition: Pick<ConditionDraft, 'fact' | 'name'>) => string | null {
  const url = URL.canParse(address) ? new URL(address) : undefined;
  const held = new Set(platformsOf(preview.clickIds));
  const page = preview.facts.landingUrl;
  const values: Readonly<Record<Exclude<LeadSourceFact, 'parameter'>, string | null>> = {
    lead_source: preview.sourceRule,
    session_source: preview.sessionSource,
    medium: 'form',
    utm_source: preview.facts.utmSource,
    utm_medium: preview.facts.utmMedium,
    utm_campaign: preview.facts.utmCampaign,
    utm_content: preview.facts.utmContent,
    utm_term: preview.facts.utmTerm,
    match_type: preview.facts.matchType,
    campaign_id: preview.facts.campaignId,
    ad_group_id: preview.facts.adGroupId,
    ad_id: preview.facts.adId,
    click_id_google: held.has('google') ? 'yes' : null,
    click_id_meta: held.has('meta') ? 'yes' : null,
    click_id_microsoft: held.has('microsoft') ? 'yes' : null,
    click_id_tiktok: held.has('tiktok') ? 'yes' : null,
    click_id_linkedin: held.has('linkedin') ? 'yes' : null,
    referrer_domain: preview.facts.referrerDomain,
    landing_page: page,
    form_page: page,
    site: url?.host ?? null,
    step: url?.pathname ?? null,
  };
  // A parameter is read as the server reads every fact of a visit: trimmed, and not at all
  // when it is empty, longer than a value may be or more than one line.
  const parameter = (name: string): string | null => {
    const value = url?.searchParams.get(name.trim())?.trim() ?? '';
    return value !== '' &&
      value.length <= LEAD_SOURCE_RULE_LIMITS.valueLength &&
      ONE_LINE.test(value)
      ? value
      : null;
  };
  return (condition) =>
    condition.fact === 'parameter' ? parameter(condition.name) : values[condition.fact];
}

const ONE_LINE = /^\P{Cc}*$/u;

export interface RuleTrial {
  /** Whether each condition holds, in the rule's order. */
  readonly holds: readonly boolean[];
  /** Every condition holds: the rule would apply. */
  readonly matches: boolean;
}

/** Whether a rule being written would match a link that was checked. */
export function tryRule(
  rule: Pick<RuleDraft, 'conditions'>,
  preview: TrialReading,
  address: string,
): RuleTrial {
  const factOf = trialFacts(preview, address);
  const holds = rule.conditions.map((condition) =>
    matchesLeadSourceCondition(conditionOf(condition), factOf(condition)),
  );
  return { holds, matches: holds.length > 0 && holds.every(Boolean) };
}
