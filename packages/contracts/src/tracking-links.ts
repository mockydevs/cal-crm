// Tracking link templates: the text to paste into an ad platform so that a click on the ad
// arrives with the parameters the lead source rules read. A small catalogue that ships in
// the code, and one pure function that builds a link or a suffix from it. No endpoint
// serves it: the dashboard imports it.
//
// What is each vendor's and what is ours:
// - every placeholder ({campaignid}, {{campaign.id}}, __CAMPAIGN_ID__…) is written exactly
//   as its vendor documents it, with the page it was read on beside the template;
// - the choice and the names of the parameters (utm_source=google, campaign_id=…) are OURS:
//   they are the names the CRM reads (ATTRIBUTION_PARAMETERS). Google publishes no utm_
//   template of its own; its example is {lpurl}?matchtype={matchtype};
// - a test expands every template with sample values and holds the lead source the CRM
//   module gives it to `leadSource` here.
//
// A placeholder is never URL-encoded: the platform replaces it when the ad is clicked. A
// value a person typed is encoded.
import type { LeadSourceKey } from './lead-sources.js';

/** Raised when a template's parameters or placeholders change: a saved choice names both. */
export const TRACKING_LINK_CATALOGUE_VERSION = 1;

export const trackingLinkPlatforms = [
  'google_ads',
  'microsoft_ads',
  'meta',
  'tiktok',
  'linkedin',
  'email',
  'other',
] as const;
export type TrackingLinkPlatform = (typeof trackingLinkPlatforms)[number];

/**
 * What a template gives:
 * - `suffix`: parameters with no `?` in front, for a field that adds them to the ad's
 *   address (Google's and Microsoft's Final URL suffix, Meta's URL parameters);
 * - `tracking_template`: the platform's own template, beginning with {lpurl};
 * - `link`: parameters to add to the address itself. With a base address the builder
 *   gives the whole link.
 */
export type TrackingLinkForm = 'suffix' | 'tracking_template' | 'link';

export interface TrackingLinkParameter {
  /** The parameter's name in the address: one the CRM reads. */
  readonly name: string;
  /** What it is set to: fixed text, or the vendor's placeholder exactly as documented. */
  readonly value: string;
  /** `placeholder`: the platform fills it in at the click. `text`: fixed words. */
  readonly kind: 'placeholder' | 'text';
  /** Whether a person may put their own words here (a campaign's name, a source). */
  readonly editable: boolean;
  /** What the CRM reads it as. */
  readonly fills: string;
}

export interface TrackingLinkTemplate {
  readonly id: string;
  readonly platform: TrackingLinkPlatform;
  readonly label: string;
  readonly form: TrackingLinkForm;
  /** Where to paste it, in the platform's own words as far as they were read. */
  readonly where: string;
  readonly parameters: readonly TrackingLinkParameter[];
  /**
   * The lead source a click on a link built from this template is given by the built-in
   * rules. `source_param` for the template that names the Source itself.
   */
  readonly leadSource: LeadSourceKey;
  /** Whether this is the one offered first for its platform. */
  readonly default: boolean;
  /** What to know before pasting: what the platform adds by itself, and what is unverified. */
  readonly notes: readonly string[];
  /**
   * False when a placeholder or the field it goes in could not be read in the vendor's own
   * documentation: the note says which.
   */
  readonly verified: boolean;
  /** The vendor pages the placeholders were read on, and when. */
  readonly sources: readonly { readonly url: string; readonly read: string }[];
  /** Values a platform would put in place of each placeholder, for an example and the tests. */
  readonly sample: Readonly<Record<string, string>>;
}

const text = (name: string, value: string, fills: string, editable = false) =>
  ({ name, value, kind: 'text', editable, fills }) as const;
const placeholder = (name: string, value: string, fills: string, editable = false) =>
  ({ name, value, kind: 'placeholder', editable, fills }) as const;

const GOOGLE_VALUETRACK = 'https://support.google.com/google-ads/answer/6305348';
const GOOGLE_SUFFIX = 'https://support.google.com/google-ads/answer/9695952';
const MICROSOFT_URLS =
  'https://learn.microsoft.com/en-us/advertising/guides/url-tracking-upgraded-urls?view=bingads-13';
const META_DYNAMIC = 'https://www.facebook.com/business/help/2360940870872492';
const META_ADD = 'https://www.facebook.com/business/help/1016122818401732';
const GHL_META =
  'https://help.gohighlevel.com/support/solutions/articles/48001204042-how-to-set-up-facebook-ad-reporting';
const TIKTOK_UTM =
  'https://ads.tiktok.com/help/article/track-offsite-web-events-with-utm-parameters';
const LINKEDIN_DYNAMIC = 'https://www.linkedin.com/help/lms/answer/a5968064';

// Google's ValueTrack parameters, as its page writes them: {campaignid} "The campaign ID",
// {adgroupid} "The ad group ID", {creative} "A unique ID for your ad", {keyword} (blank
// for keywordless matches), {matchtype} e, p, b, a, {device} m, t, c, {network} g, s, d…
const GOOGLE_PARAMETERS = [
  text('utm_source', 'google', 'UTM source'),
  text('utm_medium', 'cpc', 'UTM medium'),
  placeholder('utm_campaign', '{campaignid}', 'UTM campaign', true),
  placeholder('utm_content', '{adgroupid}', 'UTM content', true),
  placeholder('utm_term', '{keyword}', 'UTM term'),
  placeholder('matchtype', '{matchtype}', 'Match type'),
  placeholder('campaign_id', '{campaignid}', 'Campaign ID'),
  placeholder('ad_group_id', '{adgroupid}', 'Ad group ID'),
  placeholder('ad_id', '{creative}', 'Ad ID'),
  placeholder('device', '{device}', 'Not kept: for your own analytics'),
  placeholder('network', '{network}', 'Not kept: for your own analytics'),
] as const;
const GOOGLE_SAMPLE = {
  '{campaignid}': '20511223344',
  '{adgroupid}': '155667788990',
  '{creative}': '677889900112',
  '{keyword}': 'wedding photographer',
  '{matchtype}': 'p',
  '{device}': 'm',
  '{network}': 'g',
};
const GOOGLE_NOTES = [
  'The utm_ names are ours, chosen so the CRM reads them: Google publishes no utm_ template of its own. Every {placeholder} is on Google’s ValueTrack list.',
  'Auto-tagging adds gclid to the address by itself; it is on by default for new accounts. {gclid} is a ValueTrack parameter too and is not needed here. gbraid and wbraid arrive only by auto-tagging.',
  'Reports join on the ids, so renaming a campaign in Google Ads breaks nothing.',
];

// Microsoft's own example: {lpurl}?ref=bing&keyword={Keyword}&cmpid={CampaignID}&agid={AdGroupID}&adid={AdID}
const MICROSOFT_PARAMETERS = [
  text('utm_source', 'bing', 'UTM source'),
  text('utm_medium', 'cpc', 'UTM medium'),
  placeholder('utm_campaign', '{CampaignID}', 'UTM campaign', true),
  placeholder('utm_term', '{Keyword}', 'UTM term'),
  placeholder('campaign_id', '{CampaignID}', 'Campaign ID'),
  placeholder('ad_group_id', '{AdGroupID}', 'Ad group ID'),
  placeholder('ad_id', '{AdID}', 'Ad ID'),
] as const;
const MICROSOFT_SAMPLE = {
  '{CampaignID}': '501223344',
  '{AdGroupID}': '1330099887766',
  '{AdID}': '84400112233',
  '{Keyword}': 'wedding photographer',
};
const MICROSOFT_NOTES = [
  'The placeholders are the four of Microsoft’s own example, in its casing. Its full list of parameters was not read, so match type and device are left out.',
  'Auto-tagging adds msclkid to the address by itself; it is on by default for new accounts.',
];

// Meta's list: ad_id={{ad.id}}, adset_id={{adset.id}}, campaign_id={{campaign.id}},
// ad_name={{ad.name}}, adset_name={{adset.name}}, campaign_name={{campaign.name}},
// placement={{placement}}, site_source_name={{site_source_name}} (an, fb, ig, msg, th).
const META_IDS = [
  placeholder('campaign_id', '{{campaign.id}}', 'Campaign ID'),
  placeholder('adset_id', '{{adset.id}}', 'Ad group ID'),
  placeholder('ad_id', '{{ad.id}}', 'Ad ID'),
] as const;
const META_SAMPLE = {
  '{{campaign.id}}': '120210000000000001',
  '{{adset.id}}': '120210000000000002',
  '{{ad.id}}': '120210000000000003',
  '{{campaign.name}}': 'Spring promo',
  '{{adset.name}}': 'Brides 25-34',
  '{{ad.name}}': 'Video A',
  '{{site_source_name}}': 'fb',
};
const META_NOTES = [
  'A name placeholder keeps the name the campaign, ad set or ad had when it was first published: renaming it later does not change the link. Reports join on the ids.',
  'Since 2024 Meta may add a source, a medium (“paid”) and its ids to an ad’s traffic by itself. An fbclid alone does not prove a paid click, so keep utm_medium on the ad.',
  'Parameters entered here replace ones of the same name in the ad’s website address.',
];
const META_SOURCES = [
  { url: META_DYNAMIC, read: '2026-10-14' },
  { url: META_ADD, read: '2026-10-14' },
];

const SOCIAL_NOTE =
  'The utm_ names are ours, chosen so the CRM reads them; the placeholders are the platform’s own.';

/**
 * The catalogue, in the order a list of choices offers it. One template a platform is the
 * default; the others are variants.
 */
export const trackingLinkTemplates: readonly TrackingLinkTemplate[] = [
  {
    id: 'google_ads_suffix',
    platform: 'google_ads',
    label: 'Google Ads: Final URL suffix',
    form: 'suffix',
    where:
      'Google Ads → Account settings → Tracking → Final URL suffix (the field is also on a campaign, an ad group and an ad).',
    parameters: GOOGLE_PARAMETERS,
    leadSource: 'google_ads',
    default: true,
    notes: [
      ...GOOGLE_NOTES,
      'Google’s ValueTrack page does not describe the Final URL suffix; that parameters a landing page needs belong there was read in a hotel-campaign article only. If your account shows no such field, use the tracking template instead.',
    ],
    verified: false,
    sources: [
      { url: GOOGLE_VALUETRACK, read: '2026-10-14' },
      { url: GOOGLE_SUFFIX, read: '2026-10-13' },
    ],
    sample: GOOGLE_SAMPLE,
  },
  {
    id: 'google_ads_tracking_template',
    platform: 'google_ads',
    label: 'Google Ads: tracking template',
    form: 'tracking_template',
    where: 'Google Ads → Account settings → Tracking → Tracking template.',
    parameters: GOOGLE_PARAMETERS,
    leadSource: 'google_ads',
    default: false,
    notes: [
      ...GOOGLE_NOTES,
      'The template begins with {lpurl}, which Google replaces with the ad’s final URL; at the beginning it is not escaped. How Google joins the template to a final URL that already has a “?” was not read: test one ad before using it on an account whose final URLs carry a query.',
    ],
    verified: true,
    sources: [{ url: GOOGLE_VALUETRACK, read: '2026-10-14' }],
    sample: GOOGLE_SAMPLE,
  },
  {
    id: 'microsoft_ads_suffix',
    platform: 'microsoft_ads',
    label: 'Microsoft Advertising: Final URL suffix',
    form: 'suffix',
    where:
      'Microsoft Advertising: the Final URL suffix of the account, a campaign, an ad group or an ad. It must not begin with ?, & or #.',
    parameters: MICROSOFT_PARAMETERS,
    leadSource: 'microsoft_ads',
    default: true,
    notes: [
      ...MICROSOFT_NOTES,
      'Microsoft recommends the Final URL suffix for parameters the landing page needs.',
    ],
    verified: true,
    sources: [{ url: MICROSOFT_URLS, read: '2026-10-14' }],
    sample: MICROSOFT_SAMPLE,
  },
  {
    id: 'microsoft_ads_tracking_template',
    platform: 'microsoft_ads',
    label: 'Microsoft Advertising: tracking template',
    form: 'tracking_template',
    where:
      'Microsoft Advertising: the tracking template of the account (or of a campaign, an ad group or an ad).',
    parameters: MICROSOFT_PARAMETERS,
    leadSource: 'microsoft_ads',
    default: false,
    notes: MICROSOFT_NOTES,
    verified: true,
    sources: [{ url: MICROSOFT_URLS, read: '2026-10-14' }],
    sample: MICROSOFT_SAMPLE,
  },
  {
    id: 'meta_ads',
    platform: 'meta',
    label: 'Meta (Facebook and Instagram) ads',
    form: 'suffix',
    where: 'Meta Ads Manager → the ad → Tracking → URL parameters.',
    parameters: [
      text('utm_source', 'facebook', 'UTM source'),
      text('utm_medium', 'paid_social', 'UTM medium'),
      placeholder('utm_campaign', '{{campaign.name}}', 'UTM campaign', true),
      placeholder('utm_content', '{{ad.name}}', 'UTM content', true),
      ...META_IDS,
    ],
    leadSource: 'facebook_ads',
    default: true,
    notes: [
      SOCIAL_NOTE,
      ...META_NOTES,
      'Every such lead is “Facebook Ads”, wherever Meta showed the ad. To tell Instagram from Facebook, use the variant that names the app.',
    ],
    verified: true,
    sources: META_SOURCES,
    sample: META_SAMPLE,
  },
  {
    id: 'meta_ads_by_app',
    platform: 'meta',
    label: 'Meta ads, named by the app that showed the ad',
    form: 'suffix',
    where: 'Meta Ads Manager → the ad → Tracking → URL parameters.',
    parameters: [
      placeholder('utm_source', '{{site_source_name}}', 'UTM source'),
      text('utm_medium', 'paid_social', 'UTM medium'),
      placeholder('utm_campaign', '{{campaign.name}}', 'UTM campaign', true),
      placeholder('utm_content', '{{ad.name}}', 'UTM content', true),
      ...META_IDS,
    ],
    leadSource: 'facebook_ads',
    default: false,
    notes: [
      SOCIAL_NOTE,
      ...META_NOTES,
      'Meta fills {{site_source_name}} with fb, ig, msg, th or an. fb is “Facebook Ads” and ig “Instagram Ads”; Messenger, Threads and Audience Network read as “Paid (other)”.',
    ],
    verified: true,
    sources: META_SOURCES,
    sample: META_SAMPLE,
  },
  {
    id: 'meta_ads_ghl',
    platform: 'meta',
    label: 'Meta ads, GoHighLevel style (fb_ad)',
    form: 'suffix',
    where: 'Meta Ads Manager → the ad → Tracking → URL parameters.',
    parameters: [
      text('utm_source', 'fb_ad', 'UTM source'),
      placeholder('utm_medium', '{{adset.name}}', 'UTM medium'),
      placeholder('utm_campaign', '{{campaign.name}}', 'UTM campaign'),
      placeholder('utm_content', '{{ad.name}}', 'UTM content'),
      placeholder('campaign_id', '{{campaign.id}}', 'Campaign ID'),
    ],
    leadSource: 'facebook_ads',
    default: false,
    notes: [
      'The parameters GoHighLevel’s Facebook reporting guide asks for, for an account moving over with ads already tagged this way. The medium is the ad set’s name, so it is utm_source=fb_ad that marks the click as paid.',
      ...META_NOTES,
    ],
    verified: true,
    sources: [...META_SOURCES, { url: GHL_META, read: '2026-10-13' }],
    sample: META_SAMPLE,
  },
  {
    id: 'tiktok_ads',
    platform: 'tiktok',
    label: 'TikTok ads',
    form: 'link',
    where:
      'TikTok Ads Manager → the ad → its destination URL: add these to the address (TikTok’s URL builder does the same).',
    parameters: [
      text('utm_source', 'tiktok', 'UTM source'),
      text('utm_medium', 'paid_social', 'UTM medium'),
      placeholder('utm_campaign', '__CAMPAIGN_NAME__', 'UTM campaign', true),
      placeholder('utm_content', '__CID_NAME__', 'UTM content', true),
      placeholder('campaign_id', '__CAMPAIGN_ID__', 'Campaign ID'),
      placeholder('adgroup_id', '__AID__', 'Ad group ID'),
      placeholder('ad_id', '__CID__', 'Ad ID'),
    ],
    leadSource: 'tiktok_ads',
    default: true,
    notes: [
      SOCIAL_NOTE,
      'TikTok calls __CID__ the Creative ID and __AID__ the Ad Group ID. An upgraded Smart+ campaign has __ADID_V2__ for its ad: put that in ad_id there.',
      'TikTok adds ttclid to the address by itself. Alone it does not prove a paid click, so keep utm_medium on the ad.',
    ],
    verified: true,
    sources: [{ url: TIKTOK_UTM, read: '2026-10-14' }],
    sample: {
      __CAMPAIGN_NAME__: 'Spring promo',
      __CAMPAIGN_ID__: '1790000000000001',
      __AID__: '1790000000000002',
      __CID_NAME__: 'Video A',
      __CID__: '1790000000000003',
    },
  },
  {
    id: 'linkedin_ads',
    platform: 'linkedin',
    label: 'LinkedIn ads',
    form: 'link',
    where: 'LinkedIn Campaign Manager → the ad → its destination URL: add these to the address.',
    parameters: [
      text('utm_source', 'linkedin', 'UTM source'),
      text('utm_medium', 'paid_social', 'UTM medium'),
      placeholder('utm_campaign', '{{CAMPAIGN_NAME}}', 'UTM campaign', true),
      placeholder('utm_content', '{{AD_NAME}}', 'UTM content', true),
      placeholder('campaign_id', '{{CAMPAIGN_ID}}', 'Campaign ID'),
      placeholder('adset_id', '{{AD_SET_ID}}', 'Ad group ID'),
      placeholder('ad_id', '{{AD_ID}}', 'Ad ID'),
    ],
    leadSource: 'linkedin_ads',
    default: true,
    notes: [
      SOCIAL_NOTE,
      'The placeholders are LinkedIn’s set since October 2025, upper case in double braces. Where Campaign Manager asks for them was not read: paste them on the ad’s destination URL.',
      'LinkedIn adds li_fat_id by itself when enhanced conversion tracking is on. Alone it does not prove a paid click.',
    ],
    verified: false,
    sources: [{ url: LINKEDIN_DYNAMIC, read: '2026-10-13' }],
    sample: {
      '{{CAMPAIGN_NAME}}': 'Spring promo',
      '{{CAMPAIGN_ID}}': '612233445',
      '{{AD_SET_ID}}': '298877665',
      '{{AD_NAME}}': 'Carousel A',
      '{{AD_ID}}': '733221100',
    },
  },
  {
    id: 'email',
    platform: 'email',
    label: 'Email',
    form: 'link',
    where: 'A link in an email or a newsletter: add these to the address.',
    parameters: [
      text('utm_source', 'newsletter', 'UTM source', true),
      text('utm_medium', 'email', 'UTM medium'),
      text('utm_campaign', 'october', 'UTM campaign', true),
    ],
    leadSource: 'email',
    default: true,
    notes: [
      'utm_medium=email is what makes the lead “Email”, also when the link is opened in Gmail or another webmail page.',
    ],
    verified: true,
    sources: [],
    sample: {},
  },
  {
    id: 'named_source',
    platform: 'other',
    label: 'Any other link: name the Source yourself',
    form: 'link',
    where: 'A flyer’s QR code, a partner’s website, a post: add this to the address.',
    parameters: [text('source', 'Spring flyer', 'The lead’s Source, as written', true)],
    leadSource: 'source_param',
    default: true,
    notes: [
      'source= is used as written and comes before every built-in rule. No tag is made for a name a link chose.',
    ],
    verified: true,
    sources: [],
    sample: {},
  },
];

export type TrackingLinkTemplateId = string;

/** A template of the catalogue, by its id. */
export const trackingLinkTemplate = (id: string): TrackingLinkTemplate | undefined =>
  trackingLinkTemplates.find((template) => template.id === id);

/** The template offered first for a platform. */
export const defaultTrackingLinkTemplate = (
  platform: TrackingLinkPlatform,
): TrackingLinkTemplate | undefined =>
  trackingLinkTemplates.find((template) => template.platform === platform && template.default);

export interface BuildTrackingLinkInput {
  readonly templateId: string;
  /**
   * The page the ad leads to. With it, a `link` template gives the whole address; a suffix
   * and a tracking template never include it (the platform adds its own final URL).
   */
  readonly baseUrl?: string | undefined;
  /**
   * Words of your own for the parameters a template marks `editable`, by parameter name:
   * { utm_campaign: 'Spring promo' }. Blank or absent keeps the template's own value.
   * A name the template does not mark editable is ignored.
   */
  readonly values?: Readonly<Record<string, string | undefined>> | undefined;
}

export type BuiltTrackingLink =
  | {
      readonly ok: true;
      /** What `text` is: parameters to paste, a tracking template, or a whole address. */
      readonly kind: 'suffix' | 'tracking_template' | 'link';
      readonly text: string;
      /** Each parameter as written, in order. */
      readonly parameters: readonly { readonly name: string; readonly value: string }[];
    }
  | { readonly ok: false; readonly code: 'unknown_template' | 'invalid_base_url' };

/** A web address in its three parts. This package names no platform type, so no URL class. */
interface AddressParts {
  /** Scheme, host and path: everything before the query. */
  readonly page: string;
  /** The query's pairs as written, without the "?". */
  readonly pairs: readonly string[];
  /** The fragment with its "#", or nothing. */
  readonly hash: string;
}

const WEB_ADDRESS = /^(https?:\/\/[^\s?#/]+[^\s?#]*)(?:\?([^\s#]*))?(#\S*)?$/i;

const partsOf = (address: string): AddressParts | undefined => {
  const match = WEB_ADDRESS.exec(address.trim());
  const page = match?.[1];
  if (page === undefined) return undefined;
  return {
    page,
    pairs: (match?.[2] ?? '').split('&').filter((pair) => pair !== ''),
    hash: match?.[3] ?? '',
  };
};

/** A base address's own pairs, less the ones a template sets: the template's value wins. */
const keptPairs = (parts: AddressParts, set: ReadonlySet<string>): string[] =>
  parts.pairs.filter((pair) => !set.has(pair.split('=')[0] ?? ''));

/**
 * Builds what to paste. Placeholders are written as the vendor documents them, unencoded;
 * fixed words and a person's own are percent-encoded. A base address keeps its own query,
 * less any parameter the template sets (the template's value wins), and its fragment.
 */
export function buildTrackingLink(input: BuildTrackingLinkInput): BuiltTrackingLink {
  const template = trackingLinkTemplate(input.templateId);
  if (template === undefined) return { ok: false, code: 'unknown_template' };
  const parameters = template.parameters.map((parameter) => {
    const own = parameter.editable ? (input.values?.[parameter.name] ?? '').trim() : '';
    if (own !== '') return { name: parameter.name, value: encodeURIComponent(own) };
    return {
      name: parameter.name,
      value:
        parameter.kind === 'placeholder' ? parameter.value : encodeURIComponent(parameter.value),
    };
  });
  const query = parameters.map(({ name, value }) => `${name}=${value}`).join('&');
  if (template.form === 'tracking_template')
    return { ok: true, kind: 'tracking_template', text: `{lpurl}?${query}`, parameters };
  const base = (input.baseUrl ?? '').trim();
  if (template.form === 'suffix' || base === '')
    return { ok: true, kind: 'suffix', text: query, parameters };
  const parts = partsOf(base);
  if (parts === undefined) return { ok: false, code: 'invalid_base_url' };
  const kept = keptPairs(parts, new Set(parameters.map(({ name }) => name)));
  return {
    ok: true,
    kind: 'link',
    text: `${parts.page}?${[...kept, query].join('&')}${parts.hash}`,
    parameters,
  };
}

/**
 * A link as it would arrive: the template's parameters with each placeholder replaced by
 * the template's sample value (or one of `sample`), on a base address. For an example
 * beside the template and for "Check a link".
 */
export function sampleTrackingLink(
  templateId: string,
  baseUrl: string,
  sample?: Readonly<Record<string, string>>,
): string | undefined {
  const template = trackingLinkTemplate(templateId);
  const parts = partsOf(baseUrl);
  if (template === undefined || parts === undefined) return undefined;
  const values: Readonly<Record<string, string | undefined>> = { ...template.sample, ...sample };
  const pairs = template.parameters.map(
    (parameter) =>
      `${parameter.name}=${encodeURIComponent(
        parameter.kind === 'placeholder' ? (values[parameter.value] ?? '') : parameter.value,
      )}`,
  );
  const kept = keptPairs(parts, new Set(template.parameters.map(({ name }) => name)));
  return `${parts.page}?${[...kept, ...pairs].join('&')}${parts.hash}`;
}
