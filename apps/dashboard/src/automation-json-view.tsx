// The JSON view (docs/AUTOMATIONS.md section 9): the document itself, in a plain text box,
// read again on every change. Text that isn't JSON says where it goes wrong, by line and
// column; a document that reads has its problems listed by the builder, each able to select
// its place here. Copy, import (a file or pasted text) and download work on the same text.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Copy, Download, Upload } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { AutomationDialog } from './automation-dialog';
import { JSON_EDITOR_ID } from './automation-element-ids';
import { formatDraft, readImport, stepsOf, type DraftRead } from './automation-document';
import { positionOf, type JsonProblem, type JsonSpan } from './automation-json';

/** A place in the text to select; a new object selects again, even at the same place. */
export interface JsonSelection {
  readonly span: JsonSpan;
}

export interface JsonViewProps {
  readonly text: string;
  readonly read: DraftRead;
  readonly name: string;
  readonly editable: boolean;
  readonly errorCount: number;
  readonly selection: JsonSelection | undefined;
  readonly onText: (text: string) => void;
  /** Puts the text back to the last document that could be read. */
  readonly onUndo: () => void;
}

const LINE_HEIGHT = 20;

function useProblemText(): (problem: JsonProblem | 'not_an_object') => string {
  const { t } = useLingui();
  return (problem) => {
    // Braces are message syntax to the catalogs, so these two go in as values.
    const [opening, closing] = ['{', '}'];
    if (problem === 'not_an_object')
      return t`An automation is a JSON object: it starts with ${opening} and ends with ${closing}.`;
    const { line, column, found } = problem;
    const where = t`Line ${line}, column ${column}:`;
    const what =
      problem.kind === 'empty'
        ? t`There is nothing here yet.`
        : problem.kind === 'ended_early'
          ? t`The JSON stops too early. Look for a missing }, ] or closing quote.`
          : problem.kind === 'extra_text'
            ? t`There is extra text after the end of the JSON.`
            : problem.kind === 'too_deep'
              ? t`The JSON is nested too deeply to be an automation.`
              : t`“${found}” doesn't belong here. Look for a missing or extra comma, quote or bracket just before it.`;
    return problem.kind === 'empty' ? what : `${where} ${what}`;
  };
}

/** A file name from the automation's name: "New lead follow-up" is new-lead-follow-up.json. */
function fileNameOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug === '' ? 'automation' : slug}.json`;
}

export function JsonView({
  text,
  read,
  name,
  editable,
  errorCount,
  selection,
  onText,
  onUndo,
}: JsonViewProps): ReactElement {
  const { t } = useLingui();
  const problemText = useProblemText();
  const headingId = useId();
  // One JSON view to a page, and a form's "Edit in JSON" brings the keyboard here by it.
  const editorId = JSON_EDITOR_ID;
  const problemId = useId();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState({ line: 1, column: 1 });
  const [notice, setNotice] = useState<string>();
  const [importing, setImporting] = useState(false);

  const select = (span: JsonSpan): void => {
    const box = areaRef.current;
    if (box === null) return;
    box.focus();
    box.setSelectionRange(span.start, span.end);
    // A text box doesn't scroll to a selection made for it; put the line near the top.
    box.scrollTop = Math.max(0, (positionOf(text, span.start).line - 3) * LINE_HEIGHT);
    setCaret(positionOf(text, span.start));
  };
  // Selecting is the one thing here that has to reach into the text box itself.
  const selectRef = useRef(select);
  useEffect(() => {
    selectRef.current = select;
  });
  useEffect(() => {
    if (selection !== undefined) selectRef.current(selection.span);
  }, [selection]);

  const stepCount = read.ok ? stepsOf(read.draft).length : 0;
  const { line: caretLine, column: caretColumn } = caret;
  const problem = read.ok ? undefined : read.problem;

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3.5 rounded-card border border-border bg-card p-5"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id={headingId} className="text-lg font-semibold">
            <Trans>This automation as data</Trans>
          </h2>
          <span className="text-sm text-muted-foreground" data-testid="automation-json-state">
            {!read.ok
              ? t`Can't be read yet`
              : errorCount > 0
                ? t`Reads as JSON · has errors`
                : plural(stepCount, { one: 'Valid · # step', other: 'Valid · # steps' })}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void navigator.clipboard.writeText(text).then(
                () => {
                  setNotice(t`Copied.`);
                },
                () => {
                  setNotice(t`Couldn't copy. Select the text and copy it yourself.`);
                },
              );
            }}
          >
            <Copy aria-hidden className="size-4" strokeWidth={1.8} />
            <Trans>Copy</Trans>
          </Button>
          {editable ? (
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                setNotice(undefined);
                setImporting(true);
              }}
            >
              <Upload aria-hidden className="size-4" strokeWidth={1.8} />
              <Trans>Import</Trans>
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([`${text}\n`], { type: 'application/json' }),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = fileNameOf(name);
              link.click();
              URL.revokeObjectURL(url);
              setNotice(t`Downloaded.`);
            }}
          >
            <Download aria-hidden className="size-4" strokeWidth={1.8} />
            <Trans>Download</Trans>
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        <Trans>
          The Steps view and this JSON are one automation. A change in either shows up in the other.
        </Trans>
      </p>
      <p role="status" className="min-h-5 text-sm">
        {notice ?? ''}
      </p>
      <label className="sr-only" htmlFor={editorId}>
        <Trans>Automation JSON</Trans>
      </label>
      <textarea
        ref={areaRef}
        id={editorId}
        value={text}
        readOnly={!editable}
        rows={24}
        wrap="off"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-invalid={problem !== undefined}
        aria-describedby={problem === undefined ? undefined : problemId}
        className="w-full min-w-0 resize-y overflow-auto rounded-xl border border-input bg-background px-3.5 py-3 font-mono text-[13px] leading-5 text-foreground aria-invalid:border-destructive"
        onChange={(event) => {
          setNotice(undefined);
          onText(event.target.value);
        }}
        onSelect={(event) => {
          setCaret(positionOf(event.currentTarget.value, event.currentTarget.selectionStart));
        }}
      />
      <p className="text-xs text-muted-foreground">
        <Trans>
          Line {caretLine}, column {caretColumn}
        </Trans>
      </p>
      {problem === undefined ? null : (
        <div
          id={problemId}
          role="status"
          className="flex min-w-0 flex-col items-start gap-2 rounded-xl border border-destructive px-3.5 py-3 text-sm"
        >
          <p className="font-medium wrap-anywhere">
            <span className="font-semibold">
              <Trans>Not valid JSON yet.</Trans>
            </span>{' '}
            {problemText(problem)}
          </p>
          <p className="text-muted-foreground">
            <Trans>
              Until it reads, the Steps view shows the last version that did, and the draft can't be
              saved.
            </Trans>
          </p>
          <div className="flex flex-wrap gap-2">
            {problem === 'not_an_object' ? null : (
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  select({ start: problem.offset, end: Math.min(text.length, problem.offset + 1) });
                }}
              >
                <Trans>Go to the mistake</Trans>
              </Button>
            )}
            {editable ? (
              <Button variant="quiet" size="small" onClick={onUndo}>
                <Trans>Undo my JSON changes</Trans>
              </Button>
            ) : null}
          </div>
        </div>
      )}
      <ImportDialog
        open={importing}
        onOpenChange={setImporting}
        onImport={(imported) => {
          onText(imported);
          setNotice(t`Imported. Check it, then save the draft.`);
        }}
      />
    </section>
  );
}

function ImportDialog({
  open,
  onOpenChange,
  onImport,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onImport: (text: string) => void;
}): ReactElement {
  const { t } = useLingui();
  const problemText = useProblemText();
  const fileId = useId();
  const pasteId = useId();
  const problemId = useId();
  const [pasted, setPasted] = useState('');
  const [problem, setProblem] = useState<string>();
  const close = (next: boolean): void => {
    if (!next) {
      setPasted('');
      setProblem(undefined);
    }
    onOpenChange(next);
  };
  const take = (source: string): void => {
    const read = readImport(source);
    if (!read.ok) {
      setProblem(problemText(read.problem));
      return;
    }
    onImport(formatDraft(read.draft));
    close(false);
  };
  return (
    <AutomationDialog
      open={open}
      onOpenChange={close}
      title={<Trans>Import an automation</Trans>}
      description={
        <Trans>
          Importing replaces everything in this draft. Nothing is saved until you save the draft.
        </Trans>
      }
    >
      <form
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          take(pasted);
        }}
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor={fileId}>
            <Trans>Open a JSON file</Trans>
          </label>
          <input
            id={fileId}
            type="file"
            accept=".json,application/json"
            className="min-h-11 w-full min-w-0 rounded-xl border border-input bg-card px-3 py-2 text-sm file:mr-3 file:rounded-full file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file === undefined) return;
              void file.text().then(take, () => {
                setProblem(t`We couldn't read that file.`);
              });
            }}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor={pasteId}>
            <Trans>Or paste the JSON</Trans>
          </label>
          <textarea
            id={pasteId}
            value={pasted}
            rows={8}
            wrap="off"
            spellCheck={false}
            aria-invalid={problem !== undefined}
            aria-describedby={problem === undefined ? undefined : problemId}
            className="w-full min-w-0 resize-y overflow-auto rounded-xl border border-input bg-background px-3.5 py-3 font-mono text-[13px] leading-5 aria-invalid:border-destructive"
            onChange={(event) => {
              setPasted(event.target.value);
              setProblem(undefined);
            }}
          />
        </div>
        {problem === undefined ? null : (
          <p
            id={problemId}
            role="alert"
            className="text-sm font-medium text-destructive wrap-anywhere"
          >
            {problem}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="quiet"
            onClick={() => {
              close(false);
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit">
            <Trans>Import pasted JSON</Trans>
          </Button>
        </div>
      </form>
    </AutomationDialog>
  );
}
