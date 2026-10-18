// Publishing: what will change from the live version to this draft, in words, before
// anyone agrees to it. Added, removed and changed triggers, steps, stops and settings, each
// as it read before and as it reads now; then a note for the version history. A draft with
// errors shows them instead of the way forward, since the server refuses to publish it.
import { Trans, useLingui } from '@lingui/react/macro';
import type { Automation, AutomationSetup } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Textarea } from '@repo/ui/components/textarea';
import { Minus, PencilLine, Plus, type LucideIcon } from 'lucide-react';
import { useId, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import {
  describeChanges,
  publishChanges,
  type Change,
  type ChangeKind,
} from './automation-changes';
import { AutomationDialog } from './automation-dialog';
import { IssueList, type ShownIssue } from './automation-issues';

export interface PublishDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The automation as last saved: publishing publishes its saved draft. */
  readonly automation: Automation;
  readonly setup: AutomationSetup;
  /** Changes not saved yet: they wouldn't be published, so saving comes first. */
  readonly unsaved: boolean;
  /** What stops the saved draft being published. */
  readonly errors: readonly ShownIssue[];
  /** What the checks point out that doesn't stop it, such as having no trigger. */
  readonly warnings?: readonly ShownIssue[];
  readonly publishing: boolean;
  /** What the server said when it refused. */
  readonly refusal: ReactNode;
  readonly onPublish: (note: string) => void;
}

const icons: Readonly<Record<ChangeKind, LucideIcon>> = {
  added: Plus,
  removed: Minus,
  changed: PencilLine,
};

function ChangeItem({ change }: { readonly change: Change }): ReactElement {
  const { t } = useLingui();
  const notSet = t`Not set`;
  const Icon = icons[change.kind];
  const reads = change.kind === 'removed' ? change.before : change.after;
  const rewritten =
    change.kind === 'changed' && change.before !== undefined && change.before !== change.after;
  return (
    <li className="flex min-w-0 items-start gap-3 rounded-2xl bg-background px-4 py-3">
      <Icon aria-hidden className="mt-1 size-4 shrink-0" strokeWidth={1.8} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-[13px] text-muted-foreground">{change.title}</p>
        {rewritten ? (
          <dl className="grid min-w-0 gap-x-4 gap-y-1 text-md sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs font-semibold text-muted-foreground">
                <Trans>Before</Trans>
              </dt>
              <dd className="wrap-anywhere">{change.before}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-semibold text-muted-foreground">
                <Trans>After</Trans>
              </dt>
              <dd className="font-medium wrap-anywhere">{change.after ?? notSet}</dd>
            </div>
          </dl>
        ) : reads === undefined ? null : (
          <p className="text-md font-medium wrap-anywhere">{reads}</p>
        )}
        {change.details.length === 0 ? null : (
          <ul className="flex min-w-0 flex-col gap-1.5 text-sm">
            {change.details.map((detail) => (
              <li key={detail.label} className="min-w-0 wrap-anywhere">
                <span className="font-semibold">{detail.label}</span>
                <dl className="grid min-w-0 gap-x-4 sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="inline text-muted-foreground">
                      <Trans>Before:</Trans>
                    </dt>{' '}
                    <dd className="inline">{detail.before ?? notSet}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="inline text-muted-foreground">
                      <Trans>After:</Trans>
                    </dt>{' '}
                    <dd className="inline font-medium">{detail.after ?? notSet}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

export function PublishDialog({
  open,
  onOpenChange,
  automation,
  setup,
  unsaved,
  errors,
  warnings = [],
  publishing,
  refusal,
  onPublish,
}: PublishDialogProps): ReactElement {
  const { t } = useLingui();
  const noteId = useId();
  const [note, setNote] = useState('');
  const live = automation.live;
  const changes = useMemo(() => {
    if (!open) return [];
    // A first version has nothing before it: everything that starts, runs and stops it is new.
    return live === null
      ? describeChanges({}, automation.draft, setup).filter(
          (change) => change.about !== 'automation',
        )
      : publishChanges(live.document, automation.draft, setup);
  }, [open, live, automation.draft, setup]);
  const groups: readonly (readonly [ChangeKind, string])[] = [
    ['added', live === null ? t`Going live` : t`Added`],
    ['removed', t`Removed`],
    ['changed', t`Changed`],
  ];
  const blocked = unsaved || errors.length > 0;
  const liveVersion = live?.version ?? 0;

  return (
    <AutomationDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setNote('');
        onOpenChange(next);
      }}
      wide
      title={<Trans>Publish this workflow</Trans>}
      description={
        live === null ? (
          <Trans>Nothing is live yet. Publishing makes this draft the first live version.</Trans>
        ) : (
          <Trans>
            What changes from live version {liveVersion} to this draft. Contacts already in the
            automation finish the version they started.
          </Trans>
        )
      }
    >
      {unsaved ? (
        <p role="alert" className="rounded-xl border border-input px-3.5 py-3 text-md">
          <Trans>
            You have changes that aren't saved. Save the draft first: publishing uses the saved
            draft.
          </Trans>
        </p>
      ) : null}

      {changes.length === 0 ? (
        <p className="text-md">
          {live === null ? (
            <Trans>This draft has nothing in it yet.</Trans>
          ) : (
            <Trans>
              This draft is the same as the live version. Publishing would change nothing.
            </Trans>
          )}
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          {groups.map(([kind, heading]) => {
            const listed = changes.filter((change) => change.kind === kind);
            return listed.length === 0 ? null : (
              <section key={kind} aria-label={heading} className="flex min-w-0 flex-col gap-2">
                <h3 className="text-sm font-semibold">{heading}</h3>
                <ul className="flex min-w-0 flex-col gap-2">
                  {listed.map((change, position) => (
                    <ChangeItem
                      key={`${change.about}:${change.step ?? change.title}:${String(position)}`}
                      change={change}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {errors.length === 0 ? null : (
        <section
          aria-label={t`Fix these before publishing`}
          className="flex min-w-0 flex-col gap-3 rounded-xl border border-destructive px-3.5 py-3"
        >
          <h3 className="text-sm font-semibold">
            <Trans>Fix these before publishing</Trans>
          </h3>
          <IssueList issues={errors} label={t`Errors`} />
        </section>
      )}

      {warnings.length === 0 ? null : (
        <section
          aria-label={t`Worth knowing before publishing`}
          className="flex min-w-0 flex-col gap-3 rounded-xl border border-input px-3.5 py-3"
        >
          <h3 className="text-sm font-semibold">
            <Trans>Worth knowing before publishing</Trans>
          </h3>
          <p className="text-sm text-muted-foreground">
            <Trans>These don't stop you publishing.</Trans>
          </p>
          <IssueList issues={warnings} label={t`Warnings`} />
        </section>
      )}

      <form
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!blocked) onPublish(note.trim());
        }}
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor={noteId}>
            <Trans>Note for the version history</Trans>{' '}
            <span className="font-normal text-muted-foreground">
              <Trans>(optional)</Trans>
            </span>
          </label>
          <Textarea
            id={noteId}
            value={note}
            maxLength={500}
            rows={2}
            disabled={blocked}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </div>
        {refusal === undefined || refusal === null ? null : (
          <div role="alert" className="text-sm font-medium text-destructive wrap-anywhere">
            {refusal}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="quiet"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={blocked || publishing}>
            <Trans>Publish</Trans>
          </Button>
        </div>
      </form>
    </AutomationDialog>
  );
}
