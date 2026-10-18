import { createFileRoute, redirect } from '@tanstack/react-router';
import { securityQuery, sessionQuery } from '../auth';
import { AppShell } from '../shell/app-shell';
import { meQuery } from '../workspace';

// Every page of the app, for someone signed in. Anyone else goes to the sign-in page, which
// brings them back here afterwards. Someone whose agency requires two-factor sign-in sets
// it up first, as the API answers them with nothing else until then. Then the shell knows
// where they may work (GET /me).
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.query(sessionQuery);
    if (session === null) {
      throw redirect({ to: '/sign-in', search: { next: location.href } });
    }
    if (
      session.user.twoFactorEnabled !== true &&
      (await context.queryClient.query(securityQuery)).twoFactorRequired
    ) {
      throw redirect({ to: '/set-up-two-factor', search: { next: location.href } });
    }
    await context.queryClient.query(meQuery);
  },
  component: AppShell,
});
