import { automationCatalog, validateAutomation } from '@repo/contracts';
import { expect, it } from 'vitest';
import { harborSetup, welcome } from '../e2e/automation-fixtures';
import { stepPicker } from './automation-rules';

const disconnected = {
  ...harborSetup,
  channels: { email: false, sms: false, whatsapp: false },
};

it('offers implemented email and SMS for authoring before connecting their channels', () => {
  const catalog = automationCatalog();
  const picker = stepPicker(catalog.steps, catalog.stepGroups, disconnected);
  const messages = picker.groups
    .flatMap((group) => group.steps)
    .filter((step) => step.type === 'email.send' || step.type === 'sms.send')
    .map((step) => step.type);
  expect(messages).toEqual(['email.send', 'sms.send']);
});

it('keeps genuinely unimplemented email and SMS actions unavailable', () => {
  const catalog = automationCatalog();
  const picker = stepPicker(catalog.steps, catalog.stepGroups, {
    ...disconnected,
    unavailableSteps: ['email.send', 'sms.send'],
  });
  expect(
    picker.unavailable
      .filter(({ step }) => step.type === 'email.send' || step.type === 'sms.send')
      .map(({ step, missing }) => [step.type, missing]),
  ).toEqual([
    ['email.send', 'unavailable'],
    ['sms.send', 'unavailable'],
  ]);
});

it('still refuses publishing a disconnected SMS step with a real message', () => {
  const result = validateAutomation(
    {
      ...welcome,
      start: 'message',
      steps: { message: { type: 'sms.send', config: { message: 'Hi {{contact.firstName}}' } } },
    },
    disconnected,
  );
  expect(result.errors.map(({ path, code }) => ({ path, code }))).toEqual([
    { path: '/steps/message', code: 'no_provider' },
  ]);
});
