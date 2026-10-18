// The contact's "Contact Engagement Score", as GoHighLevel shows it in the contact's details:
// a section that opens to the score, which someone who may edit the contact's fields can
// set, and its latest changes, each with what made it (a rule, a workflow, a person).
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getContactScore,
  SCORING_LIMITS,
  setContactScore,
  type ContactScore as Score,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useId, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { retryFaults } from '../settings-list';
import { useBusiness } from '../workspace';
import { saidBy } from './rules';

const scoreKey = (businessId: string, contactId: string) =>
  ['b', businessId, 'contacts', contactId, 'engagement-score'] as const;

/** A score a person typed: a whole number within the bounds, or undefined. */
export function typedScore(text: string): number | undefined {
  if (!/^-?\d+$/.test(text.trim())) return undefined;
  const score = Number(text.trim());
  return Math.abs(score) <= SCORING_LIMITS.score ? score : undefined;
}

export default function ContactScore({
  contactId,
  readOnly,
}: {
  readonly contactId: string;
  readonly readOnly: boolean;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const bodyId = useId();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [notice, setNotice] = useState('');
  const key = scoreKey(business.id, contactId);
  const score = useQuery({
    queryKey: key,
    queryFn: () => apiIn(business.id).request(getContactScore, { params: { id: contactId } }),
    enabled: open,
    retry: retryFaults,
  });
  const save = useMutation({
    mutationFn: (value: number) =>
      apiIn(business.id).request(setContactScore, {
        params: { id: contactId },
        body: { score: value },
      }),
    onSuccess: (next: Score) => {
      cache.setQueryData(key, next);
      setEditing(undefined);
      const value = next.score ?? 0;
      setNotice(t`The engagement score is now ${value}.`);
    },
  });
  const sources = {
    rule: t`A scoring rule`,
    workflow: t`A workflow`,
    person: t`Set by hand`,
  } satisfies Record<Score['changes'][number]['source'], string>;
  const data = score.data;
  const typed = editing === undefined ? undefined : typedScore(editing);

  return (
    <section aria-label={t`Contact Engagement Score`} className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-control px-1 text-left text-sm font-medium -outline-offset-2 hover:bg-secondary lg:min-h-8"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Trans>Contact Engagement Score</Trans>
        <ChevronDown
          aria-hidden
          className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`}
          strokeWidth={1.8}
        />
      </button>
      <p role="status" className="sr-only">
        {notice}
      </p>
      <div id={bodyId} hidden={!open} className="flex flex-col gap-2 px-1">
        {score.isPending && open ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Loading the score…</Trans>
          </p>
        ) : null}
        {score.isError ? (
          <p role="alert" className="text-sm text-destructive">
            <Trans>The score couldn't be loaded.</Trans>
          </p>
        ) : null}
        {data === undefined ? null : editing === undefined ? (
          <div className="flex items-center justify-between gap-2">
            <p className="text-2xl font-semibold text-foreground" data-testid="engagement-score">
              {data.score ?? (
                <span className="text-md font-normal text-muted-foreground">{t`No score yet`}</span>
              )}
            </p>
            {data.canEdit && !readOnly ? (
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  save.reset();
                  setEditing(String(data.score ?? 0));
                }}
              >
                <Trans>Edit</Trans>
              </Button>
            ) : null}
          </div>
        ) : (
          <form
            className="flex flex-col gap-2"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (typed !== undefined) save.mutate(typed);
            }}
          >
            <label htmlFor={inputId} className="text-sm font-medium">
              <Trans>Engagement score</Trans>
            </label>
            <Input
              id={inputId}
              type="number"
              inputMode="numeric"
              step={1}
              aria-invalid={typed === undefined}
              value={editing}
              onChange={(event) => {
                setEditing(event.target.value);
              }}
            />
            {typed === undefined ? (
              <p role="alert" className="text-sm text-destructive">
                <Trans>Enter a whole number from -1,000,000 to 1,000,000.</Trans>
              </p>
            ) : null}
            {save.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {saidBy(
                  save.error,
                  t`The score wasn't saved. Check your connection and try again.`,
                )}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                size="small"
                disabled={save.isPending}
                onClick={() => {
                  setEditing(undefined);
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button type="submit" size="small" disabled={save.isPending || typed === undefined}>
                <Trans>Save</Trans>
              </Button>
            </div>
          </form>
        )}
        {data === undefined || data.changes.length === 0 ? null : (
          <ul aria-label={t`Latest changes`} className="flex flex-col gap-1 text-sm text-body">
            {data.changes.map((change, index) => {
              const by = sources[change.source];
              const amount =
                change.change > 0 ? `+${String(change.change)}` : String(change.change);
              const at = new Date(change.at).toLocaleString();
              return (
                <li key={`${change.at}:${String(index)}`} className="flex justify-between gap-2">
                  <span>
                    {by} · <time dateTime={change.at}>{at}</time>
                  </span>
                  <span className={change.change > 0 ? 'text-success' : 'text-destructive'}>
                    {amount}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
