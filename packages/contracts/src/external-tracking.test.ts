import { describe, expect, it } from 'vitest';

import { endpoints } from './api.js';
import {
  externalTrackingEndpoints,
  publicTrackingEndpoints,
  publicTrackingEvent,
  publicTrackingReceipt,
  TRACKING_LIMITS,
  trackedDomain,
  trackingId,
  updateExternalTrackingInput,
} from './external-tracking.js';

const session = '0190f3a2-7c1d-7e4b-9a5f-1c2d3e4f5a6b';
const token = `${'1'.repeat(13)}.${'a'.repeat(43)}`;

describe('a tracking id', () => {
  it('is tk_ and 32 lowercase letters and digits, as GoHighLevel’s', () => {
    expect(trackingId.safeParse(`tk_${'a1'.repeat(16)}`).success).toBe(true);
    for (const wrong of ['tk_short', `TK_${'a1'.repeat(16)}`, `tk_${'A1'.repeat(16)}`, 'x'])
      expect(trackingId.safeParse(wrong).success, wrong).toBe(false);
  });
});

describe('an allowed website', () => {
  it('is a domain, written in lowercase and trimmed', () => {
    expect(trackedDomain.parse(' Example.COM ')).toBe('example.com');
    expect(trackedDomain.parse('shop.example.co.uk')).toBe('shop.example.co.uk');
  });

  it('is never an address, a path, a port or a wildcard', () => {
    for (const wrong of [
      'https://example.com',
      'example.com/x',
      'example.com:8080',
      '*.example.com',
      'localhost',
      '',
    ])
      expect(trackedDomain.safeParse(wrong).success, wrong).toBe(false);
  });

  it('is listed once, and at most fifty of them', () => {
    const base = {
      pageViews: true,
      formCapture: true,
      visitorIds: 'unless_opted_out',
      revision: 1,
    };
    expect(
      updateExternalTrackingInput.safeParse({ ...base, allowedDomains: ['a.com', 'A.com'] })
        .success,
    ).toBe(false);
    const many = Array.from(
      { length: TRACKING_LIMITS.allowedDomains + 1 },
      (_, i) => `s${String(i)}.com`,
    );
    expect(updateExternalTrackingInput.safeParse({ ...base, allowedDomains: many }).success).toBe(
      false,
    );
    expect(updateExternalTrackingInput.safeParse({ ...base, allowedDomains: [] }).success).toBe(
      true,
    );
  });
});

describe('what the script sends', () => {
  it('is a page view with the page and the tab’s visit', () => {
    expect(
      publicTrackingEvent.parse({
        type: 'page_view',
        pageUrl: 'https://example.com/pricing?utm_source=google',
        sessionId: session,
      }),
    ).toEqual({
      type: 'page_view',
      pageUrl: 'https://example.com/pricing?utm_source=google',
      sessionId: session,
    });
  });

  it('is a form with its fields and the proof its page was shown', () => {
    const sent = {
      type: 'form_submission',
      pageUrl: 'https://example.com/contact',
      sessionId: session,
      viewToken: token,
      clientSubmissionId: session,
      formName: 'Contact us',
      fields: [{ name: 'email', label: 'Email', value: 'pat@example.com' }],
    };
    expect(publicTrackingEvent.parse(sent)).toEqual(sent);
    expect(publicTrackingEvent.safeParse({ ...sent, viewToken: 'nope' }).success).toBe(false);
  });

  it('is refused past its bounds, or with anything it does not know', () => {
    const page = { type: 'page_view', pageUrl: 'https://example.com/', sessionId: session };
    expect(publicTrackingEvent.safeParse({ ...page, type: 'click' }).success).toBe(false);
    expect(publicTrackingEvent.safeParse({ ...page, email: 'x@example.com' }).success).toBe(false);
    expect(publicTrackingEvent.safeParse({ ...page, pageUrl: 'javascript:alert(1)' }).success).toBe(
      false,
    );
    const fields = Array.from({ length: TRACKING_LIMITS.fields + 1 }, (_, i) => ({
      name: `f${String(i)}`,
      value: 'x',
    }));
    expect(
      publicTrackingEvent.safeParse({
        ...page,
        type: 'form_submission',
        viewToken: token,
        clientSubmissionId: session,
        formName: 'Big',
        fields,
      }).success,
    ).toBe(false);
  });

  it('gets an answer that says nothing of any contact', () => {
    expect(publicTrackingReceipt.safeParse({ status: 'received', contactId: 'x' }).success).toBe(
      false,
    );
    expect(publicTrackingReceipt.parse({ status: 'received', viewToken: token })).toEqual({
      status: 'received',
      viewToken: token,
    });
  });
});

describe('the endpoints', () => {
  it('are all in the API reference', () => {
    for (const endpoint of externalTrackingEndpoints) expect(endpoints).toContain(endpoint);
  });

  it('leave the script’s own address to the public transport, out of the reference', () => {
    for (const endpoint of publicTrackingEndpoints) {
      expect(endpoint.audience).toBe('public');
      expect(endpoints).not.toContain(endpoint);
    }
    expect(
      publicTrackingEndpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`),
    ).toEqual(['post /public/tracking/{trackingId}/events']);
  });
});
