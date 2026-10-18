// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { DealBulkActionKind, Pipeline } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import DealBulkDialog from './deal-bulk';
import type { BulkTally } from './deal-bulk-rules';

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

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const weddings: Pipeline = {
  id: 'pipe_01m4bd188ff82s0add91b7pz63',
  name: 'Weddings',
  description: '',
  archived: false,
  stages: [
    { id: 'stage_01m4bd188ff82s0add91b7pz63', name: 'New lead', description: '', archived: false },
    { id: 'stage_01m4bd188ff82s0add91b7pz64', name: 'Old', description: '', archived: true },
  ],
};
const idsOf = (count: number): string[] =>
  Array.from({ length: count }, (_unused, index) => `deal_${String(index).padStart(26, '0')}`);

interface Body {
  readonly action: string;
  readonly ids: string[];
}
const bodyOf = (input: unknown): Body => (input as { body: Body }).body;
/** Answers every deal named as changed. */
const allDone = (input: unknown) => {
  const { action, ids } = bodyOf(input);
  return {
    action,
    results: ids.map((id) => ({ id, outcome: 'done', reason: null })),
    done: ids.length,
    unchanged: 0,
    skipped: 0,
    bulkActionId: 'bulk_01m4bd188ff82s0add91b7pz63',
  };
};

interface Done {
  tally: BulkTally;
  action: DealBulkActionKind;
  finished: boolean;
}

function show(
  action: DealBulkActionKind,
  ids: string[],
): { user: ReturnType<typeof userEvent.setup>; done: Done[]; closed: () => number } {
  const done: Done[] = [];
  let closes = 0;
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <DealBulkDialog
          businessId="biz_test"
          action={action}
          ids={ids}
          pipelines={[weddings]}
          pipelineId={weddings.id}
          returnFocus={{ current: null }}
          onClose={() => {
            closes += 1;
          }}
          onDone={(tally, ran, finished) => {
            done.push({ tally, action: ran, finished });
          }}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), done, closed: () => closes };
}

const bulkCalls = (): Body[] =>
  server.calls
    .filter((call) => call.operation === 'bulkUpdateDeals')
    .map((call) => bodyOf(call.input));

describe('a bulk action on the selected opportunities', () => {
  it('moves a selection over a hundred to the trash in requests of at most a hundred', async () => {
    server.answer = (_operation, input) => allDone(input);
    const ids = idsOf(150);
    const { user, done } = show('trash', ids);
    expect(screen.getByRole('dialog', { name: 'Delete opportunities' })).toBeTruthy();
    expect(screen.getByText(/150 opportunities are selected\./)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Move to trash' }));
    await waitFor(() => {
      expect(done).toHaveLength(1);
    });
    expect(bulkCalls().map((body) => body.ids.length)).toEqual([100, 50]);
    expect(bulkCalls().flatMap((body) => body.ids)).toEqual(ids);
    expect(bulkCalls().every((body) => body.action === 'trash')).toBe(true);
    expect(done[0]).toMatchObject({
      action: 'trash',
      finished: true,
      tally: { done: 150, unchanged: 0, skipped: 0 },
    });
  });

  it('sets the status with its reason, and moves to the first stage in use of the pipeline shown', async () => {
    server.answer = (_operation, input) => allDone(input);
    const first = show('set_status', idsOf(2));
    await first.user.type(screen.getByLabelText('Status reason (optional)'), ' Paid in full ');
    await first.user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(first.done).toHaveLength(1);
    });
    expect(bulkCalls()[0]).toEqual({
      action: 'set_status',
      ids: idsOf(2),
      status: 'won',
      outcomeReason: 'Paid in full',
    });
    cleanup();
    server.calls.length = 0;
    const second = show('move', idsOf(1));
    await second.user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(second.done).toHaveLength(1);
    });
    expect(bulkCalls()[0]).toEqual({
      action: 'move',
      ids: idsOf(1),
      pipelineId: weddings.id,
      stageId: 'stage_01m4bd188ff82s0add91b7pz63',
    });
  });

  it('reassigns to nobody unless someone is chosen', async () => {
    server.answer = (operation, input) =>
      operation === 'listTaskAssignees' ? { items: [], nextCursor: null } : allDone(input);
    const { user, done } = show('assign_owner', idsOf(1));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(done).toHaveLength(1);
    });
    expect(bulkCalls()[0]).toEqual({ action: 'assign_owner', ids: idsOf(1), owner: null });
  });

  it('says why nothing was run when the first request is refused, and stays open', async () => {
    server.answer = () => {
      throw new ApiError({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'You may not change deals.',
      });
    };
    const { user, done, closed } = show('trash', idsOf(3));
    await user.click(screen.getByRole('button', { name: 'Move to trash' }));
    expect((await screen.findByRole('alert')).textContent).toBe('You may not change deals.');
    expect(done).toHaveLength(0);
    expect(closed()).toBe(0);
  });

  it('reports what was changed before a later request failed', async () => {
    let requests = 0;
    server.answer = (_operation, input) => {
      requests += 1;
      if (requests === 2) throw new Error('offline');
      return allDone(input);
    };
    const { user, done } = show('trash', idsOf(120));
    await user.click(screen.getByRole('button', { name: 'Move to trash' }));
    await waitFor(() => {
      expect(done).toHaveLength(1);
    });
    expect(done[0]).toMatchObject({ finished: false, tally: { done: 100 } });
  });
});
