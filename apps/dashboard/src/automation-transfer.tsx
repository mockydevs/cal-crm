// Moving a workflow between businesses or installs: Export downloads it with every
// reference by name (GET /automations/{id}/export), and Import reads such a file, asks the
// server what it finds wrong with it here (POST /automations/validate), and only then makes
// a new draft from it (POST /automations/import). An import is never live.
//
// Its own chunk, loaded when someone first exports or imports.
import { t as say } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  exportAutomation,
  importAutomation,
  importAutomationInput,
  validateAutomationDocument,
  type Automation,
  type AutomationExport,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useMutation } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { AutomationDialog } from './automation-dialog';
import { IssueList, issuesOf } from './automation-issues';
import { useBusiness } from './workspace';

type Api = ReturnType<typeof apiIn>;

/** A file name from a workflow's name: lower case, with dashes, and never empty. */
export function exportFileName(name: string): string {
  const base = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base === '' ? 'workflow' : base}.workflow.json`;
}

/** Asks for the portable document and hands it to the browser as a file. */
export async function downloadExport(
  api: Api,
  automation: { readonly id: string; readonly name: string },
): Promise<AutomationExport> {
  const exported = await api.request(exportAutomation, {
    params: { id: automation.id },
    query: { source: 'draft' },
  });
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(exported, null, 2)}\n`], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = exportFileName(automation.name);
  link.click();
  URL.revokeObjectURL(url);
  return exported;
}

/** Exports a workflow as a file, and says how it went: what to announce, or what went wrong. */
export async function exportWorkflow(
  api: Api,
  automation: { readonly id: string; readonly name: string },
): Promise<{ readonly ok: boolean; readonly words: string }> {
  const { name } = automation;
  try {
    const count = (await downloadExport(api, automation)).warnings.length;
    return {
      ok: true,
      words:
        count === 0
          ? say`Exported “${name}”. The file is in your downloads.`
          : say`Exported “${name}”. ${count} of its references could not be named, and only work in this business.`,
    };
  } catch (error) {
    return {
      ok: false,
      words: !(error instanceof ApiError)
        ? say`We couldn't export the workflow. Check your connection and try again.`
        : error.status === 403
          ? say`You don't have permission to export workflows.`
          : (error.problem.detail ?? say`We couldn't export the workflow. Try again.`),
    };
  }
}

/** What a chosen file holds, when it is an exported workflow. */
export function readExport(
  text: string,
): { readonly ok: true; readonly document: Record<string, unknown> } | { readonly ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const read = importAutomationInput.safeParse(parsed);
  return read.success ? { ok: true, document: read.data.document } : { ok: false };
}

export interface ImportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onImported: (automation: Automation) => void;
}

export default function ImportDialog({
  open,
  onOpenChange,
  onImported,
}: ImportDialogProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const fileId = useId();
  const [chosen, setChosen] = useState<{ name: string; document: Record<string, unknown> }>();
  const [problem, setProblem] = useState<string>();
  const refusal = (error: unknown, fallback: string): string =>
    !(error instanceof ApiError)
      ? t`We couldn't reach the server. Check your connection and try again.`
      : error.status === 403
        ? t`You don't have permission to create workflows.`
        : (error.problem.errors?.[0]?.message ?? error.problem.detail ?? fallback);

  // What the server finds wrong with the document in this business, before anything is made.
  const check = useMutation({
    mutationFn: (document: Record<string, unknown>) =>
      api.request(validateAutomationDocument, { body: { document } }),
    onError: (error) => {
      setProblem(refusal(error, t`We couldn't check the file. Try again.`));
    },
  });
  const create = useMutation({
    mutationFn: (document: Record<string, unknown>) =>
      api.request(importAutomation, {
        body: { format: 'crm.automation', formatVersion: 1, document },
      }),
    onSuccess: ({ automation }) => {
      onImported(automation);
      onOpenChange(false);
    },
    onError: (error) => {
      setProblem(refusal(error, t`We couldn't import the workflow. Try again.`));
    },
  });
  const reset = (): void => {
    setChosen(undefined);
    setProblem(undefined);
    check.reset();
    create.reset();
  };
  const choose = async (file: File | undefined): Promise<void> => {
    reset();
    if (file === undefined) return;
    const read = readExport(await file.text());
    if (!read.ok) {
      setProblem(t`That file isn't a workflow exported from here. Choose a file made with Export.`);
      return;
    }
    setChosen({ name: file.name, document: read.document });
    check.mutate(read.document);
  };
  const issues = check.data === undefined ? [] : issuesOf(check.data);
  const errors = issues.filter((issue) => issue.level === 'error');
  const workflowName =
    typeof chosen?.document['name'] === 'string' ? chosen.document['name'] : t`Untitled workflow`;

  return (
    <AutomationDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      wide
      title={<Trans>Import workflow</Trans>}
      description={
        <Trans>
          Choose a workflow file made with Export. It is checked against this business first, and
          then added as a new draft: it never starts running by itself.
        </Trans>
      }
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <label className="text-sm font-medium" htmlFor={fileId}>
          <Trans>Workflow file</Trans>
        </label>
        <input
          id={fileId}
          data-initial-focus
          type="file"
          accept="application/json,.json"
          className="max-w-full rounded-control border border-input bg-card px-3 py-2 text-sm file:mr-3 file:rounded-control file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium"
          onChange={(event) => {
            void choose(event.target.files?.[0]);
          }}
        />
      </div>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive wrap-anywhere">
          {problem}
        </p>
      )}
      {check.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Checking the file against this business…</Trans>
        </p>
      ) : null}
      {chosen === undefined || check.data === undefined ? null : (
        <section aria-label={t`What the check found`} className="flex min-w-0 flex-col gap-3">
          <p role="status" className="text-md font-medium wrap-anywhere">
            {issues.length === 0 ? (
              <Trans>“{workflowName}” is ready to import. Nothing needs fixing.</Trans>
            ) : errors.length === 0 ? (
              <Trans>“{workflowName}” can be imported. There are notes to read first.</Trans>
            ) : (
              <Trans>
                “{workflowName}” can be imported as a draft, but it has problems to fix before it
                can be published here, such as names this business doesn't have.
              </Trans>
            )}
          </p>
          {issues.length === 0 ? null : <IssueList label={t`Problems found`} issues={issues} />}
        </section>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="quiet"
          onClick={() => {
            reset();
            onOpenChange(false);
          }}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button
          disabled={chosen === undefined || check.data === undefined || create.isPending}
          onClick={() => {
            setProblem(undefined);
            if (chosen !== undefined) create.mutate(chosen.document);
          }}
        >
          <Trans>Create the workflow</Trans>
        </Button>
      </div>
    </AutomationDialog>
  );
}
