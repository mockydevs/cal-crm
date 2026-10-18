// The dialogs of Reporting's "Reports overview" (reports-list.tsx): "+ New report" from
// blank or from the Template Library, Rename, and the question before a delete. Fetched
// when one is first opened, so the list itself stays light.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createReport,
  getReport,
  listReportTemplates,
  updateReport,
  type ReportList,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactElement, type RefObject } from 'react';
import { apiIn } from '../api';
import { ListProblem } from '../list-table';
import { ConfirmDialog, SmallDialog } from '../settings-list';
import { reportingKeys, retryFaults } from './keys';

type Item = ReportList['items'][number];

/** What a refused change says: the server's sentence, or the page's own. */
export const wordsOf = (error: unknown, fallback: string): string =>
  error instanceof ApiError
    ? (error.problem.errors?.[0]?.message ?? error.problem.detail ?? fallback)
    : fallback;

/** Asks before a report is deleted, and says why it was not when it was not. */
export function DeleteDialog({
  name,
  busy,
  problem,
  returnFocus,
  onConfirm,
  onClose,
}: {
  readonly name: string;
  readonly busy: boolean;
  readonly problem: string | undefined;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  return (
    <ConfirmDialog
      open
      title={<Trans>Delete this report?</Trans>}
      description={<DeleteWords name={name} />}
      confirmLabel={t`Delete report`}
      destructive
      busy={busy}
      problem={problem}
      returnFocus={returnFocus}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

function DeleteWords({ name }: { readonly name: string }): ReactElement {
  return (
    <Trans>
      "{name}" will be gone from the list for everyone in this business. Its numbers are not
      touched: they are counted from your records each time.
    </Trans>
  );
}

const BLANK = 'blank';

/** "+ New report": from blank, or from one of the Template Library's templates. */
export function NewReportDialog({
  businessId,
  returnFocus,
  onClose,
  onCreated,
}: {
  readonly businessId: string;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onCreated: (id: string) => void;
}): ReactElement {
  const { t } = useLingui();
  const api = apiIn(businessId);
  const nameId = useId();
  const groupId = useId();
  const [start, setStart] = useState(BLANK);
  const [name, setName] = useState('');
  const templates = useQuery({
    queryKey: reportingKeys.templates(businessId),
    queryFn: () => api.request(listReportTemplates, {}),
    staleTime: 5 * 60_000,
    retry: retryFaults,
  });
  const create = useMutation({
    mutationFn: () =>
      api.request(createReport, {
        body: {
          ...(name.trim() === '' ? {} : { name: name.trim() }),
          ...(start === BLANK ? {} : { templateKey: start }),
        },
      }),
    onSuccess: (made) => {
      onCreated(made.id);
    },
  });
  const chosen = templates.data?.items.find((template) => template.key === start);
  const optionClassName =
    'grid min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-x-3 rounded-lg border border-border p-3 has-[:checked]:border-primary has-[:checked]:bg-accent';
  return (
    <SmallDialog
      open
      onClose={onClose}
      title={<Trans>New report</Trans>}
      description={<Trans>Start from blank, or from a template you then make your own.</Trans>}
      returnFocus={returnFocus}
    >
      <form
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-foreground">
            <Trans>Start from</Trans>
          </legend>
          <label className={optionClassName}>
            <input
              type="radio"
              name={groupId}
              className="row-span-2 mt-1 size-4 shrink-0 accent-primary"
              checked={start === BLANK}
              onChange={() => {
                setStart(BLANK);
              }}
            />
            <span className="font-medium text-foreground">{t`Blank report`}</span>
            <span className="col-start-2 text-sm text-muted-foreground">
              <Trans>One empty page, set to the last 30 days.</Trans>
            </span>
          </label>
          {templates.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Loading the Template Library…</Trans>
            </p>
          ) : null}
          {templates.isError ? (
            <ListProblem
              onRetry={() => {
                void templates.refetch();
              }}
            >
              <Trans>The Template Library couldn't be loaded.</Trans>
            </ListProblem>
          ) : null}
          {templates.data === undefined || templates.data.items.length === 0 ? null : (
            <>
              <p className="mt-1 text-xs font-medium text-muted-foreground">
                <Trans>Template Library</Trans>
              </p>
              {templates.data.items.map((template) => (
                <label key={template.key} className={optionClassName}>
                  <input
                    type="radio"
                    name={groupId}
                    className="row-span-2 mt-1 size-4 shrink-0 accent-primary"
                    checked={start === template.key}
                    onChange={() => {
                      setStart(template.key);
                    }}
                  />
                  <span className="font-medium break-words text-foreground">{template.name}</span>
                  <span className="col-start-2 text-sm break-words text-muted-foreground">
                    {template.description}
                  </span>
                </label>
              ))}
            </>
          )}
        </fieldset>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={nameId} className="text-sm font-medium text-foreground">
            <Trans>Report name</Trans>
          </label>
          <Input
            id={nameId}
            maxLength={120}
            autoComplete="off"
            placeholder={chosen?.name ?? t`Untitled report`}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <p className="text-xs text-muted-foreground">
            <Trans>Left empty, the report takes the name shown.</Trans>
          </p>
        </div>
        {create.isError ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {wordsOf(create.error, t`The report couldn't be made.`)}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" type="button" disabled={create.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={create.isPending}>
            <Trans>Create report</Trans>
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}

/**
 * Rename: the report is read first, since a save sends its whole definition back with the
 * revision that was read.
 */
export function RenameDialog({
  businessId,
  item,
  returnFocus,
  onClose,
  onRenamed,
}: {
  readonly businessId: string;
  readonly item: Item;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onRenamed: () => Promise<void>;
}): ReactElement {
  const { t } = useLingui();
  const api = apiIn(businessId);
  const cache = useQueryClient();
  const nameId = useId();
  const [name, setName] = useState(item.name);
  const rename = useMutation({
    mutationFn: async () => {
      const current = await api.request(getReport, { params: { id: item.id } });
      return api.request(updateReport, {
        params: { id: item.id },
        body: { name: name.trim(), definition: current.definition, revision: current.revision },
      });
    },
    onSuccess: async (saved) => {
      cache.setQueryData(reportingKeys.report(businessId, saved.id), saved);
      await onRenamed();
    },
  });
  const empty = name.trim() === '';
  return (
    <SmallDialog
      open
      onClose={onClose}
      title={<Trans>Rename report</Trans>}
      returnFocus={returnFocus}
    >
      <form
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!empty) rename.mutate();
        }}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={nameId} className="text-sm font-medium text-foreground">
            <Trans>Report name</Trans>
          </label>
          <Input
            id={nameId}
            maxLength={120}
            autoComplete="off"
            value={name}
            aria-invalid={empty}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        {rename.isError ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {rename.error instanceof ApiError && rename.error.status === 409
              ? t`This report was changed elsewhere just now. Try again.`
              : wordsOf(rename.error, t`The report couldn't be renamed.`)}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" type="button" disabled={rename.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={rename.isPending || empty}>
            <Trans>Save</Trans>
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}
