// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  automationId,
  automationOf,
  followUp,
  harborSetup,
  versionTwo,
} from '../e2e/automation-fixtures';
import type { Draft } from './automation-document';
import VersionsDialog, { type VersionsDialogProps } from './automation-versions';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const summary = (version: number, more: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `aver_01k8e2wzr0e0080000000000${String(10 + version)}`,
  version,
  changeSummary: '',
  publishedAt: '2026-10-09T09:00:00.000Z',
  publishedByKind: 'user',
  ...more,
});
/** Version 1 sent a different text first; the draft on screen is the documentation's own. */
const older: Draft = {
  ...followUp,
  steps: {
    ...followUp.steps,
    send_reel: { type: 'sms.send', config: { message: 'An older text.' } },
  },
};
const answers = (more: Partial<Record<string, (input: unknown) => unknown>> = {}): void => {
  server.answer = (operation, input) => {
    const custom = more[operation];
    if (custom !== undefined) return custom(input);
    if (operation === 'listAutomationVersions')
      return {
        items: [
          summary(2, { changeSummary: 'Shorter texts', publishedByKind: 'api_key' }),
          summary(1),
        ],
        nextCursor: null,
      };
    if (operation === 'getAutomationVersion') {
      const { version } = (input as { params: { version: number } }).params;
      return { ...versionTwo, version, document: version === 1 ? older : followUp };
    }
    throw new Error(`Unexpected request: ${operation}`);
  };
};
const callsTo = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);

interface Shown {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly restored: unknown[];
  readonly conflicts: number[];
  readonly closed: boolean[];
}
function open(over: Partial<VersionsDialogProps> = {}): Shown {
  const restored: unknown[] = [];
  const conflicts: number[] = [];
  const closed: boolean[] = [];
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <VersionsDialog
          open
          onOpenChange={(next) => {
            closed.push(next);
          }}
          automationId={automationId}
          liveVersion={2}
          draft={followUp}
          baseDraftVersion={7}
          unsaved={false}
          canManage
          setup={harborSetup}
          onRestored={(saved, version) => {
            restored.push([saved.automation.draftVersion, version]);
          }}
          onConflict={() => {
            conflicts.push(1);
          }}
          {...over}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup({ delay: null }), restored, conflicts, closed };
}
const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Version history' });

describe('version history', () => {
  it('lists every published version: its number, when, by what, its note, and which is live', async () => {
    answers();
    open();
    const list = await within(dialog()).findByRole('list', { name: 'Published versions' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Version 2');
    expect(rows[0]?.textContent).toContain('Live');
    expect(rows[0]?.textContent).toContain('Published by an app, through the API');
    expect(rows[0]?.textContent).toContain('Shorter texts');
    expect(rows[1]?.textContent).toContain('Version 1');
    expect(rows[1]?.textContent).not.toContain('Live');
    expect(rows[1]?.textContent).toContain('Published by a team member');
    expect(rows[1]?.textContent).toContain('No note was written.');
  });

  it('names the other kinds of publisher, and loads older versions when there are more', async () => {
    answers({
      listAutomationVersions: (input) =>
        (input as { query: { after?: number } }).query.after === undefined
          ? {
              items: [
                summary(4, { publishedByKind: 'ai_agent' }),
                summary(3, { publishedByKind: 'import' }),
              ],
              nextCursor: 3,
            }
          : { items: [summary(2)], nextCursor: null },
    });
    const { user } = open();
    const list = await within(dialog()).findByRole('list', { name: 'Published versions' });
    expect(list.textContent).toContain('Published by the assistant');
    expect(list.textContent).toContain('Published by the system');
    await user.click(within(dialog()).getByRole('button', { name: 'Show older versions' }));
    await waitFor(() => {
      expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    });
    expect(callsTo('listAutomationVersions')).toEqual([
      { params: { id: automationId }, query: {} },
      { params: { id: automationId }, query: { after: 3 } },
    ]);
    expect(within(dialog()).queryByRole('button', { name: 'Show older versions' })).toBeNull();
  });

  it('says in words what restoring a version would change in the draft, and nothing when nothing would', async () => {
    answers();
    const { user } = open();
    await user.click(
      await within(dialog()).findByRole('button', { name: /^Version 1, published/ }),
    );
    const compared = await within(dialog()).findByRole('region', {
      name: 'Version 1 compared with your draft',
    });
    await waitFor(() => {
      expect(compared.textContent).toContain('An older text.');
    });
    expect(compared.textContent).toContain('Changed');
    expect(
      within(compared).getByRole('button', { name: 'Restore this version as the draft' }),
    ).toBeDefined();
    // The draft already reads as version 2 does: there is nothing to restore.
    await user.click(within(dialog()).getByRole('button', { name: /^Version 2, published/ }));
    const same = await within(dialog()).findByRole('region', {
      name: 'Version 2 compared with your draft',
    });
    await waitFor(() => {
      expect(same.textContent).toContain('Nothing: your draft already reads as this version does.');
    });
    expect(
      within(same).queryByRole('button', { name: 'Restore this version as the draft' }),
    ).toBeNull();
    // Pressed again, a version is put away.
    await user.click(within(dialog()).getByRole('button', { name: /^Version 2, published/ }));
    expect(within(dialog()).queryByRole('region', { name: /compared with your draft/ })).toBeNull();
  });

  it('restores a version as the draft only after asking, by saving it over the draft it started from', async () => {
    const saved = automationOf({ draft: older, draftVersion: 8 });
    answers({
      replaceAutomationDraft: () => ({
        automation: saved,
        validation: { valid: true, errors: [], warnings: [] },
      }),
    });
    const { user, restored, closed } = open({ unsaved: true });
    await user.click(
      await within(dialog()).findByRole('button', { name: /^Version 1, published/ }),
    );
    await user.click(
      await within(dialog()).findByRole('button', { name: 'Restore this version as the draft' }),
    );
    const confirm = await screen.findByRole('dialog', { name: 'Restore version 1 as the draft?' });
    expect(confirm.textContent).toContain('your unsaved changes are dropped');
    expect(confirm.textContent).toContain('Nothing is published');
    // Cancelled, nothing is sent.
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(callsTo('replaceAutomationDraft')).toEqual([]);
    await user.click(
      await within(dialog()).findByRole('button', { name: 'Restore this version as the draft' }),
    );
    await user.click(
      within(
        await screen.findByRole('dialog', { name: 'Restore version 1 as the draft?' }),
      ).getByRole('button', { name: 'Restore as the draft' }),
    );
    await waitFor(() => {
      expect(restored).toEqual([[8, 1]]);
    });
    expect(callsTo('replaceAutomationDraft')).toEqual([
      { params: { id: automationId }, body: { baseDraftVersion: 7, document: older } },
    ]);
    expect(callsTo('publishAutomation')).toEqual([]);
    expect(closed).toContain(false);
  });

  it('hands a save made meanwhile to the builder, and says why another refusal happened', async () => {
    const refusals: unknown[] = [
      new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 }),
      new ApiError({ type: 'about:blank', title: 'Bad', status: 422, detail: 'Too many steps.' }),
      new ApiError({ type: 'about:blank', title: 'Server Error', status: 500 }),
      new Error('offline'),
      new ApiError({ type: 'about:blank', title: 'Conflict', status: 409 }),
    ];
    answers({
      replaceAutomationDraft: () => {
        throw refusals.shift();
      },
    });
    const { user, conflicts, restored } = open();
    await user.click(
      await within(dialog()).findByRole('button', { name: /^Version 1, published/ }),
    );
    for (const words of [
      "You don't have permission to change workflows.",
      'Too many steps.',
      "We couldn't restore that version. Try again.",
      "We couldn't restore that version. Check your connection and try again.",
    ]) {
      await user.click(
        await within(dialog()).findByRole('button', { name: 'Restore this version as the draft' }),
      );
      await user.click(await screen.findByRole('button', { name: 'Restore as the draft' }));
      await waitFor(() => {
        expect(within(dialog()).getByRole('alert').textContent).toBe(words);
      });
    }
    await user.click(
      await within(dialog()).findByRole('button', { name: 'Restore this version as the draft' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Restore as the draft' }));
    await waitFor(() => {
      expect(conflicts).toEqual([1]);
    });
    expect(restored).toEqual([]);
  });

  it('shows the history to someone who cannot change the workflow, without a way to restore', async () => {
    answers();
    const { user } = open({ canManage: false });
    await user.click(
      await within(dialog()).findByRole('button', { name: /^Version 1, published/ }),
    );
    const compared = await within(dialog()).findByRole('region', {
      name: 'Version 1 compared with your draft',
    });
    await waitFor(() => {
      expect(compared.textContent).toContain('An older text.');
    });
    expect(
      within(compared).queryByRole('button', { name: 'Restore this version as the draft' }),
    ).toBeNull();
  });

  it('says when nothing was published yet, when the list cannot be loaded, and when a version cannot', async () => {
    let fail = true;
    answers({
      listAutomationVersions: () => {
        if (fail) throw new Error('offline');
        return { items: [], nextCursor: null };
      },
    });
    const first = open({ liveVersion: undefined });
    expect((await within(dialog()).findByRole('alert')).textContent).toContain(
      "We couldn't load the versions.",
    );
    fail = false;
    await first.user.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    expect(
      await within(dialog()).findByText(/This workflow hasn't been published yet\./),
    ).toBeDefined();
    await first.user.click(within(dialog()).getByRole('button', { name: 'Close' }));
    expect(first.closed).toEqual([false]);
    cleanup();

    answers({
      getAutomationVersion: () => {
        throw new Error('offline');
      },
    });
    const { user } = open();
    await user.click(
      await within(dialog()).findByRole('button', { name: /^Version 1, published/ }),
    );
    expect((await within(dialog()).findByRole('alert')).textContent).toBe(
      "We couldn't load that version. Choose it again to retry.",
    );
  });
});
