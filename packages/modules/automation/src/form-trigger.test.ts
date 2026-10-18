import { automationTrigger } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { eventPassesTrigger } from './triggers.js';

const form = automationTrigger.parse({
  id: 'quote_form',
  type: 'form.submitted',
  config: { form: '0192f3a0-1111-7222-8333-444455556666' },
});

describe('a selected form submission starts a workflow', () => {
  it('accepts the selected form submission event', () => {
    expect(
      eventPassesTrigger(form, 'form.submitted', {
        formId: '0192f3a0-1111-7222-8333-444455556666',
        submissionId: '0192f3a0-2222-7222-8333-444455556666',
      }),
    ).toBe(true);
  });

  it('refuses a submission for another form', () => {
    expect(
      eventPassesTrigger(form, 'form.submitted', {
        formId: '0192f3a0-3333-7222-8333-444455556666',
      }),
    ).toBe(false);
  });

  it('refuses a submission event without a form identity', () => {
    expect(
      eventPassesTrigger(form, 'form.submitted', {
        submissionId: '0192f3a0-2222-7222-8333-444455556666',
      }),
    ).toBe(false);
  });

  it('refuses an unrelated event even when it carries the selected form identity', () => {
    expect(
      eventPassesTrigger(form, 'contact.created', {
        formId: '0192f3a0-1111-7222-8333-444455556666',
      }),
    ).toBe(false);
  });
});
