// The lead source of a touch: one short name for how a lead arrived, such as "Google Ads",
// worked out from the facts of the visit with no database. The same form on the same page
// gives two leads two names when one came from a Google ad and the other from a Facebook
// ad.
//
// The built-in rules, in the order they are tried. The first that fits decides.
//
//   1. source=… in the address                              -> that text
//      GoHighLevel's documented override ("Use the URL parameter when one form or survey
//      is shared across multiple campaigns or channels"):
//      https://help.gohighlevel.com/support/solutions/articles/155000001506-source-field-in-forms-and-surveys
//   2. a Google click id (gclid, gbraid, wbraid), utm_source containing "adwords",
//      or Google with a paid marker                         -> Google Ads
//   3. a Microsoft click id (msclkid),
//      or Bing or Microsoft with a paid marker              -> Microsoft Ads
//   4. a click-to-WhatsApp id (ctwa_clid),
//      or Facebook or Instagram with a paid marker          -> Facebook Ads, Instagram Ads
//   5. TikTok with a paid marker                            -> TikTok Ads
//   6. LinkedIn with a paid marker                          -> LinkedIn Ads
//   7. a paid medium, or utm_source ending "_ad"            -> Paid (other)
//   8. utm_medium or utm_source is email                    -> Email
//      utm_medium is sms                                    -> SMS
//   9. a search engine                                      -> Organic Search
//  10. a social site                                        -> Facebook, Instagram, LinkedIn,
//                                                              TikTok, YouTube, X, or Social
//  11. any other site they came from                        -> Referral
//  12. campaign labels that no rule names                   -> Other
//  13. nothing                                              -> Direct
//
// "Google", "Facebook" and the rest are the visit's one platform (session-source.ts,
// platformOf): what utm_source names, else a click id only that platform writes, else the
// site the visitor came from. The paid marker is the one at the top of session-source.ts.
//
// Rules 2 to 6, and the paid clicks of rule 7 that have a platform, are not decided here:
// they are session-source.ts's one answer to "was this click paid for, and on whose
// platform" (paidClickOf), which the session source reads too. So a name that says Ads
// always sits beside a paid channel, and the published order decides between two
// platforms: a click-to-WhatsApp id on a link that says google and cpc is a Facebook ad
// here because it is Paid social there. A paid click on a platform with no name of its
// own in this list (YouTube, X, Yahoo, Reddit…) is "Paid (other)", also when what says
// paid is a campaign id or an ad id rather than the medium.
//
// What is a vendor's and what is ours:
// - the click id names are each vendor's own (gclid: Google's ValueTrack list; msclkid:
//   Microsoft's auto-tagging; ttclid: TikTok; li_fat_id: LinkedIn; all). gbraid and wbraid
//   arrive by Google's auto-tagging and are in GoHighLevel's own rule 2;
// - the paid medium expression and the email list (email, e-mail, e_mail, "e mail") are
//   Google Analytics' (https://support.google.com/analytics/answer/9756891);
// - everything else is ours: the order, "sms" as a medium, the words of utm_source that
//   name a platform, rule 12, and reading a click-to-WhatsApp id as a Facebook ad (the
//   article GoHighLevel publishes calls it Paid Social; which Meta app showed the ad is not
//   in the address).
//
// Two readings of 2026-10-14 (session-source.ts has both): a mailbox read in a browser
// (mail.google.com) is no search engine and names no platform, so an untagged link opened
// there is a Referral and a link tagged email is Email; and a campaign id or an ad id on a
// link whose medium is email or sms is no paid marker, so such a link stays Email or SMS
// wherever it was opened.
//
// A click that carries only fbclid is "Facebook", not "Facebook Ads" (the owner's decision
// of 2026-10-13): whether Meta adds fbclid to unpaid clicks too is not confirmed, so the id
// alone proves no payment. ttclid and li_fat_id alone are read the same way.
import {
  leadSourceLabels,
  type AttributionMedium,
  type LeadSourceKey,
  type NamedLeadSourceKey,
} from '@repo/contracts';

import {
  isEmailLink,
  isPaidMedium,
  isSmsLink,
  isTracked,
  isWebMedium,
  paidClickOf,
  platformOf,
  type Platform,
  type VisitFacts,
} from './session-source.js';

/** A touch's lead source: the rule that decided, and the name it gives. */
export interface LeadSource {
  readonly key: LeadSourceKey;
  /** One line, at most 200 characters: what a contact's Source and a tag show. */
  readonly label: string;
}

const named = (key: NamedLeadSourceKey): LeadSource => ({ key, label: leadSourceLabels[key] });

/** The platforms whose ads have a name of their own. Any other paid click is "Paid (other)". */
const ADS: Readonly<Partial<Record<Platform, NamedLeadSourceKey>>> = {
  google: 'google_ads',
  microsoft: 'microsoft_ads',
  facebook: 'facebook_ads',
  instagram: 'instagram_ads',
  tiktok: 'tiktok_ads',
  linkedin: 'linkedin_ads',
};

/** The rules of a visit to a page, in their order. */
export function leadSourceOfVisit(visit: VisitFacts): LeadSource {
  if (visit.sourceParam !== null) return { key: 'source_param', label: visit.sourceParam };
  const source = visit.utmSource?.toLowerCase() ?? '';
  // Rules 2 to 6: the one decision the session source reads too.
  const paid = paidClickOf(visit);
  if (paid !== undefined)
    return named((paid.platform === undefined ? undefined : ADS[paid.platform]) ?? 'paid_other');
  // Rule 7 where no platform is known: the channel has no name for it, the lead source has.
  if (isPaidMedium(visit.utmMedium) || source.endsWith('_ad')) return named('paid_other');
  const platform = platformOf(visit);
  if (isEmailLink(visit)) return named('email');
  if (isSmsLink(visit)) return named('sms');
  if (platform === 'google' || platform === 'microsoft' || platform === 'search')
    return named('organic_search');
  // What is left is a social site, and each has the key of its own name.
  if (platform !== undefined) return named(platform);
  if (visit.referrerDomain !== null) return named('referral');
  return named(isTracked(visit) ? 'other' : 'direct');
}

/**
 * The lead source of a touch. Only a visit to a page has one (a form, a booking, a chat):
 * a contact added by hand, by an import or by a message arrived by no address.
 */
export function leadSourceOf(medium: AttributionMedium, visit: VisitFacts): LeadSource | null {
  return isWebMedium(medium) ? leadSourceOfVisit(visit) : null;
}
