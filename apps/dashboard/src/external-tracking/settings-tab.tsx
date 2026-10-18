// Settings → External Tracking → Settings: what the script records (page views, forms),
// which websites it answers on, whether returning visitors are recognised, and a new
// tracking id. Changing any of it takes sites.manage; anyone else sees it read-only.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  regenerateTrackingId,
  updateExternalTracking,
  type ExternalTracking,
  type UpdateExternalTrackingInput,
  type VisitorIdentification,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { ConfirmDialog } from '../settings-list';
import { useBusiness } from '../workspace';
import { readDomains } from './rules';
import {
  cardClassName,
  problemOf,
  settingsKey,
  TrackingFrame,
  useMayManageSites,
  useTrackingSettings,
} from './shared';

interface Draft {
  readonly pageViews: boolean;
  readonly formCapture: boolean;
  readonly websites: string;
  readonly visitorIds: VisitorIdentification;
}

const draftOf = (settings: ExternalTracking): Draft => ({
  pageViews: settings.pageViews,
  formCapture: settings.formCapture,
  websites: settings.allowedDomains.join('\n'),
  visitorIds: settings.visitorIds,
});

export default function SettingsTab(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const settings = useTrackingSettings();
  const mayManage = useMayManageSites();
  const pageViewsId = useId();
  const formCaptureId = useId();
  const websitesId = useId();
  const visitorsId = useId();
  const trackingIdId = useId();
  const regenerateRef = useRef<HTMLButtonElement>(null);
  // What the person changed; until they change something, the settings as saved.
  const [edited, setEdited] = useState<Draft>();
  const [message, setMessage] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const current = settings.data;
  const draft = edited ?? (current === undefined ? undefined : draftOf(current));

  const saved = (next: ExternalTracking) => {
    cache.setQueryData(settingsKey(business.id), next);
  };
  const save = useMutation({
    mutationFn: (body: UpdateExternalTrackingInput) =>
      apiIn(business.id).request(updateExternalTracking, { body }),
    onSuccess: (next) => {
      saved(next);
      setEdited(undefined);
      setMessage(t`Settings saved.`);
    },
    onError: (error) => {
      setMessage(problemOf(error, t`The settings couldn't be saved.`));
    },
  });
  const regenerate = useMutation({
    mutationFn: (revision: number) =>
      apiIn(business.id).request(regenerateTrackingId, { body: { revision } }),
    onSuccess: (next) => {
      saved(next);
      setConfirming(false);
      setMessage(t`A new tracking ID was made. Copy the new script from Installation.`);
    },
  });

  const disabled = !mayManage || current === undefined || draft === undefined;
  const choices: readonly { value: VisitorIdentification; label: string; help: string }[] = [
    {
      value: 'unless_opted_out',
      label: t`Unless their browser asks not to be tracked (recommended)`,
      help: t`Browsers that send Global Privacy Control are not recognised.`,
    },
    { value: 'always', label: t`Always`, help: t`Every returning visitor is recognised.` },
    {
      value: 'never',
      label: t`Never`,
      help: t`Page views stay anonymous; forms still create or find contacts.`,
    },
  ];
  return (
    <TrackingFrame>
      {settings.isError ? (
        <p role="alert" className="text-sm">
          {problemOf(settings.error, t`The tracking settings couldn't be loaded.`)}
        </p>
      ) : null}
      {!mayManage ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Only people who manage sites can change these settings.</Trans>
        </p>
      ) : null}
      <form
        className={cardClassName}
        onSubmit={(event) => {
          event.preventDefault();
          if (current === undefined || draft === undefined) return;
          const read = readDomains(draft.websites);
          if (read.invalid.length > 0) {
            const listed = read.invalid.join(', ');
            setMessage(t`These are not websites: ${listed}`);
            return;
          }
          setMessage(undefined);
          save.mutate({
            pageViews: draft.pageViews,
            formCapture: draft.formCapture,
            allowedDomains: [...read.domains],
            visitorIds: draft.visitorIds,
            revision: current.revision,
          });
        }}
      >
        <h2 className="text-lg font-medium">
          <Trans>What the script records</Trans>
        </h2>
        <div className="flex flex-col gap-1">
          <div className="flex items-start gap-3">
            <input
              id={pageViewsId}
              type="checkbox"
              className="mt-1 size-4"
              checked={draft?.pageViews ?? false}
              disabled={disabled}
              aria-describedby={`${pageViewsId}-help`}
              onChange={(event) => {
                if (draft !== undefined) setEdited({ ...draft, pageViews: event.target.checked });
              }}
            />
            <label htmlFor={pageViewsId} className="font-medium">
              <Trans>Track page views</Trans>
            </label>
          </div>
          <p id={`${pageViewsId}-help`} className="ps-7 text-sm text-muted-foreground">
            <Trans>
              Each page a visitor opens, kept 30 days, and counted per page for 13 months.
            </Trans>
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-start gap-3">
            <input
              id={formCaptureId}
              type="checkbox"
              className="mt-1 size-4"
              checked={draft?.formCapture ?? false}
              disabled={disabled}
              aria-describedby={`${formCaptureId}-help`}
              onChange={(event) => {
                if (draft !== undefined) setEdited({ ...draft, formCapture: event.target.checked });
              }}
            />
            <label htmlFor={formCaptureId} className="font-medium">
              <Trans>Capture form submissions</Trans>
            </label>
          </div>
          <p id={`${formCaptureId}-help`} className="ps-7 text-sm text-muted-foreground">
            <Trans>A form with an email or phone field creates or updates the contact.</Trans>
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={websitesId} className="font-medium">
            <Trans>Allowed websites</Trans>
          </label>
          <Textarea
            id={websitesId}
            rows={3}
            value={draft?.websites ?? ''}
            disabled={disabled}
            aria-describedby={`${websitesId}-help`}
            onChange={(event) => {
              if (draft !== undefined) setEdited({ ...draft, websites: event.target.value });
            }}
          />
          <p id={`${websitesId}-help`} className="text-sm text-muted-foreground">
            <Trans>
              One website a line, such as example.com; its subdomains are included. Leave it empty
              to accept any website the script is on.
            </Trans>
          </p>
        </div>
        <fieldset className="flex flex-col gap-2" aria-describedby={`${visitorsId}-help`}>
          <legend className="font-medium">
            <Trans>Recognise returning visitors</Trans>
          </legend>
          <p id={`${visitorsId}-help`} className="text-sm text-muted-foreground">
            <Trans>
              A random ID kept in the visitor's browser links their page views to the contact their
              form creates.
            </Trans>
          </p>
          {choices.map((choice) => (
            <div key={choice.value} className="flex items-start gap-3">
              <input
                id={`${visitorsId}-${choice.value}`}
                type="radio"
                name={visitorsId}
                className="mt-1 size-4"
                value={choice.value}
                checked={draft?.visitorIds === choice.value}
                disabled={disabled}
                aria-describedby={`${visitorsId}-${choice.value}-help`}
                onChange={() => {
                  if (draft !== undefined) setEdited({ ...draft, visitorIds: choice.value });
                }}
              />
              <div className="flex flex-col">
                <label htmlFor={`${visitorsId}-${choice.value}`}>{choice.label}</label>
                <span
                  id={`${visitorsId}-${choice.value}-help`}
                  className="text-sm text-muted-foreground"
                >
                  {choice.help}
                </span>
              </div>
            </div>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <p role="status" className="text-sm text-body">
            {message ?? ''}
          </p>
          <Button type="submit" disabled={disabled || save.isPending}>
            <Trans>Save</Trans>
          </Button>
        </div>
      </form>
      <section className={cardClassName} aria-labelledby={trackingIdId}>
        <h2 id={trackingIdId} className="text-lg font-medium">
          <Trans>Tracking ID</Trans>
        </h2>
        <p className="font-mono text-sm break-all">{current?.trackingId ?? ''}</p>
        <p className="text-sm text-muted-foreground">
          <Trans>
            A new tracking ID stops the old script at once: paste the new one on every website.
          </Trans>
        </p>
        <Button
          ref={regenerateRef}
          variant="secondary"
          className="self-start"
          disabled={disabled}
          onClick={() => {
            regenerate.reset();
            setConfirming(true);
          }}
        >
          <Trans>Regenerate tracking ID</Trans>
        </Button>
      </section>
      <ConfirmDialog
        open={confirming}
        title={t`Regenerate tracking ID?`}
        description={t`The script on your websites stops working at once, until you paste the new one.`}
        confirmLabel={t`Regenerate`}
        destructive
        busy={regenerate.isPending}
        problem={
          regenerate.isError
            ? problemOf(regenerate.error, t`A new tracking ID couldn't be made.`)
            : undefined
        }
        returnFocus={regenerateRef}
        onConfirm={() => {
          if (current !== undefined) regenerate.mutate(current.revision);
        }}
        onClose={() => {
          setConfirming(false);
        }}
      />
    </TrackingFrame>
  );
}
