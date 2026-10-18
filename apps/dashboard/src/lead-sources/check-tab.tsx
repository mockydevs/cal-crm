// Settings → Lead Sources → Check a link: paste the address an ad or a post sends people
// to and see what a lead arriving that way would be, step by step: which of the business's
// own rules fit, then the built-in rule, the lead source that results, the session source,
// the tags, and whose click ids the link carries. With a form chosen, also what that form
// would write on the contact. The API reads the address exactly as a submission would
// (previewLeadSource) and stores nothing.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  ATTRIBUTION_LIMITS,
  previewLeadSource,
  type PreviewLeadSourceInput,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { linkCheckRequest } from '../forms-link-check-rules';
import { useBusiness } from '../workspace';
import { CheckedLink } from './checked-link';
import { readFormChoices } from './forms-read';
import {
  cardClassName,
  fieldLabelClassName,
  labelClassName,
  LeadSourcesFrame,
  retryFaults,
} from './frame';

const NO_FORM = 'none';

export default function CheckTab(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const id = useId();
  const [url, setUrl] = useState('');
  const [referrer, setReferrer] = useState('');
  const [formId, setFormId] = useState(NO_FORM);
  const [problems, setProblems] = useState<{ readonly url?: string; readonly referrer?: string }>(
    {},
  );
  const forms = useQuery({
    queryKey: ['b', business.id, 'lead-sources', 'forms'] as const,
    queryFn: () => readFormChoices(api),
    staleTime: 60_000,
    retry: retryFaults,
  });
  const check = useMutation({
    mutationFn: (body: PreviewLeadSourceInput) => api.request(previewLeadSource, { body }),
  });
  const run = (): void => {
    const asked = linkCheckRequest(url, referrer, formId === NO_FORM ? undefined : formId);
    if (!asked.ok) {
      setProblems(asked.problems);
      check.reset();
      return;
    }
    setProblems({});
    check.mutate(asked.body);
  };
  const draftName = (name: string): string => t`${name} (draft)`;
  return (
    <LeadSourcesFrame>
      <p className="text-md text-muted-foreground">
        <Trans>
          Paste the address an ad or a post sends people to, with everything after the question
          mark, and see what a lead arriving that way would be. Nothing is stored.
        </Trans>
      </p>
      <form
        noValidate
        aria-label={t`Check a link`}
        className={cardClassName}
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
      >
        <div className="grid min-w-0 gap-3 lg:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={`${id}-url`} className={fieldLabelClassName}>
              <Trans>Link they follow</Trans>
            </label>
            <Input
              id={`${id}-url`}
              type="text"
              inputMode="url"
              autoComplete="off"
              placeholder="https://www.example.com/offer?utm_source=…"
              maxLength={ATTRIBUTION_LIMITS.urlLength}
              value={url}
              aria-invalid={problems.url === undefined ? undefined : true}
              aria-describedby={problems.url === undefined ? undefined : `${id}-url-problem`}
              onValueChange={setUrl}
            />
            {problems.url === undefined ? null : (
              <p id={`${id}-url-problem`} role="alert" className="text-sm text-destructive">
                {problems.url}
              </p>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={`${id}-referrer`} className={fieldLabelClassName}>
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
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={`${id}-form`} className={fieldLabelClassName}>
              <Trans>Form to check against (optional)</Trans>
            </label>
            <Select
              id={`${id}-form`}
              value={formId}
              aria-describedby={`${id}-form-hint`}
              onValueChange={setFormId}
            >
              <option value={NO_FORM}>{t`No form`}</option>
              {(forms.data ?? []).map((form) => (
                <option key={form.id} value={form.id}>
                  {form.draft ? draftName(form.name) : form.name}
                </option>
              ))}
            </Select>
            <p id={`${id}-form-hint`} className={labelClassName}>
              {forms.isError ? (
                <Trans>The forms couldn't be loaded. The link can still be checked.</Trans>
              ) : (
                <Trans>Also shows the Source and tags that form would write, as last saved.</Trans>
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={check.isPending}>
            {check.isPending ? t`Checking…` : t`Check`}
          </Button>
        </div>
        {check.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {check.error instanceof ApiError
              ? check.error.message
              : t`The link couldn't be checked. Check your connection and try again.`}
          </p>
        ) : null}
      </form>
      <CheckedLink preview={check.data} />
    </LeadSourcesFrame>
  );
}
