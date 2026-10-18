import { useLingui } from '@lingui/react/macro';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useEffect, type ReactElement, type ReactNode } from 'react';
import { meQuery, useBusinessInAddress } from '../workspace';

export interface PageProps {
  readonly title: string;
  /** Beside the heading, such as the button that adds the page's first item. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}

/** Names the browser tab: the title, then where it is. */
function useDocumentTitle(title: string, place: string): void {
  const { t } = useLingui();
  const documentTitle = t`${title} · ${place}`;

  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);
}

/** A page's heading, which also names the browser tab: the title, then where it is. */
export function NamedPage({
  title,
  place,
  actions,
  children,
}: PageProps & { readonly place: string }): ReactElement {
  useDocumentTitle(title, place);

  const heading = <h1 className="text-[30px] leading-tight font-semibold">{title}</h1>;
  return (
    <>
      {actions === undefined ? (
        heading
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
          {heading}
          {actions}
        </div>
      )}
      {children}
    </>
  );
}

/**
 * A page of the app, for someone signed in. Its tab is named after the business it's in,
 * so tabs open in different businesses tell themselves apart, or else the agency.
 */
export function Page(props: PageProps): ReactElement {
  const agency = useSuspenseQuery(meQuery).data.agency.name;
  const place = useBusinessInAddress()?.name ?? agency;
  return <NamedPage {...props} place={place} />;
}

/**
 * Names the browser tab as Page does, for a page that lays out its own heading: the
 * contact page has it in its left pane.
 */
export function usePageTitle(title: string): void {
  const agency = useSuspenseQuery(meQuery).data.agency.name;
  const place = useBusinessInAddress()?.name ?? agency;
  useDocumentTitle(title, place);
}
