import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { lazy, Suspense, useEffect } from 'react';
import { startEmbeddedPage } from '../public-booking-embed';
import { loadBookingWords } from '../public-booking-words';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/book/$agencySlug/$businessSlug/$calendarSlug');

// Public sibling of the signed-in _app layout; params follow TanStack's file routing.
// https://tanstack.com/router/latest/docs/framework/react/guide/path-params
export const Route = createFileRoute('/book/$agencySlug/$businessSlug/$calendarSlug')({
  component: BookingRoute,
});

// The page's words are a catalog of their own, fetched beside it (lingui.config.ts): the
// page is shown once both have arrived.
const PublicBookingPage = lazy(async () => {
  const [booking] = await Promise.all([import('../public-booking'), loadBookingWords()]);
  return { default: booking.PublicBookingPage };
});

function BookingRoute() {
  // On a website, in a frame: tells the website's script how tall the page is.
  useEffect(() => startEmbeddedPage(window, document), []);
  return (
    <Suspense fallback={null}>
      <PublicBookingPage params={route.useParams()} />
    </Suspense>
  );
}
