// The business's own lead source rules, tried before the built-in ones.
//
// What is decided here, once, for a form, a booking, a chat and "Check a link":
// - a business's rules are tried top to bottom. A rule matches when every one of its
//   conditions holds for the visit;
// - the FIRST matching rule that names a Source names the lead. When none does, the
//   built-in rules do (lead-source.ts), exactly as before there were rules;
// - the tags and the field values of EVERY matching rule apply: tags in rule order, each
//   once; a field is filled by the first matching rule that names it.
//
// A condition never reads the name a rule above it gave: `lead_source` is what the BUILT-IN
// rules call the visit, so a rule means the same wherever it stands in the list, and
// moving a rule changes only which of two matching rules names the Source.
//
// The cost, which the intake's budget holds this to: one statement, by the index that
// orders a business's rules, of at most 50 small rows; then string comparisons in memory.
// Nothing here waits on anything else.
import {
  LEAD_SOURCE_RULE_LIMITS,
  leadSourceCondition,
  matchesLeadSourceCondition,
  type LeadSourceCondition,
  type LeadSourceFact,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import * as z from 'zod';

import { leadSourceOfVisit, type LeadSource } from './lead-source.js';
import { sessionSourceOf, type VisitFacts } from './session-source.js';

/** A rule as the intake reads it: what is compared and what is done, and nothing else. */
export interface ActiveLeadSourceRule {
  /** crm.lead_source_rules.id. */
  readonly id: string;
  readonly position: number;
  readonly name: string;
  readonly conditions: readonly LeadSourceCondition[];
  readonly source: string | null;
  /** crm.tags.id, in the order the rule lists them. */
  readonly tagIds: readonly string[];
  /** crm.field_definitions.id and the text to write. */
  readonly fieldWrites: readonly { readonly fieldId: string; readonly value: string }[];
}

/** What a rule's conditions are asked of. */
export interface LeadFacts {
  readonly medium: 'form' | 'calendar' | 'chat';
  /** The facts of how the visitor arrived (session-source.ts). */
  readonly visit: VisitFacts;
  /** The page the lead was taken on, without its query; null when none may be read. */
  readonly pageUrl: string | null;
  /**
   * The address the facts were read from, with its query, for a condition on a parameter
   * by its name. Left out when there is none: such a condition then reads nothing.
   */
  readonly address?: string | undefined;
}

/** How a lead is named, and what its matching rules add. */
export interface LeadDecision {
  /** The lead source: the deciding rule's Source, else the built-in name. */
  readonly label: string;
  /** What `source_rule` stores: the deciding rule's public id (lsr_…), else the built-in key. */
  readonly rule: string;
  /** What the built-in rules alone call the visit. */
  readonly builtIn: LeadSource;
  /** The rule that named the lead, when one did. */
  readonly decidedBy: ActiveLeadSourceRule | undefined;
  /** Every rule that matched, in the order they are tried. */
  readonly matches: readonly ActiveLeadSourceRule[];
  /** crm.tags.id of the tags the matching rules add, each once, in rule order. */
  readonly tagIds: readonly string[];
  /** The fields the matching rules fill: the first rule that names a field fills it. */
  readonly fieldWrites: readonly { readonly fieldId: string; readonly value: string }[];
}

const VALUE_LENGTH = 200;
const ONE_LINE = /^\P{Cc}*$/u;

/**
 * A parameter of an address by its name, read as every fact of a visit is: trimmed, and
 * left out when empty, longer than 200 characters or not one line.
 */
export function addressParameter(address: string | undefined, name: string): string | null {
  if (address === undefined || !URL.canParse(address)) return null;
  const value = new URL(address).searchParams.get(name)?.trim() ?? '';
  return value !== '' && value.length <= VALUE_LENGTH && ONE_LINE.test(value) ? value : null;
}

const pageOf = (pageUrl: string | null): URL | undefined =>
  pageUrl !== null && URL.canParse(pageUrl) ? new URL(pageUrl) : undefined;

/** Present or not: a click id's value is never compared. */
const held = (...ids: readonly (string | null)[]): string | null =>
  ids.some((id) => id !== null) ? 'yes' : null;

/** The value a fact has in a visit, or null when the visit did not say it. */
export function leadFactValue(
  condition: Pick<LeadSourceCondition, 'fact' | 'name'>,
  facts: LeadFacts,
  builtIn: LeadSource,
): string | null {
  const { visit } = facts;
  const fact: LeadSourceFact = condition.fact;
  switch (fact) {
    case 'lead_source':
      return builtIn.key;
    case 'session_source':
      return sessionSourceOf(facts.medium, visit);
    case 'medium':
      return facts.medium;
    case 'utm_source':
      return visit.utmSource;
    case 'utm_medium':
      return visit.utmMedium;
    case 'utm_campaign':
      return visit.utmCampaign;
    case 'utm_content':
      return visit.utmContent;
    case 'utm_term':
      return visit.utmTerm;
    case 'match_type':
      return visit.matchType;
    case 'campaign_id':
      return visit.campaignId;
    case 'ad_group_id':
      return visit.adGroupId;
    case 'ad_id':
      return visit.adId;
    case 'click_id_google':
      return held(visit.gclid, visit.gbraid, visit.wbraid);
    case 'click_id_meta':
      return held(visit.fbclid, visit.ctwaClid);
    case 'click_id_microsoft':
      return held(visit.msclkid);
    case 'click_id_tiktok':
      return held(visit.ttclid);
    case 'click_id_linkedin':
      return held(visit.liFatId);
    case 'referrer_domain':
      return visit.referrerDomain;
    case 'landing_page':
      return visit.landingUrl;
    case 'form_page':
      return facts.pageUrl;
    case 'site':
      return pageOf(facts.pageUrl)?.host ?? null;
    case 'step':
      return pageOf(facts.pageUrl)?.pathname ?? null;
    case 'parameter':
      return condition.name === undefined ? null : addressParameter(facts.address, condition.name);
  }
}

/** Whether every condition of a rule holds. A rule with none matches nothing. */
export function ruleMatches(
  rule: Pick<ActiveLeadSourceRule, 'conditions'>,
  facts: LeadFacts,
  builtIn: LeadSource,
): boolean {
  return (
    rule.conditions.length > 0 &&
    rule.conditions.every((condition) =>
      matchesLeadSourceCondition(condition, leadFactValue(condition, facts, builtIn)),
    )
  );
}

/**
 * Names a lead: the business's rules, in the order given, then the built-in ones. Pure:
 * the same answer for the same rules and facts, for the intake and for "Check a link".
 */
export function decideLeadSource(
  rules: readonly ActiveLeadSourceRule[],
  facts: LeadFacts,
): LeadDecision {
  const builtIn = leadSourceOfVisit(facts.visit);
  const matches = rules.filter((rule) => ruleMatches(rule, facts, builtIn));
  const decidedBy = matches.find((rule) => rule.source !== null);
  const tagIds = [...new Set(matches.flatMap((rule) => rule.tagIds))];
  const fieldWrites: { fieldId: string; value: string }[] = [];
  for (const write of matches.flatMap((rule) => rule.fieldWrites)) {
    if (fieldWrites.length >= LEAD_SOURCE_RULE_LIMITS.fieldWritesPerLead) break;
    if (!fieldWrites.some((earlier) => earlier.fieldId === write.fieldId)) fieldWrites.push(write);
  }
  return {
    label: decidedBy?.source ?? builtIn.label,
    rule: decidedBy === undefined ? builtIn.key : toPublicId('lead_source_rule', decidedBy.id),
    builtIn,
    decidedBy,
    matches,
    tagIds,
    fieldWrites,
  };
}

/** What only the built-in rules say: the decision of a business that has no rule. */
export const builtInDecision = (visit: VisitFacts): LeadDecision =>
  decideLeadSource([], { medium: 'form', visit, pageUrl: null });

/**
 * The lead source a tag is named after (lead-source-tags.ts). A name a rule of the
 * business gave is treated as a name an address chose: the system makes no tag for it,
 * and uses one a person made under "Source: " and that name. The rule's own tags are how a
 * business tags such leads.
 */
export const taggedAs = (decision: LeadDecision): LeadSource =>
  decision.decidedBy === undefined
    ? decision.builtIn
    : { key: 'source_param', label: decision.label };

const storedConditions = z.array(leadSourceCondition);
const storedWrites = z.array(z.object({ fieldId: z.uuid(), value: z.string() }));

/**
 * The business's rules that are switched on, in the order they are tried: the ONE read a
 * lead's intake makes for them, by the index (business_id, position), of at most 50 rows.
 * A rule whose stored conditions this release cannot read is left out, so it matches
 * nothing rather than everything.
 */
export async function readActiveLeadSourceRules(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<readonly ActiveLeadSourceRule[]> {
  const rows = await trx
    .selectFrom('crm.lead_source_rules')
    .select(['id', 'position', 'name', 'conditions', 'source_label', 'tag_ids', 'field_writes'])
    .where('business_id', '=', businessId)
    .where('enabled', '=', true)
    .orderBy('position')
    .limit(LEAD_SOURCE_RULE_LIMITS.rules)
    .execute();
  return rows.flatMap((row) => {
    const conditions = storedConditions.safeParse(row.conditions);
    const writes = storedWrites.safeParse(row.field_writes);
    if (!conditions.success || !writes.success) return [];
    return [
      {
        id: row.id,
        position: row.position,
        name: row.name,
        conditions: conditions.data,
        source: row.source_label,
        tagIds: row.tag_ids,
        fieldWrites: writes.data,
      },
    ];
  });
}

/** Reads the business's rules and names a lead by them: one statement, then memory. */
export async function decideLeadSourceFor(
  trx: DatabaseTransaction,
  businessId: string,
  facts: LeadFacts,
): Promise<LeadDecision> {
  return decideLeadSource(await readActiveLeadSourceRules(trx, businessId), facts);
}
