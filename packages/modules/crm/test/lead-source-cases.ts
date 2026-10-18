// The lead source rules as a table (crm: attribution/lead-source.ts), one row for each
// built-in rule, for each way a rule can be met, and for each edge between two rules. The
// unit test runs it; the Postgres test stores each visit as a touch and reads the same name
// back; packages/db/src/lead-source-backfill.int.test.ts holds migration 0091's SQL to the
// same outcomes for the rows it can store.
import type { LeadSourceKey } from '@repo/contracts';

export interface LeadSourceCase {
  readonly name: string;
  /** The query of the page's address, with its question mark, or nothing. */
  readonly query?: string;
  readonly referrer?: string;
  readonly expected: LeadSourceKey;
  /** The name, where the rule does not fix it (`source=`). */
  readonly label?: string;
}

export const leadSourcePage = (query = ''): string =>
  `https://www.harborlights.example/offer${query}`;

export const leadSourceCases: readonly LeadSourceCase[] = [
  // Rule 1: source= in the address, GoHighLevel's override. It beats everything.
  {
    name: 'source= alone',
    query: '?source=Spring%20flyer',
    expected: 'source_param',
    label: 'Spring flyer',
  },
  {
    name: 'source= beats a Google click id',
    query: '?source=Radio&gclid=abc',
    expected: 'source_param',
    label: 'Radio',
  },
  {
    name: 'source= beats the site they came from',
    query: '?source=Partner+deal',
    referrer: 'https://www.facebook.com/',
    expected: 'source_param',
    label: 'Partner deal',
  },
  { name: 'an empty source= is no source', query: '?source=&gclid=abc', expected: 'google_ads' },
  { name: 'utm_source is not source', query: '?utm_source=flyer', expected: 'other' },

  // Rule 2: Google Ads.
  { name: 'gclid', query: '?gclid=abc', expected: 'google_ads' },
  { name: 'gbraid', query: '?gbraid=abc', expected: 'google_ads' },
  { name: 'wbraid', query: '?wbraid=abc', expected: 'google_ads' },
  { name: 'utm_source adwords', query: '?utm_source=adwords', expected: 'google_ads' },
  {
    name: 'utm_source containing AdWords, any case',
    query: '?utm_source=Google-AdWords-US',
    expected: 'google_ads',
  },
  {
    name: 'google with cpc and no click id',
    query: '?utm_source=google&utm_medium=cpc',
    expected: 'google_ads',
  },
  {
    name: 'google with a paid medium in capitals',
    query: '?utm_source=Google&utm_medium=PPC',
    expected: 'google_ads',
  },
  {
    name: 'google with a campaign id',
    query: '?utm_source=google&campaign_id=111',
    expected: 'google_ads',
  },
  {
    name: 'a paid medium, having come from Google',
    query: '?utm_medium=cpc',
    referrer: 'https://www.google.com/',
    expected: 'google_ads',
  },
  {
    name: 'a Google click id beats a Facebook source',
    query: '?utm_source=facebook&utm_medium=cpc&gclid=abc',
    expected: 'google_ads',
  },
  {
    name: 'a Google click id beats a Microsoft one',
    query: '?gclid=abc&msclkid=def',
    expected: 'google_ads',
  },

  // Rule 3: Microsoft Ads.
  { name: 'msclkid', query: '?msclkid=abc', expected: 'microsoft_ads' },
  {
    name: 'bing with cpc',
    query: '?utm_source=bing&utm_medium=cpc',
    expected: 'microsoft_ads',
  },
  {
    name: 'microsoft with a paid medium',
    query: '?utm_source=microsoft&utm_medium=paid',
    expected: 'microsoft_ads',
  },
  {
    name: 'a paid medium, having come from Bing',
    query: '?utm_medium=ppc',
    referrer: 'https://www.bing.com/',
    expected: 'microsoft_ads',
  },

  // Rule 4: Facebook Ads and Instagram Ads.
  { name: "GoHighLevel's fb_ad", query: '?utm_source=fb_ad', expected: 'facebook_ads' },
  {
    name: 'facebook with cpc',
    query: '?utm_source=facebook&utm_medium=cpc',
    expected: 'facebook_ads',
  },
  {
    name: 'facebook with paid_social',
    query: '?utm_source=facebook&utm_medium=paid_social',
    expected: 'facebook_ads',
  },
  { name: 'meta with paid', query: '?utm_source=meta&utm_medium=paid', expected: 'facebook_ads' },
  {
    name: 'fbclid with a paid medium',
    query: '?fbclid=abc&utm_medium=paidsocial',
    expected: 'facebook_ads',
  },
  {
    name: 'fbclid with a campaign id',
    query: '?fbclid=abc&campaign_id=120211',
    expected: 'facebook_ads',
  },
  { name: 'fbclid with an ad id', query: '?fbclid=abc&ad_id=77', expected: 'facebook_ads' },
  {
    name: 'a paid medium, having come from Facebook',
    query: '?utm_medium=cpc',
    referrer: 'https://l.facebook.com/l.php',
    expected: 'facebook_ads',
  },
  { name: 'a click-to-WhatsApp id', query: '?ctwa_clid=abc', expected: 'facebook_ads' },
  {
    name: 'instagram with cpc',
    query: '?utm_source=instagram&utm_medium=cpc',
    expected: 'instagram_ads',
  },
  {
    name: 'ig with a paid medium',
    query: '?utm_source=ig&utm_medium=paid_social',
    expected: 'instagram_ads',
  },
  {
    name: 'instagram named by the link, with fbclid and an ad id',
    query: '?utm_source=instagram&fbclid=abc&ad_id=9',
    expected: 'instagram_ads',
  },
  {
    name: 'a paid medium, having come from Instagram',
    query: '?utm_medium=retargeting',
    referrer: 'https://www.instagram.com/',
    expected: 'instagram_ads',
  },
  {
    name: 'a click-to-WhatsApp id on a link that names Instagram',
    query: '?utm_source=instagram&ctwa_clid=abc',
    expected: 'instagram_ads',
  },

  {
    name: 'a click-to-WhatsApp id on a link that says google and cpc (was Google Ads)',
    query: '?utm_source=google&utm_medium=cpc&ctwa_clid=abc',
    expected: 'facebook_ads',
  },

  // Rules 5 and 6: TikTok Ads and LinkedIn Ads.
  { name: 'tiktok with cpc', query: '?utm_source=tiktok&utm_medium=cpc', expected: 'tiktok_ads' },
  {
    name: 'ttclid with a paid medium',
    query: '?ttclid=abc&utm_medium=paid',
    expected: 'tiktok_ads',
  },
  { name: 'ttclid with a campaign id', query: '?ttclid=abc&campaign_id=5', expected: 'tiktok_ads' },
  {
    name: 'linkedin with cpc',
    query: '?utm_source=linkedin&utm_medium=cpc',
    expected: 'linkedin_ads',
  },
  { name: "GoHighLevel's linkedin_ad", query: '?utm_source=linkedin_ad', expected: 'linkedin_ads' },
  {
    name: 'li_fat_id with a paid medium',
    query: '?li_fat_id=abc&utm_medium=paid_social',
    expected: 'linkedin_ads',
  },

  // Rule 7: paid, on a platform with no name of its own here.
  { name: 'a paid medium alone', query: '?utm_medium=cpc', expected: 'paid_other' },
  {
    name: 'a paid medium on an unknown source',
    query: '?utm_source=taboola&utm_medium=cpc',
    expected: 'paid_other',
  },
  { name: "GoHighLevel's twitter_ad", query: '?utm_source=twitter_ad', expected: 'paid_other' },
  { name: "GoHighLevel's reddit_ad", query: '?utm_source=reddit_ad', expected: 'paid_other' },
  { name: 'x with cpc', query: '?utm_source=x&utm_medium=cpc', expected: 'paid_other' },
  {
    name: 'a paid medium, having come from Yahoo',
    query: '?utm_medium=cpc',
    referrer: 'https://uk.search.yahoo.com/',
    expected: 'paid_other',
  },
  // Paid by a campaign id or an ad id on a platform with no name of its own: the channel
  // beside each of these is paid, so the name is too.
  {
    name: 'youtube with a campaign id (was YouTube)',
    query: '?utm_source=youtube&campaign_id=5',
    expected: 'paid_other',
  },
  {
    name: 'yahoo with an ad id (was Organic Search)',
    query: '?utm_source=yahoo&ad_id=5',
    expected: 'paid_other',
  },
  {
    name: 'an ad id, having come from Reddit (was Social)',
    query: '?ad_id=5',
    referrer: 'https://www.reddit.com/',
    expected: 'paid_other',
  },
  {
    name: 'a source that only contains fb_ad and names no platform (was Other)',
    query: '?utm_source=myfb_ads',
    expected: 'paid_other',
  },
  {
    name: 'a campaign id alone is not a paid medium',
    query: '?utm_source=taboola&campaign_id=5',
    expected: 'other',
  },

  // Rule 8: email and SMS.
  { name: 'utm_medium email', query: '?utm_source=newsletter&utm_medium=email', expected: 'email' },
  { name: 'utm_medium e-mail', query: '?utm_medium=E-mail', expected: 'email' },
  { name: 'utm_source email', query: '?utm_source=email', expected: 'email' },
  {
    name: 'an email link opened from a webmail site',
    query: '?utm_medium=email',
    referrer: 'https://mail.partner.example/',
    expected: 'email',
  },
  {
    name: 'an email link with a campaign id is still email',
    query: '?utm_source=newsletter&utm_medium=email&utm_id=44',
    expected: 'email',
  },
  { name: 'utm_medium sms', query: '?utm_source=reminder&utm_medium=sms', expected: 'sms' },
  { name: 'a medium that only contains email', query: '?utm_medium=emailer', expected: 'other' },
  // 2026-10-14: a message's own campaign number is not an ad's, wherever the link was opened.
  {
    name: 'an email link with a campaign id, having come from Facebook (was Facebook Ads)',
    query: '?utm_medium=email&utm_id=44',
    referrer: 'https://www.facebook.com/',
    expected: 'email',
  },
  {
    name: 'an email link with a campaign id, having come from Google (was Google Ads)',
    query: '?utm_medium=email&utm_id=44',
    referrer: 'https://www.google.com/',
    expected: 'email',
  },
  {
    name: 'an email link with an ad id that names Facebook (was Facebook Ads)',
    query: '?utm_source=facebook&utm_medium=email&ad_id=7',
    expected: 'email',
  },
  {
    name: 'an sms link with a campaign id, having come from Facebook (was Facebook Ads)',
    query: '?utm_medium=sms&campaign_id=9',
    referrer: 'https://www.facebook.com/',
    expected: 'sms',
  },
  {
    name: 'fb_ad still marks an ad on a link that says email',
    query: '?utm_source=fb_ad&utm_medium=email&utm_id=44',
    expected: 'facebook_ads',
  },
  // 2026-10-14: a mailbox read in a browser is no search engine.
  {
    name: 'an email link with a campaign id, opened in Gmail (was Google Ads)',
    query: '?utm_source=newsletter&utm_medium=email&utm_id=44',
    referrer: 'https://mail.google.com/',
    expected: 'email',
  },
  {
    name: 'an email link opened in Gmail',
    query: '?utm_medium=email',
    referrer: 'https://mail.google.com/mail/u/0/',
    expected: 'email',
  },
  {
    name: 'a link with no label opened in Gmail (was Organic Search)',
    referrer: 'https://mail.google.com/',
    expected: 'referral',
  },
  {
    name: 'a link with no label opened in Yahoo Mail (was Organic Search)',
    referrer: 'https://mail.yahoo.com/',
    expected: 'referral',
  },
  {
    name: 'a link with no label opened in Outlook on the web',
    referrer: 'https://outlook.live.com/',
    expected: 'referral',
  },
  {
    name: 'a paid medium opened in Gmail names no platform (was Google Ads)',
    query: '?utm_medium=cpc',
    referrer: 'https://mail.google.com/',
    expected: 'paid_other',
  },
  {
    name: 'a Google click id opened in Gmail is still a Google ad',
    query: '?gclid=abc',
    referrer: 'https://mail.google.com/',
    expected: 'google_ads',
  },

  // Rule 9: organic search.
  {
    name: 'having come from Google',
    referrer: 'https://www.google.com/',
    expected: 'organic_search',
  },
  { name: 'having come from Bing', referrer: 'https://www.bing.com/', expected: 'organic_search' },
  {
    name: 'having come from DuckDuckGo',
    referrer: 'https://duckduckgo.com/',
    expected: 'organic_search',
  },
  {
    name: 'having come from Brave Search',
    referrer: 'https://search.brave.com/',
    expected: 'organic_search',
  },
  {
    name: 'google named by the link, unpaid',
    query: '?utm_source=google&utm_medium=organic',
    expected: 'organic_search',
  },

  // Rule 10: a social site, by its name.
  { name: 'having come from Facebook', referrer: 'https://m.facebook.com/', expected: 'facebook' },
  { name: 'fbclid alone', query: '?fbclid=abc', expected: 'facebook' },
  {
    name: 'fbclid, having come from Instagram',
    query: '?fbclid=abc',
    referrer: 'https://l.instagram.com/',
    expected: 'instagram',
  },
  {
    name: 'fbclid with a paid medium, having come from Instagram',
    query: '?fbclid=abc&utm_medium=cpc',
    referrer: 'https://l.instagram.com/',
    expected: 'instagram_ads',
  },
  {
    name: 'facebook named by the link, unpaid',
    query: '?utm_source=facebook&utm_medium=social',
    expected: 'facebook',
  },
  {
    name: 'having come from Instagram',
    referrer: 'https://www.instagram.com/',
    expected: 'instagram',
  },
  {
    name: 'having come from LinkedIn',
    referrer: 'https://www.linkedin.com/',
    expected: 'linkedin',
  },
  { name: 'a LinkedIn short link', referrer: 'https://lnkd.in/abc', expected: 'linkedin' },
  { name: 'li_fat_id alone', query: '?li_fat_id=abc', expected: 'linkedin' },
  { name: 'having come from TikTok', referrer: 'https://www.tiktok.com/', expected: 'tiktok' },
  { name: 'ttclid alone', query: '?ttclid=abc', expected: 'tiktok' },
  { name: 'having come from YouTube', referrer: 'https://www.youtube.com/', expected: 'youtube' },
  { name: 'a YouTube short link', referrer: 'https://youtu.be/abc', expected: 'youtube' },
  { name: 'having come from X', referrer: 'https://x.com/', expected: 'x' },
  { name: 't.co', referrer: 'https://t.co/abc', expected: 'x' },
  { name: 'having come from Reddit', referrer: 'https://www.reddit.com/', expected: 'social' },
  { name: 'pinterest named by the link', query: '?utm_source=pinterest', expected: 'social' },

  // Rule 11: any other site.
  { name: 'another site', referrer: 'https://blog.partner.example/post', expected: 'referral' },
  {
    name: 'a label no rule names, having come from another site',
    query: '?utm_source=partner',
    referrer: 'https://blog.partner.example/',
    expected: 'referral',
  },
  {
    name: 'a site whose name only ends like a short social one',
    referrer: 'https://notx.com/',
    expected: 'referral',
  },

  // Rule 12: labels no rule names.
  { name: 'utm_campaign alone', query: '?utm_campaign=spring', expected: 'other' },
  { name: 'a source that names nothing', query: '?utm_source=fbx', expected: 'other' },

  // Rule 13: nothing.
  { name: 'no label and no site', expected: 'direct' },
  {
    name: 'a page on the same site before it',
    referrer: 'https://www.harborlights.example/pricing',
    expected: 'direct',
  },
  { name: 'a parameter nobody reads', query: '?ref=homepage', expected: 'direct' },
];
