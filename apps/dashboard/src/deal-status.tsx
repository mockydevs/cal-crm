import { useLingui } from '@lingui/react/macro';
import type { Deal } from '@repo/contracts';
import type { ReactElement } from 'react';

const openClassName = 'bg-secondary text-secondary-foreground';
const wonClassName = 'border border-success-line bg-success-subtle text-success';
const lostClassName = 'border border-destructive bg-card text-destructive';

/** The status of an opportunity as a small pill: won in the success colours, lost in the danger one. */
export function DealStatus({ status }: { readonly status: Deal['status'] }): ReactElement {
  const { t } = useLingui();
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${status === 'won' ? wonClassName : status === 'lost' ? lostClassName : openClassName}`}
    >
      {status === 'won' ? t`Won` : status === 'lost' ? t`Lost` : t`Open`}
    </span>
  );
}
