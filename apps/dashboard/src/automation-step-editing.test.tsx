// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogOf, followUp, harborSetup } from '../e2e/automation-fixtures';
import type { Draft } from './automation-document';
import type { AutomationCatalogData } from './automation-step-dialog';
// Read once, here, before any test starts. Each test still gets a fresh copy (below), but
// from code already read: reading it for the first time inside a test took most of the
// test's five seconds on a busy machine.
import './automation-step-dialog';
import './automation-step-editing';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  // Each test fetches the forms' code afresh: React keeps a lazy component's first answer.
  vi.resetModules();
});
afterEach(() => {
  cleanup();
  vi.doUnmock('./automation-step-dialog');
});

async function show(): Promise<{ draft: () => Draft; user: ReturnType<typeof userEvent.setup> }> {
  const { useStepEditing } = await import('./automation-step-editing');
  let latest: Draft = followUp;
  function Harness(): ReactElement {
    const [draft, setDraft] = useState<Draft>(followUp);
    const editing = useStepEditing({
      draft,
      setup: harborSetup,
      catalog: catalogOf() as AutomationCatalogData,
      onChange: (next) => {
        latest = next;
        setDraft(next);
      },
      onEditInJson: () => undefined,
    });
    return (
      <>
        <button
          type="button"
          onClick={() => {
            editing.editStep('wait_2_days');
          }}
        >
          Edit the wait
        </button>
        <button
          type="button"
          onClick={() => {
            editing.removeStep('wait_2_days');
          }}
        >
          Remove the wait
        </button>
        {editing.dialogs}
      </>
    );
  }
  render(
    <I18nProvider i18n={i18n}>
      <Harness />
    </I18nProvider>,
  );
  // Keys follow one another with no timer between them (user-event's `delay`). Every key
  // is still its own events and its own render; what goes is a wait per character, which
  // on a busy machine took a long test past its five seconds.
  return { draft: () => latest, user: userEvent.setup({ delay: null }) };
}

describe('the step forms, fetched when one is first opened', () => {
  it('fetch nothing until a form is asked for, then open on the step', async () => {
    // The forms' own code is ready before the page is drawn, so the wait for the dialog
    // below is a wait on React. What is counted is the page asking for it.
    const forms = await vi.importActual<Record<string, unknown>>('./automation-step-dialog');
    let fetched = 0;
    vi.doMock('./automation-step-dialog', () => {
      fetched += 1;
      return forms;
    });
    const { user, draft } = await show();
    expect(fetched).toBe(0);
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(await screen.findByRole('button', { name: 'Edit the wait' }));
    const form = await screen.findByRole('dialog', { name: 'Wait' });
    expect(fetched).toBe(1);
    const amount = within(form).getByLabelText('How long to wait');
    await user.clear(amount);
    await user.type(amount, '6');
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(draft()).toMatchObject({ steps: { wait_2_days: { config: { duration: 'P6D' } } } });
    // Opened again, it is there at once: nothing is fetched twice.
    await user.click(await screen.findByRole('button', { name: 'Edit the wait' }));
    expect(await screen.findByRole('dialog', { name: 'Wait' })).toBeDefined();
    expect(fetched).toBe(1);
  });

  it("say so when their code doesn't arrive, and leave the draft and the rest working", async () => {
    vi.doMock('./automation-step-dialog', () => {
      throw new Error('The chunk failed to load.');
    });
    // React reports what the boundary caught; that's this test's subject, not noise.
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { user, draft } = await show();
    await user.click(screen.getByRole('button', { name: 'Edit the wait' }));
    const failed = await screen.findByRole('dialog', { name: "This form couldn't load" });
    reported.mockRestore();
    expect(failed.textContent).toContain(
      'Your draft is as you left it. Save it, then reload the page to try again.',
    );
    expect(draft()).toBe(followUp);
    await user.click(within(failed).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // What needs no form still works: removing a step asks, and removes.
    await user.click(screen.getByRole('button', { name: 'Remove the wait' }));
    const asking = await screen.findByRole('dialog', { name: 'Delete this action?' });
    await user.click(within(asking).getByRole('button', { name: 'Delete action' }));
    expect(Object.keys((draft() as { steps: object }).steps)).not.toContain('wait_2_days');
  });
});
