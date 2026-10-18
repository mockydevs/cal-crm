// "Continue now" for a run that waits where a wait ends down one of several branches
// (docs/AUTOMATIONS.md, "Continuing a waiting run now"): nothing happened to choose one, so
// the person does, in the builder's own words for each. Fetched when it is first asked for.
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { useId, useState, type ReactElement } from 'react';
import { AutomationDialog } from './automation-dialog';
import { branchLabel } from './automation-summary';

export interface ContinueDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The branches the wait can end down, as the run names them. */
  readonly branches: readonly string[];
  /** The step the run waits at, for the words of its branches. */
  readonly step: { readonly type: string; readonly config: Readonly<Record<string, unknown>> };
  readonly pending: boolean;
  /** What the server refused the last try for, in its words. */
  readonly refusal: string | undefined;
  readonly onContinue: (branch: string) => void;
}

export default function ContinueDialog({
  open,
  onOpenChange,
  branches,
  step,
  pending,
  refusal,
  onContinue,
}: ContinueDialogProps): ReactElement {
  const { t } = useLingui();
  const groupId = useId();
  const [chosen, setChosen] = useState<string>();
  const branch = chosen !== undefined && branches.includes(chosen) ? chosen : undefined;
  return (
    <AutomationDialog
      open={open}
      onOpenChange={onOpenChange}
      title={<Trans>Continue now: which way?</Trans>}
      description={
        <Trans>
          The run stops waiting and goes on at once. Nothing happened to choose a path, so choose
          the one it takes. What comes next can send messages.
        </Trans>
      }
    >
      <form
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (branch !== undefined && !pending) onContinue(branch);
        }}
      >
        <div
          role="radiogroup"
          aria-label={t`The path to take`}
          className="flex min-w-0 flex-col gap-1.5"
        >
          {branches.map((each, index) => (
            <label
              key={each}
              className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2.5 rounded-xl border border-input bg-card px-3 py-2 has-checked:border-primary has-checked:bg-accent"
            >
              <input
                type="radio"
                name={groupId}
                value={each}
                checked={branch === each}
                className="size-4 shrink-0 accent-primary"
                {...(index === 0 ? { 'data-initial-focus': true } : {})}
                onChange={() => {
                  setChosen(each);
                }}
              />
              <span className="min-w-0 text-sm font-medium wrap-anywhere">
                {branchLabel(step, each)}
              </span>
            </label>
          ))}
        </div>
        {refusal === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive wrap-anywhere">
            {refusal}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={branch === undefined || pending}>
            <Trans>Continue now</Trans>
          </Button>
        </div>
      </form>
    </AutomationDialog>
  );
}
