import { useLingui } from '@lingui/react/macro';
import { AuthError } from '../auth';

/**
 * What to say when changing someone's second factor is refused: a wrong password, a sign-in
 * too long ago (someone without a password must have signed in within the last 15 minutes),
 * or a server that couldn't be reached.
 */
export function useFactorChangeProblem(): (caught: unknown) => string {
  const { t } = useLingui();
  return (caught) => {
    if (caught instanceof AuthError && caught.code === 'INVALID_PASSWORD') {
      return t`That isn't your password.`;
    }
    if (caught instanceof AuthError && caught.code === 'SIGN_IN_AGAIN') {
      return t`For your safety, sign out and sign in again first: it's been more than 15 minutes since you signed in.`;
    }
    return t`We couldn't reach the server. Check your connection and try again.`;
  };
}
