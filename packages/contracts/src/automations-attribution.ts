// What a workflow can read of where a contact came from (AUTOMATIONS.md section 3): the
// contact's first and latest touch, and the touch that came with the event that started the
// run. One table of leaves, so the validator, the engine and the builder name the same
// paths with the same kinds.
//
//   contact.attribution.first.<leaf>    the touch that never changes
//   contact.attribution.latest.<leaf>   the newest touch, which moves with each new one
//   trigger.attribution.<leaf>          the touch of the form submission or the booking that
//                                       started this run: the same for the life of the run
//
// A click id is never a value here: only whether the touch holds one.
import type { AttributionMedium, SessionSource } from './reporting-attribution.js';

/** The kinds a leaf can have: each is one of the validator's field types. */
export type AttributionLeafType = 'text' | 'single_choice' | 'boolean' | 'datetime';

export interface AttributionLeaf {
  readonly key: string;
  readonly type: AttributionLeafType;
  /** The choices of a leaf that has them, by key, each with what people read. */
  readonly options: readonly { readonly key: string; readonly label: string }[];
}

// The session sources and the mediums, with what people read. The keys are those of
// reporting-attribution.ts, held to it by type here and by a test: written out so that a
// page that only validates a document does not carry that file's endpoints with it.
const SESSION_SOURCES = {
  paid_search: 'Paid search',
  paid_social: 'Paid social',
  social_media: 'Social media',
  organic_search: 'Organic search',
  referral: 'Referral',
  direct: 'Direct traffic',
  others: 'Others',
  crm_ui: 'Added by hand',
  third_party: 'Third party',
} as const satisfies Readonly<Record<SessionSource, string>>;

const MEDIUMS = {
  form: 'Form',
  calendar: 'Calendar',
  chat: 'Chat',
  manual: 'Added by hand',
  api: 'API',
  import: 'Import',
  message: 'Message',
  automation: 'Workflow',
  assistant: 'Assistant',
  unknown: 'Unknown',
} as const satisfies Readonly<Record<AttributionMedium, string>>;

/** The session sources a trigger's filter may list, in the order a list shows them. */
export const arrivalSessionSources = Object.keys(SESSION_SOURCES) as [
  SessionSource,
  ...SessionSource[],
];

const optionsOf = (names: Readonly<Record<string, string>>) =>
  Object.entries(names).map(([key, label]) => ({ key, label }));

// Each keeps its own key in its type, so a table by leaf can be checked to hold them all.
const leaf = <Key extends string>(
  key: Key,
  type: AttributionLeafType,
  options: AttributionLeaf['options'] = [],
) => ({ key, type, options }) satisfies AttributionLeaf;

/** Every leaf, in the order a list shows them. */
export const attributionLeaves = [
  leaf('source', 'text'),
  leaf('sourceKey', 'text'),
  leaf('sessionSource', 'single_choice', optionsOf(SESSION_SOURCES)),
  leaf('medium', 'single_choice', optionsOf(MEDIUMS)),
  leaf('utmSource', 'text'),
  leaf('utmMedium', 'text'),
  leaf('utmCampaign', 'text'),
  leaf('utmContent', 'text'),
  leaf('utmTerm', 'text'),
  leaf('matchType', 'text'),
  leaf('campaignId', 'text'),
  leaf('adGroupId', 'text'),
  leaf('adId', 'text'),
  leaf('referrerDomain', 'text'),
  leaf('landingPage', 'text'),
  leaf('page', 'text'),
  leaf('touchedAt', 'datetime'),
  leaf('hasGoogleClickId', 'boolean'),
  leaf('hasMetaClickId', 'boolean'),
  leaf('hasMicrosoftClickId', 'boolean'),
  leaf('hasTikTokClickId', 'boolean'),
  leaf('hasLinkedInClickId', 'boolean'),
] as const satisfies readonly AttributionLeaf[];

export type AttributionLeafKey = (typeof attributionLeaves)[number]['key'];

/**
 * What each leaf is called and holds, for the published catalog. Apart from the table
 * above, which every check of a document reads: only what lists the leaves reads these.
 */
export const attributionLeafWords: Readonly<
  Record<AttributionLeafKey, { readonly label: string; readonly description: string }>
> = {
  source: {
    label: 'Lead source',
    description:
      'The lead source worked out for the touch, as people read it, such as Google Ads (lead-sources.ts lists the built-in names). Empty for a touch that was not a visit, such as a contact added by hand.',
  },
  sourceKey: {
    label: 'Lead source rule',
    description:
      'The rule that decided the lead source: a built-in rule by its key, such as google_ads, which stays the same if the name is ever reworded.',
  },
  sessionSource: {
    label: 'Session source',
    description: 'The channel the visit came through, such as paid_search.',
  },
  medium: {
    label: 'Medium',
    description: 'The kind of interaction that recorded the touch, such as form.',
  },
  utmSource: { label: 'UTM source', description: 'utm_source of the page the visitor arrived on.' },
  utmMedium: { label: 'UTM medium', description: 'utm_medium of the page the visitor arrived on.' },
  utmCampaign: {
    label: 'UTM campaign',
    description: 'utm_campaign of the page the visitor arrived on.',
  },
  utmContent: {
    label: 'UTM content',
    description: 'utm_content of the page the visitor arrived on.',
  },
  utmTerm: {
    label: 'UTM term',
    description: 'utm_term (or utm_keyword) of the page the visitor arrived on.',
  },
  matchType: { label: 'Match type', description: 'The keyword match type an ad link carried.' },
  campaignId: { label: 'Campaign ID', description: 'The campaign id an ad link carried.' },
  adGroupId: {
    label: 'Ad group ID',
    description: 'The ad group (or ad set) id an ad link carried.',
  },
  adId: { label: 'Ad ID', description: 'The ad id an ad link carried.' },
  referrerDomain: {
    label: 'Referrer domain',
    description: 'The host of the site the visitor came from.',
  },
  landingPage: {
    label: 'Landing page',
    description: 'The page the visitor arrived on, without its query.',
  },
  page: {
    label: 'Page',
    description: 'The page the form was sent from or the booking was made on, without its query.',
  },
  touchedAt: { label: 'Date', description: 'When the touch was recorded.' },
  hasGoogleClickId: {
    label: 'Has a Google click ID',
    description:
      'Whether the touch holds a Google Ads click id (gclid, gbraid or wbraid). The id itself is never given.',
  },
  hasMetaClickId: {
    label: 'Has a Meta click ID',
    description:
      'Whether the touch holds a Facebook or Instagram click id (fbclid, or a click-to-WhatsApp id). The id itself is never given.',
  },
  hasMicrosoftClickId: {
    label: 'Has a Microsoft click ID',
    description:
      'Whether the touch holds a Microsoft Advertising click id (msclkid). The id itself is never given.',
  },
  hasTikTokClickId: {
    label: 'Has a TikTok click ID',
    description:
      'Whether the touch holds a TikTok click id (ttclid). The id itself is never given.',
  },
  hasLinkedInClickId: {
    label: 'Has a LinkedIn click ID',
    description:
      'Whether the touch holds a LinkedIn click id (li_fat_id). The id itself is never given.',
  },
};

/** Which touch a path reads. */
export const attributionScopes = ['first', 'latest', 'trigger'] as const;
export type AttributionScope = (typeof attributionScopes)[number];

const PREFIXES: Readonly<Record<AttributionScope, string>> = {
  first: 'contact.attribution.first',
  latest: 'contact.attribution.latest',
  trigger: 'trigger.attribution',
};

/** The path of a leaf of a touch, such as trigger.attribution.source. */
export const attributionPath = (scope: AttributionScope, leaf: AttributionLeafKey): string =>
  `${PREFIXES[scope]}.${leaf}`;

/** Every path a document may read attribution by. */
export const attributionPaths: readonly string[] = attributionScopes.flatMap((scope) =>
  attributionLeaves.map((leaf) => attributionPath(scope, leaf.key)),
);

/** Whether a path is written as one that reads attribution, whatever leaf it names. */
export const isAttributionPath = (path: string): boolean =>
  attributionScopes.some((scope) => path.startsWith(`${PREFIXES[scope]}.`));

/** The touch and the leaf a path reads, or nothing for a path that reads no attribution. */
export function attributionLeafAt(
  path: string,
): { readonly scope: AttributionScope; readonly leaf: AttributionLeaf } | undefined {
  for (const scope of attributionScopes) {
    const prefix = `${PREFIXES[scope]}.`;
    if (!path.startsWith(prefix)) continue;
    const key = path.slice(prefix.length);
    const leaf = attributionLeaves.find((each) => each.key === key);
    return leaf === undefined ? undefined : { scope, leaf };
  }
  return undefined;
}

/**
 * The triggers whose event comes with a touch of its own: a form submission and a booking
 * each record one, so a run they start can read trigger.attribution.*. A run anything else
 * starts reads every such path as empty.
 */
export const attributionTriggers = ['form.submitted', 'appointment.booked'] as const;

/** The most lead sources a trigger's filter may list. */
export const MAX_TRIGGER_SOURCES = 20;

/** How an opportunity step takes its source from how the lead arrived. */
export const DEAL_SOURCE_ARRIVAL = 'arrival';
