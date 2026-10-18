// Merge keys in an automation step's text: a custom value's key in both of its spellings, a
// contact field's key, and the keys no step can fill in.
import { describe, expect, it } from 'vitest';

import { validateAutomation, type AutomationSetup } from './automations-validate.js';
import { harborLights } from './automations-validate.test.js';
import { customValueMergeKey, fieldMergeKey, mergeToken } from './merge-fields.js';

function texting(message: string, setup: AutomationSetup = harborLights) {
  const result = validateAutomation(
    {
      name: 'Merge keys',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'text',
      steps: { text: { type: 'sms.send', config: { message, number: 'Main line' } } },
    },
    setup,
  );
  return {
    errors: result.errors,
    message: (result.document?.steps['text']?.config as { message?: string } | undefined)?.message,
  };
}

describe('a custom value in a step’s text', () => {
  it('is accepted as custom_values.<key>, the key Settings shows, and left as written', () => {
    const token = mergeToken(customValueMergeKey('sample_reel_url'));
    expect(token).toBe('{{custom_values.sample_reel_url}}');
    expect(texting(`Our reel: ${token}`)).toEqual({ errors: [], message: `Our reel: ${token}` });
  });

  it('is still accepted as values.<key>, as AUTOMATIONS.md writes it', () => {
    const message = 'Here’s our video sample reel: {{values.sample_reel_url}}';
    expect(texting(message)).toEqual({ errors: [], message });
  });

  it.each(['custom_values', 'values'])(
    'is refused under %s when the business has no value with that key, with the nearest one',
    (head) => {
      expect(texting(`Reel: {{${head}.sample_reel_ur}}`).errors).toEqual([
        {
          path: '/steps/text/config/message',
          code: 'unknown_merge_field',
          message: `${head}.sample_reel_ur is not a custom value.`,
          suggestion: 'Did you mean sample_reel_url?',
        },
      ]);
    },
  );

  it('is refused for a business that has no custom values at all', () => {
    const { errors } = texting('{{custom_values.sample_reel_url}}', {
      ...harborLights,
      values: [],
    });
    expect(errors).toEqual([
      {
        path: '/steps/text/config/message',
        code: 'unknown_merge_field',
        message: 'custom_values.sample_reel_url is not a custom value.',
      },
    ]);
  });
});

describe('a field’s merge key in a step’s text', () => {
  it('is accepted for a contact field and stored as the canonical path', () => {
    const key = fieldMergeKey('contact', 'event_date');
    expect(key).toBe('contact.event_date');
    expect(texting(`See you on ${mergeToken(key ?? '')}.`)).toEqual({
      errors: [],
      message: 'See you on {{contact.custom.event_date}}.',
    });
  });

  it('reaches a contact field named like a built-in one through contact.custom only', () => {
    // harborLights has a custom field with the key "name".
    expect(fieldMergeKey('contact', 'name')).toBe('contact.custom.name');
    expect(texting('{{contact.custom.name}} / {{contact.name}}')).toEqual({
      errors: [],
      message: '{{contact.custom.name}} / {{contact.name}}',
    });
  });

  it.each([
    ['deal', 'quote_total', 'opportunity.quote_total'],
    ['company', 'city', 'business.city'],
  ])('is refused for a %s field, which no step can fill in', (kind, key, path) => {
    expect(fieldMergeKey(kind, key)).toBe(path);
    expect(texting(`Total: ${mergeToken(path)}`).errors).toEqual([
      {
        path: '/steps/text/config/message',
        code: 'unknown_merge_field',
        message: `${path} can't be filled in: a step has the contact's fields and the business's custom values only.`,
      },
    ]);
  });

  it('names the starts a merge field can have when it has none of them', () => {
    expect(texting('{{account.name}}').errors).toEqual([
      {
        path: '/steps/text/config/message',
        code: 'unknown_merge_field',
        message: 'account.name is not a merge field.',
        suggestion:
          'Merge fields start with contact., deal., appointment., custom_values., values., trigger_link., steps. or trigger.',
      },
    ]);
  });
});
