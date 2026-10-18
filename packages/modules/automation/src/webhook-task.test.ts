// The body a webhook.call step sends: the standard envelope, or the step's own JSON with
// merge fields filled in so that no value can change its structure.
import { describe, expect, it } from 'vitest';

import { webhookBody } from './webhook-task.js';

const envelope = { event: 'automation.webhook', deliveryId: 'arun_1:1' };
const values = { 'contact.firstName': 'Ada', 'contact.custom.guests': 40 };
const sent = (template: string | undefined, given: Record<string, unknown> = values): unknown => {
  const result = webhookBody(template, given as typeof values, envelope);
  if (!result.ok) throw new Error(`${result.code}: ${result.explanation}`);
  return JSON.parse(result.body);
};

describe('a webhook body', () => {
  it('is the standard envelope when the step gives none', () => {
    expect(sent(undefined)).toEqual(envelope);
  });

  it('fills merge fields in text values, at any depth, and leaves everything else alone', () => {
    expect(
      sent(
        JSON.stringify({
          name: '{{contact.firstName}}',
          note: 'Party of {{contact.custom.guests}} for {{ contact.firstName }}',
          nested: [{ who: '{{contact.firstName}}' }, 7, true, null, ''],
          '{{contact.firstName}}': 'keys are not filled in',
        }),
      ),
    ).toEqual({
      name: 'Ada',
      note: 'Party of 40 for Ada',
      nested: [{ who: 'Ada' }, 7, true, null, ''],
      '{{contact.firstName}}': 'keys are not filled in',
    });
  });

  it('keeps a value from changing the structure, whatever it holds', () => {
    const hostile = '", "admin": true, "x": "';
    const body = sent('{"name": "{{contact.firstName}}"}', { 'contact.firstName': hostile });
    expect(body).toEqual({ name: hostile });
    expect(Object.keys(body as object)).toEqual(['name']);
    expect(
      sent('{"note": "{{contact.firstName}}"}', { 'contact.firstName': 'a\nb\t"c"\\' }),
    ).toEqual({ note: 'a\nb\t"c"\\' });
  });

  it('refuses a body that is not JSON, or is nested too deeply', () => {
    expect(webhookBody('name={{contact.firstName}}', values, envelope)).toEqual({
      ok: false,
      code: 'invalid_body',
      explanation: "The step's body is not JSON.",
    });
    const deep = `${'['.repeat(40)}"x"${']'.repeat(40)}`;
    expect(webhookBody(deep, values, envelope)).toMatchObject({ ok: false, code: 'invalid_body' });
    expect(sent(`${'['.repeat(30)}"x"${']'.repeat(30)}`)).toBeDefined();
  });

  it('refuses to send with a merge field that has no value, naming each', () => {
    expect(
      webhookBody(
        '{"a": "{{contact.lastName}}", "b": ["{{contact.custom.missing}}", "{{contact.firstName}}"]}',
        values,
        envelope,
      ),
    ).toEqual({
      ok: false,
      code: 'missing_values',
      explanation: 'There is no value for contact.lastName, contact.custom.missing.',
    });
  });
});
