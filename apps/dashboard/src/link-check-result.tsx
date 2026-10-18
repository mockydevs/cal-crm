// What "Check a link" answers, drawn: the lead source first and largest, the session source,
// what decided, and for a form the Source it would write and the tags it would add; whose
// click ids the link carries, by platform; and what else the API has to say. Shown on a
// form's card (forms-link-check.tsx) and in Settings → Lead Sources: its words are in the
// catalog of each (lingui.config.ts).
import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactElement } from 'react';
import { isClickIdPlatform, platformNames } from './click-id-platforms';
import type { LinkCheckRule, LinkCheckView } from './forms-link-check-rules';
import { useReportWords } from './reporting/words';

const labelClassName = 'text-sm text-muted-foreground';

/** What a matching rule would do, in words: "Source: Spring promo · tags: Promo, VIP". */
function RuleLine({ rule }: { readonly rule: LinkCheckRule }): ReactElement {
  const { t } = useLingui();
  const gone = t`a deleted tag (skipped)`;
  const tags = rule.tags.map((tag) => tag ?? gone).join(', ');
  const position = rule.position;
  const source = rule.source;
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <span className="min-w-0 font-medium wrap-anywhere">
        <span className="text-muted-foreground tabular-nums">{t`${position}.`}</span> {rule.name}
      </span>
      <span className="min-w-0 wrap-anywhere text-muted-foreground">
        {rule.source === null ? (
          <Trans>Names no Source</Trans>
        ) : rule.decides ? (
          <Trans>
            Source: <span className="font-medium text-foreground">{source}</span> (used)
          </Trans>
        ) : (
          <Trans>Source: {source} (not used: an earlier rule named it)</Trans>
        )}
        {rule.tags.length === 0 ? null : <> · {t`tags: ${tags}`}</>}
        {rule.fills.map((fill) => {
          const field = fill.field ?? t`a field that is gone`;
          const value = fill.value;
          return (
            <span key={`${field}:${value}`}>
              {' · '}
              {fill.applies
                ? t`fills ${field}: ${value}`
                : t`would fill ${field}: ${value} (skipped)`}
            </span>
          );
        })}
      </span>
    </li>
  );
}

export function LinkCheckResult({
  view,
  steps = false,
}: {
  /** Nothing while no link was checked: the region stays, so an answer is said aloud. */
  readonly view: LinkCheckView | undefined;
  /**
   * Every step of the decision is shown, also the ones that did nothing: that none of the
   * business's rules matched, and what the built-in rules call the visit. Without it only
   * the rules that matched are listed.
   */
  readonly steps?: boolean;
}): ReactElement {
  const { i18n } = useLingui();
  const words = useReportWords();
  return (
    <div aria-live="polite" className="flex min-w-0 flex-col gap-3 empty:hidden">
      {view === undefined ? null : (
        <>
          {view.untracked ? (
            <p className="rounded-lg bg-attention px-3 py-2 text-sm text-attention-foreground">
              <Trans>
                This link carries nothing that tells us where the visitor came from, so it would be
                recorded as Direct. Add tracking to your ad links, such as utm_source and
                utm_medium, so each lead says where it came from.
              </Trans>
            </p>
          ) : null}
          <dl className="grid min-w-0 gap-x-4 gap-y-2.5 sm:grid-cols-2">
            {view.rules.length === 0 && !steps ? null : (
              <div className="flex min-w-0 flex-col gap-1 sm:col-span-2">
                <dt className={labelClassName}>
                  <Trans>Your rules that match</Trans>
                </dt>
                <dd className="m-0 min-w-0">
                  {view.rules.length === 0 ? (
                    <Trans>None of your rules match this link.</Trans>
                  ) : (
                    <ol className="flex min-w-0 list-none flex-col gap-1.5 p-0">
                      {view.rules.map((rule) => (
                        <RuleLine key={rule.id} rule={rule} />
                      ))}
                    </ol>
                  )}
                </dd>
              </div>
            )}
            {steps ? (
              <div className="flex min-w-0 flex-col gap-0.5 sm:col-span-2">
                <dt className={labelClassName}>
                  <Trans>Built-in rule</Trans>
                </dt>
                <dd className="m-0 min-w-0 wrap-anywhere">
                  <span className="font-medium">{view.builtIn.source}</span>{' '}
                  <span className="text-muted-foreground">
                    {view.builtIn.decides ? (
                      <Trans>(names the lead)</Trans>
                    ) : (
                      <Trans>(not used: a rule of yours names the lead)</Trans>
                    )}
                  </span>
                  <br />
                  <span className="text-muted-foreground">{view.builtIn.looksFor}</span>
                </dd>
              </div>
            ) : null}
            <div className="flex min-w-0 flex-col gap-0.5">
              <dt className={labelClassName}>
                <Trans>Lead source</Trans>
              </dt>
              <dd className="m-0 min-w-0 text-base font-semibold wrap-anywhere">{view.source}</dd>
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <dt className={labelClassName}>
                <Trans>Session source</Trans>
              </dt>
              <dd className="m-0 min-w-0 font-medium wrap-anywhere">
                {words.sessionSource(view.sessionSource)}
              </dd>
            </div>
            <div className="flex min-w-0 flex-col gap-0.5 sm:col-span-2">
              <dt className={labelClassName}>
                <Trans>Decided by</Trans>
              </dt>
              <dd className="m-0 min-w-0 wrap-anywhere">{view.reason}</dd>
            </div>
            {view.contactSource === undefined ? null : (
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className={labelClassName}>
                  <Trans>Source written on the contact</Trans>
                </dt>
                <dd className="m-0 min-w-0 wrap-anywhere">
                  {view.contactSource === null ? (
                    <Trans>None: this form writes no source.</Trans>
                  ) : (
                    <>
                      <span className="font-medium">{view.contactSource}</span>{' '}
                      <span className="text-muted-foreground">
                        <Trans>(only if the contact has none yet)</Trans>
                      </span>
                    </>
                  )}
                </dd>
              </div>
            )}
            {view.tags === undefined ? null : (
              <div className="flex min-w-0 flex-col gap-1">
                <dt className={labelClassName}>
                  <Trans>Tags added</Trans>
                </dt>
                <dd className="m-0 min-w-0">
                  {view.tags.length === 0 ? (
                    <Trans>None</Trans>
                  ) : (
                    <ul className="flex min-w-0 list-none flex-wrap gap-1.5 p-0">
                      {view.tags.map((tag) => (
                        <li
                          key={tag.name}
                          className="max-w-full min-w-0 rounded-full bg-secondary px-2.5 py-1 text-sm font-medium wrap-anywhere"
                        >
                          {tag.name}
                          {tag.madeOnFirstUse ? (
                            <span className="font-normal text-muted-foreground">
                              {' '}
                              <Trans>(made by the first such lead)</Trans>
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>
              </div>
            )}
            {view.clickIds.length === 0 ? null : (
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className={labelClassName}>
                  <Trans>Click ids in the link</Trans>
                </dt>
                <dd className="m-0 min-w-0 wrap-anywhere">
                  {view.clickIds
                    .map((key) => (isClickIdPlatform(key) ? i18n._(platformNames[key]) : key))
                    .join(', ')}
                </dd>
              </div>
            )}
          </dl>
          {view.notes.length === 0 ? null : (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
              {view.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
