// The automation API's contract: the catalog the code serves fits the schema the API
// documents, and the draft inputs take exactly what AUTOMATIONS.md section 5 describes.
import { describe, expect, it } from 'vitest';

import { automationCatalog } from './automations.js';
import {
  automationCatalogResponse,
  createAutomationTestRunInput,
  patchAutomationDraftInput,
  replaceAutomationDraftInput,
} from './automations-api.js';
import { MAX_PATCH_OPERATIONS } from './automations-patch.js';

const emptySetup = {
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
  channels: { email: false, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};

describe('the automation API contract', () => {
  it('documents the catalog exactly as the code builds it', () => {
    const served = { ...automationCatalog(), setup: emptySetup };
    expect(automationCatalogResponse.parse(served)).toEqual(served);
  });

  it('needs the draft version a change started from', () => {
    expect(replaceAutomationDraftInput.safeParse({ document: {} }).success).toBe(false);
    expect(patchAutomationDraftInput.safeParse({ baseDraftVersion: 1, patch: [] }).success).toBe(
      false,
    );
  });

  it('takes at most the patch engine’s operations, ignoring members RFC 6902 lets it ignore', () => {
    const operation = { op: 'add', path: '/a', value: 1, xyz: 123 };
    expect(
      patchAutomationDraftInput.parse({ baseDraftVersion: 2, patch: [operation] }).patch,
    ).toEqual([operation]);
    const tooMany = Array.from({ length: MAX_PATCH_OPERATIONS + 1 }, () => operation);
    expect(
      patchAutomationDraftInput.safeParse({ baseDraftVersion: 2, patch: tooMany }).success,
    ).toBe(false);
  });
});

describe('a test run’s simulated events', () => {
  it('needs a real duration for when each happens, so none is silently ignored', () => {
    const run = (after: string) =>
      createAutomationTestRunInput.safeParse({ events: [{ event: 'message.received', after }] });
    expect(run('P1D').success).toBe(true);
    expect(run('PT2H').success).toBe(true);
    expect(run('1 day').success).toBe(false);
    expect(run('').success).toBe(false);
  });
});
