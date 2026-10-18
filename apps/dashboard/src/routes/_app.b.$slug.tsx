import { createFileRoute, getRouteApi, notFound, Outlet } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useRealtime } from '../realtime';
import { NotFound } from '../shell/not-found';
import { SoftphoneProvider } from '../softphone';
import { meQuery } from '../workspace';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug');

// A business's pages. Its address names it by slug; it's found among the businesses the
// person may enter (GET /me), and pages read it with useBusiness(). Any other slug, of a
// business they may not enter or of none, shows the not-found page.
export const Route = createFileRoute('/_app/b/$slug')({
  beforeLoad: async ({ context, params }) => {
    const me = await context.queryClient.query(meQuery);
    const business = me.businesses.find((candidate) => candidate.slug === params.slug);
    if (business === undefined) throw notFound();
    return { business };
  },
  component: BusinessPages,
  notFoundComponent: NotFound,
});

/**
 * The pages, mounted afresh for each business. Otherwise a page would stay mounted across
 * a switch: a half-written form would be saved in the next business, and a change still on
 * its way would take on the next business's options, which a paused one would then send.
 */
function BusinessPages(): ReactElement {
  const { business } = route.useRouteContext();
  useRealtime(business.id);
  return (
    <SoftphoneProvider businessId={business.id}>
      <Outlet key={business.id} />
    </SoftphoneProvider>
  );
}
