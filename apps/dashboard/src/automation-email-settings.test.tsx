// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { catalogOf, harborSetup } from '../e2e/automation-fixtures';
import { SettingsDialog, type AutomationCatalogData } from './automation-step-dialog';

vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));

function surroundings({ children }: { readonly children: ReactNode }): ReactElement {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

beforeAll(async () => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  await import('./email-step/panel');
});
afterEach(cleanup);

it('preserves a saved template and sender even when their setup records are unavailable', async () => {
  const user = userEvent.setup();
  const saved = vi.fn();
  render(
    <I18nProvider i18n={i18n}>
      <SettingsDialog
        open
        onOpenChange={() => undefined}
        owner="step"
        editing={{
          key: 'email-step',
          type: 'email.send',
          config: { template: 'emt_saved', mailbox: 'mbx_saved' },
        }}
        catalog={catalogOf() as AutomationCatalogData}
        setup={{ ...harborSetup, emailTemplates: [], mailboxes: [] }}
        onSubmit={saved}
      />
    </I18nProvider>,
    { wrapper: surroundings },
  );
  expect(await screen.findByRole('radio', { name: 'Select existing template' })).toHaveProperty(
    'checked',
    true,
  );
  expect(screen.queryByLabelText('Subject')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Save action' }));
  expect(saved).toHaveBeenCalledWith(
    'email.send',
    { template: 'emt_saved', mailbox: 'mbx_saved' },
    { condition: undefined, label: undefined },
  );
});

it('saves inline email content without a template or connected mailbox', async () => {
  const user = userEvent.setup();
  const saved = vi.fn();
  render(
    <I18nProvider i18n={i18n}>
      <SettingsDialog
        open
        onOpenChange={() => undefined}
        owner="step"
        presetType="email.send"
        catalog={catalogOf() as AutomationCatalogData}
        setup={{ ...harborSetup, emailTemplates: [], mailboxes: [] }}
        onSubmit={saved}
      />
    </I18nProvider>,
    { wrapper: surroundings },
  );
  await user.click(await screen.findByLabelText('Subject'));
  await user.paste('Hello {{contact.firstName}}');
  await user.type(screen.getByLabelText('Message'), 'Welcome to our team.');
  await user.click(await screen.findByRole('radio', { name: 'Select existing template' }));
  expect(screen.queryByLabelText('Subject')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Save action' }));
  expect(saved).not.toHaveBeenCalled();
  await user.click(screen.getByRole('radio', { name: 'Quick compose' }));
  expect(screen.getByLabelText<HTMLInputElement>('Subject').value).toBe(
    'Hello {{contact.firstName}}',
  );
  expect(screen.getByLabelText<HTMLTextAreaElement>('Message').value).toBe('Welcome to our team.');
  await user.click(screen.getByRole('button', { name: 'Save action' }));
  expect(saved).toHaveBeenCalledWith(
    'email.send',
    { subject: 'Hello {{contact.firstName}}', body: 'Welcome to our team.' },
    { condition: undefined, label: undefined },
  );
});
