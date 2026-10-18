// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { automationId, followUp, harborSetup } from '../e2e/automation-fixtures';
import type { CanvasLoader, RunsLoader } from './automation-view-loader';
// Read once, here, before any test starts. Each test still gets a fresh copy (below), but
// from code already read: reading it for the first time inside a test took most of the
// test's five seconds on a busy machine.
import './automation-view-loader';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  // Each test fetches the view's code afresh: React keeps a lazy component's first answer.
  vi.resetModules();
});
afterEach(() => {
  cleanup();
  vi.doUnmock('./automation-canvas');
  vi.doUnmock('./automation-runs');
});

const nothing = (): void => undefined;
const canvasProps: ComponentProps<typeof CanvasLoader> = {
  draft: followUp,
  setup: harborSetup,
  steps: [],
  stepGroups: [],
  issues: [],
  editable: true,
  editing: {
    addStep: nothing,
    editStep: nothing,
    removeStep: nothing,
    addTrigger: nothing,
    editTrigger: nothing,
    removeTrigger: nothing,
    duplicateTrigger: nothing,
    selected: undefined,
  },
  onChange: nothing,
  onEditInJson: nothing,
};
const runsProps: ComponentProps<typeof RunsLoader> = {
  automationId,
  runId: undefined,
  setup: harborSetup,
  navigation: { hrefFor: () => '', go: nothing },
};

async function show(view: 'canvas' | 'runs'): Promise<void> {
  const loaders = await import('./automation-view-loader');
  render(
    <I18nProvider i18n={i18n}>
      {view === 'canvas' ? (
        <loaders.CanvasLoader {...canvasProps} />
      ) : (
        <loaders.RunsLoader {...runsProps} />
      )}
    </I18nProvider>,
  );
}

describe('a view loaded when first opened', () => {
  it('says the canvas is loading, then shows it with what the builder gave it', async () => {
    vi.doMock('./automation-canvas', () => ({
      default: (props: { editable: boolean; draft: { name: string } }): ReactElement => (
        <p>
          The canvas of {props.draft.name}, {props.editable ? 'editable' : 'read-only'}
        </p>
      ),
    }));
    await show('canvas');
    expect(screen.getByRole('status').textContent).toBe('Loading the canvas…');
    expect(await screen.findByText('The canvas of New lead follow-up, editable')).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says the runs are loading, then shows them', async () => {
    vi.doMock('./automation-runs', () => ({
      default: (props: { automationId: string }): ReactElement => (
        <p>The runs of {props.automationId}</p>
      ),
    }));
    await show('runs');
    expect(screen.getByRole('status').textContent).toBe('Loading the runs…');
    expect(await screen.findByText(`The runs of ${automationId}`)).toBeDefined();
  });

  it.each([
    ['canvas', './automation-canvas', /The canvas couldn't load\. Your draft is still here/],
    ['runs', './automation-runs', /The run history couldn't load\. Your draft is still here/],
  ] as const)(
    "says so in the view's place when the %s's code doesn't arrive, and loses nothing",
    async (view, module, message) => {
      vi.doMock(module, () => {
        throw new Error('The chunk failed to load.');
      });
      // React reports what the boundary caught; that's this test's subject, not noise.
      const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await show(view);
      const alert = await screen.findByRole('alert');
      reported.mockRestore();
      expect(alert.textContent).toMatch(message);
    },
  );
});
