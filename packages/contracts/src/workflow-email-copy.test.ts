import { expect, it } from 'vitest';
import { copyWorkflowEmailTemplate } from './workflow-email-copy.js';

const input = {
  baseDraftVersion: 1,
  step: 'welcome',
  template: 'tmpl_01h455vb4pex5vsknk084sn02q',
  revision: 'a'.repeat(64),
};

it('declares revision checked template selection as an explicit draft mutation', () => {
  expect(copyWorkflowEmailTemplate.method).toBe('post');
  expect(copyWorkflowEmailTemplate.path).toBe('/automations/{id}/draft/email-template-copy');
  expect(copyWorkflowEmailTemplate.body.parse(input)).toEqual(input);
});

it('accepts the pending draft so a newly added action can be copied atomically', () => {
  const pending = {
    ...input,
    document: { name: 'Unsaved title', steps: { welcome: { type: 'email.send', config: {} } } },
  };
  expect(copyWorkflowEmailTemplate.body.parse(pending)).toEqual(pending);
});

it.each([
  { baseDraftVersion: 0 },
  { step: 'invalid/path' },
  { template: 'tfld_01h455vb4pex5vsknk084sn02q' },
  { revision: 'A'.repeat(64) },
  { businessId: 'foreign' },
  { body: 'Client supplied content' },
])('rejects invalid selectors or client authority: %j', (patch) => {
  expect(copyWorkflowEmailTemplate.body.safeParse({ ...input, ...patch }).success).toBe(false);
});
