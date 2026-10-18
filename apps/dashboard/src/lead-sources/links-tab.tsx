// Settings → Lead Sources → Tracking links: choose where an ad runs and get the text to
// paste into it, so a click on the ad arrives with what the lead source rules read. The
// templates, their parameters, their placeholders, where each is pasted and what was and
// was not read in the platform's own documentation are the catalogue's
// (packages/contracts/src/tracking-links.ts); the text is built by its own function. Under
// it, "What this link will record" checks the link as a click would arrive, with sample
// values where the platform fills its own in.
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  ATTRIBUTION_LIMITS,
  previewLeadSource,
  trackingLinkTemplate,
  type BuiltTrackingLink,
  type TrackingLinkPlatform,
  type TrackingLinkTemplate,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { useEffect, useId, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { linkCheckView } from '../forms-link-check-rules';
import { LinkCheckResult } from '../link-check-result';
import { useBusiness } from '../workspace';
import {
  cardClassName,
  fieldLabelClassName,
  labelClassName,
  LeadSourcesFrame,
  retryFaults,
  useSettled,
} from './frame';
import {
  arrivingLink,
  baseUrlProblem,
  builtLink,
  editableParameters,
  firstTemplateOf,
  linkDraftOf,
  linkPlatforms,
  pastedBesideAddress,
  templatesOf,
  withTemplate,
  type LinkDraft,
} from './links';

/** The platforms' own names: the same in every language. */
const platformNames: Readonly<Record<TrackingLinkPlatform, MessageDescriptor>> = {
  google_ads: msg`Google Ads`,
  microsoft_ads: msg`Microsoft Advertising`,
  meta: msg`Meta`,
  tiktok: msg`TikTok`,
  linkedin: msg`LinkedIn`,
  email: msg`Email`,
  other: msg`Other`,
};

const radioCardClassName =
  'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium has-checked:border-primary has-checked:bg-accent lg:min-h-9';

function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  const { t } = useLingui();
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
  const Icon = copied ? Check : Copy;
  return (
    <>
      <Button
        variant="secondary"
        size="small"
        aria-label={label}
        disabled={text === ''}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => {
              setCopied(true);
            },
            () => undefined,
          );
        }}
      >
        <Icon aria-hidden className="size-4" strokeWidth={1.8} />
        {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
      </Button>
      <span role="status" className="sr-only">
        {copied ? t`Copied.` : ''}
      </span>
    </>
  );
}

/** What the built text is, in the words of the box it is pasted into. */
function useOutputName(): (template: TrackingLinkTemplate, built: BuiltTrackingLink) => string {
  const { t } = useLingui();
  return (template, built) => {
    if (!built.ok) return t`Text to paste`;
    if (built.kind === 'tracking_template') return t`Tracking template to paste`;
    if (built.kind === 'link') return t`Link to use in the ad`;
    return template.form === 'link' ? t`Parameters to add to the address` : t`Parameters to paste`;
  };
}

export default function LinksTab(): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const id = useId();
  const outputName = useOutputName();
  const [platform, setPlatform] = useState<TrackingLinkPlatform>(linkPlatforms[0] ?? 'google_ads');
  const [draft, setDraft] = useState<LinkDraft>(() => linkDraftOf(platform));
  const templates = templatesOf(platform);
  const template = trackingLinkTemplate(draft.templateId) ?? firstTemplateOf(platform);
  const built = builtLink(draft);
  const badBase = baseUrlProblem(draft);
  const arriving = useSettled(badBase ? '' : (arrivingLink(draft) ?? ''), 400);
  const record = useQuery({
    queryKey: ['b', business.id, 'lead-sources', 'link-record', arriving] as const,
    queryFn: () => api.request(previewLeadSource, { body: { url: arriving } }),
    enabled: arriving !== '' && arriving.length <= ATTRIBUTION_LIMITS.urlLength,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: retryFaults,
  });
  const choosePlatform = (next: TrackingLinkPlatform): void => {
    setPlatform(next);
    // The landing page typed stays: it is the same page whatever platform sends people to it.
    setDraft((now) => ({ ...linkDraftOf(next), baseUrl: now.baseUrl }));
  };
  const date = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeZone: 'UTC' });
  if (template === undefined) return <LeadSourcesFrame>{null}</LeadSourcesFrame>;
  const beside = pastedBesideAddress(template);
  const editable = editableParameters(template);
  const text = built.ok ? built.text : '';
  const output = outputName(template, built);
  const platformName = i18n._(platformNames[platform]);
  return (
    <LeadSourcesFrame>
      <p className="text-md text-muted-foreground">
        <Trans>
          An ad tells us which campaign a lead came from only when its link says so. Choose where
          the ad runs, copy the text, and paste it where the platform asks for it.
        </Trans>
      </p>
      <section className={cardClassName}>
        <h2 id={`${id}-platform`} className="text-base font-medium">
          <Trans>Where the ad or the link runs</Trans>
        </h2>
        <div
          role="radiogroup"
          aria-labelledby={`${id}-platform`}
          className="flex min-w-0 flex-wrap gap-2"
        >
          {linkPlatforms.map((each) => (
            <label key={each} className={radioCardClassName}>
              <input
                type="radio"
                name={`${id}-platform`}
                className="size-4 shrink-0 accent-primary"
                checked={platform === each}
                onChange={() => {
                  choosePlatform(each);
                }}
              />
              {i18n._(platformNames[each])}
            </label>
          ))}
        </div>
        {templates.length < 2 ? null : (
          <>
            <p id={`${id}-template`} className={fieldLabelClassName}>
              <Trans>Template</Trans>
            </p>
            <div
              role="radiogroup"
              aria-labelledby={`${id}-template`}
              className="flex min-w-0 flex-col gap-2 lg:flex-row lg:flex-wrap"
            >
              {templates.map((each) => (
                <label key={each.id} className={radioCardClassName}>
                  <input
                    type="radio"
                    name={`${id}-template`}
                    className="size-4 shrink-0 accent-primary"
                    checked={template.id === each.id}
                    onChange={() => {
                      setDraft((now) => withTemplate(now, each.id));
                    }}
                  />
                  <span className="min-w-0 wrap-anywhere">{each.label}</span>
                </label>
              ))}
            </div>
          </>
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className={labelClassName}>
            <Trans>Where to paste it</Trans>
          </p>
          <p className="min-w-0 wrap-anywhere">{template.where}</p>
        </div>
      </section>

      <section className={cardClassName} aria-labelledby={`${id}-build`}>
        <h2 id={`${id}-build`} className="text-base font-medium">
          <Trans>Build it</Trans>
        </h2>
        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5 lg:col-span-2">
            <label htmlFor={`${id}-base`} className={fieldLabelClassName}>
              <Trans>Landing page address</Trans>
            </label>
            <Input
              id={`${id}-base`}
              type="text"
              inputMode="url"
              autoComplete="off"
              placeholder="https://www.example.com/offer"
              maxLength={ATTRIBUTION_LIMITS.urlLength}
              value={draft.baseUrl}
              aria-invalid={badBase ? true : undefined}
              aria-describedby={`${id}-base-hint`}
              onValueChange={(baseUrl) => {
                setDraft((now) => ({ ...now, baseUrl }));
              }}
            />
            <p
              id={`${id}-base-hint`}
              role={badBase ? 'alert' : undefined}
              className={badBase ? 'text-sm text-destructive' : labelClassName}
            >
              {badBase ? (
                <Trans>Enter a web address, starting with https://.</Trans>
              ) : beside ? (
                <Trans>
                  Used only for the example below: {platformName} adds the ad's own address itself,
                  so it is not part of the text to paste.
                </Trans>
              ) : (
                <Trans>
                  The page the link leads to. Left empty, you get the parameters to add to an
                  address yourself.
                </Trans>
              )}
            </p>
          </div>
          {editable.map((parameter) => {
            const name = parameter.name;
            const fills = parameter.fills;
            const filled = parameter.value;
            return (
              <div key={name} className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor={`${id}-own-${name}`} className={fieldLabelClassName}>
                  {t`${fills} (${name})`}
                </label>
                <Input
                  id={`${id}-own-${name}`}
                  type="text"
                  autoComplete="off"
                  maxLength={200}
                  value={draft.values[name] ?? ''}
                  aria-describedby={`${id}-own-${name}-hint`}
                  onValueChange={(value) => {
                    setDraft((now) => ({ ...now, values: { ...now.values, [name]: value } }));
                  }}
                />
                <p id={`${id}-own-${name}-hint`} className={labelClassName}>
                  {parameter.kind === 'placeholder'
                    ? t`Optional. Left empty, ${platformName} fills it in itself: ${filled}`
                    : t`Optional. Left empty, it is “${filled}”.`}
                </p>
              </div>
            );
          })}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <label htmlFor={`${id}-out`} className={fieldLabelClassName}>
              {output}
            </label>
            <CopyButton text={text} label={t`Copy: ${output}`} />
          </div>
          <textarea
            id={`${id}-out`}
            readOnly
            rows={3}
            value={text}
            className="w-full min-w-0 resize-y rounded-control border border-input bg-muted px-3 py-2 font-mono text-xs break-all text-body outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </section>

      <section className={cardClassName} aria-labelledby={`${id}-parameters`}>
        <h2 id={`${id}-parameters`} className="text-base font-medium">
          <Trans>What each parameter is</Trans>
        </h2>
        <ul className="flex min-w-0 list-none flex-col gap-2 p-0">
          {template.parameters.map((parameter) => {
            const typed = parameter.editable ? (draft.values[parameter.name] ?? '').trim() : '';
            const own = typed !== '';
            const fills = parameter.fills;
            return (
              <li
                key={parameter.name}
                className="grid min-w-0 gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]"
              >
                <code className="min-w-0 font-mono text-xs break-all text-body">
                  {parameter.name}={own ? typed : parameter.value}
                </code>
                <span className="min-w-0 text-sm wrap-anywhere text-muted-foreground">
                  {own
                    ? t`${fills}. Your own words.`
                    : parameter.kind === 'placeholder'
                      ? t`${fills}. ${platformName} fills it in when the ad is clicked.`
                      : parameter.editable
                        ? t`${fills}. An example: write your own above.`
                        : t`${fills}. Always these words.`}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className={cardClassName} aria-labelledby={`${id}-record`}>
        <h2 id={`${id}-record`} className="text-base font-medium">
          <Trans>What this link will record</Trans>
        </h2>
        <p className={labelClassName}>
          <Trans>
            A click as it would arrive, with sample values where the platform fills its own in:
          </Trans>
        </p>
        <code className="min-w-0 rounded-control bg-muted px-2 py-1.5 font-mono text-xs break-all text-body">
          {arriving === '' ? '—' : arriving}
        </code>
        {record.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {record.error instanceof ApiError
              ? record.error.message
              : t`The link couldn't be checked. Check your connection and try again.`}
          </p>
        ) : null}
        <LinkCheckResult
          view={
            arriving === '' || record.data === undefined ? undefined : linkCheckView(record.data)
          }
          steps
        />
      </section>

      <section className={cardClassName} aria-labelledby={`${id}-notes`}>
        <h2 id={`${id}-notes`} className="text-base font-medium">
          <Trans>Before you paste it</Trans>
        </h2>
        {template.verified ? (
          template.sources.length === 0 ? null : (
            <p className="rounded-lg bg-success-subtle px-3 py-2 text-sm text-success">
              <Trans>
                Checked: the placeholders, and the box they go in, were read in the platform's own
                documentation.
              </Trans>
            </p>
          )
        ) : (
          <p className="rounded-lg bg-attention px-3 py-2 text-sm text-attention-foreground">
            <Trans>
              Not fully confirmed: a placeholder, or the box it goes in, could not be read in the
              platform's own documentation, so this template is as commonly used. The notes say
              which part. Test one ad before using it widely.
            </Trans>
          </p>
        )}
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
          {template.notes.map((note) => (
            <li key={note} className="min-w-0 wrap-anywhere">
              {note}
            </li>
          ))}
        </ul>
        {template.sources.length === 0 ? null : (
          <div className="flex min-w-0 flex-col gap-1">
            <p className={labelClassName}>
              <Trans>Read on the platform's own pages</Trans>
            </p>
            <ul className="flex min-w-0 list-none flex-col gap-1 p-0 text-sm">
              {template.sources.map((source) => {
                // A day with no time is read as that day in UTC, and written so.
                const when = date.format(new Date(source.read));
                return (
                  <li key={source.url} className="min-w-0">
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-control text-link underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="min-w-0 break-all">{source.url}</span>
                      <ExternalLink aria-hidden className="size-3.5 shrink-0" strokeWidth={1.8} />
                      <span className="sr-only">
                        <Trans>(opens in a new tab)</Trans>
                      </span>
                    </a>{' '}
                    <span className="text-muted-foreground">{t`(read ${when})`}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>
    </LeadSourcesFrame>
  );
}
