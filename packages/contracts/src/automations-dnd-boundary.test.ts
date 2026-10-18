import { expect, it } from 'vitest';

import { automationStep } from './automations.js';
import { automationStepTypes, automationTriggerTypes } from './automations-catalog.js';
import { offeredDndChannels } from './contact-attributes.js';
import { validateAutomation } from './automations-validate.js';

it('refuses an unknown DND reason merge field before publishing', () => {
  const result = validateAutomation(
    {
      name: 'Respect contact preferences',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'restrict',
      steps: {
        restrict: {
          type: 'dnd.set',
          config: {
            channel: 'all',
            action: 'enable',
            reason: 'Requested by {{contact.unknown}}.',
          },
        },
      },
    },
    {
      fields: { contact: [], deal: [] },
      values: [],
      tags: [],
      users: [],
      pipelines: [],
      lostReasons: [],
      emailTemplates: [],
      whatsappTemplates: [],
      phoneNumbers: [],
      mailboxes: [],
      calendars: [],
      forms: [],
      automations: [],
      ai: false,
      channels: { email: false, sms: false, whatsapp: false },
      webhooks: false,
      unavailableSteps: [],
      unavailableTriggers: [],
    },
  );
  expect(result.valid).toBe(false);
  expect(result.errors).toMatchObject([
    { path: '/steps/restrict/config/reason', code: 'unknown_merge_field' },
  ]);
});

it.each(['all', 'email', 'sms', 'call', 'webchat'])(
  'accepts a native DND restriction for %s',
  (channel) => {
    expect(
      automationStep.safeParse({
        type: 'dnd.set',
        config: { channel, action: 'enable', reason: 'Requested by the contact.' },
      }).success,
    ).toBe(true);
    expect(
      automationStep.safeParse({
        type: 'dnd.set',
        config: {
          direction: 'outbound',
          channel,
          action: 'enable',
          reason: 'Requested by the contact.',
        },
      }).success,
    ).toBe(true);
  },
);

it('takes inbound do not disturb with no channel, since it is one setting', () => {
  const inbound = (channel?: string) =>
    automationStep.safeParse({
      type: 'dnd.set',
      config: {
        direction: 'inbound',
        ...(channel === undefined ? {} : { channel }),
        action: 'enable',
        reason: 'Calls every night.',
      },
    });
  expect(inbound().success).toBe(true);
  for (const channel of ['all', 'sms']) {
    const refused = inbound(channel);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(['config', 'channel']);
  }
  // Outbound needs one.
  const unnamed = automationStep.safeParse({
    type: 'dnd.set',
    config: { action: 'enable', reason: 'Requested by the contact.' },
  });
  expect(unnamed.error?.issues[0]).toMatchObject({
    path: ['config', 'channel'],
    message: 'Choose every channel, or one channel.',
  });
  expect(
    automationStep.safeParse({
      type: 'dnd.set',
      config: { direction: 'sideways', channel: 'all', action: 'enable', reason: 'Calls a lot.' },
    }).success,
  ).toBe(false);
});

it('accepts clearing a restriction with a reason', () => {
  expect(
    automationStep.safeParse({
      type: 'dnd.set',
      config: { channel: 'email', action: 'disable', reason: 'Requested by the contact.' },
    }).success,
  ).toBe(true);
});

it.each(['', '123456789', ' '.repeat(20), 'x'.repeat(1001)])(
  'refuses an invalid DND reason',
  (reason) => {
    expect(
      automationStep.safeParse({
        type: 'dnd.set',
        config: { channel: 'all', action: 'enable', reason },
      }).success,
    ).toBe(false);
  },
);

it.each(['whatsapp', 'inbound', 'fax'])('refuses unsupported native DND channel %s', (channel) => {
  expect(
    automationStep.safeParse({
      type: 'dnd.set',
      config: { channel, action: 'enable', reason: 'Requested by the contact.' },
    }).success,
  ).toBe(false);
});

it('refuses caller revisions and invented consent overrides', () => {
  expect(
    automationStep.safeParse({
      type: 'dnd.set',
      config: {
        channel: 'all',
        action: 'disable',
        reason: 'Requested by the contact.',
        grantConsent: true,
      },
    }).success,
  ).toBe(false);
});

it('offers the contact page’s channels, every channel at once first, in the action and the trigger', () => {
  const channelsOf = (config: unknown): unknown =>
    (
      config as { shape: { channel: { unwrap: () => { options: unknown } } } }
    ).shape.channel.unwrap().options;
  expect(channelsOf(automationStepTypes['dnd.set'].config)).toEqual(['all', ...offeredDndChannels]);
  expect(channelsOf(automationTriggerTypes['contact.dnd_changed'].config)).toEqual([
    'all',
    ...offeredDndChannels,
  ]);
});
