import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { loadPhoneWords } from '../phone-words';

/** Calls, all of them or, with `?contactId=`, one contact's. */
export const Route = createFileRoute('/_app/b/$slug/calls')({
  validateSearch: (search: Record<string, unknown>): { contactId?: string } =>
    typeof search['contactId'] === 'string' ? { contactId: search['contactId'] } : {},
  component: CallsRoute,
});

const route = getRouteApi('/_app/b/$slug/calls');
const CallsPage = lazy(async () => {
  const [calls] = await Promise.all([import('../calls'), loadPhoneWords()]);
  return { default: calls.CallsPage };
});
function CallsRoute(): ReactElement {
  const { contactId } = route.useSearch();
  return (
    <Suspense fallback={null}>
      <CallsPage contactId={contactId} />
    </Suspense>
  );
}
