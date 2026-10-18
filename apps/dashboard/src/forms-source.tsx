// The Source a form writes on the contact it reaches, on the card "When someone sends the
// form": one of four choices, each said in a sentence; whether the lead source's tag is
// added as well; the rule that holds whatever is chosen; and the names "how they arrived"
// can be, which are the API's own list (leadSourceKeys), so the card never names one the
// server does not write.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  contactAttributeLimits,
  LEAD_SOURCE_LIMITS,
  leadSourceKeys,
  leadSourceLabels,
  leadSourceRuleDescriptions,
  type FormContactActions,
} from '@repo/contracts';
import { Input } from '@repo/ui/components/input';
import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useId, useState, type ReactElement } from 'react';
import {
  sourceModeOf,
  sourceModes,
  sourceTagExample,
  sourceTagFits,
  sourceTextOf,
  withSourceMode,
  withSourceText,
  withTagBySource,
  type SourceMode,
} from './forms-source-rules';

export function FormSourceChoice({
  actions,
  formName,
  slug,
  onChange,
}: {
  readonly actions: FormContactActions;
  /** The business in the address: names the way to its own lead source rules. */
  readonly slug: string;
  /** The form's name as it is typed, for the choice that writes it. */
  readonly formName: string;
  readonly onChange: (next: FormContactActions) => void;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const mode = sourceModeOf(actions);
  // A name typed and then left for another choice comes back with the choice.
  const [typed, setTyped] = useState(() => sourceTextOf(actions));
  const [namesOpen, setNamesOpen] = useState(false);
  const { google_ads: paid, facebook: social, organic_search: search } = leadSourceLabels;
  const name = formName.trim();
  const choices: Readonly<Record<SourceMode, { readonly label: string; readonly says: string }>> = {
    arrived: {
      label: t`From how they arrived (recommended)`,
      says: t`${paid}, ${social}, ${search} and so on, worked out for each person from the link they followed and the site they came from.`,
    },
    text: {
      label: t`A name I write`,
      says: t`The same name for everyone who sends this form, whatever link they followed.`,
    },
    form_name: {
      label: t`The name of this form`,
      says:
        name === ''
          ? t`The form's name, for everyone who sends it.`
          : t`“${name}” for everyone who sends this form.`,
    },
    none: {
      label: t`Leave it empty`,
      says: t`This form writes no source on the contact.`,
    },
  };
  const example = sourceTagExample(paid);
  const most = LEAD_SOURCE_LIMITS.tagsPerSubmission;
  const Chevron = namesOpen ? ChevronUp : ChevronDown;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p id={`${id}-label`} className="text-sm font-medium">
        <Trans>Source written on the contact</Trans>
      </p>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        className="grid min-w-0 gap-2 sm:grid-cols-2"
      >
        {sourceModes.map((each) => (
          <div
            key={each}
            className="flex min-w-0 flex-col gap-1 rounded-lg border border-border px-3 py-2 has-checked:border-primary"
          >
            <label className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm font-medium">
              <input
                type="radio"
                name={`${id}-source`}
                className="size-4 shrink-0 accent-primary"
                aria-describedby={`${id}-${each}`}
                checked={mode === each}
                onChange={() => {
                  onChange(withSourceMode(actions, each, typed));
                }}
              />
              {choices[each].label}
            </label>
            <p id={`${id}-${each}`} className="pl-[26px] text-sm text-muted-foreground">
              {choices[each].says}
            </p>
            {each === 'text' && mode === 'text' ? (
              <div className="pt-1 pl-[26px]">
                <Input
                  aria-label={t`Source to write`}
                  placeholder={t`Such as Trade fair 2026`}
                  value={sourceTextOf(actions)}
                  maxLength={contactAttributeLimits.source}
                  onValueChange={(text) => {
                    setTyped(text);
                    onChange(withSourceText(actions, text));
                  }}
                />
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium lg:min-h-9">
        <input
          type="checkbox"
          role="switch"
          className="size-5 shrink-0 accent-primary"
          aria-describedby={`${id}-tag`}
          checked={actions.tagBySource}
          onChange={(event) => {
            onChange(withTagBySource(actions, event.target.checked));
          }}
        />
        <Trans>Also tag by source</Trans>
      </label>
      <p id={`${id}-tag`} className="-mt-1.5 pl-8 text-sm text-muted-foreground">
        {t`Adds one tag for how each person arrived, such as “${example}”. A tag is made the first time it is needed.`}
        {actions.tagBySource && !sourceTagFits(actions) ? (
          <>
            {' '}
            <span className="font-medium text-foreground">
              {t`This form already adds ${most} tags of its own, the most one submission adds, so this tag would be left out. Remove one to make room.`}
            </span>
          </>
        ) : null}
      </p>
      <p className="text-sm text-muted-foreground">
        <Trans>A contact who already has a source keeps it; tags are always added.</Trans>
      </p>
      <p className="text-sm text-muted-foreground">
        <Trans>
          Rules of your own, for every form at once, are in Settings:{' '}
          <Link
            to="/b/$slug/settings/lead-sources"
            params={{ slug }}
            className="rounded-control font-medium text-link underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Lead source rules
          </Link>
        </Trans>
      </p>
      <div className="flex min-w-0 flex-col gap-2">
        <button
          type="button"
          aria-expanded={namesOpen}
          aria-controls={namesOpen ? `${id}-names` : undefined}
          className="flex min-h-9 items-center gap-1.5 self-start rounded-control text-sm text-link underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            setNamesOpen((open) => !open);
          }}
        >
          <Trans>The names “how they arrived” can be</Trans>
          <Chevron aria-hidden className="size-4 shrink-0" strokeWidth={2} />
        </button>
        {namesOpen ? (
          <div id={`${id}-names`} className="flex min-w-0 flex-col gap-2 text-sm">
            <p className="text-muted-foreground">
              <Trans>
                Each lead gets one of these names, tried from the top: the first that fits is the
                lead source. It is kept with the contact's attribution whatever this form writes as
                the Source.
              </Trans>
            </p>
            <dl className="grid min-w-0 gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
              {leadSourceKeys.map((key) => (
                <div key={key} className="contents">
                  <dt className="min-w-0 font-medium wrap-anywhere">
                    {key === 'source_param' ? t`The name in the link` : leadSourceLabels[key]}
                  </dt>
                  <dd className="m-0 min-w-0 pb-1 wrap-anywhere text-muted-foreground sm:pb-0">
                    {leadSourceRuleDescriptions[key]}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-muted-foreground">
              <Trans>
                A name a link gives with source= gets its tag only when someone has already made
                that tag.
              </Trans>
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
