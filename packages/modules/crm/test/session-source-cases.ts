// The session-source rules as a table (crm: attribution/session-source.ts), one row for
// each rule of the published order and for each edge between two rules. The unit test and
// the Postgres test both run it.
import type { AttributionMedium, SessionSource } from '@repo/contracts';

export interface SessionSourceCase {
  readonly name: string;
  readonly medium: AttributionMedium;
  /** The page's address, with its query. */
  readonly pageUrl?: string;
  readonly referrer?: string;
  readonly expected: SessionSource;
}

const page = (query = ''): string => `https://www.harborlights.example/contact${query}`;

export const sessionSourceCases: readonly SessionSourceCase[] = [
  // 2026-10-14: a mailbox read in a browser is not the search site, and a message's own
  // campaign number is not an ad's.
  {
    name: 'a link with no label opened in Gmail (was organic search)',
    medium: 'form',
    pageUrl: page(),
    referrer: 'https://mail.google.com/',
    expected: 'referral',
  },
  {
    name: 'an email link opened in Gmail is not rule 3 (was paid search)',
    medium: 'form',
    pageUrl: page('?utm_source=newsletter&utm_medium=email'),
    referrer: 'https://mail.google.com/mail/u/0/',
    expected: 'referral',
  },
  {
    name: 'a link with no label opened in Yahoo Mail (was organic search)',
    medium: 'form',
    pageUrl: page(),
    referrer: 'https://mail.yahoo.com/',
    expected: 'referral',
  },
  {
    name: 'a paid medium opened in Gmail has no channel of its own (was paid search)',
    medium: 'form',
    pageUrl: page('?utm_medium=cpc'),
    referrer: 'https://mail.google.com/',
    expected: 'referral',
  },
  {
    name: 'a Google click id opened in Gmail is still paid search',
    medium: 'form',
    pageUrl: page('?gclid=abc'),
    referrer: 'https://mail.google.com/',
    expected: 'paid_search',
  },
  {
    name: 'an email link with a campaign id, having come from Facebook (was paid social)',
    medium: 'form',
    pageUrl: page('?utm_medium=email&utm_id=44'),
    referrer: 'https://www.facebook.com/',
    expected: 'social_media',
  },
  {
    name: 'an sms link with a campaign id, having come from Bing (was paid search)',
    medium: 'form',
    pageUrl: page('?utm_medium=sms&campaign_id=9'),
    referrer: 'https://www.bing.com/',
    expected: 'organic_search',
  },
  {
    name: 'an email link with a campaign id from the Google search site is still rule 3',
    medium: 'form',
    pageUrl: page('?utm_medium=email&utm_id=44'),
    referrer: 'https://www.google.com/',
    expected: 'paid_search',
  },
  {
    name: 'an email link that names Facebook, with an ad id (was paid social)',
    medium: 'form',
    pageUrl: page('?utm_source=facebook&utm_medium=email&ad_id=7'),
    expected: 'others',
  },
  // Rule 1: utm_source contains "adwords".
  {
    name: 'utm_source adwords',
    medium: 'form',
    pageUrl: page('?utm_source=adwords'),
    expected: 'paid_search',
  },
  {
    name: 'utm_source containing AdWords, any case',
    medium: 'form',
    pageUrl: page('?utm_source=Google-AdWords-KE'),
    expected: 'paid_search',
  },
  {
    name: 'adwords wins over a social referrer',
    medium: 'form',
    pageUrl: page('?utm_source=adwords'),
    referrer: 'https://www.facebook.com/',
    expected: 'paid_search',
  },
  // Rule 2: a Google or Microsoft click id.
  { name: 'gclid', medium: 'form', pageUrl: page('?gclid=abc'), expected: 'paid_search' },
  { name: 'wbraid', medium: 'calendar', pageUrl: page('?wbraid=abc'), expected: 'paid_search' },
  { name: 'gbraid', medium: 'chat', pageUrl: page('?gbraid=abc'), expected: 'paid_search' },
  { name: 'msclkid', medium: 'form', pageUrl: page('?msclkid=abc'), expected: 'paid_search' },
  {
    name: 'a click id wins over fb_ad',
    medium: 'form',
    pageUrl: page('?utm_source=fb_ad&gclid=abc'),
    expected: 'paid_search',
  },
  // Rule 3: any of the three UTM labels, and the referrer is Google.
  {
    name: 'utm_medium with a Google referrer',
    medium: 'form',
    pageUrl: page('?utm_medium=cpc'),
    referrer: 'https://www.google.com/',
    expected: 'paid_search',
  },
  {
    name: 'utm_campaign with a Google country referrer',
    medium: 'form',
    pageUrl: page('?utm_campaign=spring'),
    referrer: 'https://www.google.co.ke/search',
    expected: 'paid_search',
  },
  {
    name: 'utm_source with a Google referrer',
    medium: 'form',
    pageUrl: page('?utm_source=newsletter'),
    referrer: 'https://google.com',
    expected: 'paid_search',
  },
  {
    name: 'utm_content alone with a Google referrer is not paid',
    medium: 'form',
    pageUrl: page('?utm_content=banner'),
    referrer: 'https://www.google.com/',
    expected: 'organic_search',
  },
  {
    name: 'a UTM label with a Bing referrer is not rule 3',
    medium: 'form',
    pageUrl: page('?utm_campaign=spring'),
    referrer: 'https://www.bing.com/',
    expected: 'organic_search',
  },
  // Rule 4: paid social sources, and a WhatsApp click id.
  { name: 'fb_ad', medium: 'form', pageUrl: page('?utm_source=fb_ad'), expected: 'paid_social' },
  {
    name: 'linkedin_ad',
    medium: 'form',
    pageUrl: page('?utm_source=linkedin_ad'),
    expected: 'paid_social',
  },
  {
    name: 'twitter_ad',
    medium: 'form',
    pageUrl: page('?utm_source=twitter_ad'),
    expected: 'paid_social',
  },
  {
    name: 'reddit_ad',
    medium: 'form',
    pageUrl: page('?utm_source=reddit_ad'),
    expected: 'paid_social',
  },
  { name: 'ctwa_clid', medium: 'chat', pageUrl: page('?ctwa_clid=abc'), expected: 'paid_social' },
  {
    name: 'fb_ad wins over a search referrer',
    medium: 'form',
    pageUrl: page('?utm_source=fb_ad'),
    referrer: 'https://www.bing.com/',
    expected: 'paid_social',
  },
  // Ours, 4a and 4b: paid by a paid marker, after everything the article names. Each with what it
  // is now.
  {
    name: 'plan row 1: a Google ad with auto-tagging (gbraid)',
    medium: 'form',
    pageUrl: page('?gbraid=abc'),
    expected: 'paid_search',
  },
  {
    name: 'plan row 2: a Google ad with no click id, google and cpc, no referrer (was others)',
    medium: 'form',
    pageUrl: page('?utm_source=google&utm_medium=cpc'),
    expected: 'paid_search',
  },
  {
    name: 'plan row 2: the same with a Google referrer',
    medium: 'form',
    pageUrl: page('?utm_source=google&utm_medium=cpc'),
    referrer: 'https://www.google.com/',
    expected: 'paid_search',
  },
  {
    name: "plan row 3: a Meta ad with GoHighLevel's parameters",
    medium: 'form',
    pageUrl: page('?utm_source=fb_ad&utm_medium=Ad+set&utm_campaign=Spring&campaign_id=1'),
    expected: 'paid_social',
  },
  {
    name: 'plan row 4: a Meta ad with fbclid only, from Facebook, is still not proved paid',
    medium: 'form',
    pageUrl: page('?fbclid=abc'),
    referrer: 'https://l.facebook.com/',
    expected: 'social_media',
  },
  {
    name: 'plan row 5: facebook and cpc, from Facebook (was social media)',
    medium: 'form',
    pageUrl: page('?utm_source=facebook&utm_medium=cpc'),
    referrer: 'https://l.facebook.com/',
    expected: 'paid_social',
  },
  {
    name: 'plan row 5: facebook and cpc, no referrer (was others)',
    medium: 'form',
    pageUrl: page('?utm_source=facebook&utm_medium=cpc'),
    expected: 'paid_social',
  },
  {
    name: 'facebook and paid_social',
    medium: 'form',
    pageUrl: page('?utm_source=facebook&utm_medium=paid_social'),
    expected: 'paid_social',
  },
  {
    name: 'fbclid with a paid medium',
    medium: 'form',
    pageUrl: page('?fbclid=abc&utm_medium=paid'),
    expected: 'paid_social',
  },
  {
    name: 'fbclid with a campaign id',
    medium: 'calendar',
    pageUrl: page('?fbclid=abc&campaign_id=120211'),
    expected: 'paid_social',
  },
  {
    name: 'ttclid with a paid medium',
    medium: 'form',
    pageUrl: page('?ttclid=abc&utm_medium=cpc'),
    expected: 'paid_social',
  },
  {
    name: 'li_fat_id with a paid medium',
    medium: 'form',
    pageUrl: page('?li_fat_id=abc&utm_medium=cpc'),
    expected: 'paid_social',
  },
  {
    name: 'tiktok and cpc',
    medium: 'form',
    pageUrl: page('?utm_source=tiktok&utm_medium=cpc'),
    expected: 'paid_social',
  },
  {
    name: 'instagram and an ad id',
    medium: 'form',
    pageUrl: page('?utm_source=instagram&ad_id=9'),
    expected: 'paid_social',
  },
  {
    name: 'a paid medium, having come from Instagram',
    medium: 'form',
    pageUrl: page('?utm_medium=cpc'),
    referrer: 'https://www.instagram.com/',
    expected: 'paid_social',
  },
  {
    name: 'x and ppc',
    medium: 'form',
    pageUrl: page('?utm_source=x&utm_medium=ppc'),
    expected: 'paid_social',
  },
  {
    name: 'bing and cpc, no click id',
    medium: 'form',
    pageUrl: page('?utm_source=bing&utm_medium=cpc'),
    expected: 'paid_search',
  },
  {
    name: 'what the link names decides before the site: google and cpc from Facebook',
    medium: 'form',
    pageUrl: page('?utm_source=google&utm_medium=cpc'),
    referrer: 'https://www.facebook.com/',
    expected: 'paid_search',
  },
  // Ours, 4c: a search engine they came from, with a paid marker. Before it, each of
  // these read Organic search while the lead source beside it said Ads.
  {
    name: 'a paid medium, having come from Bing (was organic search)',
    medium: 'form',
    pageUrl: page('?utm_medium=cpc'),
    referrer: 'https://www.bing.com/',
    expected: 'paid_search',
  },
  {
    name: 'a campaign id, having come from Yahoo (was organic search)',
    medium: 'form',
    pageUrl: page('?campaign_id=5'),
    referrer: 'https://uk.search.yahoo.com/',
    expected: 'paid_search',
  },
  {
    name: 'an ad id and no label, having come from Google (was organic search)',
    medium: 'form',
    pageUrl: page('?ad_id=9'),
    referrer: 'https://www.google.com/',
    expected: 'paid_search',
  },
  {
    name: 'a paid medium on a source that names no platform, having come from DuckDuckGo',
    medium: 'form',
    pageUrl: page('?utm_source=taboola&utm_medium=cpc'),
    referrer: 'https://duckduckgo.com/',
    expected: 'paid_search',
  },
  {
    name: 'what the link names still decides before the site: facebook and cpc from Bing',
    medium: 'form',
    pageUrl: page('?utm_source=facebook&utm_medium=cpc'),
    referrer: 'https://www.bing.com/',
    expected: 'paid_social',
  },
  {
    name: 'rule 4 before ours: a click-to-WhatsApp id on a link that says google and cpc',
    medium: 'form',
    pageUrl: page('?utm_source=google&utm_medium=cpc&ctwa_clid=abc'),
    expected: 'paid_social',
  },
  {
    name: 'facebook named by the link with no paid marker, no referrer',
    medium: 'form',
    pageUrl: page('?utm_source=facebook&utm_medium=social'),
    expected: 'others',
  },
  {
    name: 'a paid medium on a source that names no platform',
    medium: 'form',
    pageUrl: page('?utm_source=taboola&utm_medium=cpc'),
    expected: 'others',
  },
  { name: 'ttclid alone', medium: 'form', pageUrl: page('?ttclid=abc'), expected: 'others' },
  // source= names the lead source and is not tracking.
  { name: 'source= alone', medium: 'form', pageUrl: page('?source=Flyer'), expected: 'direct' },
  // Rule 5: a social site.
  {
    name: 'a Facebook referrer',
    medium: 'form',
    pageUrl: page(),
    referrer: 'https://l.facebook.com/l.php',
    expected: 'social_media',
  },
  {
    name: 'an Instagram referrer',
    medium: 'form',
    pageUrl: page(),
    referrer: 'https://www.instagram.com/',
    expected: 'social_media',
  },
  {
    name: 't.co',
    medium: 'form',
    pageUrl: page(),
    referrer: 'https://t.co/abc',
    expected: 'social_media',
  },
  {
    name: 'a LinkedIn short link',
    medium: 'form',
    pageUrl: page(),
    referrer: 'https://lnkd.in/abc',
    expected: 'social_media',
  },
  {
    name: 'fbclid decides nothing: the referrer does',
    medium: 'form',
    pageUrl: page('?fbclid=abc'),
    referrer: 'https://m.facebook.com/',
    expected: 'social_media',
  },
  // Rule 6: a search engine.
  {
    name: 'a Google referrer with no label',
    medium: 'form',
    pageUrl: page(),
    referrer: 'https://www.google.com/',
    expected: 'organic_search',
  },
  {
    name: 'Yahoo',
    medium: 'form',
    pageUrl: page(),
    referrer: 'https://uk.search.yahoo.com/',
    expected: 'organic_search',
  },
  {
    name: 'Bing',
    medium: 'calendar',
    pageUrl: page(),
    referrer: 'https://www.bing.com/',
    expected: 'organic_search',
  },
  {
    name: 'DuckDuckGo',
    medium: 'form',
    pageUrl: page(),
    referrer: 'https://duckduckgo.com/',
    expected: 'organic_search',
  },
  {
    name: 'Brave Search',
    medium: 'form',
    pageUrl: page(),
    referrer: 'https://search.brave.com/',
    expected: 'organic_search',
  },
  // Rule 7: any other site.
  {
    name: 'another site',
    medium: 'form',
    pageUrl: page(),
    referrer: 'https://blog.partner.example/post',
    expected: 'referral',
  },
  {
    name: 'a site whose name only ends like a short social one',
    medium: 'form',
    pageUrl: page(),
    referrer: 'https://notx.com/',
    expected: 'referral',
  },
  {
    name: 'a site under a top-level domain named google',
    medium: 'form',
    pageUrl: page(),
    referrer: 'https://about.google/',
    expected: 'referral',
  },
  {
    name: 'a UTM label that names no rule, with a referrer',
    medium: 'form',
    pageUrl: page('?utm_source=newsletter'),
    referrer: 'https://mail.partner.example/',
    expected: 'referral',
  },
  // Rule 8: nothing at all.
  { name: 'no referrer and no tracking', medium: 'form', pageUrl: page(), expected: 'direct' },
  { name: 'no page and no referrer', medium: 'calendar', expected: 'direct' },
  {
    name: 'a referrer on the page’s own site is no referrer',
    medium: 'form',
    pageUrl: page(),
    referrer: 'https://www.harborlights.example/pricing',
    expected: 'direct',
  },
  {
    name: 'an address that is not the web’s',
    medium: 'form',
    pageUrl: page(),
    referrer: 'android-app://com.example/',
    expected: 'direct',
  },
  // Rule 9: tracking that no rule above names, and messages.
  {
    name: 'a UTM label that names no rule, with no referrer',
    medium: 'form',
    pageUrl: page('?utm_source=newsletter'),
    expected: 'others',
  },
  { name: 'fbclid alone', medium: 'form', pageUrl: page('?fbclid=abc'), expected: 'others' },
  { name: 'a message', medium: 'message', expected: 'others' },
  { name: 'unknown', medium: 'unknown', expected: 'others' },
  // Rules 10 and 11: by hand, and by an integration. A visit says nothing for them.
  {
    name: 'made by hand',
    medium: 'manual',
    pageUrl: page('?utm_source=adwords'),
    expected: 'crm_ui',
  },
  { name: 'the API', medium: 'api', expected: 'third_party' },
  { name: 'an import', medium: 'import', expected: 'third_party' },
  { name: 'an automation', medium: 'automation', expected: 'third_party' },
  { name: 'an assistant', medium: 'assistant', expected: 'third_party' },
];
