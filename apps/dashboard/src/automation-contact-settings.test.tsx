// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { catalogOf, harborSetup } from '../e2e/automation-fixtures';
import { SettingsDialog, type AutomationCatalogData } from './automation-step-dialog';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

it('saves a contact name change through field controls without writing JSON', async () => {
  const user = userEvent.setup();
  const saved = vi.fn();
  render(
    <I18nProvider i18n={i18n}>
      <SettingsDialog
        open
        onOpenChange={() => undefined}
        owner="step"
        presetType="contact.update"
        catalog={catalogOf() as AutomationCatalogData}
        setup={harborSetup}
        onSubmit={saved}
      />
    </I18nProvider>,
  );
  await user.click(await screen.findByRole('button', { name: 'Add field' }));
  await user.type(screen.getByLabelText('Value, field 1'), 'Grace');
  await user.click(screen.getByRole('button', { name: 'Save action' }));
  expect(saved).toHaveBeenCalledWith(
    'contact.update',
    { fields: { 'contact.firstName': 'Grace' } },
    { condition: undefined, label: undefined },
  );
});
