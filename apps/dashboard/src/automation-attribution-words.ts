// How a workflow's cards say where a lead came from (docs/AUTOMATIONS.md section 3): a path
// such as trigger.attribution.source as "lead source", a session source by its name, the
// lead sources a trigger starts for, and where an opportunity step takes its source from.
// Kept small and apart from the lists a person chooses from (automation-attribution.ts):
// every card reads these, and only the panels read those.
//
// Its words are in the catalog every page has: a card that names a lead source is shown
// wherever a step's summary is, also outside the builder.
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { attributionLeafAt, type AttributionLeafKey, type AttributionScope } from '@repo/contracts';

/** What each leaf is called where one is chosen. */
export const leafNames: Readonly<Record<AttributionLeafKey, MessageDescriptor>> = {
  source: msg`Lead source`,
  sourceKey: msg`Lead source rule`,
  sessionSource: msg`Session source`,
  medium: msg`Medium`,
  utmSource: msg`UTM source`,
  utmMedium: msg`UTM medium`,
  utmCampaign: msg`UTM campaign`,
  utmContent: msg`UTM content`,
  utmTerm: msg`UTM term`,
  matchType: msg`Match type`,
  campaignId: msg`Campaign ID`,
  adGroupId: msg`Ad group ID`,
  adId: msg`Ad ID`,
  referrerDomain: msg`Referrer domain`,
  landingPage: msg`Landing page`,
  page: msg`Page of the form or booking`,
  touchedAt: msg`Date`,
  hasGoogleClickId: msg`Has a Google click ID`,
  hasMetaClickId: msg`Has a Meta click ID`,
  hasMicrosoftClickId: msg`Has a Microsoft click ID`,
  hasTikTokClickId: msg`Has a TikTok click ID`,
  hasLinkedInClickId: msg`Has a LinkedIn click ID`,
};

/** What the settings that read the arrival are called in a trigger's and a step's panel. */
export const arrivalSettings = {
  sources: msg`Lead source is any of`,
  sourcesHint: msg`Tick none to start for every lead. A lead source is worked out from how the lead arrived: the ad or the site they came from.`,
  sessionSources: msg`Session source is any of`,
  sessionSourcesHint: msg`Tick none for any. The session source is the channel: paid search, organic search, a referral and so on.`,
  dealSource: msg`Opportunity source`,
  dealSourceHint: msg`From how they arrived: the lead source of the form or booking that started this workflow, or else the contact's Source.`,
} as const;

/** The heading each touch's fields are listed under. */
export const scopeHeadings: Readonly<Record<AttributionScope, MessageDescriptor>> = {
  first: msg`Attribution (first)`,
  latest: msg`Attribution (latest)`,
  trigger: msg`This lead's arrival`,
};

// A leaf where one is chosen, by the touch it is read from. A list shows only the name of
// what is chosen once it is closed, so the contact's own two say which they are; the
// arrival is the plain name.
const inList: Readonly<Record<AttributionScope, (name: string) => string>> = {
  first: (name) => i18n._(msg`${name} (first)`),
  latest: (name) => i18n._(msg`${name} (latest)`),
  trigger: (name) => name,
};

/** What a leaf of a touch is called in a list of fields. */
export const leafLabel = (scope: AttributionScope, leaf: AttributionLeafKey): string =>
  inList[scope](i18n._(leafNames[leaf]));

// A leaf in a sentence, by the touch it is read from: the arrival needs no more words
// ("lead source is…"), the contact's own two say which ("first lead source is…").
const inSentence: Readonly<Record<AttributionScope, (name: string) => string>> = {
  first: (name) => i18n._(msg`first ${name}`),
  latest: (name) => i18n._(msg`latest ${name}`),
  trigger: (name) => name,
};

// A name in the middle of a sentence: its first word loses its capital, unless it is an
// abbreviation (UTM). The words after it are names of their own (Google, ID) and keep theirs.
const lowered = (name: string): string => {
  const [first = '', ...rest] = name.split(' ');
  return [
    first === first.toUpperCase() && first.length > 1 ? first : first.toLowerCase(),
    ...rest,
  ].join(' ');
};

/** An attribution path in a sentence, or nothing for a path that reads no attribution. */
export function attributionWords(path: string): string | undefined {
  const found = attributionLeafAt(path);
  if (found === undefined) return undefined;
  const { key } = found.leaf;
  const name = lowered(i18n._(leafNames[key as AttributionLeafKey]));
  return inSentence[found.scope](name);
}

/** The names of the session sources and the mediums, as GoHighLevel's lists call them. */
export const choiceNames: Readonly<Record<string, MessageDescriptor>> = {
  paid_search: msg`Paid Search`,
  paid_social: msg`Paid Social`,
  social_media: msg`Social Media`,
  organic_search: msg`Organic Search`,
  referral: msg`Referral`,
  direct: msg`Direct Traffic`,
  others: msg`Others`,
  crm_ui: msg`CRM UI`,
  third_party: msg`Third Party`,
  form: msg`Form`,
  calendar: msg`Calendar`,
  chat: msg`Chat`,
  manual: msg`Manual`,
  api: msg`API`,
  import: msg`Import`,
  message: msg`Message`,
  automation: msg`Workflow`,
  assistant: msg`Assistant`,
  unknown: msg`Unknown`,
};

/** A session source or a medium by its name; a key nothing here knows as it is. */
export const choiceName = (key: string): string => {
  const name = Object.hasOwn(choiceNames, key) ? choiceNames[key] : undefined;
  return name === undefined ? key : i18n._(name);
};

/**
 * What a condition compares an attribution path with, in words, when it is a choice or a
 * yes or no; nothing for text, which is said as it is written.
 */
export function attributionValueWords(path: unknown, value: unknown): string | undefined {
  const found = typeof path === 'string' ? attributionLeafAt(path) : undefined;
  if (found === undefined) return undefined;
  if (found.leaf.type === 'single_choice' && typeof value === 'string') return choiceName(value);
  return undefined;
}

/** Whether a path reads text of a touch, so "includes" reads as "contains". */
export const isAttributionText = (path: unknown): boolean =>
  typeof path === 'string' && attributionLeafAt(path)?.leaf.type === 'text';

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);
const texts = (value: unknown): string[] =>
  isList(value) ? value.filter((each): each is string => typeof each === 'string') : [];

/**
 * The lead sources and session sources a trigger starts for, as the end of its sentence:
 * "from Google Ads or Facebook Ads". Nothing for a trigger that takes every lead.
 */
export function arrivalFilterWords(
  config: Readonly<Record<string, unknown>>,
  list: (parts: readonly string[]) => string,
): string | undefined {
  const sources = texts(config['sources']);
  const sessions = texts(config['sessionSources']).map(choiceName);
  if (sources.length === 0 && sessions.length === 0) return undefined;
  const named = list(sources);
  const channels = list(sessions);
  if (sessions.length === 0) return i18n._(msg`from ${named}`);
  if (sources.length === 0) return i18n._(msg`through ${channels}`);
  return i18n._(msg`from ${named}, through ${channels}`);
}

/** How an opportunity step's source setting is written. */
export type DealSourceMode = 'arrival' | 'text' | 'none' | 'unset' | 'other';

/** Which of the choices a step's source setting is, as the document holds it. */
export function dealSourceMode(value: unknown): DealSourceMode {
  if (value === undefined) return 'unset';
  if (value === null) return 'none';
  if (typeof value === 'string') return 'text';
  return typeof value === 'object' &&
    Object.keys(value).length === 1 &&
    (value as { readonly from?: unknown }).from === 'arrival'
    ? 'arrival'
    : 'other';
}

/**
 * Where a Create opportunity step takes the source from, for its card: a step that names
 * none takes it from how the lead arrived.
 */
export function createdSourceWords(value: unknown): string | undefined {
  const mode = dealSourceMode(value);
  if (mode === 'arrival' || mode === 'unset') return i18n._(msg`Source: from how they arrived`);
  if (mode === 'none') return i18n._(msg`No source`);
  if (mode !== 'text') return undefined;
  const written = String(value);
  return i18n._(msg`Source: ${written}`);
}
