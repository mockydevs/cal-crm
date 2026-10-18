// What the business switcher is given. Kept in a file of its own because both the button
// (business-switcher.tsx) and the list it loads on demand (business-switcher-menu.tsx)
// need it, and neither may import the other for it.
import type { BusinessSummary, Me } from '@repo/contracts';
import type { ModulePlace } from './modules';

/** A business's pages that every business has, so switching business can stay on one. */
export type BusinessSection = ModulePlace;

export interface BusinessSwitcherProps {
  readonly me: Me;
  /** The business the page is in; none at the agency, or on a page outside any business. */
  readonly business: BusinessSummary | undefined;
  /** Where another business opens: the section this page is in. */
  readonly section: BusinessSection;
  readonly atAgency: boolean;
}
