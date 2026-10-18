import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { loadBookingWords } from '../public-booking-words';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/appointments/manage/$token');

export const Route = createFileRoute('/appointments/manage/$token')({
  component: AppointmentRoute,
});

// The page's words are a catalog of their own, fetched beside it (lingui.config.ts): the
// page is shown once both have arrived.
const PublicAppointmentPage = lazy(async () => {
  const [booking] = await Promise.all([import('../public-booking'), loadBookingWords()]);
  return { default: booking.PublicAppointmentPage };
});

function AppointmentRoute() {
  return (
    <Suspense fallback={null}>
      <PublicAppointmentPage token={route.useParams().token} />
    </Suspense>
  );
}
