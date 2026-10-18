import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Field, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link, redirect, useNavigate } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import {
  AuthError,
  sendSignInLink,
  sessionQuery,
  signInWithPasskey,
  signInWithPassword,
} from '../auth';
import { safeNext, SignInLayout } from '../shell/sign-in-layout';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/sign-in');

export interface SignInSearch {
  /** Where to go once signed in. */
  readonly next?: string;
  /** Set by a magic link that was used or ran out. */
  readonly error?: string;
}

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>): SignInSearch => ({
    ...(typeof search['next'] === 'string' ? { next: search['next'] } : {}),
    ...(typeof search['error'] === 'string' ? { error: search['error'] } : {}),
  }),
  beforeLoad: async ({ context, search }) => {
    if ((await context.queryClient.query(sessionQuery)) !== null) {
      throw redirect({ href: safeNext(search.next), replace: true });
    }
  },
  component: SignInPage,
});

type Problem =
  | 'mismatch'
  | 'too_many'
  | 'email_needed'
  | 'passkey_unverified'
  | 'passkey_unknown'
  | 'unexpected';

/** The browser's answer when someone closes its passkey prompt (WebAuthn's NotAllowedError). */
const cancelled = (caught: unknown): boolean =>
  caught instanceof Error && (caught.name === 'NotAllowedError' || caught.name === 'AbortError');

function SignInPage(): ReactElement {
  const { t } = useLingui();
  const { next, error } = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState<Problem>();
  const [linkSentTo, setLinkSentTo] = useState<string>();

  const failed = (caught: unknown): void => {
    if (caught instanceof AuthError && caught.code === 'USER_NOT_VERIFIED') {
      setProblem('passkey_unverified');
    } else if (caught instanceof AuthError && caught.code === 'PASSKEY_NOT_FOUND') {
      setProblem('passkey_unknown');
    } else if (caught instanceof AuthError && caught.status === 401) setProblem('mismatch');
    else if (caught instanceof AuthError && caught.status === 429) setProblem('too_many');
    else setProblem('unexpected');
  };

  // Signed in: they start afresh, as nothing cached for whoever this tab had before is theirs.
  const enter = async (): Promise<void> => {
    queryClient.clear();
    await navigate({ href: safeNext(next), replace: true });
  };

  const signIn = useMutation({
    mutationFn: (values: { email: string; password: string }) =>
      signInWithPassword(values.email, values.password),
    onSuccess: async ({ codeNeeded }) => {
      if (codeNeeded) {
        await navigate({ to: '/sign-in/two-factor', search: { next: safeNext(next) } });
        return;
      }
      await enter();
    },
    onError: failed,
  });
  const passkey = useMutation({
    mutationFn: signInWithPasskey,
    onSuccess: enter,
    onError: (caught) => {
      if (!cancelled(caught)) failed(caught);
    },
  });
  const sendLink = useMutation({
    mutationFn: (address: string) => sendSignInLink(address, safeNext(next)),
    onSuccess: (_data, address) => {
      setLinkSentTo(address);
    },
    onError: failed,
  });

  const messages: Record<Problem, string> = {
    mismatch: t`That email and password don't match.`,
    too_many: t`Too many attempts. Wait a few minutes, then try again.`,
    email_needed: t`Enter your email address first, so we know where to send the link.`,
    passkey_unverified: t`Use a passkey that asks for your PIN, fingerprint or face.`,
    passkey_unknown: t`That passkey isn't one you've added here. Sign in another way, then add it in Settings.`,
    unexpected: t`We couldn't reach the server. Check your connection and try again.`,
  };

  return (
    <SignInLayout title={t`Sign in`}>
      {error === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          <Trans>That sign-in link has run out or was already used. Ask for a new one below.</Trans>
        </p>
      )}
      {linkSentTo === undefined ? (
        <Form<Record<string, unknown>>
          onFormSubmit={(values) => {
            setProblem(undefined);
            signIn.mutate({
              email: typeof values['email'] === 'string' ? values['email'] : '',
              password: typeof values['password'] === 'string' ? values['password'] : '',
            });
          }}
        >
          <Field name="email">
            <FieldLabel>
              <Trans>Email</Trans>
            </FieldLabel>
            <Input
              type="email"
              autoComplete="username"
              required
              value={email}
              onValueChange={setEmail}
            />
            <FieldError />
          </Field>
          <Field name="password">
            <FieldLabel>
              <Trans>Password</Trans>
            </FieldLabel>
            <Input type="password" autoComplete="current-password" required />
            <FieldError />
          </Field>
          {problem === undefined ? null : (
            <p role="alert" className="text-sm font-medium text-destructive">
              {messages[problem]}
            </p>
          )}
          <Button type="submit" disabled={signIn.isPending}>
            <Trans>Sign in</Trans>
          </Button>
          <Button
            variant="secondary"
            disabled={sendLink.isPending}
            onClick={() => {
              setProblem(undefined);
              if (email.trim() === '') setProblem('email_needed');
              else sendLink.mutate(email.trim());
            }}
          >
            <Trans>Email me a sign-in link instead</Trans>
          </Button>
          <Button
            variant="secondary"
            disabled={passkey.isPending}
            onClick={() => {
              setProblem(undefined);
              passkey.mutate();
            }}
          >
            <Trans>Sign in with a passkey</Trans>
          </Button>
          <Link to="/forgot-password" className="self-start text-sm text-link underline">
            <Trans>Forgot your password?</Trans>
          </Link>
        </Form>
      ) : (
        <div role="status" className="flex flex-col gap-3">
          <p className="text-md leading-normal">
            <Trans>
              Check your email. If {linkSentTo} has an account here, we've sent it a link that signs
              you in. It works once, within 15 minutes.
            </Trans>
          </p>
          <Button
            variant="secondary"
            className="self-start"
            onClick={() => {
              setLinkSentTo(undefined);
            }}
          >
            <Trans>Back to signing in</Trans>
          </Button>
        </div>
      )}
    </SignInLayout>
  );
}
