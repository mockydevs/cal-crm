import {
  buildTrackingLink,
  trackingLinkPlatforms,
  trackingLinkTemplate,
  trackingLinkTemplates,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  arrivingLink,
  baseUrlProblem,
  builtLink,
  editableParameters,
  firstTemplateOf,
  linkDraftOf,
  linkPlatforms,
  pastedBesideAddress,
  SAMPLE_PAGE,
  templatesOf,
  withTemplate,
  type LinkDraft,
} from './links';

const draft = (patch: Partial<LinkDraft> = {}): LinkDraft => ({
  ...linkDraftOf('google_ads'),
  ...patch,
});

describe('the catalogue as the builder offers it', () => {
  it('offers every platform that has a template, in the order of the catalogue', () => {
    expect(linkPlatforms).toEqual(
      trackingLinkPlatforms.filter((platform) =>
        trackingLinkTemplates.some((template) => template.platform === platform),
      ),
    );
    // Every template is reachable: none is left out by the grouping.
    expect(
      linkPlatforms.flatMap((platform) => templatesOf(platform).map((each) => each.id)).toSorted(),
    ).toEqual(trackingLinkTemplates.map((each) => each.id).toSorted());
  });

  it('opens each platform on the template the catalogue offers first, listed first', () => {
    for (const platform of linkPlatforms) {
      const first = firstTemplateOf(platform);
      expect(first?.platform, platform).toBe(platform);
      expect(first?.default, platform).toBe(true);
      expect(templatesOf(platform)[0], platform).toBe(first);
      expect(linkDraftOf(platform)).toEqual({ templateId: first?.id, baseUrl: '', values: {} });
    }
    expect(templatesOf('google_ads').map((each) => each.form)).toEqual([
      'suffix',
      'tracking_template',
    ]);
  });

  it('knows which templates are pasted beside the ad’s own address', () => {
    for (const template of trackingLinkTemplates)
      expect(pastedBesideAddress(template), template.id).toBe(template.form !== 'link');
  });
});

describe('building', () => {
  it("gives exactly what the catalogue's own builder gives, for every template", () => {
    for (const template of trackingLinkTemplates) {
      const own = Object.fromEntries(
        editableParameters(template).map((parameter) => [parameter.name, 'Spring promo']),
      );
      const typed = draft({
        templateId: template.id,
        baseUrl: 'www.example.com/offer?x=1',
        values: own,
      });
      expect(builtLink(typed), template.id).toEqual(
        buildTrackingLink({
          templateId: template.id,
          ...(template.form === 'link' ? { baseUrl: 'https://www.example.com/offer?x=1' } : {}),
          values: own,
        }),
      );
    }
  });

  it('builds Google’s two forms: parameters for the suffix, {lpurl} first for the template', () => {
    const suffix = builtLink(draft({ templateId: 'google_ads_suffix', baseUrl: 'example.com/a' }));
    expect(suffix.ok && suffix.kind).toBe('suffix');
    expect(suffix.ok && suffix.text.startsWith('utm_source=google&utm_medium=cpc')).toBe(true);
    // The landing page is not part of a suffix, whatever was typed.
    expect(suffix.ok && suffix.text.includes('example.com')).toBe(false);
    const template = builtLink(
      draft({ templateId: 'google_ads_tracking_template', baseUrl: 'not an address at all' }),
    );
    expect(template.ok && template.kind).toBe('tracking_template');
    expect(template.ok && template.text.startsWith('{lpurl}?utm_source=google')).toBe(true);
    // The platform's placeholders are written as they are, never encoded.
    expect(template.ok && template.text.includes('campaign_id={campaignid}')).toBe(true);
  });

  it('builds a whole link for a template that goes on the address, and encodes own words', () => {
    const email = builtLink(
      draft({
        templateId: 'email',
        baseUrl: 'www.example.com/offer',
        values: { utm_campaign: 'Spring promo' },
      }),
    );
    expect(email).toMatchObject({
      ok: true,
      kind: 'link',
      text: 'https://www.example.com/offer?utm_source=newsletter&utm_medium=email&utm_campaign=Spring%20promo',
    });
    const bare = builtLink(draft({ templateId: 'email' }));
    expect(bare.ok && bare.kind).toBe('suffix');
    expect(builtLink(draft({ templateId: 'email', baseUrl: 'ftp://example.com' }))).toEqual({
      ok: false,
      code: 'invalid_base_url',
    });
    expect(builtLink(draft({ templateId: 'nothing' }))).toEqual({
      ok: false,
      code: 'unknown_template',
    });
  });

  it('keeps the landing page and the words the next template takes when the template changes', () => {
    const typed = draft({
      templateId: 'meta_ads',
      baseUrl: 'example.com/a',
      values: { utm_campaign: 'Spring', utm_content: 'Video', nothing: 'x' },
    });
    // The GoHighLevel-style template lets nobody write over its names.
    expect(withTemplate(typed, 'meta_ads_ghl')).toEqual({
      templateId: 'meta_ads_ghl',
      baseUrl: 'example.com/a',
      values: {},
    });
    expect(withTemplate(typed, 'meta_ads_by_app').values).toEqual({
      utm_campaign: 'Spring',
      utm_content: 'Video',
    });
    expect(withTemplate(typed, 'unknown').values).toEqual({});
  });

  it('says a landing page is wrong only when something typed is no web address', () => {
    expect(baseUrlProblem(draft())).toBe(false);
    expect(baseUrlProblem(draft({ baseUrl: '  ' }))).toBe(false);
    expect(baseUrlProblem(draft({ baseUrl: 'www.example.com/offer' }))).toBe(false);
    expect(baseUrlProblem(draft({ baseUrl: 'http://example.com' }))).toBe(false);
    expect(baseUrlProblem(draft({ baseUrl: 'ftp://example.com' }))).toBe(true);
    expect(baseUrlProblem(draft({ baseUrl: 'https://exa mple.com' }))).toBe(true);
  });
});

describe('the link as a click would arrive', () => {
  it('puts a sample value where the platform fills its own in, for every template', () => {
    for (const template of trackingLinkTemplates) {
      const arriving = arrivingLink(draft({ templateId: template.id, baseUrl: 'example.com/a' }));
      expect(arriving, template.id).toBeDefined();
      const query = new URL(arriving ?? '').searchParams;
      for (const parameter of template.parameters) {
        const expected =
          parameter.kind === 'placeholder'
            ? (template.sample[parameter.value] ?? '')
            : parameter.value;
        expect(query.get(parameter.name), `${template.id} ${parameter.name}`).toBe(expected);
        // No placeholder of the platform is left in a link that is to be read as a click.
        expect(query.get(parameter.name)?.includes('{') ?? false).toBe(false);
      }
    }
  });

  it('uses the words typed in place of a sample, and a sample page while none is typed', () => {
    const arriving = arrivingLink(
      draft({ templateId: 'meta_ads', values: { utm_campaign: ' Spring promo ' } }),
    );
    expect(arriving?.startsWith(SAMPLE_PAGE)).toBe(true);
    const query = new URL(arriving ?? '').searchParams;
    expect(query.get('utm_campaign')).toBe('Spring promo');
    expect(query.get('utm_content')).toBe(trackingLinkTemplate('meta_ads')?.sample['{{ad.name}}']);
    // A parameter the landing page already had stays, and the template's value wins.
    const kept = arrivingLink(
      draft({ templateId: 'email', baseUrl: 'https://example.com/a?ref=1&utm_medium=old' }),
    );
    expect(new URL(kept ?? '').searchParams.get('ref')).toBe('1');
    expect(new URL(kept ?? '').searchParams.get('utm_medium')).toBe('email');
  });

  it('gives nothing for a template it does not know or a page that is no web address', () => {
    expect(arrivingLink(draft({ templateId: 'nothing' }))).toBeUndefined();
    expect(arrivingLink(draft({ baseUrl: 'https://exa mple.com' }))).toBeUndefined();
    expect(arrivingLink(draft({ baseUrl: 'ftp://example.com' }))).toBeUndefined();
  });
});
