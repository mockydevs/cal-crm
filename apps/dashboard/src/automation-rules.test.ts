import { automationCatalog, validateAutomation } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { followUp, harborSetup, stepExamples, welcome } from '../e2e/automation-fixtures';
import {
  automationAccess,
  availableTriggers,
  missingSetupOf,
  setupOf,
  stepPicker,
} from './automation-rules';

const catalog = automationCatalog();
const offered = (setup: Parameters<typeof stepPicker>[2]): string[] =>
  stepPicker(catalog.steps, catalog.stepGroups, setup).groups.flatMap((group) =>
    group.steps.map((step) => step.type),
  );
const noSteps: readonly string[] = [];
const everything = {
  channels: { email: true, sms: true, whatsapp: true },
  ai: true,
  webhooks: true,
  emailVerification: true,
  unavailableSteps: noSteps,
};
const nothing = {
  channels: { email: false, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  emailVerification: false,
  unavailableSteps: noSteps,
};

describe('a step a workflow has one of', () => {
  it('is listed apart, with why, once the workflow has it', () => {
    const picker = stepPicker(catalog.steps, catalog.stepGroups, everything, ['goal']);
    expect(picker.groups.flatMap((group) => group.steps).map((step) => step.type)).not.toContain(
      'goal',
    );
    expect(picker.unavailable.map(({ step, missing }) => [step.type, missing])).toEqual([
      ['goal', 'only_one'],
    ]);
    expect(
      stepPicker(catalog.steps, catalog.stepGroups, everything)
        .groups.flatMap((group) => group.steps)
        .map((step) => step.type),
    ).toContain('goal');
  });
});

describe('stepPicker', () => {
  it('offers every step when everything is set up', () => {
    const picker = stepPicker(catalog.steps, catalog.stepGroups, everything);
    expect(picker.unavailable).toEqual([]);
    expect(offered(everything).toSorted()).toEqual(
      catalog.steps.map((step) => step.type).toSorted(),
    );
    expect(picker.groups.map((group) => group.group)).toEqual(catalog.stepGroups);
  });

  it('offers text authoring without a provider while retaining its sending-readiness diagnosis', () => {
    const setup = { ...everything, channels: { ...everything.channels, sms: false } };
    expect(offered(setup)).toContain('sms.send');
    expect(missingSetupOf({ type: 'sms.send', group: 'messages' }, setup)).toBe('sms');
    expect(
      stepPicker(catalog.steps, catalog.stepGroups, setup).unavailable.map(({ step, missing }) => [
        step.type,
        missing,
      ]),
    ).toEqual([]);
  });

  it('never offers an AI step without AI set up, and drops the empty group', () => {
    const setup = { ...everything, ai: false };
    const picker = stepPicker(catalog.steps, catalog.stepGroups, setup);
    expect(offered(setup).filter((type) => type.startsWith('ai.'))).toEqual([]);
    expect(picker.unavailable.map(({ step, missing }) => [step.type, missing])).toEqual([
      ['ai.ask', 'ai'],
      ['ai.classify', 'ai'],
      ['ai.draft_reply', 'ai'],
    ]);
    expect(picker.groups.map((group) => group.group)).not.toContain('ai');
  });

  it('never offers a step the product does not run yet, whatever is connected', () => {
    const setup = { ...everything, unavailableSteps: ['owner.assign', 'whatsapp.send', 'ai.ask'] };
    const picker = stepPicker(catalog.steps, catalog.stepGroups, setup);
    for (const type of setup.unavailableSteps) expect(offered(setup)).not.toContain(type);
    // Said as not available, never as something a setting would fix.
    expect(picker.unavailable.map(({ step, missing }) => [step.type, missing])).toEqual([
      ['whatsapp.send', 'unavailable'],
      ['owner.assign', 'unavailable'],
      ['ai.ask', 'unavailable'],
    ]);
    expect(
      missingSetupOf(
        { type: 'whatsapp.send', group: 'messages' },
        { ...nothing, unavailableSteps: ['whatsapp.send'] },
      ),
    ).toBe('unavailable');
  });

  it('never offers a webhook call without a signing secret', () => {
    const setup = { ...everything, webhooks: false };
    expect(offered(setup)).not.toContain('webhook.call');
    expect(
      stepPicker(catalog.steps, catalog.stepGroups, setup).unavailable.map(({ step, missing }) => [
        step.type,
        missing,
      ]),
    ).toEqual([['webhook.call', 'webhooks']]);
  });

  it('never offers Email verification while verification is off, and offers it when a server does not say', () => {
    const setup = { ...everything, emailVerification: false };
    expect(offered(setup)).not.toContain('email.verify');
    expect(
      stepPicker(catalog.steps, catalog.stepGroups, setup).unavailable.map(({ step, missing }) => [
        step.type,
        missing,
      ]),
    ).toEqual([['email.verify', 'verification']]);
    const { emailVerification: _unsaid, ...older } = everything;
    expect(offered(older)).toContain('email.verify');
    expect(missingSetupOf({ type: 'email.verify', group: 'records' }, older)).toBeUndefined();
  });

  it('accounts for every step: offered, or listed with what it needs', () => {
    const picker = stepPicker(catalog.steps, catalog.stepGroups, nothing);
    const listed = [
      ...picker.groups.flatMap((group) => group.steps.map((step) => step.type)),
      ...picker.unavailable.map(({ step }) => step.type),
    ];
    expect(listed.toSorted()).toEqual(catalog.steps.map((step) => step.type).toSorted());
    expect(picker.unavailable.map(({ missing }) => missing).toSorted()).toEqual([
      'ai',
      'ai',
      'ai',
      'verification',
      'webhooks',
      'whatsapp',
    ]);
  });

  // The validator is the rule; the picker must refuse exactly what it would refuse. Each
  // step gets a config the contract accepts, since the validator checks the shape first.
  it.each(catalog.steps)('agrees with the validator about $type', (step) => {
    const config = stepExamples[step.type]?.config;
    if (config === undefined) throw new Error(`Add an example for ${step.type}.`);
    const check = (setup: typeof everything): boolean =>
      validateAutomation(
        { ...welcome, steps: { add_tag: { type: step.type, config } } },
        { ...harborSetup, ...setup },
      ).errors.some(
        (issue) =>
          issue.path === '/steps/add_tag' &&
          (issue.code.startsWith('no_') || issue.code === 'verification_off'),
      );
    expect(check(nothing)).toBe(missingSetupOf(step, nothing) !== undefined);
    expect(check(everything)).toBe(false);
    expect(missingSetupOf(step, everything)).toBeUndefined();
  });
});

describe('automationAccess', () => {
  it('allows only what the API plainly says is allowed', () => {
    expect(automationAccess({ canManage: true, canPublish: true })).toEqual({
      canManage: true,
      canPublish: true,
    });
    expect(automationAccess({ canManage: true })).toEqual({ canManage: true, canPublish: false });
    expect(automationAccess({ canManage: false, canPublish: true })).toEqual({
      canManage: false,
      canPublish: true,
    });
  });

  it.each([[undefined], [null], [{}], [{ canManage: 'true', canPublish: 1 }], [[true, true]]])(
    'is read-only for %j',
    (answer) => {
      expect(automationAccess(answer)).toEqual({ canManage: false, canPublish: false });
    },
  );
});

describe('setupOf', () => {
  it('gives the validator the setup the catalog sent', () => {
    const sent = {
      ...harborSetup,
      fields: {
        contact: [
          {
            key: 'services',
            aliases: [],
            type: 'multi_choice',
            options: [{ key: 'video', label: 'Video' }],
          },
          { key: 'mood', aliases: ['feeling'], type: 'emoji', options: [] },
          {
            key: 'diet',
            aliases: [],
            type: 'text',
            options: [],
            label: 'Dietary needs',
            folder: { id: 'ffld_forms', name: 'Form answers', position: 2 },
          },
          { key: 'loose', aliases: [], type: 'text', options: [], label: 'Loose', folder: null },
        ],
        deal: [],
      },
    };
    const setup = setupOf(sent);
    expect(setup.fields.contact).toEqual([
      {
        key: 'services',
        aliases: [],
        type: 'multi_choice',
        options: [{ key: 'video', label: 'Video' }],
      },
      { key: 'mood', aliases: ['feeling'], type: 'text', options: [] },
      // What the field is called and the folder it is in come through; no folder is left out.
      {
        key: 'diet',
        aliases: [],
        type: 'text',
        options: [],
        label: 'Dietary needs',
        folder: { id: 'ffld_forms', name: 'Form answers' },
      },
      { key: 'loose', aliases: [], type: 'text', options: [], label: 'Loose' },
    ]);
    expect(validateAutomation(followUp, setup).errors).toEqual([]);
  });

  it('keeps whether email verification is on, and leaves it out when the server does not say', () => {
    const verifying = { ...welcome, steps: { add_tag: { type: 'email.verify', config: {} } } };
    const off = setupOf({ ...harborSetup, emailVerification: false });
    expect(off.emailVerification).toBe(false);
    expect(validateAutomation(verifying, off).errors.map((issue) => issue.code)).toContain(
      'verification_off',
    );
    expect(setupOf({ ...harborSetup, emailVerification: true }).emailVerification).toBe(true);
    expect('emailVerification' in setupOf(harborSetup)).toBe(false);
  });
});

describe('availableTriggers', () => {
  it('leaves out the ways to start that nothing fires yet', () => {
    const offeredTriggers = availableTriggers(catalog.triggers, {
      unavailableTriggers: ['schedule', 'date.reached', 'webhook.received'],
    }).map((trigger) => trigger.type);
    expect(offeredTriggers).toContain('contact.created');
    expect(offeredTriggers).not.toContain('schedule');
    expect(offeredTriggers).toHaveLength(catalog.triggers.length - 3);
    expect(availableTriggers(catalog.triggers, { unavailableTriggers: [] })).toHaveLength(
      catalog.triggers.length,
    );
  });
});
