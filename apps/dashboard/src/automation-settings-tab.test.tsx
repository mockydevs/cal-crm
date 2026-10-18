// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { validateAutomation } from '@repo/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { followUp, harborSetup, welcome } from '../e2e/automation-fixtures';
import type { Draft } from './automation-document';
import SettingsTab from './automation-settings-tab';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

// The draft as the tab last changed it.
const seen: { draft: Draft } = { draft: {} };

function Harness({
  initial,
  editable,
}: {
  readonly initial: Draft;
  readonly editable: boolean;
}): ReactElement {
  const [draft, setDraft] = useState(initial);
  return (
    <I18nProvider i18n={i18n}>
      <SettingsTab
        draft={draft}
        editable={editable}
        onChange={(next) => {
          seen.draft = next;
          setDraft(next);
        }}
      />
    </I18nProvider>
  );
}

function open(initial: Draft, editable = true): ReturnType<typeof userEvent.setup> {
  render(<Harness initial={initial} editable={editable} />);
  return userEvent.setup({ delay: null });
}

const toggle = (name: string): HTMLElement => screen.getByRole('switch', { name });
const isOn = (name: string): boolean => toggle(name).getAttribute('aria-checked') === 'true';

describe('the Settings tab', () => {
  it("shows the document's settings as cards of switches, each saying what it does", () => {
    open(followUp);
    expect(screen.getAllByRole('heading', { level: 2 }).map((each) => each.textContent)).toEqual([
      'Contact',
      'Communication',
    ]);
    const contact = screen.getByRole('region', { name: 'Contact' });
    expect(
      within(contact)
        .getAllByRole('switch')
        .map((each) => each.getAttribute('aria-labelledby'))
        .map((id) => document.getElementById(id ?? '')?.textContent),
    ).toEqual(['Allow re-entry', 'Stop on response']);
    expect(isOn('Allow re-entry')).toBe(true);
    expect(isOn('Stop on response')).toBe(true);
    expect(isOn('Specific time')).toBe(false);
    expect(toggle('Stop on response').getAttribute('aria-describedby')).not.toBeNull();
    expect(
      document.getElementById(toggle('Stop on response').getAttribute('aria-describedby') ?? '')
        ?.textContent,
    ).toBe(
      'The workflow ends for a contact as soon as they send a message. Any message counts, on any channel, unless you ask only for replies to what this workflow sent.',
    );
    expect(screen.getByRole('combobox', { name: 'Timezone' }).textContent).toBe('Contact timezone');
    // What the engine does not have is not drawn.
    expect(screen.queryByText(/multiple opportunities/i)).toBeNull();
    expect(screen.queryByText(/Sender/)).toBeNull();
  });

  it('switches re-entry and the stop on a reply, in the draft', async () => {
    const user = open(followUp);
    await user.click(toggle('Allow re-entry'));
    expect(isOn('Allow re-entry')).toBe(false);
    expect(seen.draft['settings']).toEqual({ reEnrollment: 'never', timezone: 'contact' });
    await user.click(toggle('Stop on response'));
    expect(isOn('Stop on response')).toBe(false);
    expect(seen.draft['stopWhen']).toEqual([
      { event: 'appointment.booked' },
      { event: 'deal.closed' },
    ]);
    await user.click(toggle('Stop on response'));
    expect(seen.draft['stopWhen']).toEqual([
      { event: 'appointment.booked' },
      { event: 'deal.closed' },
      { event: 'message.received', from: 'contact' },
    ]);
    expect(validateAutomation(seen.draft, harborSetup).errors).toEqual([]);
  });

  it('chooses whose clock the workflow goes by', async () => {
    const user = open(welcome);
    expect(screen.getByRole('combobox', { name: 'Timezone' }).textContent).toBe('Account timezone');
    await user.click(screen.getByRole('combobox', { name: 'Timezone' }));
    await user.click(await screen.findByRole('option', { name: 'Contact timezone' }));
    expect(seen.draft['settings']).toEqual({ reEnrollment: 'never', timezone: 'contact' });
    await user.click(screen.getByRole('combobox', { name: 'Timezone' }));
    await user.click(await screen.findByRole('option', { name: 'Account timezone' }));
    expect(seen.draft['settings']).toEqual({ reEnrollment: 'never', timezone: 'business' });
  });

  it('opens a time window on working hours, and changes its days and its times', async () => {
    const user = open(welcome);
    expect(screen.queryByRole('group', { name: 'Days' })).toBeNull();
    await user.click(toggle('Specific time'));
    const days = screen.getByRole('group', { name: 'Days' });
    expect(
      within(days)
        .getAllByRole('checkbox')
        .map((box) => (box as HTMLInputElement).checked),
    ).toEqual([true, true, true, true, true, false, false]);
    await user.click(within(days).getByRole('checkbox', { name: 'Saturday' }));
    await user.click(within(days).getByRole('checkbox', { name: 'Monday' }));
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '08:30' } });
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '18:00' } });
    // An emptied time is not a time: the one before it stays.
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '' } });
    expect(seen.draft['settings']).toEqual({
      reEnrollment: 'never',
      timezone: 'business',
      sendingWindow: {
        days: ['tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
        start: '08:30',
        end: '18:00',
      },
    });
    expect(validateAutomation(seen.draft, harborSetup).errors).toEqual([]);

    await user.click(toggle('Specific time'));
    expect(seen.draft['settings']).toEqual({ reEnrollment: 'never', timezone: 'business' });
    expect(screen.queryByRole('group', { name: 'Days' })).toBeNull();
  });

  it('asks which messages stop it, once it stops on a response', async () => {
    const user = open(welcome);
    expect(screen.queryByRole('combobox', { name: 'Which messages stop it' })).toBeNull();
    await user.click(toggle('Stop on response'));
    const which = screen.getByRole('combobox', { name: 'Which messages stop it' });
    expect(which.textContent).toBe('Any message from the contact');
    await user.click(which);
    await user.click(
      await screen.findByRole('option', {
        name: 'Only when they reply to a message this automation sent',
      }),
    );
    expect(seen.draft['stopWhen']).toEqual([
      { event: 'message.received', from: 'contact', repliedTo: 'this_run' },
    ]);
    expect(validateAutomation(seen.draft, harborSetup).errors).toEqual([]);
    expect(
      document.getElementById(which.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toMatch(/^A reply counts when this contact's run has already sent them a message/);
  });

  it('says so when a window has no day left', async () => {
    const user = open({
      ...welcome,
      settings: { sendingWindow: { days: ['monday'], start: '09:00', end: '17:00' } },
    });
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Monday' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'Choose at least one day, or messages would never be sent.',
    );
  });

  it('is for reading only when the draft cannot be changed', () => {
    open(
      {
        ...followUp,
        settings: { sendingWindow: { days: ['monday'], start: '09:00', end: '17:00' } },
      },
      false,
    );
    expect(screen.getByText("These settings can't be changed right now.")).toBeDefined();
    for (const each of screen.getAllByRole('switch'))
      expect((each as HTMLButtonElement).disabled).toBe(true);
    for (const each of screen.getAllByRole('checkbox'))
      expect((each as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByLabelText('Start time')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('End time')).toHaveProperty('disabled', true);
    expect(screen.getByRole('combobox', { name: 'Timezone' })).toHaveProperty('disabled', true);
  });
});
