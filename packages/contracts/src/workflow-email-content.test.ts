import { expect, it } from 'vitest';
import { workflowEmailContent } from './workflow-email-content.js';
import { automationStepTypes } from './automations-catalog.js';

const source = { id: 'tmpl_01h455vb4pex5vsknk084sn02q', revision: 'a'.repeat(64) };

// Sync is explicit, never inferred (the tests below).
it('accepts an explicit independent copy, and an explicit sync, in the email action catalog', () => {
  const copy = {
    mode: 'copy',
    source,
    subject: 'Your guide',
    body: 'Welcome',
    mailbox: 'Selected sender',
  };
  expect(automationStepTypes['email.send'].config.parse(copy)).toEqual(copy);
  expect(automationStepTypes['email.send'].config.parse({ mode: 'sync', source })).toEqual({
    mode: 'sync',
    source,
  });
  // A step that syncs has no content of its own to drift from the template.
  expect(
    automationStepTypes['email.send'].config.safeParse({ mode: 'sync', source, body: 'Mine' })
      .success,
  ).toBe(false);
});

it('keeps a copied template independent even when provenance is present', () => {
  const copy = { mode: 'copy', subject: 'Your guide', body: 'Hello {{contact.firstName}}', source };
  expect(workflowEmailContent.parse(copy)).toEqual(copy);
});

it('accepts independent quick composition without inventing a source', () => {
  expect(workflowEmailContent.parse({ mode: 'copy', subject: 'Hello', body: 'Welcome' })).toEqual({
    mode: 'copy',
    subject: 'Hello',
    body: 'Welcome',
  });
});

it('requires an explicit mode rather than inferring sync from a source ID', () => {
  expect(workflowEmailContent.safeParse({ source }).success).toBe(false);
});

it('represents continuous sync with a source and refuses a competing local body', () => {
  expect(workflowEmailContent.parse({ mode: 'sync', source })).toEqual({ mode: 'sync', source });
  expect(workflowEmailContent.safeParse({ mode: 'sync' }).success).toBe(false);
  expect(
    workflowEmailContent.safeParse({ mode: 'sync', source, subject: 'Other', body: 'Other' })
      .success,
  ).toBe(false);
});

it.each(['', '0'.repeat(63), '0'.repeat(65), 'A'.repeat(64)])(
  'refuses an invalid source revision %s',
  (revision) => {
    expect(
      workflowEmailContent.safeParse({ mode: 'sync', source: { ...source, revision } }).success,
    ).toBe(false);
  },
);

it('refuses a foreign ID kind and unexpected authority fields', () => {
  expect(
    workflowEmailContent.safeParse({
      mode: 'sync',
      source: { ...source, id: 'tfld_01h455vb4pex5vsknk084sn02q' },
    }).success,
  ).toBe(false);
  expect(
    workflowEmailContent.safeParse({ mode: 'sync', source: { ...source, businessId: 'other' } })
      .success,
  ).toBe(false);
  expect(
    workflowEmailContent.safeParse({
      mode: 'copy',
      subject: 'Hello',
      body: 'Welcome',
      enabled: true,
    }).success,
  ).toBe(false);
});

it.each(['Hello\rBcc: injected', 'Hello\nBcc: injected', '   '])(
  'refuses unsafe or blank subjects',
  (subject) => {
    expect(workflowEmailContent.safeParse({ mode: 'copy', subject, body: 'Welcome' }).success).toBe(
      false,
    );
  },
);

it('enforces the current inline email limits and preserves content literally', () => {
  const input = { mode: 'copy', subject: 'x'.repeat(998), body: 'x'.repeat(1_000_000) };
  expect(workflowEmailContent.parse(input)).toEqual(input);
  expect(workflowEmailContent.safeParse({ ...input, subject: 'x'.repeat(999) }).success).toBe(
    false,
  );
  expect(workflowEmailContent.safeParse({ ...input, body: 'x'.repeat(1_000_001) }).success).toBe(
    false,
  );
  expect(workflowEmailContent.safeParse({ ...input, body: '\n \t' }).success).toBe(false);
  expect(
    workflowEmailContent.parse({ mode: 'copy', subject: ' Hello ', body: '\nWelcome\n' }),
  ).toEqual({ mode: 'copy', subject: ' Hello ', body: '\nWelcome\n' });
});
