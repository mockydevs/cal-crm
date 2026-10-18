import { i18n } from '@lingui/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { needsWords } from './automation-setup-words';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

describe('what a step that cannot be used yet needs', () => {
  it('points to where email verification is turned on', () => {
    expect(needsWords('verification')).toBe(
      'Turn on email verification in Settings → Email Services → Email Verification to use this action.',
    );
  });

  it('still says what the other steps need', () => {
    expect(needsWords('webhooks')).toBe(
      'Create a webhook signing secret in Settings to use this action.',
    );
    expect(needsWords('unavailable')).toBe("This action isn't available yet.");
  });
});
