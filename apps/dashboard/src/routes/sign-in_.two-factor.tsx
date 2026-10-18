import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Field, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link, redirect, useNavigate } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { AuthError, sessionQuery, verifyCode, verifyRecoveryCode } from '../auth';
import { safeNext, SignInLayout } from '../shell/sign-in-layout';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/sign-in_/two-factor');

export interface TwoFactorSearch {
  /** Where to go once signed in. */
  readonly next?: string;
}

// The second step of signing in, after a password or a sign-in link, for people who also
// use an authenticator app. A cookie from the first step says who's signing in; it lasts
// ten minutes.
export const Route = createFileRoute('/sign-in_/two-factor')({
  validateSearch: (search: Record<string, unknown>): TwoFactorSearch =>
    typeof search['next'] === 'string' ? { next: search['next'] } : {},
  beforeLoad: async ({ context, search }) => {
    if ((await context.queryClient.query(sessionQuery)) !== null) {
      throw redirect({ href: safeNext(search.next), replace: true });
    }
  },
  component: TwoFactorPage,
});

type Problem = 'wrong_code' | 'wrong_recovery_code' | 'start_again' | 'too_many' | 'unexpected';

function TwoFactorPage(): ReactElement {
  const { t } = useLingui();
  const { next } = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [recovery, setRecovery] = useState(false);
  const [problem, setProblem] = useState<Problem>();

  const verify = useMutation({
    mutationFn: (code: string) => (recovery ? verifyRecoveryCode(code) : verifyCode(code)),
    onSuccess: async () => {
      // Signed in: nothing cached for whoever this tab had before is theirs.
      queryClient.clear();
      await navigate({ href: safeNext(next), replace: true });
    },
    onError: (caught) => {
      if (!(caught instanceof AuthError)) setProblem('unexpected');
      else if (caught.code === 'INVALID_CODE') setProblem('wrong_code');
      else if (caught.code === 'INVALID_BACKUP_CODE') setProblem('wrong_recovery_code');
      else if (caught.status === 429) setProblem('too_many');
      // The first step's cookie ran out, or this sign-in had too many wrong codes.
      else if (caught.status === 400 || caught.status === 401) setProblem('start_again');
      else setProblem('unexpected');
    },
  });

  const messages: Record<Problem, string> = {
    wrong_code: t`That code didn't match. Enter the newest code your app shows.`,
    wrong_recovery_code: t`That recovery code didn't match, or it was already used.`,
    start_again: t`Signing in took too long, or had too many wrong codes. Start again.`,
    too_many: t`Too many tries. Wait a few minutes, then try again.`,
    unexpected: t`We couldn't reach the server. Check your connection and try again.`,
  };

  return (
    <SignInLayout title={t`Enter your code`}>
      <Form<Record<string, unknown>>
        onFormSubmit={(values) => {
          setProblem(undefined);
          const code = values['code'];
          verify.mutate(typeof code === 'string' ? code : '');
        }}
      >
        <p className="text-md leading-normal">
          {recovery ? (
            <Trans>
              Enter one of the recovery codes you saved when you set up two-factor sign-in.
            </Trans>
          ) : (
            <Trans>Open your authenticator app and enter the code it shows for this account.</Trans>
          )}
        </p>
        <Field name="code" key={recovery ? 'recovery' : 'app'}>
          <FieldLabel>{recovery ? <Trans>Recovery code</Trans> : <Trans>Code</Trans>}</FieldLabel>
          {recovery ? (
            <Input autoComplete="off" autoCapitalize="off" spellCheck={false} required />
          ) : (
            <Input inputMode="numeric" autoComplete="one-time-code" required />
          )}
          <FieldError />
        </Field>
        {problem === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {messages[problem]}
          </p>
        )}
        <Button type="submit" disabled={verify.isPending}>
          <Trans>Sign in</Trans>
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setProblem(undefined);
            setRecovery(!recovery);
          }}
        >
          {recovery ? (
            <Trans>Use a code from my app instead</Trans>
          ) : (
            <Trans>Use a recovery code instead</Trans>
          )}
        </Button>
        {problem === 'start_again' ? (
          <Link
            to="/sign-in"
            search={next === undefined ? {} : { next }}
            className="self-start text-sm text-link underline"
          >
            <Trans>Back to signing in</Trans>
          </Link>
        ) : null}
      </Form>
    </SignInLayout>
  );
}
