import { createFileRoute, redirect } from '@tanstack/react-router';
import { lazy, Suspense, useMemo, type ReactElement } from 'react';
import { apiIn } from '../api';
import { securityQuery, sessionQuery } from '../auth';
import { loadMarketplaceWords } from '../marketplace-words';
import { authorizationRequestOf } from '../oauth-consent-rules';
import { meQuery } from '../workspace';

// Connecting an app: an app sends a person here. Someone signed out signs in and
// comes back to the same address, as the app wrote it; someone whose agency requires
// two-factor sign-in sets it up first, as everywhere else.
export const Route = createFileRoute('/oauth/authorize')({
  beforeLoad: async ({ context }) => {
    const here = `${window.location.pathname}${window.location.search}`;
    const session = await context.queryClient.query(sessionQuery);
    if (session === null) throw redirect({ to: '/sign-in', search: { next: here } });
    if (
      session.user.twoFactorEnabled !== true &&
      (await context.queryClient.query(securityQuery)).twoFactorRequired
    )
      throw redirect({ to: '/set-up-two-factor', search: { next: here } });
  },
  loader: ({ context }) => context.queryClient.query(meQuery),
  component: OAuthAuthorizeRoute,
});

const OAuthConsentPage = lazy(async () => {
  const [page] = await Promise.all([import('../oauth-consent'), loadMarketplaceWords()]);
  return { default: page.OAuthConsentPage };
});

const leave = (url: string) => {
  window.location.assign(url);
};

function OAuthAuthorizeRoute(): ReactElement {
  const me = Route.useLoaderData();
  const request = useMemo(() => authorizationRequestOf(window.location.search), []);
  return (
    <Suspense fallback={null}>
      <OAuthConsentPage
        request={request}
        businesses={me.businesses}
        clientIn={apiIn}
        leave={leave}
      />
    </Suspense>
  );
}
