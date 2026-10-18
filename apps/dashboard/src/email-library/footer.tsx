// The foot of an Emails library: how many rows a page holds, which rows show of how many
// ("1 - 50 of 51"), and Previous and Next. The list is a keyset list, so there is one page
// number, the page showing. The same as the other lists' foot (settings-list.tsx), with the
// browser's own list for the page size, so the library page does not bring the kit's.
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import type { ReactElement } from 'react';
import { pageSizes, type PageSize, type Range } from '../settings-rules';
import { Select } from './select';

export function LibraryFooter({
  perPageLabel,
  pageSize,
  onPageSize,
  range,
  number,
  previous,
  next,
  busy,
  onPrevious,
  onNext,
}: {
  /** What the page-size choice is called, such as "Templates per page". */
  readonly perPageLabel: string;
  readonly pageSize: PageSize;
  readonly onPageSize: (size: PageSize) => void;
  readonly range: Range;
  /** The page showing, from 1. */
  readonly number: number;
  readonly previous: boolean;
  readonly next: boolean;
  readonly busy: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}): ReactElement {
  const { t } = useLingui();
  const { from, to, total } = range;
  return (
    <nav
      aria-label={t`Pages`}
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-body"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-muted-foreground">
          {perPageLabel}
        </span>
        <Select
          aria-label={perPageLabel}
          className="w-20"
          value={String(pageSize)}
          onValueChange={(value) => {
            const size = pageSizes.find((each) => String(each) === value);
            if (size !== undefined) onPageSize(size);
          }}
        >
          {pageSizes.map((size) => (
            <option key={size} value={String(size)}>
              {size}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <p role="status" aria-busy={busy} className="tabular-nums">
          <Trans>
            {from} - {to} of {total}
          </Trans>
        </p>
        <Button
          variant="quiet"
          size="small"
          aria-label={t`Previous page`}
          disabled={!previous || busy}
          onClick={onPrevious}
        >
          <Trans>Previous</Trans>
        </Button>
        <span
          aria-hidden
          className="flex size-8 items-center justify-center rounded-control border border-primary font-medium text-link"
        >
          {number}
        </span>
        <Button
          variant="quiet"
          size="small"
          aria-label={t`Next page`}
          disabled={!next || busy}
          onClick={onNext}
        >
          <Trans>Next</Trans>
        </Button>
      </div>
    </nav>
  );
}
