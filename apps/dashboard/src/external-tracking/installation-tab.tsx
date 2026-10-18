// Settings → External Tracking → Installation, as GoHighLevel's: "External Tracking Script
// Installation", the script with the business's tracking id in a code box, "Copy Script",
// and the events it tracks, Page Views and Form Fills / Optins with what a form needs.
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { useId, useState, type ReactElement } from 'react';
import { scriptTag } from './rules';
import { cardClassName, problemOf, TrackingFrame, useTrackingSettings } from './shared';

export default function InstallationTab(): ReactElement {
  const { t } = useLingui();
  const settings = useTrackingSettings();
  const codeId = useId();
  const eventsId = useId();
  const [copied, setCopied] = useState<'yes' | 'no'>();
  const origin = window.location.origin;
  const code = settings.data === undefined ? '' : scriptTag(origin, settings.data.trackingId);
  return (
    <TrackingFrame>
      <section className={cardClassName} aria-labelledby={`${codeId}-title`}>
        <h2 id={`${codeId}-title`} className="text-lg font-medium">
          <Trans>External Tracking Script Installation</Trans>
        </h2>
        <p className="text-md text-body">
          <Trans>
            Copy and paste this tracking code into every page of your site, just before the closing
            &lt;/body&gt; tag
          </Trans>
        </p>
        {settings.isError ? (
          <p role="alert" className="text-sm">
            {problemOf(settings.error, t`The tracking script couldn't be loaded.`)}
          </p>
        ) : null}
        <label htmlFor={codeId} className="sr-only">
          <Trans>Tracking script</Trans>
        </label>
        <textarea
          id={codeId}
          readOnly
          rows={3}
          value={code}
          spellCheck={false}
          aria-busy={settings.isPending}
          className="w-full min-w-0 resize-none rounded-control border border-input bg-muted p-3 font-mono text-sm break-all text-foreground"
          onFocus={(event) => {
            event.currentTarget.select();
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="text-sm text-body">
            {copied === 'yes'
              ? t`Script copied.`
              : copied === 'no'
                ? t`The script couldn't be copied. Select it and copy it yourself.`
                : ''}
          </p>
          <Button
            disabled={code === ''}
            onClick={() => {
              void navigator.clipboard.writeText(code).then(
                () => {
                  setCopied('yes');
                },
                () => {
                  setCopied('no');
                },
              );
            }}
          >
            <Trans>Copy Script</Trans>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          <Trans>
            If your website sets a Content-Security-Policy, allow {origin} in its script-src and
            connect-src. Add data-debug="true" to the tag to see what the script does in the
            browser's console.
          </Trans>
        </p>
      </section>
      <section className={cardClassName} aria-labelledby={eventsId}>
        <h2 id={eventsId} className="text-lg font-medium">
          <Trans>Events Tracked</Trans>
        </h2>
        <dl className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <dt className="font-medium">
              <Trans>Page Views</Trans>
            </dt>
            <dd className="text-md text-body">
              <Trans>Tracks when a user views any page where the script is installed.</Trans>
              {settings.data?.pageViews === false ? (
                <span className="block text-sm text-muted-foreground">
                  <Trans>Page views are turned off in Settings.</Trans>
                </span>
              ) : null}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="font-medium">
              <Trans>Form Fills / Optins</Trans>
            </dt>
            <dd className="flex flex-col gap-2 text-md text-body">
              <span>
                <Trans>
                  When a user fills a form on any page where the script is installed. Forms should
                  follow these requirements:
                </Trans>
              </span>
              <ul className="list-disc ps-5 text-sm">
                <li>
                  <Trans>Use a real &lt;form&gt; element.</Trans>
                </li>
                <li>
                  <Trans>
                    Give every field a name attribute, such as email, phone or first_name.
                  </Trans>
                </li>
                <li>
                  <Trans>
                    Include an email or phone field: that is how the contact is created or found.
                  </Trans>
                </li>
                <li>
                  <Trans>Fields must be visible on the page. Hidden fields are not captured.</Trans>
                </li>
                <li>
                  <Trans>
                    Forms inside an iframe are not captured. Passwords and card numbers never are.
                  </Trans>
                </li>
              </ul>
              {settings.data?.formCapture === false ? (
                <span className="text-sm text-muted-foreground">
                  <Trans>Form capture is turned off in Settings.</Trans>
                </span>
              ) : null}
            </dd>
          </div>
        </dl>
      </section>
    </TrackingFrame>
  );
}
