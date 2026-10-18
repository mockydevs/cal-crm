// owner.assign for teams: one member, or several who take turns, and a contact that keeps
// the owner it has. Shape, validation and the published catalog; the engine's side is
// tested in packages/modules/automation.
import { describe, expect, it } from 'vitest';

import { automationStepTypes, MAX_ASSIGN_USERS } from './automations-catalog.js';
import { automationCatalog, automationDocument } from './automations.js';
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
  users: [
    { id: 'mem_amina', name: 'Amina Odhiambo' },
    { id: 'mem_brian', name: 'Brian Kip' },
    { id: 'mem_cate', name: 'Cate Wanjiru' },
  ],
  automations: [],
  values: [],
  channels: { email: true, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};

const document = (config: unknown) => ({
  name: 'Share the leads',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'assign',
  steps: { assign: { type: 'owner.assign', config } },
});
const codes = (result: ReturnType<typeof validateAutomation>) =>
  result.errors.map((issue) => `${issue.path} ${issue.code}`);
const configOf = (result: ReturnType<typeof validateAutomation>) =>
  result.document?.steps['assign']?.config;

describe('the shape of owner.assign', () => {
  it('keeps the single user as it was written, and adds nothing to it', () => {
    const parsed = automationDocument.parse(document({ user: 'mem_amina' }));
    expect(parsed.steps['assign']?.config).toEqual({ user: 'mem_amina' });
  });

  it('takes one to twenty members who take turns', () => {
    expect(automationDocument.safeParse(document({ users: ['a'] })).success).toBe(true);
    expect(
      automationDocument.safeParse(
        document({
          users: Array.from({ length: MAX_ASSIGN_USERS }, (_, index) => `m${String(index)}`),
        }),
      ).success,
    ).toBe(true);
    expect(automationDocument.safeParse(document({ users: [] })).success).toBe(false);
    expect(
      automationDocument.safeParse(
        document({
          users: Array.from({ length: MAX_ASSIGN_USERS + 1 }, (_, index) => `m${String(index)}`),
        }),
      ).success,
    ).toBe(false);
  });

  it('takes onlyIfUnassigned on either shape, and never both a user and users', () => {
    for (const config of [
      { user: 'a', onlyIfUnassigned: true },
      { users: ['a', 'b'], onlyIfUnassigned: false },
    ])
      expect(automationDocument.safeParse(document(config)).success).toBe(true);
    for (const config of [
      { user: 'a', users: ['b'] },
      { onlyIfUnassigned: true },
      { users: ['a'], onlyIfUnassigned: 'yes' },
      { users: ['a'], weights: [1] },
    ])
      expect(automationDocument.safeParse(document(config)).success).toBe(false);
  });
});

describe('validating owner.assign', () => {
  it('resolves each member by name or id, in the order written', () => {
    const result = validateAutomation(
      document({ users: ['Brian Kip', 'mem_amina', 'cate wanjiru'], onlyIfUnassigned: true }),
      setup,
    );
    expect(result.valid).toBe(true);
    expect(configOf(result)).toEqual({
      users: ['mem_brian', 'mem_amina', 'mem_cate'],
      onlyIfUnassigned: true,
    });
    expect(result.document?.steps['assign']?.typeVersion).toBe(2);
  });

  it('still resolves the single user, and leaves that shape alone', () => {
    const result = validateAutomation(document({ user: 'Amina Odhiambo' }), setup);
    expect(configOf(result)).toEqual({ user: 'mem_amina' });
  });

  it('points at the member it does not know', () => {
    const result = validateAutomation(document({ users: ['mem_amina', 'Brain Kip'] }), setup);
    expect(codes(result)).toEqual(['/steps/assign/config/users/1 unknown_reference']);
    expect(result.errors[0]?.suggestion).toBe('Did you mean Brian Kip?');
  });

  it('refuses a member named twice, however each was written', () => {
    const result = validateAutomation(
      document({ users: ['mem_amina', 'Brian Kip', 'Amina Odhiambo'] }),
      setup,
    );
    expect(codes(result)).toEqual(['/steps/assign/config/users/2 duplicate_member']);
  });

  it('names the members again for another business', () => {
    const { document: portable, warnings } = portableAutomation(
      document({ users: ['mem_amina', 'mem_cate'] }),
      setup,
    );
    expect(warnings).toEqual([]);
    expect(portable['steps']).toMatchObject({
      assign: { config: { users: ['Amina Odhiambo', 'Cate Wanjiru'] } },
    });
  });
});

describe('owner.assign in the catalog', () => {
  it('says what it gives later steps, and that it can be retried', () => {
    expect(automationStepTypes['owner.assign'].version).toBe(2);
    const listed = automationCatalog().steps.find((step) => step.type === 'owner.assign');
    expect(listed?.outputs.map((output) => output.key)).toEqual(['membershipId']);
    expect(listed?.branches).toEqual({ kind: 'none' });
    expect(automationCatalog().failures.retryableSteps).toContain('owner.assign');
  });
});
