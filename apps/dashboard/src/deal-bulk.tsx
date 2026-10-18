// The dialog a bulk action on the selected opportunities is set up and run in: change the
// owner, move to a pipeline and stage, set the status, or delete, which moves them to the
// trash. The server applies it at once to at most a hundred opportunities a request and
// says what became of each; a larger selection goes in several requests. Fetched when an
// action is first chosen.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  bulkUpdateDeals,
  DEAL_BULK_LIMIT,
  listTaskAssignees,
  type BulkDealsResult,
  type DealBulkActionKind,
  type EndpointInput,
  type Pipeline,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Field, FieldLabel } from '@repo/ui/components/field';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useId, useState, type ReactElement, type RefObject } from 'react';

import { apiIn } from './api';
import { batchesOf, tallyOf, type BulkTally } from './deal-bulk-rules';
import { refusalOf } from './deal-people-data';
import { SmallDialog } from './settings-list';

type BulkBody = EndpointInput<typeof bulkUpdateDeals>['body'];
type Status = 'open' | 'won' | 'lost';

const NO_OWNER = 'none';

/** A request that failed after others had gone through: what those changed is kept. */
class PartlyDone extends Error {
  constructor(readonly tally: BulkTally) {
    super();
  }
}

export default function DealBulkDialog({
  businessId,
  action,
  ids,
  pipelines,
  pipelineId,
  returnFocus,
  onClose,
  onDone,
}: {
  readonly businessId: string;
  readonly action: DealBulkActionKind;
  /** The opportunities selected, each once. */
  readonly ids: readonly string[];
  readonly pipelines: readonly Pipeline[];
  /** The pipeline the page shows, offered first for a move. */
  readonly pipelineId: string | undefined;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  /** What became of the opportunities, also when a later request failed after some changed. */
  readonly onDone: (tally: BulkTally, action: DealBulkActionKind, finished: boolean) => void;
}): ReactElement {
  const { t } = useLingui();
  const formId = useId();
  const client = apiIn(businessId);
  const count = ids.length;
  const usable = pipelines.filter(
    (each) => !each.archived && each.stages.some((stage) => !stage.archived),
  );
  const [owner, setOwner] = useState(NO_OWNER);
  const [toPipeline, setToPipeline] = useState(
    usable.find((each) => each.id === pipelineId)?.id ?? usable[0]?.id ?? '',
  );
  const stagesOf = (id: string) =>
    usable.find((each) => each.id === id)?.stages.filter((stage) => !stage.archived) ?? [];
  const [toStage, setToStage] = useState(() => stagesOf(toPipeline)[0]?.id ?? '');
  const [status, setStatus] = useState<Status>('won');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string>();
  const people = useInfiniteQuery({
    queryKey: ['b', businessId, 'task-assignees'],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      client.request(listTaskAssignees, {
        query: pageParam === undefined ? {} : { after: pageParam },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: action === 'assign_owner',
    staleTime: 60_000,
  });
  const team = people.data?.pages.flatMap((page) => page.items) ?? [];
  const bodyFor = (batch: string[]): BulkBody =>
    action === 'assign_owner'
      ? { action, ids: batch, owner: owner === NO_OWNER ? null : owner }
      : action === 'move'
        ? { action, ids: batch, pipelineId: toPipeline, stageId: toStage }
        : action === 'set_status'
          ? {
              action,
              ids: batch,
              status,
              outcomeReason: status === 'open' ? null : reason.trim() || null,
            }
          : { action, ids: batch };
  const run = useMutation({
    mutationFn: async () => {
      const results: BulkDealsResult[] = [];
      for (const batch of batchesOf(ids, DEAL_BULK_LIMIT)) {
        try {
          results.push(await client.request(bulkUpdateDeals, { body: bodyFor(batch) }));
        } catch (failure) {
          if (results.length === 0) throw failure;
          throw new PartlyDone(tallyOf(results));
        }
      }
      return tallyOf(results);
    },
    onMutate: () => {
      setProblem(undefined);
    },
    onSuccess: (tally) => {
      onDone(tally, action, true);
    },
    onError: (failure) => {
      const fallback = t`The bulk action wasn't run. Check your connection and try again.`;
      if (failure instanceof PartlyDone) {
        onDone(failure.tally, action, false);
        return;
      }
      setProblem(refusalOf(failure, fallback));
    },
  });
  const titles: Readonly<Record<DealBulkActionKind, string>> = {
    assign_owner: t`Change owner`,
    move: t`Change pipeline and stage`,
    set_status: t`Change status`,
    trash: t`Delete opportunities`,
  };
  const ready =
    action === 'move'
      ? toPipeline !== '' && toStage !== ''
      : action === 'set_status'
        ? status !== 'lost' || reason.trim() !== ''
        : true;
  const selectedText = plural(count, {
    one: '# opportunity is selected.',
    other: '# opportunities are selected.',
  });
  return (
    <SmallDialog
      open
      onClose={() => {
        if (!run.isPending) onClose();
      }}
      title={titles[action]}
      description={
        action === 'trash'
          ? t`${selectedText} They move to the trash, where each can be restored.`
          : selectedText
      }
      returnFocus={returnFocus}
    >
      <form
        id={formId}
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !run.isPending) run.mutate();
        }}
      >
        {action === 'assign_owner' ? (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            <Trans>New owner</Trans>
            <Select
              aria-label={t`New owner`}
              value={owner}
              disabled={run.isPending}
              onValueChange={setOwner}
            >
              <option value={NO_OWNER}>{t`No owner`}</option>
              {team.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.you ? t`You` : (person.name ?? t`Team member`)}
                </option>
              ))}
            </Select>
            {people.isError ? (
              <span role="alert" className="font-normal">
                <Trans>People couldn't be loaded.</Trans>
              </span>
            ) : null}
            {people.hasNextPage ? (
              <Button
                variant="quiet"
                size="small"
                className="self-start"
                disabled={people.isFetching}
                onClick={() => {
                  void people.fetchNextPage();
                }}
              >
                <Trans>Load more people</Trans>
              </Button>
            ) : null}
          </label>
        ) : null}
        {action === 'move' ? (
          usable.length === 0 ? (
            <p role="alert" className="text-sm">
              <Trans>There is no pipeline with a stage in use to move them to.</Trans>
            </p>
          ) : (
            <>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                <Trans>Pipeline</Trans>
                <Select
                  aria-label={t`Move to pipeline`}
                  value={toPipeline}
                  disabled={run.isPending}
                  onValueChange={(next) => {
                    setToPipeline(next);
                    setToStage(stagesOf(next)[0]?.id ?? '');
                  }}
                >
                  {usable.map((each) => (
                    <option key={each.id} value={each.id}>
                      {each.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                <Trans>Stage</Trans>
                <Select
                  aria-label={t`Move to stage`}
                  value={toStage}
                  disabled={run.isPending}
                  onValueChange={setToStage}
                >
                  {stagesOf(toPipeline).map((stage) => (
                    <option key={stage.id} value={stage.id}>
                      {stage.name}
                    </option>
                  ))}
                </Select>
              </label>
            </>
          )
        ) : null}
        {action === 'set_status' ? (
          <>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              <Trans>Status</Trans>
              <Select
                aria-label={t`New status`}
                value={status}
                disabled={run.isPending}
                onValueChange={(next) => {
                  if (next === 'open' || next === 'won' || next === 'lost') setStatus(next);
                }}
              >
                <option value="open">{t`Open`}</option>
                <option value="won">{t`Won`}</option>
                <option value="lost">{t`Lost`}</option>
              </Select>
            </label>
            {status === 'open' ? null : (
              <Field>
                <FieldLabel htmlFor={`${formId}-reason`}>
                  {status === 'lost' ? (
                    <Trans>Status reason</Trans>
                  ) : (
                    <Trans>Status reason (optional)</Trans>
                  )}
                </FieldLabel>
                <Textarea
                  id={`${formId}-reason`}
                  value={reason}
                  disabled={run.isPending}
                  required={status === 'lost'}
                  maxLength={2000}
                  onChange={(event) => {
                    setReason(event.target.value);
                  }}
                />
              </Field>
            )}
          </>
        ) : null}
      </form>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={run.isPending} onClick={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          type="submit"
          form={formId}
          variant={action === 'trash' ? 'secondary' : 'primary'}
          className={action === 'trash' ? 'border-destructive text-destructive' : undefined}
          disabled={!ready || run.isPending}
        >
          {run.isPending ? (
            <Trans>Working…</Trans>
          ) : action === 'trash' ? (
            <Trans>Move to trash</Trans>
          ) : (
            <Trans>Apply</Trans>
          )}
        </Button>
      </div>
    </SmallDialog>
  );
}
