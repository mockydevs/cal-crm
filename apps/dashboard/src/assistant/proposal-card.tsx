// A confirmation card in the assistant's conversation: what the assistant wants made live,
// which only a person confirms. Publish, "Not now" and Undo are the proposal's own
// operations, run as the person. Drawn like the Inbox's cards (inbox-assistant.tsx), so
// what the assistant proposes looks the same wherever it shows.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Proposal } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Check, Copy } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { cardStateOf } from './rules';

export type Decision = 'apply' | 'dismiss' | 'undo';

const whileBusy = 'aria-disabled:opacity-50';

/** Native proposal data shown as labelled settings; record words stay escaped text. */
function ChangeDetails({ value }: { readonly value: unknown }): ReactElement {
  if (value === null || value === undefined)
    return (
      <span>
        <Trans>Not set</Trans>
      </span>
    );
  if (typeof value === 'boolean')
    return <span>{value ? <Trans>Yes</Trans> : <Trans>No</Trans>}</span>;
  if (Array.isArray(value)) {
    const seen = new Map<string, number>();
    const entries = value.map((item: unknown) => {
      const identity = JSON.stringify(item);
      const occurrence = (seen.get(identity) ?? 0) + 1;
      seen.set(identity, occurrence);
      return { key: `${identity}:${String(occurrence)}`, item };
    });
    return value.length === 0 ? (
      <span>
        <Trans>None</Trans>
      </span>
    ) : (
      <ol className="flex flex-col gap-3">
        {entries.map(({ item, key }) => (
          <li key={key} className="rounded-control border p-2">
            <ChangeDetails value={item} />
          </li>
        ))}
      </ol>
    );
  }
  if (typeof value === 'object')
    return (
      <dl className="flex min-w-0 flex-col gap-2">
        {Object.entries(value as Record<string, unknown>).map(([key, item]) => {
          const words = key.replaceAll(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
          return (
            <div key={key} className="min-w-0">
              <dt className="font-medium">{words.charAt(0).toUpperCase() + words.slice(1)}</dt>
              <dd className="min-w-0 wrap-anywhere">
                <ChangeDetails value={item} />
              </dd>
            </div>
          );
        })}
      </dl>
    );
  return (
    <span className="whitespace-pre-wrap wrap-anywhere">
      {typeof value === 'string' || typeof value === 'number' ? value : ''}
    </span>
  );
}

/** A value to hand on, with a button that copies it. It can be selected by hand too. */
function Copyable({
  label,
  value,
  copyLabel,
}: {
  readonly label: string;
  readonly value: string;
  /** What the button is called, such as "Copy the link". */
  readonly copyLabel: string;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-1.5">
        <input
          id={id}
          readOnly
          value={value}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          className="min-h-11 min-w-0 flex-1 rounded-control border border-input bg-card px-2.5 font-mono text-xs text-body lg:min-h-8"
        />
        <Button
          variant="secondary"
          size="small"
          aria-label={copyLabel}
          title={copyLabel}
          className="px-2.5"
          onClick={() => {
            // A browser that refuses leaves the value in its box, to copy by hand.
            void navigator.clipboard.writeText(value).then(
              () => {
                setCopied(true);
              },
              () => undefined,
            );
          }}
        >
          {copied ? (
            <Check aria-hidden className="size-4" strokeWidth={2} />
          ) : (
            <Copy aria-hidden className="size-4" strokeWidth={1.8} />
          )}
        </Button>
      </div>
      <span role="status" className="sr-only">
        {copied ? t`Copied.` : null}
      </span>
    </div>
  );
}

export function ProposalCard({
  proposal,
  busy,
  failure,
  onDecide,
}: {
  readonly proposal: Proposal;
  /** A decision is on its way: no button means anything until it is answered. */
  readonly busy: boolean;
  /** Why the last decision on this card did not happen, in words. */
  readonly failure: string | null;
  readonly onDecide: (decision: Decision, proposal: Proposal) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const labelId = useId();
  const wordsId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const state = cardStateOf(proposal);
  const { change, result } = proposal;
  const publish = change.kind === 'form_publish';

  // A decision takes its own button away: the keyboard goes to the card it changed.
  const statusRef = useRef(proposal.status);
  useEffect(() => {
    if (statusRef.current === proposal.status) return;
    statusRef.current = proposal.status;
    rootRef.current?.focus();
  }, [proposal.status]);

  const questions = publish ? change.questions : 0;
  const consents = publish ? change.consents : 0;
  return (
    <div
      ref={rootRef}
      role="group"
      aria-labelledby={labelId}
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-3 rounded-card border bg-card p-4 focus:outline-none focus-visible:outline-2"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant="assistant" className="px-2.5 py-0.5 text-xs">
          {state.waiting ? <Trans>Needs you</Trans> : <Trans>Assistant</Trans>}
        </Badge>
        <span id={labelId} className="min-w-0 text-md font-medium wrap-anywhere">
          {proposal.summary}
        </span>
      </div>
      {publish ? (
        <p className="text-sm text-body">
          {plural(questions, { one: '# question', other: '# questions' })}
          {' · '}
          {plural(consents, { one: '# consent box', other: '# consent boxes' })}
          {change.republish ? (
            <>
              {'. '}
              <Trans>The form is live already: publishing replaces what websites show.</Trans>
            </>
          ) : null}
        </p>
      ) : null}
      {change.kind === 'crm_change' ? (
        <details className="min-w-0 text-sm text-body">
          <summary className="cursor-pointer">
            <Trans>Review the proposed changes</Trans>
          </summary>
          <div className="mt-2 max-h-72 overflow-auto rounded-control border p-3 text-sm">
            <ChangeDetails value={change.details} />
          </div>
        </details>
      ) : null}
      {state.words === null ? null : (
        <p id={wordsId} className="text-sm text-muted-foreground">
          {i18n._(state.words)}
        </p>
      )}
      {proposal.status === 'applied' ? (
        <>
          <p className="text-sm font-medium text-success">
            {publish ? <Trans>Published.</Trans> : <Trans>Done.</Trans>}
          </p>
          {result?.hostedUrl === undefined ? null : (
            <Copyable label={t`Link`} value={result.hostedUrl} copyLabel={t`Copy the link`} />
          )}
          {result?.embedSnippet === undefined ? null : (
            <Copyable
              label={t`Embed line`}
              value={result.embedSnippet}
              copyLabel={t`Copy the embed line`}
            />
          )}
          {state.undoRefusal === null ? null : (
            <p className="text-sm text-muted-foreground">{state.undoRefusal}</p>
          )}
        </>
      ) : null}
      {failure === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      {state.waiting ? (
        <div className="flex min-w-0 flex-wrap gap-2.5">
          <Button
            size="small"
            className={whileBusy}
            disabled={busy || !state.canConfirm}
            focusableWhenDisabled
            aria-describedby={state.words === null ? undefined : wordsId}
            onClick={() => {
              onDecide('apply', proposal);
            }}
          >
            {publish ? <Trans>Publish</Trans> : <Trans>Confirm</Trans>}
          </Button>
          {state.canDismiss ? (
            <Button
              variant="quiet"
              size="small"
              className={whileBusy}
              disabled={busy}
              focusableWhenDisabled
              onClick={() => {
                onDecide('dismiss', proposal);
              }}
            >
              <Trans>Not now</Trans>
            </Button>
          ) : null}
        </div>
      ) : state.canUndo ? (
        <Button
          variant="secondary"
          size="small"
          className={`self-start ${whileBusy}`}
          disabled={busy}
          focusableWhenDisabled
          onClick={() => {
            onDecide('undo', proposal);
          }}
        >
          <Trans>Undo</Trans>
        </Button>
      ) : null}
    </div>
  );
}
