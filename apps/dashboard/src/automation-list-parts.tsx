// The parts of the Workflows list that wait until they are asked for: the dialogs that name
// a folder or a workflow and move a workflow, and the numbers under a row. Their own chunk,
// so opening the list doesn't wait for them.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createAutomationFolder,
  getAutomationStats,
  moveAutomation,
  patchAutomationDraft,
  updateAutomationFolder,
  type AutomationFolder,
  type AutomationRunCounts,
  type AutomationSummary,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { apiIn } from './api';
import type { Opened } from './automation-list-rules';
import { folderChoices } from './automation-list-rules';
import { ListProblem, SmallDialog } from './settings-list';
import { useBusiness } from './workspace';

const TOP_LEVEL = 'root';

/** What went wrong with a request, in the server's words when it gave any. */
function refusalOf(error: unknown, fallback: string, forbidden: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 403) return forbidden;
  return error.problem.errors?.[0]?.message ?? error.problem.detail ?? fallback;
}

function Figures({
  label,
  counts,
}: {
  readonly label: string;
  readonly counts: AutomationRunCounts;
}): ReactElement {
  const { t, i18n } = useLingui();
  const number = new Intl.NumberFormat(i18n.locale);
  const figures: readonly (readonly [string, number])[] = [
    [t`Enrolled`, counts.enrolled],
    [t`Active`, counts.active],
    [t`Completed`, counts.completed],
    [t`Stopped early`, counts.exited],
    [t`Failed`, counts.failed],
    [t`Cancelled`, counts.cancelled],
  ];
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-1.5">
      <span aria-hidden className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <dl className="flex flex-wrap gap-x-8 gap-y-2">
        {figures.map(([name, value]) => (
          <div key={name} className="flex min-w-20 flex-col">
            <dt className="text-xs text-muted-foreground">{name}</dt>
            <dd className="text-base font-medium text-foreground">{number.format(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A workflow's numbers, read when its row is opened: every version, and the live one. */
export function StatsStrip({
  automation,
}: {
  readonly automation: AutomationSummary;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const stats = useQuery({
    // Under the list's own key, so whatever refreshes the list refreshes these too.
    queryKey: ['b', business.id, 'automations', 'stats', automation.id],
    queryFn: () =>
      apiIn(business.id).request(getAutomationStats, { params: { id: automation.id } }),
  });
  if (stats.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        <Trans>Loading the numbers…</Trans>
      </p>
    );
  if (stats.isError)
    return (
      <ListProblem
        onRetry={() => {
          void stats.refetch();
        }}
      >
        <Trans>The numbers couldn't be loaded.</Trans>
      </ListProblem>
    );
  const { liveVersion, runs } = stats.data;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Figures label={t`Every version`} counts={runs.allTime} />
      {runs.live === null || liveVersion === null ? null : (
        <Figures label={t`Live version ${liveVersion}`} counts={runs.live} />
      )}
    </div>
  );
}

/** Asks for one name: a new folder's, or a new one for a folder or a workflow. */
function NameDialog({
  title,
  label,
  initial,
  submitLabel,
  fallback,
  forbidden,
  returnFocus,
  onSubmit,
  onSaved,
  onClose,
}: {
  readonly title: ReactNode;
  readonly label: string;
  readonly initial: string;
  readonly submitLabel: string;
  readonly fallback: string;
  readonly forbidden: string;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onSubmit: (name: string) => Promise<unknown>;
  readonly onSaved: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  const nameId = useId();
  const problemId = useId();
  const [name, setName] = useState(initial);
  const [problem, setProblem] = useState<string>();
  const save = useMutation({
    mutationFn: onSubmit,
    onSuccess: onSaved,
    onError: (error) => {
      setProblem(refusalOf(error, fallback, forbidden));
    },
  });
  return (
    <SmallDialog open title={title} returnFocus={returnFocus} onClose={onClose}>
      <form
        noValidate
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const next = name.trim();
          if (next === '') {
            setProblem(t`Give it a name.`);
            return;
          }
          setProblem(undefined);
          save.mutate(next);
        }}
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor={nameId}>
            {label}
          </label>
          <Input
            id={nameId}
            value={name}
            maxLength={120}
            aria-invalid={problem !== undefined}
            aria-describedby={problem === undefined ? undefined : problemId}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        {problem === undefined ? null : (
          <p id={problemId} role="alert" className="text-sm font-medium text-destructive">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}

/** Chooses the folder a workflow goes to, or the top level. */
function MoveDialog({
  automation,
  folders,
  returnFocus,
  onMoved,
  onClose,
}: {
  readonly automation: AutomationSummary;
  readonly folders: readonly AutomationFolder[];
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onMoved: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const folderId = useId();
  const [to, setTo] = useState(automation.folderId ?? TOP_LEVEL);
  const [problem, setProblem] = useState<string>();
  const move = useMutation({
    mutationFn: () =>
      apiIn(business.id).request(moveAutomation, {
        params: { id: automation.id },
        body: { folderId: to === TOP_LEVEL ? null : to },
      }),
    onSuccess: onMoved,
    onError: (error) => {
      setProblem(
        refusalOf(
          error,
          t`We couldn't move the workflow. Try again.`,
          t`You don't have permission to move workflows.`,
        ),
      );
    },
  });
  const { name } = automation;
  return (
    <SmallDialog
      open
      title={<Trans>Move to folder</Trans>}
      description={name}
      returnFocus={returnFocus}
      onClose={onClose}
    >
      <form
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setProblem(undefined);
          move.mutate();
        }}
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor={folderId}>
            <Trans>Folder</Trans>
          </label>
          <Select id={folderId} value={to} onValueChange={setTo}>
            <option value={TOP_LEVEL}>{t`Home`}</option>
            {folderChoices(folders).map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </Select>
        </div>
        {problem === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={move.isPending}>
            <Trans>Move</Trans>
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}

/** Whichever of the list's dialogs is open: naming a folder or a workflow, or moving one. */
export function ListDialogs({
  opened,
  parentId,
  folders,
  returnFocus,
  onDone,
  onClose,
}: {
  readonly opened: Exclude<Opened, { kind: 'delete' | 'delete-folder' }>;
  /** The folder a new folder goes in; null at the top level. */
  readonly parentId: string | null;
  readonly folders: readonly AutomationFolder[];
  readonly returnFocus: RefObject<HTMLElement | null>;
  /** Closes the dialog and says what was done. */
  readonly onDone: (message: string) => void;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  if (opened.kind === 'move')
    return (
      <MoveDialog
        automation={opened.automation}
        folders={folders}
        returnFocus={returnFocus}
        onMoved={() => {
          onDone(t`Workflow moved.`);
        }}
        onClose={onClose}
      />
    );
  if (opened.kind === 'create-folder')
    return (
      <NameDialog
        title={<Trans>Create folder</Trans>}
        label={t`Folder name`}
        initial=""
        submitLabel={t`Create folder`}
        fallback={t`We couldn't create the folder. Try again.`}
        forbidden={t`You don't have permission to change folders.`}
        returnFocus={returnFocus}
        onSubmit={(name) => api.request(createAutomationFolder, { body: { name, parentId } })}
        onSaved={() => {
          onDone(t`Folder created.`);
        }}
        onClose={onClose}
      />
    );
  if (opened.kind === 'rename-folder')
    return (
      <NameDialog
        title={<Trans>Rename folder</Trans>}
        label={t`Folder name`}
        initial={opened.folder.name}
        submitLabel={t`Save`}
        fallback={t`We couldn't rename the folder. Try again.`}
        forbidden={t`You don't have permission to change folders.`}
        returnFocus={returnFocus}
        onSubmit={(name) =>
          api.request(updateAutomationFolder, {
            params: { id: opened.folder.id },
            body: { revision: opened.folder.revision, name },
          })
        }
        onSaved={() => {
          onDone(t`Folder renamed.`);
        }}
        onClose={onClose}
      />
    );
  return (
    <NameDialog
      title={<Trans>Rename workflow</Trans>}
      label={t`Workflow name`}
      initial={opened.automation.name}
      submitLabel={t`Save`}
      fallback={t`We couldn't rename the workflow. Try again.`}
      forbidden={t`You don't have permission to change workflows.`}
      returnFocus={returnFocus}
      onSubmit={(name) =>
        api.request(patchAutomationDraft, {
          params: { id: opened.automation.id },
          body: {
            baseDraftVersion: opened.automation.draftVersion,
            patch: [{ op: 'replace', path: '/name', value: name }],
          },
        })
      }
      onSaved={() => {
        onDone(t`Workflow renamed.`);
      }}
      onClose={onClose}
    />
  );
}
