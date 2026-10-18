// "Check a link" on a form's card: paste the address an ad or a post would send people to,
// and see what a lead arriving that way would get on this form: the lead source, the rule
// that decided it, the session source, the Source written on the contact and the tags
// added. The API reads the address exactly as a submission would (previewLeadSource) and
// stores nothing; it answers for the form as last saved.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  ATTRIBUTION_LIMITS,
  previewLeadSource,
  type PreviewLeadSourceInput,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useMutation } from '@tanstack/react-query';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useId, useState, type KeyboardEvent, type ReactElement } from 'react';
import { linkCheckRequest, linkCheckView } from './forms-link-check-rules';
import { LinkCheckResult } from './link-check-result';

export function FormLinkCheck({
  formId,
  unsaved,
  client,
}: {
  readonly formId: string;
  /** The builder holds changes that are not saved: the answer is for the form as saved. */
  readonly unsaved: boolean;
  readonly client: Client;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [referrer, setReferrer] = useState('');
  const [problems, setProblems] = useState<{ readonly url?: string; readonly referrer?: string }>(
    {},
  );
  const check = useMutation({
    mutationFn: (body: PreviewLeadSourceInput) => client.request(previewLeadSource, { body }),
  });
  const run = (): void => {
    const asked = linkCheckRequest(url, referrer, formId);
    if (!asked.ok) {
      setProblems(asked.problems);
      check.reset();
      return;
    }
    setProblems({});
    check.mutate(asked.body);
  };
  // The card is inside the builder's form: Enter here checks the link, and saves nothing.
  const onEnter = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    run();
  };
  const view = check.data === undefined ? undefined : linkCheckView(check.data);
  const Chevron = open ? ChevronUp : ChevronDown;
  const labelClassName = 'text-sm text-muted-foreground';
  return (
    <div className="flex min-w-0 flex-col gap-3 border-t border-border pt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? `${id}-body` : undefined}
        className="flex min-h-9 items-center gap-1.5 self-start rounded-control text-sm font-medium text-foreground outline-none hover:text-link focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        <Trans>Check a link</Trans>
        <Chevron aria-hidden className="size-4 shrink-0" strokeWidth={2} />
      </button>
      {open ? (
        <div
          id={`${id}-body`}
          role="group"
          aria-label={t`Check a link`}
          className="flex min-w-0 flex-col gap-3"
        >
          <p className={labelClassName}>
            <Trans>
              Paste the address an ad or a post sends people to, with everything after the question
              mark, and see what a lead arriving that way would get on this form. Nothing is stored.
            </Trans>
          </p>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={`${id}-url`} className="text-sm font-medium">
                <Trans>Link they follow</Trans>
              </label>
              <Input
                id={`${id}-url`}
                // Plain text: the builder's own form must never refuse to save over what is typed here.
                type="text"
                inputMode="url"
                autoComplete="off"
                placeholder="https://www.example.com/offer?utm_source=…"
                maxLength={ATTRIBUTION_LIMITS.urlLength}
                value={url}
                aria-invalid={problems.url === undefined ? undefined : true}
                aria-describedby={problems.url === undefined ? undefined : `${id}-url-problem`}
                onValueChange={setUrl}
                onKeyDown={onEnter}
              />
              {problems.url === undefined ? null : (
                <p id={`${id}-url-problem`} role="alert" className="text-sm text-destructive">
                  {problems.url}
                </p>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={`${id}-referrer`} className="text-sm font-medium">
                <Trans>Where they came from (optional)</Trans>
              </label>
              <Input
                id={`${id}-referrer`}
                type="text"
                inputMode="url"
                autoComplete="off"
                placeholder="https://www.google.com"
                maxLength={ATTRIBUTION_LIMITS.urlLength}
                value={referrer}
                aria-invalid={problems.referrer === undefined ? undefined : true}
                aria-describedby={
                  problems.referrer === undefined ? `${id}-referrer-hint` : `${id}-referrer-problem`
                }
                onValueChange={setReferrer}
                onKeyDown={onEnter}
              />
              {problems.referrer === undefined ? (
                <p id={`${id}-referrer-hint`} className={labelClassName}>
                  <Trans>The site the link is on, when you know it.</Trans>
                </p>
              ) : (
                <p id={`${id}-referrer-problem`} role="alert" className="text-sm text-destructive">
                  {problems.referrer}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={check.isPending}
              onClick={run}
            >
              {check.isPending ? t`Checking…` : t`Check`}
            </Button>
            {unsaved ? (
              <p className={labelClassName}>
                <Trans>
                  This checks the form as last saved. Save the draft to check what you changed.
                </Trans>
              </p>
            ) : null}
          </div>
          {check.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {check.error instanceof ApiError
                ? check.error.message
                : t`The link couldn't be checked. Check your connection and try again.`}
            </p>
          ) : null}
          <LinkCheckResult view={view} />
        </div>
      ) : null}
    </div>
  );
}
