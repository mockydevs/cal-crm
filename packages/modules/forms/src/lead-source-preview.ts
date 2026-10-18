// "Check a link": what a lead arriving by an address would be. The address is read exactly
// as a submission's page is, by the CRM module's own rules (the business's rules first,
// then the built-in ones: the same function a submission is named by), and nothing is
// stored. The business's rules that match are listed, in their order, with what each would
// do. With a form, its saved draft says what Source and which tags such a lead would get.
// Anyone in the business may ask, as anyone may read a form.
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  LEAD_SOURCE_LIMITS,
  leadSourceRuleDescriptions,
  leadSourceTagName,
  type ClickIdName,
  type LeadSourcePreview,
  type PreviewLeadSourceInput,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import {
  decideLeadSource,
  findLeadSourceTag,
  readActiveLeadSourceRules,
  readTagNames,
  readVisit,
  sessionSourceOf,
  taggedAs,
  type ActiveLeadSourceRule,
  type LeadDecision,
  type LeadSource,
  type VisitFacts,
} from '@repo/module-crm';

import { EMPTY_FORM_DEFINITION, storedDefinition } from './definition.js';
import { sourceOf, tagsOf } from './public.js';

type Warning = LeadSourcePreview['warnings'][number];

const CLICK_IDS: readonly (readonly [ClickIdName, keyof VisitFacts])[] = [
  ['gclid', 'gclid'],
  ['gbraid', 'gbraid'],
  ['wbraid', 'wbraid'],
  ['fbclid', 'fbclid'],
  ['msclkid', 'msclkid'],
  ['ctwa_clid', 'ctwaClid'],
  ['ttclid', 'ttclid'],
  ['li_fat_id', 'liFatId'],
];

/** The click ids that prove no payment by themselves (lead-source.ts). */
const UNPROVEN: ReadonlySet<LeadSource['key']> = new Set(['facebook', 'tiktok', 'linkedin']);

/**
 * What the address says, by the rules given (the business's, in their order) and then the
 * built-in ones: no database. The names of the tags and fields the rules add are not
 * known here and are left null; readLeadSourcePreview fills them in.
 */
export function previewVisit(
  input: Pick<PreviewLeadSourceInput, 'url' | 'referrer'>,
  rules: readonly ActiveLeadSourceRule[] = [],
): {
  readonly visit: VisitFacts;
  readonly decision: LeadDecision;
  /** The answer for an address alone: no form is named in it. */
  readonly preview: LeadSourcePreview;
} {
  const visit = readVisit({ pageUrl: input.url, referrer: input.referrer });
  // A link is checked as a form would take it, on the page the link leads to.
  const decision = decideLeadSource(rules, {
    medium: 'form',
    visit,
    pageUrl: visit.landingUrl,
    address: input.url,
  });
  const lead = decision.builtIn;
  const decider = decision.decidedBy;
  const written = new Set<string>();
  const clickIds = CLICK_IDS.flatMap(([name, fact]) => (visit[fact] === null ? [] : [name]));
  const warnings: Warning[] = [];
  // A warning is about what the built-in rules could tell. A rule of the business that
  // names the lead has answered it.
  if (decider === undefined && lead.key === 'direct')
    warnings.push({
      code: 'no_tracking',
      message:
        'This link has no parameters and no click ID, and no site they came from is known: it would read as Direct. Add utm_source and utm_medium to the ad’s link.',
    });
  if (decider === undefined && lead.key === 'source_param')
    warnings.push({
      code: 'source_param',
      message:
        'The link names its own source (source=…), which is used as written and comes before every rule.',
    });
  if (decider === undefined && UNPROVEN.has(lead.key) && clickIds.length > 0)
    warnings.push({
      code: 'click_id_only',
      message:
        'The link carries a click ID and nothing that says the click was paid for, so it is not counted as an ad. Add utm_medium=paid_social (or cpc) to the ad’s link.',
    });
  return {
    visit,
    decision,
    preview: {
      sessionSource: sessionSourceOf('form', visit),
      source: decision.label,
      sourceRule: lead.key,
      reason:
        decider === undefined
          ? leadSourceRuleDescriptions[lead.key]
          : `Your rule “${decider.name}” names this lead. Without it, it would be “${lead.label}”.`,
      decidedBy:
        decider === undefined
          ? { kind: 'built_in', key: lead.key }
          : {
              kind: 'rule',
              ruleId: toPublicId('lead_source_rule', decider.id),
              name: decider.name,
            },
      builtIn: { source: lead.label, sourceRule: lead.key },
      rules: decision.matches.map((rule) => ({
        id: toPublicId('lead_source_rule', rule.id),
        name: rule.name,
        position: rule.position,
        source: rule.source,
        decidesSource: rule.id === decider?.id,
        tags: rule.tagIds.map((id) => ({ id: toPublicId('tag', id), name: null })),
        fieldWrites: rule.fieldWrites.map((write) => {
          // The first matching rule that names a field fills it.
          const applies = !written.has(write.fieldId);
          written.add(write.fieldId);
          return {
            fieldId: toPublicId('field', write.fieldId),
            label: null,
            value: write.value,
            applies,
          };
        }),
      })),
      facts: {
        utmSource: visit.utmSource,
        utmMedium: visit.utmMedium,
        utmCampaign: visit.utmCampaign,
        utmContent: visit.utmContent,
        utmTerm: visit.utmTerm,
        matchType: visit.matchType,
        campaignId: visit.campaignId,
        adGroupId: visit.adGroupId,
        adId: visit.adId,
        referrerDomain: visit.referrerDomain,
        landingUrl: visit.landingUrl,
      },
      clickIds,
      form: null,
      warnings,
    },
  };
}

/** The preview, with what the named form's saved draft would do with such a lead. */
export async function readLeadSourcePreview(
  trx: DatabaseTransaction,
  invocation: Invocation,
  input: PreviewLeadSourceInput,
): Promise<LeadSourcePreview> {
  const businessId = requireBusiness(invocation.context);
  const rules = await readActiveLeadSourceRules(trx, businessId);
  const { decision, preview: bare } = previewVisit(input, rules);
  // What the matching rules name, as people call it: a tag deleted or a field archived
  // since the rule was saved stays null, and is skipped by a submission too.
  const ruleTags = await readTagNames(trx, businessId, decision.tagIds);
  const fieldIds = decision.matches.flatMap((rule) => rule.fieldWrites.map((w) => w.fieldId));
  const fields =
    fieldIds.length === 0
      ? []
      : await trx
          .selectFrom('crm.field_definitions')
          .select(['id', 'label'])
          .where('business_id', '=', businessId)
          .where('id', 'in', fieldIds)
          .where('archived_at', 'is', null)
          .execute();
  const fieldLabels = new Map(fields.map((field) => [toPublicId('field', field.id), field.label]));
  const tagNames = new Map(
    [...ruleTags].map(([id, name]) => [toPublicId('tag', id), name] as const),
  );
  const preview: LeadSourcePreview = {
    ...bare,
    rules: (bare.rules ?? []).map((rule) => ({
      ...rule,
      tags: rule.tags.map((tag) => ({ ...tag, name: tagNames.get(tag.id) ?? null })),
      fieldWrites: rule.fieldWrites.map((write) => ({
        ...write,
        label: fieldLabels.get(write.fieldId) ?? null,
      })),
    })),
  };
  const lead = taggedAs(decision);
  if (input.formId === undefined) return preview;
  const id = parsePublicId('form', input.formId);
  const row =
    id === undefined
      ? undefined
      : await trx
          .selectFrom('forms.forms')
          .select(['name', 'definition'])
          .where('business_id', '=', businessId)
          .where('id', '=', id)
          .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Form', input.formId);
  // A draft the builder did not write gives a lead nothing, as it would serve nothing.
  const definition = storedDefinition(row.definition) ?? EMPTY_FORM_DEFINITION;
  const adds = tagsOf(definition);
  const ids = adds.tagIds.flatMap((tagId) => parsePublicId('tag', tagId) ?? []);
  const names = await readTagNames(trx, businessId, ids);
  const tags: NonNullable<LeadSourcePreview['form']>['tags'][number][] = ids.flatMap((tagId) => {
    const name = names.get(tagId);
    // A tag deleted since the form was saved is skipped by a submission too.
    return name === undefined ? [] : [{ name, kind: 'form' as const, exists: true }];
  });
  const warnings = [...preview.warnings];
  // The order a submission adds them in: the form's own, the lead source's, then the rules'
  // for as many as are left of the ten.
  const ruleRoom =
    LEAD_SOURCE_LIMITS.tagsPerSubmission - adds.tagIds.length - (adds.bySource ? 1 : 0);
  const fromRules = decision.tagIds.slice(0, Math.max(0, ruleRoom)).flatMap((tagId) => {
    const name = ruleTags.get(tagId);
    return name === undefined || tags.some((tag) => tag.name === name)
      ? []
      : [{ name, kind: 'rule' as const, exists: true }];
  });
  if (definition.contactActions?.tagBySource === true) {
    if (!adds.bySource)
      warnings.push({
        code: 'too_many_tags',
        message: `The form already adds ${String(LEAD_SOURCE_LIMITS.tagsPerSubmission)} tags, which is the most one submission adds: the lead source’s tag would not be added.`,
      });
    else {
      const existing = await findLeadSourceTag(trx, businessId, lead);
      const name = existing?.name ?? leadSourceTagName(lead.label);
      // The system makes the tag of a built-in lead source; a name the link chose gets one
      // only when someone has made it.
      if (name !== undefined && (existing !== undefined || lead.key !== 'source_param'))
        tags.push({ name, kind: 'source', exists: existing !== undefined });
      else
        warnings.push({
          code: 'no_tag',
          message:
            'No tag would be added for this source: the link chose the name, and tags for such names are only used when someone has made them (“Source: ” and the name, at most 60 characters).',
        });
    }
  }
  return {
    ...preview,
    warnings,
    form: {
      id: input.formId,
      contactSource: sourceOf({ name: row.name, definition }, decision) ?? null,
      tags: [...tags, ...fromRules],
    },
  };
}
