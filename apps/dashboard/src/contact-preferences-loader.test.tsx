// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Read once, here, before any test starts. Each test still gets a fresh copy (below), but
// from code already read: reading it for the first time inside a test took most of the
// test's five seconds on a busy machine.
import './contact-preferences-loader';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  // Each test fetches the forms' code afresh: React keeps a lazy component's first answer.
  vi.resetModules();
});
afterEach(() => {
  cleanup();
  vi.doUnmock('./contact-preferences-forms');
});

const opened = { timeZone: null, doNotContact: false, preferencesRevision: 'a'.repeat(64) };

async function open(): Promise<{ closed: () => number }> {
  let closed = 0;
  const { default: ContactPreferenceFormLoader } = await import('./contact-preferences-loader');
  render(
    <I18nProvider i18n={i18n}>
      <ContactPreferenceFormLoader
        setting="doNotContact"
        contactId="con_01m4bd188ff82s0add91b7pz63"
        opened={opened}
        onOutdated={() => undefined}
        close={() => {
          closed += 1;
        }}
      />
    </I18nProvider>,
  );
  return { closed: () => closed };
}

describe('the forms loader', () => {
  it('says the form is loading, then shows it with what it was given', async () => {
    vi.doMock('./contact-preferences-forms', () => ({
      default: (props: { setting: string; contactId: string }): ReactElement => (
        <p>
          The {props.setting} form, for {props.contactId}
        </p>
      ),
    }));
    await open();
    expect(screen.getByRole('status').textContent).toBe('Loading form…');
    expect(
      await screen.findByText('The doNotContact form, for con_01m4bd188ff82s0add91b7pz63'),
    ).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it("says so when the form's code doesn't arrive, and lets the person leave it", async () => {
    vi.doMock('./contact-preferences-forms', () => {
      throw new Error('The chunk failed to load.');
    });
    // React reports what the boundary caught; that's this test's subject, not noise.
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { closed } = await open();
    const alert = await screen.findByRole('alert');
    reported.mockRestore();
    expect(alert.textContent).toMatch(/The form couldn't load\. Nothing was changed\./);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reload page' }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(closed()).toBe(1);
  });
});
