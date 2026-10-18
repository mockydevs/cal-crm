// A list of choices as the browser draws it, with the looks of the kit's fields. The Emails
// pages use it rather than the kit's popup list, which is 9 KB a page would download for a
// handful of options: a route's own code has a budget (scripts/check-budget.mjs).
import { ChevronDown } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

/** A list of choices as the browser draws it, with the looks of the kit's fields. */
export function Select({
  'aria-labelledby': labelledBy,
  id,
  value,
  onValueChange,
  disabled = false,
  className = '',
  children,
  'aria-label': ariaLabel,
}: {
  readonly id?: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
}): ReactElement {
  return (
    <span className={`relative inline-flex min-w-0 ${className === '' ? 'w-full' : className}`}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        className="min-h-11 w-full min-w-0 appearance-none truncate rounded-control border border-input bg-card py-1.5 pr-9 pl-3 text-md text-foreground disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-9"
        onChange={(event) => {
          onValueChange(event.target.value);
        }}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 size-[18px] -translate-y-1/2 text-muted-foreground"
        strokeWidth={1.8}
      />
    </span>
  );
}
