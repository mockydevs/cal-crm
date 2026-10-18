import { describe, expect, it } from 'vitest';

import { leadSourceKeys } from './lead-sources.js';
import { ATTRIBUTION_PARAMETERS } from './reporting-attribution.js';
import {
  buildTrackingLink,
  defaultTrackingLinkTemplate,
  sampleTrackingLink,
  TRACKING_LINK_CATALOGUE_VERSION,
  trackingLinkPlatforms,
  trackingLinkTemplate,
  trackingLinkTemplates,
} from './tracking-links.js';

const text = (input: Parameters<typeof buildTrackingLink>[0]): string => {
  const built = buildTrackingLink(input);
  if (!built.ok) throw new Error(built.code);
  return built.text;
};

describe('the catalogue', () => {
  it('is versioned, and each template is whole', () => {
    expect(TRACKING_LINK_CATALOGUE_VERSION).toBe(1);
    const ids = trackingLinkTemplates.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'google_ads_suffix',
      'google_ads_tracking_template',
      'microsoft_ads_suffix',
      'microsoft_ads_tracking_template',
      'meta_ads',
      'meta_ads_by_app',
      'meta_ads_ghl',
      'tiktok_ads',
      'linkedin_ads',
      'email',
      'named_source',
    ]);
    const read: readonly string[] = ATTRIBUTION_PARAMETERS;
    for (const template of trackingLinkTemplates) {
      expect(trackingLinkPlatforms, template.id).toContain(template.platform);
      expect(leadSourceKeys, template.id).toContain(template.leadSource);
      expect(template.where, template.id).not.toBe('');
      expect(template.notes.length, template.id).toBeGreaterThan(0);
      // A template of an ad platform says where its placeholders were read.
      if (template.parameters.some((parameter) => parameter.kind === 'placeholder'))
        expect(template.sources.length, template.id).toBeGreaterThan(0);
      for (const source of template.sources) expect(source.url).toMatch(/^https:\/\//u);
      const names = template.parameters.map((parameter) => parameter.name);
      expect(new Set(names).size, template.id).toBe(names.length);
      for (const parameter of template.parameters) {
        // Every parameter is one the CRM reads, or is marked as the advertiser's own.
        if (!parameter.fills.startsWith('Not kept'))
          expect(read, `${template.id} ${parameter.name}`).toContain(parameter.name);
        // What a person may reword is a label, never an id the reports join on.
        if (parameter.editable) expect(parameter.name).not.toMatch(/_id$/u);
      }
    }
    for (const platform of trackingLinkPlatforms)
      expect(defaultTrackingLinkTemplate(platform)?.platform, platform).toBe(platform);
    expect(trackingLinkTemplate('nope')).toBeUndefined();
  });

  it('writes each vendor’s placeholders exactly as the vendor documents them', () => {
    const placeholders = (id: string) =>
      trackingLinkTemplate(id)
        ?.parameters.filter((parameter) => parameter.kind === 'placeholder')
        .map((parameter) => parameter.value);
    // Google's ValueTrack list (support.google.com/google-ads/answer/6305348).
    expect(new Set(placeholders('google_ads_suffix'))).toEqual(
      new Set([
        '{campaignid}',
        '{adgroupid}',
        '{creative}',
        '{keyword}',
        '{matchtype}',
        '{device}',
        '{network}',
      ]),
    );
    // Microsoft's own example, in its casing.
    expect(new Set(placeholders('microsoft_ads_suffix'))).toEqual(
      new Set(['{CampaignID}', '{AdGroupID}', '{AdID}', '{Keyword}']),
    );
    // Meta Business Help 2360940870872492.
    expect(placeholders('meta_ads')).toEqual([
      '{{campaign.name}}',
      '{{ad.name}}',
      '{{campaign.id}}',
      '{{adset.id}}',
      '{{ad.id}}',
    ]);
    expect(placeholders('meta_ads_by_app')?.[0]).toBe('{{site_source_name}}');
    expect(placeholders('tiktok_ads')).toEqual([
      '__CAMPAIGN_NAME__',
      '__CID_NAME__',
      '__CAMPAIGN_ID__',
      '__AID__',
      '__CID__',
    ]);
    // LinkedIn's set since October 2025.
    expect(placeholders('linkedin_ads')).toEqual([
      '{{CAMPAIGN_NAME}}',
      '{{AD_NAME}}',
      '{{CAMPAIGN_ID}}',
      '{{AD_SET_ID}}',
      '{{AD_ID}}',
    ]);
    // What could not be read in the vendor's own pages is said, not hidden.
    expect(
      trackingLinkTemplates.filter((template) => !template.verified).map((template) => template.id),
    ).toEqual(['google_ads_suffix', 'linkedin_ads']);
  });
});

describe('the builder', () => {
  it('gives a suffix with no question mark, placeholders as written', () => {
    expect(text({ templateId: 'google_ads_suffix' })).toBe(
      'utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={adgroupid}&utm_term={keyword}&matchtype={matchtype}&campaign_id={campaignid}&ad_group_id={adgroupid}&ad_id={creative}&device={device}&network={network}',
    );
    expect(text({ templateId: 'microsoft_ads_suffix' })).toBe(
      'utm_source=bing&utm_medium=cpc&utm_campaign={CampaignID}&utm_term={Keyword}&campaign_id={CampaignID}&ad_group_id={AdGroupID}&ad_id={AdID}',
    );
    // A suffix never takes the page's address: the platform adds its own final URL.
    expect(
      buildTrackingLink({ templateId: 'meta_ads', baseUrl: 'https://x.example/' }),
    ).toMatchObject({ ok: true, kind: 'suffix' });
  });

  it('gives a tracking template that begins with {lpurl}', () => {
    const google = buildTrackingLink({ templateId: 'google_ads_tracking_template' });
    expect(google).toMatchObject({ ok: true, kind: 'tracking_template' });
    expect(google.ok && google.text.startsWith('{lpurl}?utm_source=google&utm_medium=cpc&')).toBe(
      true,
    );
    expect(text({ templateId: 'microsoft_ads_tracking_template' })).toBe(
      `{lpurl}?${text({ templateId: 'microsoft_ads_suffix' })}`,
    );
  });

  it('puts a person’s own words where a template lets them, encoded, and ignores the rest', () => {
    expect(
      text({
        templateId: 'meta_ads',
        values: {
          utm_campaign: 'Spring & Summer',
          utm_source: 'mine',
          campaign_id: '1',
          utm_content: ' ',
        },
      }),
    ).toBe(
      'utm_source=facebook&utm_medium=paid_social&utm_campaign=Spring%20%26%20Summer&utm_content={{ad.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}',
    );
    expect(text({ templateId: 'named_source', values: { source: 'Spring flyer' } })).toBe(
      'source=Spring%20flyer',
    );
  });

  it('gives a whole link for a template that goes on the address, keeping the page’s own query', () => {
    expect(
      text({
        templateId: 'email',
        baseUrl: ' https://www.example.com/offer?ref=a&utm_source=old#top ',
        values: { utm_source: 'october news', utm_campaign: 'oct' },
      }),
    ).toBe(
      'https://www.example.com/offer?ref=a&utm_source=october%20news&utm_medium=email&utm_campaign=oct#top',
    );
    const tiktok = buildTrackingLink({
      templateId: 'tiktok_ads',
      baseUrl: 'https://www.example.com',
    });
    expect(tiktok).toMatchObject({ ok: true, kind: 'link' });
    expect(tiktok.ok && tiktok.text).toBe(
      'https://www.example.com?utm_source=tiktok&utm_medium=paid_social&utm_campaign=__CAMPAIGN_NAME__&utm_content=__CID_NAME__&campaign_id=__CAMPAIGN_ID__&adgroup_id=__AID__&ad_id=__CID__',
    );
    // With no page, the same template gives what to add.
    expect(buildTrackingLink({ templateId: 'tiktok_ads' })).toMatchObject({ kind: 'suffix' });
  });

  it('refuses what it cannot build', () => {
    expect(buildTrackingLink({ templateId: 'nope' })).toEqual({
      ok: false,
      code: 'unknown_template',
    });
    for (const baseUrl of [
      'example.com/offer',
      'ftp://example.com/',
      'https://',
      'https://a b.example/',
    ])
      expect(buildTrackingLink({ templateId: 'email', baseUrl }), baseUrl).toEqual({
        ok: false,
        code: 'invalid_base_url',
      });
  });

  it('shows a link as it would arrive, with each placeholder filled', () => {
    expect(sampleTrackingLink('microsoft_ads_suffix', 'https://www.example.com/offer?x=1')).toBe(
      'https://www.example.com/offer?x=1&utm_source=bing&utm_medium=cpc&utm_campaign=501223344&utm_term=wedding%20photographer&campaign_id=501223344&ad_group_id=1330099887766&ad_id=84400112233',
    );
    expect(sampleTrackingLink('nope', 'https://www.example.com/')).toBeUndefined();
    expect(sampleTrackingLink('email', 'nowhere')).toBeUndefined();
  });
});
