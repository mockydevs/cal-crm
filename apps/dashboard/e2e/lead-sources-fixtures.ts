// A business's lead source rules as the API holds them, for the component tests and the
// browser spec of Settings → Lead Sources: every write is parsed by the contract's own
// schema, every answer is typed by the contract's own types, and "Check a link" answers as
// the server does for these rules (the built-in name for a few kinds of link, then the
// business's rules in their order, by the contract's own comparison). Nothing here imports
// the dashboard's code, so a test never checks the page against itself.
import {
  createLeadSourceRuleInput,
  LEAD_SOURCE_RULE_LIMITS,
  leadSourceLabels,
  leadSourceRuleDescriptions,
  matchesLeadSourceCondition,
  previewLeadSourceInput,
  reorderLeadSourceRulesInput,
  updateLeadSourceRuleInput,
  type FieldConfiguration,
  type LeadSourceCondition,
  type LeadSourceKey,
  type LeadSourcePreview,
  type LeadSourceRule,
  type LeadSourceRuleList,
  type PreviewLeadSourceInput,
  type TagConfiguration,
} from '@repo/contracts';

export const at = '2026-10-14T09:00:00.000Z';
export const ruleId = (number: number): string =>
  `lsr_01k8e2wzr0e00800000000${String(number).padStart(4, '0')}`;
export const tagId = (number: number): string =>
  `tag_01k8e2wzr0e00800000000${String(number).padStart(4, '0')}`;
export const fieldId = (number: number): string =>
  `fld_01k8e2wzr0e00800000000${String(number).padStart(4, '0')}`;
export const formId = 'form_01k8e2wzr0e008000000000001';

const tagOf = (number: number, name: string): TagConfiguration['items'][number] => ({
  id: tagId(number),
  name,
  description: '',
  createdAt: at,
  updatedAt: at,
  groupId: null,
  revision: 'a'.repeat(64),
});
export const tags: TagConfiguration = {
  items: [tagOf(1, 'Promo'), tagOf(2, 'VIP'), tagOf(3, 'Wedding enquiry'), tagOf(4, 'Newsletter')],
  groups: [],
  rules: { creation: 'everyone', suggestSimilar: true, revision: 'a'.repeat(64) },
  canManage: true,
  canCreate: true,
};

const fieldOf = (
  number: number,
  label: string,
  {
    valueType = 'text',
    archived = false,
    objectKey = 'contact',
  }: {
    valueType?: FieldConfiguration['items'][number]['valueType'];
    archived?: boolean;
    objectKey?: string;
  } = {},
): FieldConfiguration['items'][number] => ({
  id: fieldId(number),
  objectKey,
  key: label.toLowerCase().replace(/\s+/g, '_'),
  label,
  description: `${label}.`,
  options: [],
  aiFillSources: [],
  aiOverwrite: 'ask',
  archived,
  valueType,
  currency: null,
  revision: 'a'.repeat(64),
});
/** Two text fields of contacts a rule may fill, and three it may not. */
export const fields: FieldConfiguration = {
  items: [
    fieldOf(1, 'Campaign'),
    fieldOf(2, 'Promo code', { valueType: 'long_text' }),
    fieldOf(3, 'Budget', { valueType: 'number' }),
    fieldOf(4, 'Old note', { archived: true }),
    fieldOf(5, 'Deal note', { objectKey: 'deal' }),
  ],
  objects: [
    { key: 'contact', label: 'Contact' },
    { key: 'deal', label: 'Opportunity' },
  ],
  canManage: true,
};

export const ruleOf = (number: number, patch: Partial<LeadSourceRule> = {}): LeadSourceRule => ({
  id: ruleId(number),
  position: number,
  name: `Rule ${String(number)}`,
  enabled: true,
  conditions: [{ fact: 'utm_campaign', op: 'contains', value: `campaign-${String(number)}` }],
  source: `Source ${String(number)}`,
  tagIds: [],
  fieldWrites: [],
  problems: [],
  revision: 1,
  createdAt: at,
  updatedAt: at,
  ...patch,
});

/** Two rules a business might have: one names a Source and tags, one only tags a funnel. */
export const springRule = (): LeadSourceRule =>
  ruleOf(1, {
    name: 'Spring promo',
    conditions: [
      { fact: 'utm_campaign', op: 'contains', value: 'spring' },
      { fact: 'lead_source', op: 'is', value: 'facebook_ads' },
    ],
    source: 'Spring promo',
    tagIds: [tagId(1), tagId(2)],
  });
export const funnelRule = (): LeadSourceRule =>
  ruleOf(2, {
    name: 'Wedding funnel',
    conditions: [{ fact: 'step', op: 'starts_with', value: '/wedding' }],
    source: null,
    tagIds: [tagId(3)],
    fieldWrites: [{ fieldId: fieldId(1), value: 'wedding' }],
  });

export interface LeadSourcesWorld {
  rules: LeadSourceRule[];
  canManage: boolean;
  /** Counts every change to the list: its revision is made of it. */
  changes: number;
  /** The next rule's number. */
  next: number;
  /** Every write, in order, as the schema parsed it. */
  writes: { readonly operation: string; readonly body: unknown }[];
  checked: PreviewLeadSourceInput[];
}

export const worldOf = (
  rules: LeadSourceRule[] = [],
  rest: Partial<LeadSourcesWorld> = {},
): LeadSourcesWorld => ({
  rules: rules.map((rule, index) => ({ ...rule, position: index + 1 })),
  canManage: true,
  changes: 0,
  next: 100,
  writes: [],
  checked: [],
  ...rest,
});

const listRevision = (world: LeadSourcesWorld): string =>
  world.changes.toString(16).padStart(64, '0');

export const listOf = (world: LeadSourcesWorld): LeadSourceRuleList => ({
  items: world.rules,
  revision: listRevision(world),
  limit: LEAD_SOURCE_RULE_LIMITS.rules,
  canManage: world.canManage,
});

/** What a refusal says, as the API's problem details do. */
export interface Refusal {
  readonly status: number;
  readonly detail: string;
  readonly errors?: { readonly path: string; readonly message: string; readonly code: string }[];
}
export const isRefusal = (answer: unknown): answer is Refusal =>
  typeof answer === 'object' && answer !== null && 'status' in answer && 'detail' in answer;

const renumber = (world: LeadSourcesWorld): void => {
  world.rules = world.rules.map((rule, index) => ({ ...rule, position: index + 1 }));
  world.changes += 1;
};

// The fixture's own refusal of a field, to show where the page puts one: the server may
// well allow two rules of one name.
const NAME_TAKEN: Refusal = {
  status: 422,
  detail: 'The rule was refused.',
  errors: [{ path: '/name', message: 'Another rule already has this name.', code: 'name_taken' }],
};
const nameTaken = (world: LeadSourcesWorld, name: string, but: string | undefined): boolean =>
  world.rules.some((rule) => rule.id !== but && rule.name.toLowerCase() === name.toLowerCase());

export function createRule(world: LeadSourcesWorld, sent: unknown): LeadSourceRule | Refusal {
  const body = createLeadSourceRuleInput.parse(sent);
  world.writes.push({ operation: 'createLeadSourceRule', body });
  if (world.rules.length >= LEAD_SOURCE_RULE_LIMITS.rules)
    return {
      status: 422,
      detail: 'A business has at most 50 lead source rules.',
      errors: [
        {
          path: '',
          message: 'A business has at most 50 lead source rules.',
          code: 'limit_reached',
        },
      ],
    };
  if (nameTaken(world, body.name, undefined)) return NAME_TAKEN;
  const made = ruleOf(world.next, { ...body, position: world.rules.length + 1 });
  world.next += 1;
  world.rules = [...world.rules, made];
  renumber(world);
  return made;
}

export function updateRule(
  world: LeadSourcesWorld,
  id: string,
  sent: unknown,
): LeadSourceRule | Refusal {
  const { revision, ...body } = updateLeadSourceRuleInput.parse(sent);
  world.writes.push({ operation: 'updateLeadSourceRule', body: { revision, ...body } });
  const stored = world.rules.find((rule) => rule.id === id);
  if (stored === undefined) return { status: 404, detail: 'No such rule.' };
  if (stored.revision !== revision)
    return { status: 409, detail: 'Someone else changed this rule. Reload it and try again.' };
  if (nameTaken(world, body.name, id)) return NAME_TAKEN;
  const saved = { ...stored, ...body, revision: revision + 1 };
  world.rules = world.rules.map((rule) => (rule.id === id ? saved : rule));
  world.changes += 1;
  return saved;
}

export function reorderRules(world: LeadSourcesWorld, sent: unknown): LeadSourceRuleList | Refusal {
  const body = reorderLeadSourceRulesInput.parse(sent);
  world.writes.push({ operation: 'reorderLeadSourceRules', body });
  if (body.revision !== listRevision(world))
    return { status: 409, detail: 'The rules changed since they were read.' };
  world.rules = body.ruleIds.flatMap((id) => world.rules.filter((rule) => rule.id === id));
  renumber(world);
  return listOf(world);
}

export function deleteRule(world: LeadSourcesWorld, id: string): void {
  world.writes.push({ operation: 'deleteLeadSourceRule', body: { ruleId: id } });
  world.rules = world.rules.filter((rule) => rule.id !== id);
  renumber(world);
}

const PAID = /^(.*cp.*|ppc|retargeting|paid.*)$/;

/** The built-in rule for the few kinds of link the tests follow. */
function builtInOf(query: URLSearchParams): { key: LeadSourceKey; source: string } {
  type Named = Exclude<LeadSourceKey, 'source_param'>;
  const named = query.get('source');
  if (named !== null && named.trim() !== '') return { key: 'source_param', source: named.trim() };
  const source = (query.get('utm_source') ?? '').toLowerCase();
  const paid = PAID.test((query.get('utm_medium') ?? '').toLowerCase());
  const key: Named =
    query.has('gclid') || (source === 'google' && paid)
      ? 'google_ads'
      : query.has('msclkid') || (source === 'bing' && paid)
        ? 'microsoft_ads'
        : (source === 'facebook' || source === 'fb' || source === 'fb_ad') &&
            (paid || source === 'fb_ad')
          ? 'facebook_ads'
          : source === 'ig' && paid
            ? 'instagram_ads'
            : source === 'tiktok' && paid
              ? 'tiktok_ads'
              : source === 'linkedin' && paid
                ? 'linkedin_ads'
                : (query.get('utm_medium') ?? '').toLowerCase() === 'email'
                  ? 'email'
                  : query.has('fbclid')
                    ? 'facebook'
                    : source !== '' || query.has('utm_campaign')
                      ? 'other'
                      : 'direct';
  return { key, source: leadSourceLabels[key] };
}

const sessionSourceOf = (key: LeadSourceKey): LeadSourcePreview['sessionSource'] =>
  key === 'google_ads' || key === 'microsoft_ads'
    ? 'paid_search'
    : key.endsWith('_ads')
      ? 'paid_social'
      : key === 'facebook'
        ? 'social_media'
        : key === 'direct'
          ? 'direct'
          : 'others';

const CLICK_IDS = [
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'ctwa_clid',
  'msclkid',
  'ttclid',
  'li_fat_id',
] as const;
const platformIds = {
  click_id_google: ['gclid', 'gbraid', 'wbraid'],
  click_id_meta: ['fbclid', 'ctwa_clid'],
  click_id_microsoft: ['msclkid'],
  click_id_tiktok: ['ttclid'],
  click_id_linkedin: ['li_fat_id'],
} as const;

/** "Check a link", answered for the world's rules as the server answers it. */
export function previewOf(world: LeadSourcesWorld, sent: unknown): LeadSourcePreview {
  const asked = previewLeadSourceInput.parse(sent);
  world.checked.push(asked);
  const url = new URL(asked.url);
  const query = url.searchParams;
  const page = `${url.origin}${url.pathname}`;
  const builtIn = builtInOf(query);
  const sessionSource = sessionSourceOf(builtIn.key);
  const referrerDomain = asked.referrer === undefined ? null : new URL(asked.referrer).host;
  const facts = {
    utmSource: query.get('utm_source'),
    utmMedium: query.get('utm_medium'),
    utmCampaign: query.get('utm_campaign'),
    utmContent: query.get('utm_content'),
    utmTerm: query.get('utm_term'),
    matchType: query.get('matchtype'),
    campaignId: query.get('campaign_id'),
    adGroupId: query.get('ad_group_id') ?? query.get('adgroup_id') ?? query.get('adset_id'),
    adId: query.get('ad_id'),
    referrerDomain,
    landingUrl: page,
  };
  const clickIds = CLICK_IDS.filter((name) => query.has(name));
  const valueOf = (condition: LeadSourceCondition): string | null => {
    switch (condition.fact) {
      case 'lead_source':
        return builtIn.key;
      case 'session_source':
        return sessionSource;
      case 'medium':
        return 'form';
      case 'utm_source':
        return facts.utmSource;
      case 'utm_medium':
        return facts.utmMedium;
      case 'utm_campaign':
        return facts.utmCampaign;
      case 'utm_content':
        return facts.utmContent;
      case 'utm_term':
        return facts.utmTerm;
      case 'match_type':
        return facts.matchType;
      case 'campaign_id':
        return facts.campaignId;
      case 'ad_group_id':
        return facts.adGroupId;
      case 'ad_id':
        return facts.adId;
      case 'referrer_domain':
        return referrerDomain;
      case 'landing_page':
      case 'form_page':
        return page;
      case 'site':
        return url.host;
      case 'step':
        return url.pathname;
      case 'parameter':
        return query.get(condition.name ?? '');
      case 'click_id_google':
      case 'click_id_meta':
      case 'click_id_microsoft':
      case 'click_id_tiktok':
      case 'click_id_linkedin':
        return platformIds[condition.fact].some((name) => query.has(name)) ? 'yes' : null;
    }
  };
  const matching = world.rules.filter(
    (rule) =>
      rule.enabled &&
      rule.conditions.every((condition) =>
        matchesLeadSourceCondition(condition, valueOf(condition)),
      ),
  );
  const decider = matching.find((rule) => rule.source !== null);
  const filled = new Set<string>();
  const rules = matching.map((rule) => ({
    id: rule.id,
    name: rule.name,
    position: rule.position,
    source: rule.source,
    decidesSource: rule.id === decider?.id,
    tags: rule.tagIds.map((id) => ({
      id,
      name: tags.items.find((tag) => tag.id === id)?.name ?? null,
    })),
    fieldWrites: rule.fieldWrites.map((write) => {
      const applies = !filled.has(write.fieldId);
      filled.add(write.fieldId);
      return {
        fieldId: write.fieldId,
        label: fields.items.find((field) => field.id === write.fieldId)?.label ?? null,
        value: write.value,
        applies,
      };
    }),
  }));
  const source = decider?.source ?? builtIn.source;
  const untracked = builtIn.key === 'direct' && referrerDomain === null;
  return {
    sessionSource,
    source,
    sourceRule: builtIn.key,
    reason:
      decider === undefined
        ? leadSourceRuleDescriptions[builtIn.key]
        : `Your rule “${decider.name}” names the Source.`,
    decidedBy:
      decider === undefined
        ? { kind: 'built_in', key: builtIn.key }
        : { kind: 'rule', ruleId: decider.id, name: decider.name },
    builtIn: { source: builtIn.source, sourceRule: builtIn.key },
    rules,
    facts,
    clickIds,
    form:
      asked.formId === undefined
        ? null
        : {
            id: asked.formId,
            contactSource: source,
            tags: [
              { name: 'Wedding enquiry', kind: 'form', exists: true },
              ...(builtIn.key === 'source_param'
                ? []
                : [{ name: `Source: ${builtIn.source}`, kind: 'source' as const, exists: false }]),
              ...rules.flatMap((rule) =>
                rule.tags.flatMap((tag) =>
                  tag.name === null
                    ? []
                    : [{ name: tag.name, kind: 'rule' as const, exists: true }],
                ),
              ),
            ],
          },
    warnings: [
      ...(untracked
        ? [
            {
              code: 'no_tracking' as const,
              message: 'This link has no parameters and no click id: it would read as Direct.',
            },
          ]
        : []),
      ...(builtIn.key === 'facebook'
        ? [
            {
              code: 'click_id_only' as const,
              message:
                'Only a Facebook click id is known: a paid click cannot be told from a post’s.',
            },
          ]
        : []),
    ],
  };
}
