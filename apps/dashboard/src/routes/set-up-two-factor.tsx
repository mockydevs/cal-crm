import { Trans, useLingui } from '@lingui/react/macro';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, redirect, useNavigate } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { securityQuery, sessionQuery } from '../auth';
import { TwoFactorSetUpFlow } from '../security/two-factor-set-up';
import { safeNext, SignInLayout } from '../shell/sign-in-layout';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/set-up-two-factor');

export interface SetUpSearch {
  /** Where to go once it's set up. */
  readonly next?: string;
}

// Where the app sends someone whose agency requires two-factor sign-in until they've set
// it up (the _app route's guard). Nothing else answers them before then.
export const Route = createFileRoute('/set-up-two-factor')({
  validateSearch: (search: Record<string, unknown>): SetUpSearch =>
    typeof search['next'] === 'string' ? { next: search['next'] } : {},
  beforeLoad: async ({ context, location, search }) => {
    const session = await context.queryClient.query(sessionQuery);
    if (session === null) {
      throw redirect({ to: '/sign-in', search: { next: location.href } });
    } else if (session.user.twoFactorEnabled === true) {
      throw redirect({ href: safeNext(search.next), replace: true });
    }
  },
  loader: ({ context }) => context.queryClient.query(securityQuery),
  component: SetUpPage,
});

function SetUpPage(): ReactElement {
  const { t } = useLingui();
  const { next } = route.useSearch();
  const navigate = useNavigate();
  const { data: security } = useSuspenseQuery(securityQuery);

  return (
    <SignInLayout title={t`Set up two-factor sign-in`}>
      <p className="text-md leading-normal">
        <Trans>
          Your agency asks everyone on its team to sign in with a code from an authenticator app as
          well as their password or a sign-in link. It takes a minute.
        </Trans>
      </p>
      <TwoFactorSetUpFlow
        hasPassword={security.hasPassword}
        onDone={() => {
          void navigate({ href: safeNext(next), replace: true });
        }}
      />
    </SignInLayout>
  );
}
