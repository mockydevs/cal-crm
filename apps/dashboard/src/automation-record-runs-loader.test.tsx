// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Read once, here, before any test starts. Each test still gets a fresh copy (below), but
// from code already read: reading it for the first time inside a test took most of the
// test's five seconds on a busy machine.
import './automation-record-runs-loader';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  // Each test fetches the panel's code afresh: React keeps a lazy component's first answer.
  vi.resetModules();
});
afterEach(() => {
  cleanup();
  vi.doUnmock('./automation-record-runs');
});

async function show(): Promise<void> {
  const { RecordAutomationRunsLoader } = await import('./automation-record-runs-loader');
  render(
    <I18nProvider i18n={i18n}>
      <RecordAutomationRunsLoader recordId="con_01k8e2wzr0e008000000000031" />
    </I18nProvider>,
  );
}

describe("a record's automations, loaded after its page", () => {
  it('holds the panel’s place while its code loads, then shows it for the record', async () => {
    vi.doMock('./automation-record-runs', () => ({
      RecordAutomationRuns: (props: { recordId: string }): ReactElement => (
        <p>The automations of {props.recordId}</p>
      ),
    }));
    await show();
    const panel = screen.getByRole('region', { name: 'Workflows' });
    expect(within(panel).getByText('Loading automations…')).toBeDefined();
    expect(
      await screen.findByText('The automations of con_01k8e2wzr0e008000000000031'),
    ).toBeDefined();
  });

  it("says so in the panel's place when its code doesn't arrive", async () => {
    vi.doMock('./automation-record-runs', () => {
      throw new Error('The chunk failed to load.');
    });
    // React reports what the boundary caught; that's this test's subject, not noise.
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await show();
    const alert = await screen.findByRole('alert');
    reported.mockRestore();
    expect(alert.textContent).toBe(
      "The automations couldn't be loaded. Reload the page to try again.",
    );
    expect(screen.getByRole('region', { name: 'Workflows' })).toBeDefined();
  });
});
