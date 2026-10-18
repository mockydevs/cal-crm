// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { catalogOf, harborSetup, recordSetup } from '../e2e/automation-fixtures';
import { SettingsDialog, type AutomationCatalogData } from './automation-step-dialog';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

it('edits an email restriction with its reason through native controls', async () => {
  const user = userEvent.setup();
  const saved = vi.fn();
  render(
    <I18nProvider i18n={i18n}>
      <SettingsDialog
        open
        onOpenChange={() => undefined}
        owner="step"
        presetType="dnd.set"
        catalog={catalogOf() as AutomationCatalogData}
        setup={harborSetup}
        onSubmit={saved}
      />
    </I18nProvider>,
  );
  await user.click(screen.getByLabelText('Restrict'));
  await user.click(await screen.findByRole('option', { name: 'Email' }));
  await user.click(screen.getByLabelText('Restriction'));
  await user.click(await screen.findByRole('option', { name: 'Clear do not disturb' }));
  await user.click(screen.getByLabelText('Reason'));
  await user.paste('Requested by {{contact.firstName}}.');
  await user.click(screen.getByRole('button', { name: 'Save action' }));
  expect(saved).toHaveBeenCalledWith(
    'dnd.set',
    {
      channel: 'email',
      action: 'disable',
      reason: 'Requested by {{contact.firstName}}.',
    },
    expect.objectContaining({ label: undefined }),
  );
  expect(
    screen.getByText('Clearing a restriction does not opt the contact into messages.'),
  ).toBeDefined();
});

it('requires a meaningful reason before saving', async () => {
  const user = userEvent.setup();
  const saved = vi.fn();
  render(
    <I18nProvider i18n={i18n}>
      <SettingsDialog
        open
        onOpenChange={() => undefined}
        owner="step"
        presetType="dnd.set"
        catalog={catalogOf() as AutomationCatalogData}
        setup={harborSetup}
        onSubmit={saved}
      />
    </I18nProvider>,
  );
  await user.type(screen.getByLabelText('Reason'), 'short');
  await user.click(screen.getByRole('button', { name: 'Save action' }));
  expect(saved).not.toHaveBeenCalled();
  expect(screen.getByText('Say why, using 10 to 1,000 characters.')).toBeDefined();
});

it('sets inbound do not disturb with no channel, which is one setting', async () => {
  const user = userEvent.setup();
  const saved = vi.fn();
  render(
    <I18nProvider i18n={i18n}>
      <SettingsDialog
        open
        onOpenChange={() => undefined}
        owner="step"
        presetType="dnd.set"
        catalog={catalogOf() as AutomationCatalogData}
        setup={harborSetup}
        onSubmit={saved}
      />
    </I18nProvider>,
  );
  // Outbound offers every channel this product stops, and not WhatsApp.
  await user.click(screen.getByLabelText('Restrict'));
  for (const name of ['Every channel', 'Email', 'Text messages', 'Calls & Voicemails', 'Web chat'])
    expect(await screen.findByRole('option', { name })).toBeDefined();
  expect(screen.queryByRole('option', { name: /WhatsApp/ })).toBeNull();
  await user.keyboard('{Escape}');
  await user.click(screen.getByLabelText(/^DND direction/));
  await user.click(await screen.findByRole('option', { name: 'Inbound' }));
  expect(screen.queryByLabelText('Restrict')).toBeNull();
  await user.click(screen.getByLabelText('Reason'));
  await user.paste('Calls every night at three.');
  await user.click(screen.getByRole('button', { name: 'Save action' }));
  expect(saved).toHaveBeenCalledWith(
    'dnd.set',
    { direction: 'inbound', action: 'enable', reason: 'Calls every night at three.' },
    expect.objectContaining({ label: undefined }),
  );
});

it('adds the team members chosen as followers', async () => {
  const user = userEvent.setup();
  const saved = vi.fn();
  render(
    <I18nProvider i18n={i18n}>
      <SettingsDialog
        open
        onOpenChange={() => undefined}
        owner="step"
        presetType="followers.add"
        catalog={catalogOf() as AutomationCatalogData}
        setup={recordSetup}
        onSubmit={saved}
      />
    </I18nProvider>,
  );
  await user.click(await screen.findByRole('button', { name: 'Save action' }));
  expect(saved).not.toHaveBeenCalled();
  expect(screen.getByText('Choose at least one team member.')).toBeDefined();
  await user.click(screen.getByRole('checkbox', { name: 'Sam Okoye' }));
  await user.click(screen.getByRole('checkbox', { name: 'Dana Brooks' }));
  expect(screen.getByText('2 chosen.')).toBeDefined();
  await user.click(screen.getByRole('button', { name: 'Save action' }));
  expect(saved).toHaveBeenCalledWith(
    'followers.add',
    { users: ['usr_sam', 'usr_dana'] },
    expect.objectContaining({ label: undefined }),
  );
});

it('removes chosen followers, or every follower with the toggle', async () => {
  const user = userEvent.setup();
  const saved = vi.fn();
  render(
    <I18nProvider i18n={i18n}>
      <SettingsDialog
        open
        onOpenChange={() => undefined}
        owner="step"
        presetType="followers.remove"
        catalog={catalogOf() as AutomationCatalogData}
        setup={recordSetup}
        onSubmit={saved}
      />
    </I18nProvider>,
  );
  await user.click(await screen.findByRole('checkbox', { name: 'Chris Marino' }));
  await user.click(screen.getByRole('switch', { name: 'Remove all followers' }));
  // Every follower: there is nobody to choose.
  expect(screen.queryByRole('checkbox', { name: 'Chris Marino' })).toBeNull();
  expect(screen.getByText('Every follower of the contact is removed.')).toBeDefined();
  await user.click(screen.getByRole('button', { name: 'Save action' }));
  expect(saved).toHaveBeenCalledWith(
    'followers.remove',
    { all: true },
    expect.objectContaining({ label: undefined }),
  );
});
