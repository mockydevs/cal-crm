import { expect, it } from 'vitest';
import {
  portableAutomation,
  validateAutomation,
  type AutomationSetup,
} from './automations-validate.js';

const setup: AutomationSetup = {
  fields: { contact: [], deal: [] },
  forms: [],
  emailTemplates: [],
  whatsappTemplates: [],
  mailboxes: [],
  phoneNumbers: [],
  calendars: [],
  pipelines: [],
  lostReasons: [],
  tags: [],
  users: [],
  automations: [],
  values: [],
  channels: { email: true, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};

const copy = {
  mode: 'copy',
  source: { id: 'tmpl_01h455vb4pex5vsknk084sn02q', revision: 'a'.repeat(64) },
  subject: 'Your guide',
  body: 'Hello {{contact.firstName}}\nKeep this copy.',
};
const workflow = {
  name: 'Independent welcome',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'welcome',
  steps: { welcome: { type: 'email.send', config: copy } },
};

it('exports literal copy content and explicit mode without converting provenance to a live reference', () => {
  const result = portableAutomation(workflow, setup);
  expect(result.warnings).toEqual([]);
  expect(result.document).toEqual(workflow);
});

it('imports an independent copy even when the destination has no library templates', () => {
  const exported = portableAutomation(workflow, setup);
  const imported = validateAutomation(exported.document, setup);
  expect(imported.errors).toEqual([]);
  expect(imported.document?.steps['welcome']).toEqual({
    type: 'email.send',
    typeVersion: 1,
    config: copy,
  });
});
