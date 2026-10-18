// The two tabs of a Send email action's panel, as GoHighLevel's: "Edit action" and
// "Statistics". Shown for an action that is in the draft, since only such a one has sent
// anything to count.
//
// Its words are in the email catalog (lingui.config.ts, email-words.ts).
import { useLingui } from '@lingui/react/macro';
import type { ReactElement } from 'react';

export type EmailTab = 'edit' | 'statistics';

export default function EmailTabs({
  label,
  tab,
  onTab,
}: {
  /** What the tabs are of: the action's kind. */
  readonly label: string;
  readonly tab: EmailTab;
  readonly onTab: (tab: EmailTab) => void;
}): ReactElement {
  const { t } = useLingui();
  const names: Readonly<Record<EmailTab, string>> = {
    edit: t`Edit action`,
    statistics: t`Statistics`,
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex self-start rounded-lg bg-muted p-1"
    >
      {(['edit', 'statistics'] as const).map((each) => (
        <button
          key={each}
          type="button"
          role="tab"
          aria-selected={tab === each}
          tabIndex={tab === each ? 0 : -1}
          className="inline-flex min-h-11 items-center rounded-control px-3 text-[13px] font-medium text-body -outline-offset-2 hover:text-foreground aria-selected:bg-card aria-selected:text-link aria-selected:shadow-[0_1px_2px_rgb(16_24_40/0.05)] lg:min-h-7"
          onClick={() => {
            onTab(each);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
            onTab(each === 'edit' ? 'statistics' : 'edit');
            const other =
              event.currentTarget.nextElementSibling ?? event.currentTarget.previousElementSibling;
            if (other instanceof HTMLElement) other.focus();
          }}
        >
          {names[each]}
        </button>
      ))}
    </div>
  );
}
