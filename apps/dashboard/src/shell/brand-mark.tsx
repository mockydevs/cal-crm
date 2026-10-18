import type { ReactElement } from 'react';

/** The default mark, in the agency's accent. A logo upload replaces it. */
export function BrandMark(): ReactElement {
  return (
    <svg width="34" height="34" viewBox="0 0 30 30" aria-hidden className="shrink-0">
      <rect width="30" height="30" rx="15" className="fill-primary" />
      <path
        d="M8 18.5c2.6-5.6 8.4-8 13-5.6-3.2-.2-5.7 1.6-6.8 4.6"
        fill="none"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-primary-foreground"
      />
    </svg>
  );
}
