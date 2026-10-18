// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { automationId } from '../e2e/automation-fixtures';
import type { AutomationsSearch } from './automation-navigation';
// Read once, here, before any test starts. Each test still gets a fresh copy (below), but
// from code already read: reading it for the first time inside a test took most of the
// test's five seconds on a busy machine.
import './automation-builder-loader';

vi.mock('./shell/page', () => ({
  usePageTitle: () => undefined,
  Page: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  // Each test fetches the builder's code afresh: React keeps a lazy component's first answer.
  vi.resetModules();
});
afterEach(() => {
  cleanup();
  vi.doUnmock('./automation-builder');
});

async function open(): Promise<AutomationsSearch[]> {
  const went: AutomationsSearch[] = [];
  const { default: AutomationBuilderLoader } = await import('./automation-builder-loader');
  render(
    <I18nProvider i18n={i18n}>
      <AutomationBuilderLoader
        automationId={automationId}
        view="steps"
        navigation={{
          hrefFor: () => '/b/harbor/automations',
          go: (search) => {
            went.push(search);
          },
        }}
      />
    </I18nProvider>,
  );
  return went;
}

describe('the builder loader', () => {
  it('says the builder is loading, then shows it', async () => {
    vi.doMock('./automation-builder', () => ({
      default: (props: { automationId: string; view: string }): ReactElement => (
        <p>
          The builder, on {props.automationId}, in {props.view}
        </p>
      ),
    }));
    await open();
    expect(screen.getByRole('status').textContent).toBe('Loading the builder…');
    expect(await screen.findByText(`The builder, on ${automationId}, in steps`)).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it("says so when the builder's code doesn't arrive, and offers the ways on", async () => {
    vi.doMock('./automation-builder', () => {
      throw new Error('The chunk failed to load.');
    });
    // React reports what the boundary caught; that's this test's subject, not noise.
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const went = await open();
    const alert = await screen.findByRole('alert');
    reported.mockRestore();
    expect(alert.textContent).toMatch(/The builder couldn't load\. Your workflows are safe\./);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reload page' }));
    await userEvent.setup().click(screen.getByRole('link', { name: 'Workflows list' }));
    expect(went).toEqual([{}]);
  });
});
