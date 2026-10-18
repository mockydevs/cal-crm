// What a form has beside its questions: what a submission also does (after sending, the
// contact's source and tags, who is told, and what a given link would lead to), its own
// page and a preview of the draft, and its numbers. Kept apart from the builder so each
// stays readable.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  FORM_LIMITS,
  getFormAnalytics,
  getFormPreview,
  type Form,
  type FormContactActions,
  type FormDefinition,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ExternalLink, Eye } from 'lucide-react';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { FormLinkCheck } from './forms-link-check';
import { FormSourceChoice } from './forms-source';
import { actionsOf, withTags } from './forms-source-rules';
import { TagPicker } from './tag-picker';
import { useBusiness } from './workspace';

function Row({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: (id: string, describedBy: string | undefined) => ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      {children(id, hint === undefined ? undefined : `${id}-hint`)}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * What happens when someone sends the form, beside the contact it makes: where the visitor
 * goes, the source and tags the contact gets, and who on the team is told. These are part
 * of the form, so they take effect when it is published. Under them, "Check a link" says
 * what a lead arriving by a given address would get, for the form as last saved.
 */
export function FormSubmitSettings({
  formId,
  formName,
  definition,
  disabled,
  unsaved,
  client,
  onChange,
}: {
  readonly formId: string;
  /** The form's name as the builder holds it. */
  readonly formName: string;
  readonly definition: FormDefinition;
  readonly disabled: boolean;
  /** The builder holds changes that are not saved yet. */
  readonly unsaved: boolean;
  readonly client: Client;
  readonly onChange: (next: FormDefinition) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const headingId = useId();
  const after = definition.afterSubmit ?? { kind: 'message' as const };
  const actions = actionsOf(definition);
  const notify = definition.notify ?? { mode: 'managers' as const };
  const setActions = (next: FormContactActions): void => {
    onChange({ ...definition, contactActions: next });
  };
  const memberCount = notify.mode === 'members' ? notify.memberIds.length : 0;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <h3 id={headingId} className="mb-1 text-lg font-semibold">
        <Trans>When someone sends the form</Trans>
      </h3>
      <div className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-[18px]">
        <fieldset
          disabled={disabled}
          aria-labelledby={headingId}
          className="flex min-w-0 flex-col gap-4 border-0 p-0"
        >
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <Row label={t`After sending`}>
              {(id) => (
                <Select
                  id={id}
                  value={after.kind}
                  onValueChange={(value) => {
                    onChange({
                      ...definition,
                      afterSubmit:
                        value === 'redirect'
                          ? { kind: 'redirect', url: after.kind === 'redirect' ? after.url : '' }
                          : { kind: 'message' },
                    });
                  }}
                >
                  <option value="message">{t`Show the message above`}</option>
                  <option value="redirect">{t`Go to a web page`}</option>
                </Select>
              )}
            </Row>
            {after.kind === 'redirect' ? (
              <Row label={t`Web page to go to`} hint={t`A secure address, starting with https://.`}>
                {(id, described) => (
                  <Input
                    id={id}
                    type="url"
                    {...(described === undefined ? {} : { 'aria-describedby': described })}
                    value={after.url}
                    placeholder="https://"
                    maxLength={FORM_LIMITS.urlLength}
                    onValueChange={(url) => {
                      onChange({
                        ...definition,
                        afterSubmit: { kind: 'redirect', url: url.trim() },
                      });
                    }}
                  />
                )}
              </Row>
            ) : null}
            <Row label={t`Who is told about a new submission`}>
              {(id) => (
                <Select
                  id={id}
                  value={notify.mode}
                  onValueChange={(value) => {
                    if (value === 'members') return;
                    onChange({
                      ...definition,
                      notify:
                        value === 'nobody'
                          ? { mode: 'nobody' }
                          : value === 'contact_owner'
                            ? { mode: 'contact_owner' }
                            : { mode: 'managers' },
                    });
                  }}
                >
                  <option value="managers">{t`Everyone who manages forms`}</option>
                  <option value="contact_owner">{t`The contact's owner`}</option>
                  <option value="nobody">{t`Nobody`}</option>
                  {notify.mode === 'members' ? (
                    <option value="members">{t`${memberCount} chosen team members`}</option>
                  ) : null}
                </Select>
              )}
            </Row>
          </div>
          <FormSourceChoice
            actions={actions}
            formName={formName}
            slug={business.slug}
            onChange={setActions}
          />
          <TagPicker
            label={t`Tags added to the contact`}
            chosen={actions.tagIds}
            limit={FORM_LIMITS.tags}
            disabled={disabled}
            client={client}
            cacheKey={['b', business.id, 'tags']}
            onChange={(tagIds) => {
              setActions(withTags(actions, tagIds));
            }}
          />
        </fieldset>
        {/* Outside the settings: a link can be checked by someone who may only read the form. */}
        <FormLinkCheck formId={formId} unsaved={unsaved} client={client} />
      </div>
    </section>
  );
}

/** The form's own page to share as a link, and a look at the draft before it is published. */
export function FormLink({
  form,
  client,
}: {
  readonly form: Form;
  readonly client: Client;
}): ReactElement {
  const { t } = useLingui();
  const headingId = useId();
  const [copied, setCopied] = useState<'copied' | 'failed'>();
  const preview = useMutation({
    mutationFn: () => client.request(getFormPreview, { params: { id: form.id } }),
    onSuccess: ({ url }) => {
      window.open(url, '_blank', 'noopener');
    },
  });
  const published = form.status === 'published';
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-card p-[22px] text-sm"
    >
      <h3 id={headingId} className="text-lg font-semibold">
        <Trans>Link and preview</Trans>
      </h3>
      {published ? (
        <>
          <p className="text-muted-foreground">
            <Trans>
              The form on a page of its own. Share this link anywhere: no website is needed.
            </Trans>
          </p>
          <p className="rounded-xl bg-secondary p-3 font-mono text-xs break-all">
            {form.hostedUrl}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground">
          <Trans>
            Publish the form to get a link to share. Until then you can preview the draft.
          </Trans>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {published ? (
          <>
            <Button
              size="small"
              variant="secondary"
              onClick={() => {
                navigator.clipboard.writeText(form.hostedUrl).then(
                  () => {
                    setCopied('copied');
                  },
                  () => {
                    setCopied('failed');
                  },
                );
              }}
            >
              <Trans>Copy the link</Trans>
            </Button>
            <a
              href={form.hostedUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-10 items-center gap-1.5 rounded-control px-3 text-sm text-link underline-offset-2 hover:underline lg:min-h-8"
            >
              <ExternalLink aria-hidden className="size-4" strokeWidth={1.8} />
              <Trans>Open the page</Trans>
            </a>
          </>
        ) : null}
        <Button
          size="small"
          variant="secondary"
          disabled={preview.isPending}
          onClick={() => {
            preview.mutate();
          }}
        >
          <Eye aria-hidden className="size-4" strokeWidth={1.8} />
          {preview.isPending ? t`Opening…` : t`Preview the saved draft`}
        </Button>
        <span role="status" className="empty:sr-only">
          {copied === 'copied'
            ? t`Copied.`
            : copied === 'failed'
              ? t`Couldn't copy. Select the link and copy it yourself.`
              : null}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        <Trans>
          The preview opens in a new tab and works for 30 minutes. Nothing sent from a preview is
          kept.
        </Trans>
      </p>
      {preview.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {preview.error instanceof ApiError
            ? preview.error.message
            : t`The preview couldn't be opened. Check your connection and try again.`}
        </p>
      ) : null}
    </section>
  );
}

/** A form's numbers for the last 30 days: views, responses, how many finished, and how long it took. */
export function FormAnalytics({
  form,
  client,
}: {
  readonly form: Form;
  readonly client: Client;
}): ReactElement {
  const { t, i18n } = useLingui();
  const numbers = useQuery({
    queryKey: ['forms', 'analytics', form.id],
    queryFn: () => client.request(getFormAnalytics, { params: { id: form.id }, query: {} }),
  });
  const percent = new Intl.NumberFormat(i18n.locale, {
    style: 'percent',
    maximumFractionDigits: 0,
  });
  const day = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const time = (seconds: number | null): string => {
    if (seconds === null) return '--';
    const whole = Math.round(seconds);
    const minutes = String(Math.floor(whole / 60)).padStart(2, '0');
    const rest = String(whole % 60).padStart(2, '0');
    return `${minutes}:${rest}`;
  };
  const rate = (value: number | null): string => (value === null ? '--' : percent.format(value));
  /** A calendar day as the API writes it (2026-10-12), at midnight UTC so it prints as that day. */
  const dateOf = (iso: string): Date => {
    const [year = 1970, month = 1, date = 1] = iso.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, date));
  };
  if (numbers.isPending)
    return (
      <p role="status">
        <Trans>Loading the numbers…</Trans>
      </p>
    );
  if (numbers.isError)
    return (
      <p role="alert">
        <Trans>The numbers couldn't be loaded.</Trans>{' '}
        <Button
          variant="quiet"
          onClick={() => {
            void numbers.refetch();
          }}
        >
          <Trans>Try again</Trans>
        </Button>
      </p>
    );
  const { totals, days, from, to } = numbers.data;
  const cards: readonly { readonly label: string; readonly value: string }[] = [
    { label: t`Views`, value: String(totals.views) },
    { label: t`Responses`, value: String(totals.responses) },
    { label: t`Completion rate`, value: rate(totals.completionRate) },
    { label: t`Average time`, value: time(totals.averageSeconds) },
  ];
  const busy = days.filter((each) => each.views > 0 || each.responses > 0).toReversed();
  const fromDay = day.format(dateOf(from));
  const toDay = day.format(dateOf(to));
  return (
    <div className="flex min-w-0 flex-col gap-[18px]">
      <p className="text-sm text-muted-foreground">
        {t`${fromDay} to ${toDay}. A view is each time the published form was shown; reloads count again.`}
      </p>
      <dl className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className="flex min-w-0 flex-col gap-1 rounded-card border border-border bg-card p-[18px]"
          >
            <dt className="text-sm text-muted-foreground">{card.label}</dt>
            <dd className="text-[26px] leading-tight font-semibold">{card.value}</dd>
          </div>
        ))}
      </dl>
      <section className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-card p-[18px]">
        <h3 className="text-base font-medium">
          <Trans>By day</Trans>
        </h3>
        {busy.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground">
            <Trans>Nobody has seen or sent this form in these days.</Trans>
          </p>
        ) : (
          <div className="max-w-full overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    <Trans>Day</Trans>
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    <Trans>Views</Trans>
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    <Trans>Responses</Trans>
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    <Trans>Completion rate</Trans>
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    <Trans>Average time</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {busy.map((each) => (
                  <tr key={each.date} className="border-b border-border last:border-0">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      {day.format(dateOf(each.date))}
                    </th>
                    <td className="py-2 pr-3 text-right tabular-nums">{each.views}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{each.responses}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {rate(each.completionRate)}
                    </td>
                    <td className="py-2 text-right tabular-nums">{time(each.averageSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
