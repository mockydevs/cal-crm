// "Remember how visitors arrived" in a site's Settings (the arrival kept across a funnel):
// whether the site's pages keep, in the visitor's own browser tab, the address of the first
// page they opened and the site they came from, so a form on a later step or a booking is
// still named after the ad. Three answers, each said in one sentence. It is part of the
// site's settings form and saved with it; fetched apart from the Settings tab, whose own
// code is at its budget (scripts/check-budget.mjs).
import { Trans, useLingui } from '@lingui/react/macro';
import type { SiteKeepArrival } from '@repo/contracts';
import { useId, type ReactElement } from 'react';
import { keepArrivalChoices } from './sites-rules';

export default function SiteArrivalSetting({
  value,
  disabled,
  onChange,
}: {
  readonly value: SiteKeepArrival;
  readonly disabled: boolean;
  readonly onChange: (next: SiteKeepArrival) => void;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const choices: Readonly<
    Record<SiteKeepArrival, { readonly label: string; readonly says: string }>
  > = {
    unless_opted_out: {
      label: t`Yes, unless their browser asks us not to (recommended)`,
      says: t`A visitor whose browser sends the Global Privacy Control signal is left alone: nothing is kept, and their lead is named from the page they send it on.`,
    },
    always: {
      label: t`Yes, always`,
      says: t`Kept for every visitor, whatever privacy signal their browser sends.`,
    },
    never: {
      label: t`No`,
      says: t`Nothing is kept. A form on a later page, or a booking, is named from its own page, which often reads as Direct.`,
    },
  };
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-4">
      <h2 id={`${id}-title`} className="text-base font-medium">
        <Trans>Remember how visitors arrived</Trans>
      </h2>
      <p id={`${id}-what`} className="text-sm text-muted-foreground">
        <Trans>
          A visitor often lands on one page and sends the form, or books, on another. When this is
          on, the address of the first page they opened and the site they came from are kept in
          their own browser tab until the tab is closed, so the lead is still named after the ad. No
          cookie is set, and nothing is sent to us before they send a form or book.
        </Trans>
      </p>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-what`}
        className="grid min-w-0 gap-2 lg:grid-cols-3"
      >
        {keepArrivalChoices.map((each) => (
          <div
            key={each}
            className="flex min-w-0 flex-col gap-1 rounded-lg border border-border px-3 py-2 has-checked:border-primary"
          >
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium lg:min-h-9">
              <input
                type="radio"
                name={`${id}-keep`}
                className="size-4 shrink-0 accent-primary"
                aria-describedby={`${id}-${each}`}
                disabled={disabled}
                checked={value === each}
                onChange={() => {
                  onChange(each);
                }}
              />
              {choices[each].label}
            </label>
            <p id={`${id}-${each}`} className="pl-[26px] text-sm text-muted-foreground">
              {choices[each].says}
            </p>
          </div>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        <Trans>
          Only a site with a published form, or a calendar that can be booked, loads anything for
          this. This is not legal advice: whether your business must honour a browser's privacy
          signal, and what your privacy notice must say, are questions for your counsel.
        </Trans>
      </p>
    </section>
  );
}
