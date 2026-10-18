import { assistantTargetKinds } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { targetHref, targetLink } from './targets';

const id = 'x_01k8e2wzr0e008000000000001';

describe('targetHref', () => {
  it.each([
    ['form', `/b/harbor/settings/forms?form=${id}`, '/b/harbor/settings/forms'],
    ['contact', `/b/harbor/contacts/${id}`, '/b/harbor/contacts'],
    ['company', `/b/harbor/contacts/companies/${id}`, '/b/harbor/contacts/companies'],
    ['deal', `/b/harbor/deals?deal=${id}`, '/b/harbor/deals'],
    ['conversation', `/b/harbor/inbox?conversation=${id}`, '/b/harbor/inbox'],
    ['automation', `/b/harbor/automations?automation=${id}`, '/b/harbor/automations'],
    ['calendar', `/b/harbor/settings/calendars/${id}`, '/b/harbor/settings/calendars'],
    ['pipeline', `/b/harbor/deals/pipelines?pipeline=${id}`, '/b/harbor/deals/pipelines'],
    ['field', '/b/harbor/settings/custom-fields', '/b/harbor/settings/custom-fields'],
    ['tag', '/b/harbor/settings/tags', '/b/harbor/settings/tags'],
    ['ai_settings', '/b/harbor/settings/ai-models', '/b/harbor/settings/ai-models'],
    ['automations', '/b/harbor/automations', '/b/harbor/automations'],
  ] as const)('leads a %s to its page, and to its list without an id', (kind, one, list) => {
    expect(targetHref('harbor', { kind, id })).toBe(one);
    expect(targetHref('harbor', { kind, id: null })).toBe(list);
  });

  it('answers every kind the contract has', () => {
    for (const kind of assistantTargetKinds)
      expect(targetHref('harbor', { kind, id: null })).toMatch(/^\/b\/harbor\//);
  });

  it('keeps an id from changing the address around it', () => {
    expect(targetHref('harbor', { kind: 'deal', id: 'a&b=c' })).toBe(
      '/b/harbor/deals?deal=a%26b%3Dc',
    );
  });
});

describe('targetLink', () => {
  it('is the address of the target', () => {
    expect(targetLink('harbor', { kind: 'tag', id: null }, '/b/harbor')).toBe(
      '/b/harbor/settings/tags',
    );
  });

  it('is nothing for no target, and for the page the person is on', () => {
    expect(targetLink('harbor', null, '/b/harbor')).toBeNull();
    expect(
      targetLink('harbor', { kind: 'form', id }, `/b/harbor/settings/forms?form=${id}`),
    ).toBeNull();
  });
});
