import { describe, expect, it } from 'vitest';

import { trackingMismatch } from './tracking-trigger.js';

const view = { pageHost: 'www.acme.example', pagePath: '/pricing/roofs', utmSource: 'google' };
const form = { ...view, pagePath: '/contact', formName: 'Free Estimate', utmCampaign: 'Spring' };

describe('the External Tracking Event trigger', () => {
  it('starts for any page view or form with no filter', () => {
    expect(trackingMismatch({}, 'external_tracking.page_viewed', view)).toBeUndefined();
    expect(trackingMismatch({}, 'external_tracking.form_submitted', form)).toBeUndefined();
  });

  it('starts only for the event chosen', () => {
    expect(
      trackingMismatch({ event: 'form_submission' }, 'external_tracking.page_viewed', view),
    ).toEqual({
      filter: 'event',
      expected: 'form_submission',
      actual: 'page_view',
    });
    expect(
      trackingMismatch({ event: 'page_view' }, 'external_tracking.page_viewed', view),
    ).toBeUndefined();
  });

  it('filters by domain as GoHighLevel does: the site or a subdomain of it', () => {
    expect(
      trackingMismatch({ domain: 'acme.example' }, 'external_tracking.page_viewed', view),
    ).toBeUndefined();
    expect(
      trackingMismatch({ domain: 'WWW.Acme.example' }, 'external_tracking.page_viewed', view),
    ).toBeUndefined();
    expect(
      trackingMismatch({ domain: 'other.example' }, 'external_tracking.page_viewed', view),
    ).toEqual({
      filter: 'domain',
      expected: 'other.example',
      actual: 'www.acme.example',
    });
  });

  it('filters by a page path it contains, a form name and campaign labels, ignoring case', () => {
    expect(
      trackingMismatch({ pagePath: '/PRICING' }, 'external_tracking.page_viewed', view),
    ).toBeUndefined();
    expect(
      trackingMismatch({ pagePath: '/about' }, 'external_tracking.page_viewed', view),
    ).toMatchObject({
      filter: 'pagePath',
    });
    expect(
      trackingMismatch({ formName: 'free estimate' }, 'external_tracking.form_submitted', form),
    ).toBeUndefined();
    expect(
      trackingMismatch({ formName: 'Newsletter' }, 'external_tracking.form_submitted', form),
    ).toMatchObject({
      filter: 'formName',
      actual: 'Free Estimate',
    });
    // A page view has no form: a form filter never passes it.
    expect(
      trackingMismatch({ formName: 'Free Estimate' }, 'external_tracking.page_viewed', view),
    ).toMatchObject({
      filter: 'formName',
      actual: null,
    });
    expect(
      trackingMismatch({ utmSource: 'Google' }, 'external_tracking.page_viewed', view),
    ).toBeUndefined();
    expect(
      trackingMismatch({ utmCampaign: 'Spring' }, 'external_tracking.page_viewed', view),
    ).toMatchObject({
      filter: 'utmCampaign',
      actual: null,
    });
    expect(
      trackingMismatch({ utmMedium: 'cpc' }, 'external_tracking.form_submitted', form),
    ).toMatchObject({
      filter: 'utmMedium',
    });
  });
});

describe('the trigger in the catalog', () => {
  it('listens to both events and judges them by its filters', async () => {
    const { eventPassesTrigger, triggerMismatch } = await import('./triggers.js');
    const trigger = {
      id: 't1',
      type: 'external_tracking.event',
      config: { event: 'form_submission', formName: 'free estimate' },
    } as const;
    expect(eventPassesTrigger(trigger, 'external_tracking.form_submitted', form)).toBe(true);
    expect(eventPassesTrigger(trigger, 'external_tracking.page_viewed', view)).toBe(false);
    expect(eventPassesTrigger(trigger, 'form.submitted', form)).toBe(false);
    expect(triggerMismatch(trigger, 'external_tracking.page_viewed', view)).toMatchObject({
      filter: 'event',
    });
    expect(triggerMismatch(trigger, 'external_tracking.form_submitted', form)).toBeUndefined();
  });
});
