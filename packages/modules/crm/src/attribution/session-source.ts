// The channel a touch came through, and what is read of a visit, with no database.
//
// The order of the rules is GoHighLevel's published one, read on 2026-10-12 from
// https://help.gohighlevel.com/support/solutions/articles/48001219997-understanding-attribution-source
// ("How is Attribution Source Determined?"):
//
//   1. utm_source contains "adwords"                                   -> Paid Search
//   2. a Google click id (gclid, wbraid, gbraid) or Microsoft's (msclkid) -> Paid Search
//   3. a UTM source, medium or campaign, and the referrer is Google    -> Paid Search
//   4. utm_source contains fb_ad, linkedin_ad, twitter_ad or reddit_ad,
//      or ctwa_clid is present                                         -> Paid Social
//   5. the referrer is a social media site                             -> Social Media
//   6. the referrer is a search engine                                 -> Organic Search
//   7. the referrer is any other site                                  -> Referral
//   8. no referrer and no tracking in the address                      -> Direct Traffic
//   9. an incoming call, text, email or message, or anything else      -> Others
//  10. made by hand in the CRM                                         -> CRM UI
//  11. made by an integration                                          -> Third-Party
//
// The article names four search engines (Google, Yahoo, Bing, DuckDuckGo) and no social
// sites: the two lists below are ours, and longer. fbclid is in no rule of the article, so
// by itself it decides nothing here either. Two things are ours and not the article's: a
// referrer on the page's own site is the visitor moving within it, and counts as no
// referrer; and a visit with tracking in its address that no rule above names is Others,
// by rule 9.
//
// Three more rules are ours, tried after the article's
// first four and before its fifth, so everything the article names is decided as the
// article says:
//
//   4a. a social site named by utm_source, or a social click id (fbclid, ttclid,
//       li_fat_id), or a social referrer, WITH a paid marker                  -> Paid Social
//   4b. a search engine named by utm_source, with a paid marker               -> Paid Search
//   4c. a search engine they came from, with a paid marker                    -> Paid Search
//
// Whether a click was paid for, on which channel and on whose platform is decided ONCE, by
// paidClickOf below: rules 1, 2 and 4 of the article and our 4a to 4c. The session source
// and the lead source (lead-source.ts) both read that one answer, so a touch cannot be
// "Microsoft Ads" by its name and Organic search by its channel. What the two can still
// say apart, on purpose: the article's rule 3 calls any labelled visit from Google paid
// search, and the name says "Google Ads" only when the address has a paid marker (a
// newsletter link opened in Gmail is "Email"); and a paid medium on no platform we know is
// "Paid (other)" by name while its channel is whatever rules 5 to 9 say, the article
// having no channel for it.
//
// Two more readings are ours:
//
// - a webmail page is not a search engine. mail.google.com and mail.yahoo.com carry a
//   search engine's name, and a link opened there was opened from an email: such a
//   referrer is no Google for rule 3, no search engine for rule 6 or 4c, and names no
//   platform. It is an ordinary site (rule 7, Referral), and the lead source is Email when
//   the link says so (utm_medium=email). The article's rule 3 reads "the referring domain
//   is google.com": the search site, which a mailbox is not;
// - a campaign id or an ad id is no paid marker on a link whose medium is email or sms.
//   Mail and text tools number their own campaigns (utm_id=44), so on such a link the
//   number says nothing of an ad, whatever site the visitor came from. A paid medium and
//   the article's own utm_source conventions still mark it.
//
// A paid marker is: utm_medium matching Google Analytics' expression for a paid medium
// (^(.*cp.*|ppc|retargeting|paid.*)$, https://support.google.com/analytics/answer/9756891,
// read 2026-10-13: cpc, ppc, paid_social, paidsocial, retargeting…); or utm_source ending
// "_ad" or containing "adwords" (the article's own convention); or a campaign id or an ad
// id in the address of a link whose medium is not email or sms. Without one, a click id
// proves no payment: Meta's fbclid is not confirmed to be on ad clicks only.
import { PAID_MEDIUM, type AttributionMedium, type SessionSource } from '@repo/contracts';

/** A search engine by the label its hosts carry (www.google.co.ke, uk.search.yahoo.com). */
const SEARCH_BRANDS = [
  'google',
  'yahoo',
  'bing',
  'duckduckgo',
  'baidu',
  'yandex',
  'ecosia',
  'startpage',
  'qwant',
] as const;
const SEARCH_HOSTS = ['search.brave.com'] as const;

const SOCIAL_BRANDS = [
  'facebook',
  'instagram',
  'linkedin',
  'twitter',
  'reddit',
  'tiktok',
  'youtube',
  'pinterest',
  'snapchat',
  'whatsapp',
  'threads',
  'messenger',
  'telegram',
] as const;
/** Short addresses of the same sites: matched whole, since their one label is too short to trust. */
const SOCIAL_HOSTS = ['x.com', 't.co', 'fb.com', 'fb.me', 'lnkd.in', 'wa.me', 't.me', 'youtu.be'];

const PAID_SOCIAL_SOURCES = ['fb_ad', 'linkedin_ad', 'twitter_ad', 'reddit_ad'] as const;

/**
 * Webmail: a mailbox read in a browser. A host with a label that says mail, and the
 * mailboxes whose host says nothing of the kind. The list is ours.
 */
const WEBMAIL_LABELS: ReadonlySet<string> = new Set(['mail', 'webmail', 'email', 'gmail']);
const WEBMAIL_HOSTS = [
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'app.fastmail.com',
  'app.tuta.com',
] as const;

const labelsOf = (host: string): string[] => host.toLowerCase().split('.');

/** Whether a host is the site or under it: www.x.com is under x.com, and notx.com is not. */
const under = (host: string, site: string): boolean => host === site || host.endsWith(`.${site}`);

const isSite = (host: string, brands: readonly string[], hosts: readonly string[]): boolean => {
  const lowered = host.toLowerCase();
  // The last label is the top-level domain: google.com is Google, something.google is not.
  const names = labelsOf(lowered).slice(0, -1);
  return (
    brands.some((brand) => names.includes(brand)) || hosts.some((site) => under(lowered, site))
  );
};

/** Whether a host is a mailbox read in a browser: mail.google.com, outlook.live.com. */
export const isWebmail = (host: string): boolean => {
  const lowered = host.toLowerCase();
  return (
    labelsOf(lowered)
      .slice(0, -1)
      .some((label) => WEBMAIL_LABELS.has(label)) ||
    WEBMAIL_HOSTS.some((site) => under(lowered, site))
  );
};

/** A search engine's own site. A mailbox under its name is not one. */
export const isSearchEngine = (host: string): boolean =>
  !isWebmail(host) && isSite(host, SEARCH_BRANDS, SEARCH_HOSTS);
export const isSocialSite = (host: string): boolean => isSite(host, SOCIAL_BRANDS, SOCIAL_HOSTS);
const isGoogle = (host: string): boolean =>
  !isWebmail(host) && labelsOf(host).slice(0, -1).includes('google');

/**
 * Where a visit came from, as far as one name can say: an advertising platform, a social
 * site, or search in general. `search` is a search engine that is neither Google nor
 * Microsoft's, `social` a social site with no name of its own here.
 */
export type Platform =
  | 'google'
  | 'microsoft'
  | 'search'
  | 'facebook'
  | 'instagram'
  | 'linkedin'
  | 'tiktok'
  | 'youtube'
  | 'x'
  | 'social';

const SEARCH_PLATFORMS: ReadonlySet<Platform> = new Set(['google', 'microsoft', 'search']);
export const isSearchPlatform = (platform: Platform | undefined): boolean =>
  platform !== undefined && SEARCH_PLATFORMS.has(platform);
export const isSocialPlatform = (platform: Platform | undefined): boolean =>
  platform !== undefined && !SEARCH_PLATFORMS.has(platform);

/**
 * The platform a word of utm_source names. utm_source is cut into words at anything that
 * is not a letter or a digit, so "fb_ad" names Facebook and "fbx" names nothing. The short
 * words (fb, ig) are common practice, not any vendor's published list.
 */
const SOURCE_WORDS: Readonly<Record<string, Platform>> = {
  google: 'google',
  googleads: 'google',
  adwords: 'google',
  bing: 'microsoft',
  microsoft: 'microsoft',
  yahoo: 'search',
  duckduckgo: 'search',
  baidu: 'search',
  yandex: 'search',
  ecosia: 'search',
  startpage: 'search',
  qwant: 'search',
  brave: 'search',
  facebook: 'facebook',
  fb: 'facebook',
  meta: 'facebook',
  messenger: 'facebook',
  instagram: 'instagram',
  ig: 'instagram',
  linkedin: 'linkedin',
  tiktok: 'tiktok',
  youtube: 'youtube',
  twitter: 'x',
  x: 'x',
  reddit: 'social',
  pinterest: 'social',
  snapchat: 'social',
  whatsapp: 'social',
  threads: 'social',
  telegram: 'social',
};

/** The sites with a name of their own, by the label a host carries and by short address. */
const NAMED_SITES: readonly {
  readonly platform: Platform;
  readonly brands: readonly string[];
  readonly hosts: readonly string[];
}[] = [
  { platform: 'google', brands: ['google'], hosts: [] },
  { platform: 'microsoft', brands: ['bing'], hosts: [] },
  { platform: 'facebook', brands: ['facebook', 'messenger'], hosts: ['fb.com', 'fb.me'] },
  { platform: 'instagram', brands: ['instagram'], hosts: [] },
  { platform: 'linkedin', brands: ['linkedin'], hosts: ['lnkd.in'] },
  { platform: 'tiktok', brands: ['tiktok'], hosts: [] },
  { platform: 'youtube', brands: ['youtube'], hosts: ['youtu.be'] },
  { platform: 'x', brands: ['twitter'], hosts: ['x.com', 't.co'] },
];

/** The platform utm_source names, if it names one: its first word that does. */
export function platformOfSource(utmSource: string | null): Platform | undefined {
  for (const word of (utmSource ?? '').toLowerCase().split(/[^a-z0-9]+/u)) {
    // Looked up as an own key only: "constructor" names no platform.
    if (Object.hasOwn(SOURCE_WORDS, word)) return SOURCE_WORDS[word];
  }
  return undefined;
}

/** The platform a host is, if it is a search engine or a social site. */
export function platformOfHost(host: string | null): Platform | undefined {
  // A mailbox names no platform, whoever runs it.
  if (host === null || isWebmail(host)) return undefined;
  const named = NAMED_SITES.find((site) => isSite(host, site.brands, site.hosts));
  if (named !== undefined) return named.platform;
  if (isSearchEngine(host)) return 'search';
  return isSocialSite(host) ? 'social' : undefined;
}

/**
 * The one platform of a visit. What the link says comes first (utm_source), then a click
 * id that only one platform writes, then the site the visitor came from. Meta writes
 * fbclid for Facebook and Instagram alike, so with one, having come from Instagram says
 * which of the two it was.
 */
export function platformOf(visit: VisitFacts): Platform | undefined {
  const named = platformOfSource(visit.utmSource);
  if (named !== undefined) return named;
  const site = platformOfHost(visit.referrerDomain);
  if (visit.fbclid !== null || visit.ctwaClid !== null)
    return site === 'instagram' ? 'instagram' : 'facebook';
  if (visit.ttclid !== null) return 'tiktok';
  if (visit.liFatId !== null) return 'linkedin';
  return site;
}

/** Whether utm_medium is a paid one, by Google Analytics' expression. */
export const isPaidMedium = (utmMedium: string | null): boolean =>
  PAID_MEDIUM.test((utmMedium ?? '').toLowerCase());

/** utm_medium or utm_source saying email, by Google Analytics' list for its Email channel. */
const EMAIL = /^(email|e-mail|e_mail|e mail)$/;

/** Whether the link says it was sent by email. */
export const isEmailLink = (visit: VisitFacts): boolean =>
  EMAIL.test(visit.utmMedium?.toLowerCase() ?? '') ||
  EMAIL.test(visit.utmSource?.toLowerCase() ?? '');

/** Whether the link says it was sent in a text message. */
export const isSmsLink = (visit: VisitFacts): boolean => visit.utmMedium?.toLowerCase() === 'sms';

/** Whether the address says the click was paid for (the paid marker at the top of this file). */
export function hasPaidMarker(visit: VisitFacts): boolean {
  const source = visit.utmSource?.toLowerCase() ?? '';
  if (isPaidMedium(visit.utmMedium) || source.endsWith('_ad') || source.includes('adwords'))
    return true;
  // A message's own campaign number is not an ad's.
  if (isEmailLink(visit) || isSmsLink(visit)) return false;
  return visit.campaignId !== null || visit.adId !== null;
}

/** What a touch knows of a visit. Everything is null when the visit did not say it. */
export interface VisitFacts {
  readonly utmSource: string | null;
  readonly utmMedium: string | null;
  readonly utmCampaign: string | null;
  readonly utmContent: string | null;
  readonly utmTerm: string | null;
  readonly matchType: string | null;
  readonly campaignId: string | null;
  readonly adGroupId: string | null;
  readonly adId: string | null;
  readonly gclid: string | null;
  readonly gbraid: string | null;
  readonly wbraid: string | null;
  readonly fbclid: string | null;
  readonly msclkid: string | null;
  readonly ctwaClid: string | null;
  /** TikTok's click id and LinkedIn's, by the names each appends to a landing address. */
  readonly ttclid: string | null;
  readonly liFatId: string | null;
  /**
   * `source=` in the address: the name the link's writer gives the lead (GoHighLevel's
   * documented override of a form's Source). It names the lead source and nothing else: it
   * is not tracking, and no rule of the session source reads it.
   */
  readonly sourceParam: string | null;
  /** The host of the address the visitor came from; null when on the page's own site. */
  readonly referrerDomain: string | null;
  /** The page, without its query and fragment. */
  readonly landingUrl: string | null;
}

export const NO_VISIT: VisitFacts = {
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmContent: null,
  utmTerm: null,
  matchType: null,
  campaignId: null,
  adGroupId: null,
  adId: null,
  gclid: null,
  gbraid: null,
  wbraid: null,
  fbclid: null,
  msclkid: null,
  ctwaClid: null,
  ttclid: null,
  liFatId: null,
  sourceParam: null,
  referrerDomain: null,
  landingUrl: null,
};

/**
 * The query parameters read from a page's address, by what each fills: the first one
 * present wins. Nothing else of a query is kept, since a query can hold anything, a
 * visitor's own details included.
 */
export const PARAMETERS: Readonly<
  Record<Exclude<keyof VisitFacts, 'referrerDomain' | 'landingUrl'>, readonly string[]>
> = {
  utmSource: ['utm_source'],
  utmMedium: ['utm_medium'],
  utmCampaign: ['utm_campaign'],
  utmContent: ['utm_content'],
  utmTerm: ['utm_term', 'utm_keyword'],
  matchType: ['utm_matchtype', 'matchtype'],
  campaignId: ['campaign_id', 'utm_id'],
  adGroupId: ['ad_group_id', 'adgroup_id', 'adset_id'],
  adId: ['ad_id'],
  gclid: ['gclid'],
  gbraid: ['gbraid'],
  wbraid: ['wbraid'],
  fbclid: ['fbclid'],
  msclkid: ['msclkid'],
  ctwaClid: ['ctwa_clid'],
  // https://ads.tiktok.com/help/article/track-offsite-web-events-with-utm-parameters and
  // https://www.linkedin.com/help/lms/answer/a5968064.
  ttclid: ['ttclid'],
  liFatId: ['li_fat_id'],
  sourceParam: ['source'],
};

/**
 * The most characters a label, an id or a click id is kept with: every one of their
 * columns holds at most 200 (contact_attributions, migrations 0086 and 0091), and so does a
 * Source. A longer value is cut to its first 200, not left out: a gclid of 250 characters
 * still says the click came from a Google ad. Google publishes no maximum length for a
 * gclid, so no length is assumed to be enough. What is kept of a click id is then a prefix
 * and no longer the platform's id; nothing here sends one back to a platform, and only
 * whether one is present is ever read (lead-source-rules.ts, automations).
 */
const VALUE_LENGTH = 200;
const URL_LENGTH = 2000;
const DOMAIN_LENGTH = 255;
const ONE_LINE = /^\P{Cc}*$/u;

/**
 * A value cut to VALUE_LENGTH characters, counted as the database counts them (code points,
 * so a character outside the basic plane is never split in half), and trimmed again.
 */
const bounded = (value: string): string =>
  value.length <= VALUE_LENGTH ? value : Array.from(value).slice(0, VALUE_LENGTH).join('').trim();

const web = (address: string | undefined): URL | undefined => {
  if (address === undefined || address.length > URL_LENGTH || !URL.canParse(address))
    return undefined;
  const url = new URL(address);
  return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
};

/**
 * What is kept of a visit. Both addresses are whatever a browser said, so: only web
 * addresses are read; a value that is empty or not one line is left out; a label, an id or
 * a click id longer than 200 characters is cut to its first 200 (VALUE_LENGTH), so the
 * visit keeps its source; `source=` longer than 200 is left out, never cut, since it is
 * the lead's name word for word; the page is kept without its query and fragment; and of
 * the referrer only the host. With `pageOrigin`, a page that is not on that website is not
 * read at all (a form is admitted from one website, and says nothing about another).
 */
export function readVisit(
  visit: { readonly pageUrl?: string | undefined; readonly referrer?: string | undefined },
  pageOrigin?: string,
): VisitFacts {
  const read = web(visit.pageUrl);
  const page =
    read !== undefined && (pageOrigin === undefined || read.origin === pageOrigin)
      ? read
      : undefined;
  const facts: Record<string, string | null> = {};
  for (const [fact, names] of Object.entries(PARAMETERS)) {
    facts[fact] = null;
    for (const name of names) {
      const value = page?.searchParams.get(name)?.trim() ?? '';
      if (value === '' || !ONE_LINE.test(value)) continue;
      if (fact !== 'sourceParam') {
        facts[fact] = bounded(value);
        break;
      }
      if (value.length <= VALUE_LENGTH) {
        facts[fact] = value;
        break;
      }
    }
  }
  const landing = page === undefined ? null : `${page.origin}${page.pathname}`;
  const from = web(visit.referrer)?.hostname.toLowerCase() ?? null;
  const ownSite = from !== null && from === page?.hostname.toLowerCase();
  return {
    ...NO_VISIT,
    ...facts,
    referrerDomain:
      from === null || from === '' || ownSite || from.length > DOMAIN_LENGTH ? null : from,
    landingUrl: landing !== null && landing.length <= URL_LENGTH ? landing : null,
  };
}

/** A click somebody paid for: its channel, and the platform that sold it when one is known. */
export interface PaidClick {
  readonly channel: 'paid_search' | 'paid_social';
  readonly platform: Platform | undefined;
  /** What decided: the article's rule 1, 2 or 4, or one of ours (4a to 4c). */
  readonly rule: 1 | 2 | 4 | 'ours';
}

/**
 * Whether the visit was a paid click, and whose: the article's rules 1, 2 and 4 in their
 * order, then ours. Rule 3 (a labelled visit from Google) is the session source's alone
 * and sits between 2 and 4 there. Both the session source and the lead source are read
 * from this one answer.
 */
export function paidClickOf(visit: VisitFacts): PaidClick | undefined {
  const source = visit.utmSource?.toLowerCase() ?? '';
  if (source.includes('adwords')) return { channel: 'paid_search', platform: 'google', rule: 1 };
  if (visit.gclid !== null || visit.wbraid !== null || visit.gbraid !== null)
    return { channel: 'paid_search', platform: 'google', rule: 2 };
  if (visit.msclkid !== null) return { channel: 'paid_search', platform: 'microsoft', rule: 2 };
  const platform = platformOf(visit);
  if (PAID_SOCIAL_SOURCES.some((name) => source.includes(name)) || visit.ctwaClid !== null) {
    // Which social platform, when the visit says: a click-to-WhatsApp id is Meta's, so it
    // is Facebook unless the link or the site names Instagram.
    const social = isSocialPlatform(platform) ? platform : undefined;
    return {
      channel: 'paid_social',
      platform: social ?? (visit.ctwaClid === null ? undefined : 'facebook'),
      rule: 4,
    };
  }
  // Ours (4a to 4c): what the link names decides before the site they came from does.
  if (platform === undefined || !hasPaidMarker(visit)) return undefined;
  return {
    channel: isSearchPlatform(platform) ? 'paid_search' : 'paid_social',
    platform,
    rule: 'ours',
  };
}

/** The mediums that are a visit to a page: their session source is decided by the visit. */
const WEB: ReadonlySet<AttributionMedium> = new Set(['form', 'calendar', 'chat']);

const FIXED: Readonly<
  Record<Exclude<AttributionMedium, 'form' | 'calendar' | 'chat'>, SessionSource>
> = {
  manual: 'crm_ui',
  api: 'third_party',
  import: 'third_party',
  automation: 'third_party',
  assistant: 'third_party',
  message: 'others',
  unknown: 'others',
};

const isWeb = (medium: AttributionMedium): medium is 'form' | 'calendar' | 'chat' =>
  WEB.has(medium);

/** The session source of a touch: the rules at the top of this file, in their order. */
export function sessionSourceOf(medium: AttributionMedium, visit: VisitFacts): SessionSource {
  if (!isWeb(medium)) return FIXED[medium];
  const referrer = visit.referrerDomain;
  const paid = paidClickOf(visit);
  // Rules 1 and 2.
  if (paid !== undefined && (paid.rule === 1 || paid.rule === 2)) return paid.channel;
  // Rule 3.
  const utm = visit.utmSource !== null || visit.utmMedium !== null || visit.utmCampaign !== null;
  if (utm && referrer !== null && isGoogle(referrer)) return 'paid_search';
  // Rule 4, then ours.
  if (paid !== undefined) return paid.channel;
  if (referrer !== null)
    return isSocialSite(referrer)
      ? 'social_media'
      : isSearchEngine(referrer)
        ? 'organic_search'
        : 'referral';
  return isTracked(visit) ? 'others' : 'direct';
}

const UNTRACKED: ReadonlySet<string> = new Set(['landingUrl', 'referrerDomain', 'sourceParam']);

/** Whether the address carried a campaign label, an ad id or a click id. */
export function isTracked(visit: VisitFacts): boolean {
  return Object.entries(visit).some(([fact, value]) => !UNTRACKED.has(fact) && value !== null);
}

/** Whether a medium is a visit to a page: only such a touch has a lead source. */
export const isWebMedium = (medium: AttributionMedium): medium is 'form' | 'calendar' | 'chat' =>
  isWeb(medium);
