import {
  leadSourceRuleDescriptions,
  previewLeadSourceInput,
  type LeadSourcePreview,
} from '@repo/contracts';
import { expect, it } from 'vitest';
import { addressOf, linkCheckRequest, linkCheckView } from './forms-link-check-rules';

const formId = 'form_01k8e2wzr0e008000000000001';
const nothing = {
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmContent: null,
  utmTerm: null,
  matchType: null,
  campaignId: null,
  adGroupId: null,
  adId: null,
  referrerDomain: null,
  landingUrl: 'https://www.example.com/offer',
};
const previewOf = (patch: Partial<LeadSourcePreview> = {}): LeadSourcePreview => ({
  sessionSource: 'paid_search',
  source: 'Google Ads',
  sourceRule: 'google_ads',
  reason: 'A Google click id (gclid, gbraid or wbraid).',
  decidedBy: { kind: 'built_in', key: 'google_ads' },
  builtIn: { source: 'Google Ads', sourceRule: 'google_ads' },
  rules: [],
  facts: { ...nothing, utmSource: 'google', utmMedium: 'cpc' },
  clickIds: ['gclid'],
  form: {
    id: formId,
    contactSource: 'Google Ads',
    tags: [
      { name: 'Wedding enquiry', kind: 'form', exists: true },
      { name: 'Source: Google Ads', kind: 'source', exists: false },
    ],
  },
  warnings: [],
  ...patch,
});

it('reads a pasted link as the browser would, with https put back when it was left off', () => {
  expect(addressOf('  www.example.com/offer?utm_source=google  ')).toBe(
    'https://www.example.com/offer?utm_source=google',
  );
  expect(addressOf('http://example.com/a')).toBe('http://example.com/a');
  expect(addressOf('HTTPS://Example.com/a')).toBe('HTTPS://Example.com/a');
  expect(addressOf('   ')).toBe('');
});

it('makes the request the API takes, with where they came from only when given', () => {
  const asked = linkCheckRequest('www.example.com/offer?gclid=abc', '', formId);
  expect(asked).toEqual({
    ok: true,
    body: { url: 'https://www.example.com/offer?gclid=abc', formId },
  });
  const withReferrer = linkCheckRequest(
    'https://www.example.com/offer',
    ' https://www.google.com/ ',
    formId,
  );
  expect(withReferrer).toEqual({
    ok: true,
    body: { url: 'https://www.example.com/offer', referrer: 'https://www.google.com/', formId },
  });
  if (withReferrer.ok) expect(previewLeadSourceInput.parse(withReferrer.body)).toBeTruthy();
});

it('says which box is wrong, in the words of the API, and asks nothing', () => {
  const words = 'Enter a web address, starting with https://.';
  expect(linkCheckRequest('', '', formId)).toEqual({ ok: false, problems: { url: words } });
  expect(linkCheckRequest('not an address', '', formId)).toEqual({
    ok: false,
    problems: { url: words },
  });
  expect(linkCheckRequest('ftp://example.com/x', '', formId)).toEqual({
    ok: false,
    problems: { url: words },
  });
  expect(linkCheckRequest('https://www.example.com/', 'from google', formId)).toEqual({
    ok: false,
    problems: { referrer: words },
  });
  expect(linkCheckRequest('a b', 'c d', formId)).toEqual({
    ok: false,
    problems: { url: words, referrer: words },
  });
  expect(linkCheckRequest(`https://www.example.com/?x=${'y'.repeat(2000)}`, '', formId)).toEqual({
    ok: false,
    problems: { url: 'Use at most 2000 characters.' },
  });
});

it('shows what a lead arriving by an ad link would get on this form', () => {
  expect(linkCheckView(previewOf())).toEqual({
    // No rule of the business matched: the built-in rule named the lead.
    rules: [],
    builtIn: {
      source: 'Google Ads',
      looksFor: leadSourceRuleDescriptions.google_ads,
      decides: true,
    },
    source: 'Google Ads',
    reason: 'A Google click id (gclid, gbraid or wbraid).',
    sessionSource: 'paid_search',
    untracked: false,
    contactSource: 'Google Ads',
    tags: [
      { name: 'Wedding enquiry', madeOnFirstUse: false },
      { name: 'Source: Google Ads', madeOnFirstUse: true },
    ],
    clickIds: ['google'],
    notes: [],
  });
});

it('marks a lead source tag that already exists as an ordinary tag', () => {
  const view = linkCheckView(
    previewOf({
      form: {
        id: formId,
        contactSource: null,
        tags: [{ name: 'Source: Google Ads', kind: 'source', exists: true }],
      },
    }),
  );
  expect(view.tags).toEqual([{ name: 'Source: Google Ads', madeOnFirstUse: false }]);
  // A form that writes no source says so with nothing, which is not the same as not asked.
  expect(view.contactSource).toBeNull();
});

it('says a bare link is untracked in its own sentence, and passes on what else the API remarks', () => {
  const bare = linkCheckView(
    previewOf({
      sessionSource: 'direct',
      source: 'Direct',
      sourceRule: 'direct',
      reason: 'Nothing is known of how they arrived.',
      facts: nothing,
      clickIds: [],
      warnings: [{ code: 'no_tracking', message: 'This link has no parameters and no click id.' }],
    }),
  );
  expect(bare.untracked).toBe(true);
  expect(bare.notes).toEqual([]);
  expect(bare.clickIds).toEqual([]);
  const remarked = linkCheckView(
    previewOf({
      clickIds: ['fbclid', 'ctwa_clid'],
      warnings: [
        { code: 'click_id_only', message: 'Only a Facebook click id: it may not be an ad.' },
        { code: 'too_many_tags', message: 'The form already adds 10 tags.' },
      ],
    }),
  );
  expect(remarked.untracked).toBe(false);
  expect(remarked.notes).toEqual([
    'Only a Facebook click id: it may not be an ad.',
    'The form already adds 10 tags.',
  ]);
  expect(remarked.clickIds).toEqual(['meta']);
});

it('says nothing about the form when the answer names none', () => {
  const view = linkCheckView(previewOf({ form: null }));
  expect(view.contactSource).toBeUndefined();
  expect(view.tags).toBeUndefined();
});

it("lists the business's rules that match, with what each would do, and says who named the lead", () => {
  const view = linkCheckView(
    previewOf({
      source: 'Spring promo',
      decidedBy: { kind: 'rule', ruleId: 'lsr_01k8e2wzr0e008000000000001', name: 'Spring promo' },
      rules: [
        {
          id: 'lsr_01k8e2wzr0e008000000000001',
          name: 'Spring promo',
          position: 2,
          source: 'Spring promo',
          decidesSource: true,
          tags: [
            { id: 'tag_01k8e2wzr0e008000000000001', name: 'Promo' },
            { id: 'tag_01k8e2wzr0e008000000000002', name: null },
          ],
          fieldWrites: [
            {
              fieldId: 'fld_01k8e2wzr0e008000000000001',
              label: 'Campaign',
              value: 'spring',
              applies: true,
            },
            // A field that is gone is not filled, whatever the answer says of its turn.
            { fieldId: 'fld_01k8e2wzr0e008000000000002', label: null, value: 'x', applies: true },
            {
              fieldId: 'fld_01k8e2wzr0e008000000000003',
              label: 'Promo code',
              value: 'y',
              applies: false,
            },
          ],
        },
      ],
    }),
  );
  expect(view.source).toBe('Spring promo');
  expect(view.rules).toEqual([
    {
      id: 'lsr_01k8e2wzr0e008000000000001',
      position: 2,
      name: 'Spring promo',
      source: 'Spring promo',
      decides: true,
      tags: ['Promo', null],
      fills: [
        { field: 'Campaign', value: 'spring', applies: true },
        { field: null, value: 'x', applies: false },
        { field: 'Promo code', value: 'y', applies: false },
      ],
    },
  ]);
  // The built-in rule is still said, and that it did not name the lead.
  expect(view.builtIn).toEqual({
    source: 'Google Ads',
    looksFor: leadSourceRuleDescriptions.google_ads,
    decides: false,
  });
});

it('reads the answer of a server that knows no rules of the business as none matched', () => {
  const { decidedBy: _decided, builtIn: _builtIn, rules: _rules, ...older } = previewOf();
  const view = linkCheckView(older);
  expect(view.rules).toEqual([]);
  expect(view.builtIn).toEqual({
    source: 'Google Ads',
    looksFor: leadSourceRuleDescriptions.google_ads,
    decides: true,
  });
});
