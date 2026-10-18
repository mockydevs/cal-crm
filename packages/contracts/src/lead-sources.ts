// The lead source: one short name for how a lead arrived, such as "Google Ads", worked out
// from the facts of the visit by the CRM module's built-in rules
// (attribution/lead-source.ts) and kept on the touch. Three things are told apart
// everywhere:
// - the contact's Source: one text on the contact, written once, by a person or a form;
// - the session source: GoHighLevel's nine channels (reporting-attribution.ts);
// - the lead source: this, the name of the platform or the channel.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { ATTRIBUTION_LIMITS, clickIdNames, sessionSources } from './reporting-attribution.js';
import { tag } from './tags.js';

/**
 * The built-in rules, in the order they are tried: the first that fits decides. A key never
 * changes; the name beside it may be reworded later, and the touches already written keep
 * the key (`sourceRule`), so nothing recorded is lost by a rename.
 *
 * `source_param` is the one rule whose name is not fixed: it gives the text the address
 * carried in `source=` (GoHighLevel's documented override).
 */
export const leadSourceKeys = [
  'source_param',
  'google_ads',
  'microsoft_ads',
  'facebook_ads',
  'instagram_ads',
  'tiktok_ads',
  'linkedin_ads',
  'paid_other',
  'email',
  'sms',
  'organic_search',
  'facebook',
  'instagram',
  'linkedin',
  'tiktok',
  'youtube',
  'x',
  'social',
  'referral',
  'other',
  'direct',
] as const;
export type LeadSourceKey = (typeof leadSourceKeys)[number];

/** The keys whose name is fixed: every built-in rule but `source_param`. */
export type NamedLeadSourceKey = Exclude<LeadSourceKey, 'source_param'>;

/** The name each built-in rule gives. The name is what a contact's Source and a tag show. */
export const leadSourceLabels = {
  google_ads: 'Google Ads',
  microsoft_ads: 'Microsoft Ads',
  facebook_ads: 'Facebook Ads',
  instagram_ads: 'Instagram Ads',
  tiktok_ads: 'TikTok Ads',
  linkedin_ads: 'LinkedIn Ads',
  paid_other: 'Paid (other)',
  email: 'Email',
  sms: 'SMS',
  organic_search: 'Organic Search',
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
  social: 'Social',
  referral: 'Referral',
  other: 'Other',
  direct: 'Direct',
} as const satisfies Readonly<Record<NamedLeadSourceKey, string>>;

/** The fixed names with their keys, in the order of the rules: what a list of choices offers. */
export const leadSources: readonly { readonly key: NamedLeadSourceKey; readonly label: string }[] =
  leadSourceKeys.flatMap((key) =>
    key === 'source_param' ? [] : [{ key, label: leadSourceLabels[key] }],
  );

/** What each built-in rule looks for, in one sentence, for the list in Settings and the preview. */
export const leadSourceRuleDescriptions = {
  source_param: 'The address carries source=…: that text is the lead source.',
  google_ads:
    'A Google click id (gclid, gbraid or wbraid), utm_source containing "adwords", or Google as the source or the site they came from with a paid marker.',
  microsoft_ads:
    'A Microsoft click id (msclkid), or Bing or Microsoft as the source or the site they came from with a paid marker.',
  facebook_ads:
    'Facebook or Meta as the source or the site they came from, or a Facebook click id (fbclid), with a paid marker; or a click-to-WhatsApp id (ctwa_clid).',
  instagram_ads: 'Instagram as the source or the site they came from, with a paid marker.',
  tiktok_ads:
    'TikTok as the source or the site they came from, or a TikTok click id (ttclid), with a paid marker.',
  linkedin_ads:
    'LinkedIn as the source or the site they came from, or a LinkedIn click id (li_fat_id), with a paid marker.',
  paid_other:
    'A paid medium (cpc, ppc, paid…, retargeting) or a utm_source ending in "_ad"; or a paid click on a platform with no name of its own in this list.',
  email: 'utm_medium or utm_source is email.',
  sms: 'utm_medium is sms.',
  organic_search: 'They came from a search engine, or utm_source names one.',
  facebook: 'They came from Facebook, utm_source names it, or only a Facebook click id is known.',
  instagram: 'They came from Instagram, or utm_source names it.',
  linkedin: 'They came from LinkedIn, utm_source names it, or only a LinkedIn click id is known.',
  tiktok: 'They came from TikTok, utm_source names it, or only a TikTok click id is known.',
  youtube: 'They came from YouTube, or utm_source names it.',
  x: 'They came from X (Twitter), or utm_source names it.',
  social: 'They came from another social site, or utm_source names one.',
  referral: 'They came from another website.',
  other: 'The address carries campaign labels that no rule above names.',
  direct: 'Nothing is known of how they arrived.',
} as const satisfies Readonly<Record<LeadSourceKey, string>>;

/**
 * A medium is paid when it matches this, Google Analytics' own expression for its paid
 * channels (https://support.google.com/analytics/answer/9756891, read 2026-10-13). Compared
 * in lower case.
 */
export const PAID_MEDIUM = /^(.*cp.*|ppc|retargeting|paid.*)$/;

export const LEAD_SOURCE_LIMITS = {
  /** A lead source's name: a contact's Source holds as much. */
  labelLength: 200,
  /** A tag's name holds 60 characters: a lead source whose tag would be longer gets none. */
  tagNameLength: 60,
  /** Tags one submission adds to its contact, the form's own and the lead source's together. */
  tagsPerSubmission: 10,
} as const;

/** What a lead source's tag starts with: "Source: Google Ads". */
const TAG_PREFIX = 'Source: ';
/** The tag group the system keeps the lead source tags in. */
export const LEAD_SOURCE_TAG_GROUP = 'Lead source';

/** The name of the tag a lead source gives, or undefined when a tag cannot hold it. */
export function leadSourceTagName(label: string): string | undefined {
  const name = `${TAG_PREFIX}${label.trim()}`;
  return label.trim() === '' || name.length > LEAD_SOURCE_LIMITS.tagNameLength ? undefined : name;
}

const fact = z.string().nullable();

export const previewLeadSourceInput = z
  .strictObject({
    url: z
      .url({ protocol: /^https?$/, error: 'Enter a web address, starting with https://.' })
      .max(ATTRIBUTION_LIMITS.urlLength, { error: 'Use at most 2000 characters.' })
      .meta({
        description: "The address a visitor would land on: an ad's final address, with its query.",
        examples: ['https://www.example.com/offer?utm_source=facebook&utm_medium=paid_social'],
      }),
    referrer: z
      .url({ protocol: /^https?$/, error: 'Enter a web address, starting with https://.' })
      .max(ATTRIBUTION_LIMITS.urlLength, { error: 'Use at most 2000 characters.' })
      .optional()
      .meta({ description: 'The address they would come from, when that is known.' }),
    formId: publicId('form')
      .optional()
      .meta({ description: 'A form, to be told what its saved draft would do with such a lead.' }),
  })
  .meta({ id: 'PreviewLeadSourceInput' });
export type PreviewLeadSourceInput = z.output<typeof previewLeadSourceInput>;

export const leadSourcePreviewWarningCodes = [
  /** Nothing in the address and no referrer: every such visit is Direct. */
  'no_tracking',
  /** Only a Facebook click id: a paid click cannot be told from a post's. */
  'click_id_only',
  /** `source=` decided the name: whoever writes the link chooses it. */
  'source_param',
  /** The name is not a built-in one and no tag carries it: no tag would be added. */
  'no_tag',
  /** The form's own tags and the lead source's are more than a submission adds. */
  'too_many_tags',
] as const;

export const leadSourcePreview = z
  .looseObject({
    sessionSource: z.enum(sessionSources),
    source: z
      .string()
      .meta({ description: 'The lead source: its name.', examples: ['Google Ads'] }),
    sourceRule: z.enum(leadSourceKeys).meta({
      description:
        'The built-in rule that fits the address. It decided the name unless `decidedBy` says a rule of the business did.',
    }),
    reason: z.string().meta({ description: 'Why the lead has this name, in a sentence.' }),
    decidedBy: z
      .discriminatedUnion('kind', [
        z.looseObject({
          kind: z.literal('rule'),
          ruleId: publicId('lead_source_rule'),
          name: z.string(),
        }),
        z.looseObject({ kind: z.literal('built_in'), key: z.enum(leadSourceKeys) }),
      ])
      .optional()
      .meta({
        description:
          'What named the lead: the first matching rule of the business that names a Source, else the built-in rule. Absent from a server older than this.',
      }),
    builtIn: z
      .looseObject({ source: z.string(), sourceRule: z.enum(leadSourceKeys) })
      .optional()
      .meta({
        description:
          'What the built-in rules alone call this visit. Absent from a server older than this.',
      }),
    rules: z
      .array(
        z.looseObject({
          id: publicId('lead_source_rule'),
          name: z.string(),
          position: z.int().min(1),
          source: z.string().nullable().meta({
            description: 'The Source this rule names, or null when it names none.',
          }),
          decidesSource: z.boolean().meta({
            description:
              'True for the one rule whose Source is used: the first matching rule that names one.',
          }),
          tags: z.array(
            z.looseObject({
              id: publicId('tag'),
              /** Null for a tag deleted since the rule was saved: it would be skipped. */
              name: z.string().nullable(),
            }),
          ),
          fieldWrites: z.array(
            z.looseObject({
              fieldId: publicId('field'),
              /** Null for a field that can no longer be filled: it would be skipped. */
              label: z.string().nullable(),
              value: z.string(),
              /** False when an earlier matching rule fills the same field: the first wins. */
              applies: z.boolean(),
            }),
          ),
        }),
      )
      .optional()
      .meta({
        description:
          'The rules of the business that match this visit, in the order they are tried, with what each would do. Empty when none matches. Rules are tried as for a form (medium form). Absent from a server older than this.',
      }),
    /** What was read of the address: the same list a submission keeps. */
    facts: z.looseObject({
      utmSource: fact,
      utmMedium: fact,
      utmCampaign: fact,
      utmContent: fact,
      utmTerm: fact,
      matchType: fact,
      campaignId: fact,
      adGroupId: fact,
      adId: fact,
      referrerDomain: fact,
      landingUrl: fact,
    }),
    clickIds: z.array(z.enum(clickIdNames)).meta({
      description: 'Which click ids the address carries. Their values are not repeated.',
    }),
    form: z
      .looseObject({
        id: publicId('form'),
        contactSource: z.string().nullable().meta({
          description:
            'What the form would write as the Source of a contact that has none. Null when it writes none.',
        }),
        tags: z.array(
          z.looseObject({
            name: z.string(),
            /**
             * `form`: one of the form's own. `source`: the one named after the lead
             * source. `rule`: one a matching rule of the business adds.
             */
            kind: z.enum(['form', 'source', 'rule']),
            /** False for a lead source tag that the first such lead would make. */
            exists: z.boolean(),
          }),
        ),
      })
      .nullable()
      .meta({
        description: "What the named form's saved draft would do. Null when none was named.",
      }),
    warnings: z.array(
      z.looseObject({ code: z.enum(leadSourcePreviewWarningCodes), message: z.string() }),
    ),
  })
  .meta({ id: 'LeadSourcePreview' });
export type LeadSourcePreview = z.output<typeof leadSourcePreview>;

export const previewLeadSource = defineEndpoint({
  operationId: 'previewLeadSource',
  method: 'post',
  path: '/lead-sources/preview',
  summary: 'Check a link: what a lead arriving by this address would be (nothing is stored)',
  group: 'Forms',
  body: previewLeadSourceInput,
  response: {
    status: 200,
    description: 'What a lead arriving by this address would be.',
    schema: leadSourcePreview,
  },
});

/** A built-in lead source, by its key: every rule but `source_param`, whose name is anybody's. */
export const namedLeadSourceKey = z.enum(leadSourceKeys).exclude(['source_param']);

export const ensureLeadSourceTagsInput = z
  .strictObject({
    sources: z
      .array(namedLeadSourceKey)
      .min(1)
      .max(leadSourceKeys.length - 1)
      .meta({
        description:
          'The built-in lead sources whose tags are wanted, by key. A name of your own is not taken: the list is closed.',
        examples: [['google_ads', 'facebook_ads']],
      }),
  })
  .meta({ id: 'EnsureLeadSourceTagsInput' });
export type EnsureLeadSourceTagsInput = z.output<typeof ensureLeadSourceTagsInput>;

export const leadSourceTags = z
  .looseObject({
    items: z.array(
      z.looseObject({
        source: namedLeadSourceKey,
        label: z.string().meta({ examples: ['Google Ads'] }),
        tag,
      }),
    ),
  })
  .meta({
    id: 'LeadSourceTags',
    description: 'The tag of each lead source asked for, in the order asked.',
  });
export type LeadSourceTags = z.output<typeof leadSourceTags>;

/**
 * The tags forms add for built-in lead sources ("Source: Google Ads"), found or made, for
 * whatever wants to name the same tags: a workflow that tags by source uses these ids, so
 * a lead tagged by its form and by a workflow carries one tag. A tag is known by the lead
 * source's key, not by its name: one a person renamed is the one returned.
 */
export const ensureLeadSourceTags = defineEndpoint({
  operationId: 'ensureLeadSourceTags',
  method: 'post',
  path: '/lead-sources/tags',
  summary: 'Find the tags of built-in lead sources, making the ones not there yet',
  group: 'Tags',
  body: ensureLeadSourceTagsInput,
  response: {
    status: 200,
    description:
      'The tag of each lead source. Asking again makes nothing: the same tags are returned.',
    schema: leadSourceTags,
  },
});

export const leadSourceEndpoints = [previewLeadSource, ensureLeadSourceTags] as const;
