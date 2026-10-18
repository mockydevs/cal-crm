import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Field, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { acceptInvitation, AuthError, checkInvitation, sessionQuery, signOut } from '../auth';
import { SignInLayout } from '../shell/sign-in-layout';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/accept-invitation');

export const Route = createFileRoute('/accept-invitation')({
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search['token'] === 'string' ? { token: search['token'] } : {},
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: async ({ context, deps }) => {
    const [link, session] = await Promise.all([
      checkInvitation(deps.token ?? ''),
      context.queryClient.query(sessionQuery),
    ]);
    return { link, session };
  },
  component: AcceptInvitationPage,
});

function AcceptInvitationPage(): ReactElement {
  const { t } = useLingui();
  const { token } = route.useSearch();
  const { link, session } = route.useLoaderData();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [spent, setSpent] = useState(false);
  const [problem, setProblem] = useState<string>();
  const accept = useMutation({
    mutationFn: (details: { name?: string; password?: string }) =>
      acceptInvitation({ token: token ?? '', email: link.valid ? link.email : '', ...details }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await navigate({ to: '/', replace: true });
    },
    onError: (error) => {
      if (error instanceof AuthError && error.code === 'INVALID_INVITATION') setSpent(true);
      else if (error instanceof AuthError && error.code === 'SIGN_IN_REQUIRED')
        setProblem(t`Sign in with the invited email address, then open this invitation again.`);
      else if (error instanceof AuthError && error.status === 403)
        setProblem(t`This account cannot accept the invitation. Ask your admin for help.`);
      else
        setProblem(t`The invitation could not be accepted. Check your connection and try again.`);
    },
  });
  const leave = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
      // An account that exists signs in, then comes back here. A new one is made here.
      await (link.valid && link.existingAccount
        ? navigate({
            to: '/sign-in',
            search: {
              next: `/accept-invitation?${new URLSearchParams({ token: token ?? '' }).toString()}`,
            },
          })
        : navigate({ to: '/accept-invitation', search: { token: token ?? '' }, replace: true }));
    },
  });
  if (!link.valid || spent)
    return (
      <SignInLayout title={t`This invitation has run out`}>
        <p role="alert" className="text-md">
          <Trans>
            An invitation works once, within seven days. Ask an owner or admin to send a new
            invitation.
          </Trans>
        </p>
      </SignInLayout>
    );
  const matches = session?.user.email.toLowerCase() === link.email.toLowerCase();
  const email = link.email;
  const mustSignIn = link.existingAccount && !matches;
  return (
    <SignInLayout title={t`Join your team`}>
      <p className="text-md break-all">
        <Trans>This invitation is for {email}.</Trans>
      </p>
      {mustSignIn || (session !== null && !matches) ? (
        <>
          <p className="text-sm text-muted-foreground">
            {link.existingAccount ? (
              <Trans>
                Sign in with this email address to accept. Your existing password stays the same.
              </Trans>
            ) : (
              <Trans>
                You’re signed in as someone else. Sign out, then make the account for this email
                address here.
              </Trans>
            )}
          </p>
          {session === null ? (
            <Link
              to="/sign-in"
              search={{
                next: `/accept-invitation?${new URLSearchParams({ token: token ?? '' }).toString()}`,
              }}
              className="font-medium underline"
            >
              <Trans>Sign in to accept</Trans>
            </Link>
          ) : (
            <Button
              disabled={leave.isPending}
              onClick={() => {
                leave.mutate();
              }}
            >
              {link.existingAccount ? (
                <Trans>Sign out and use the invited account</Trans>
              ) : (
                <Trans>Sign out to create the invited account</Trans>
              )}
            </Button>
          )}
          {leave.isError ? (
            <p role="alert">
              <Trans>We couldn't sign you out. Check your connection and try again.</Trans>
            </p>
          ) : null}
        </>
      ) : (
        <Form<Record<string, unknown>>
          onFormSubmit={(values) => {
            setProblem(undefined);
            const name = values['name'];
            const password = values['password'];
            accept.mutate(
              link.existingAccount
                ? {}
                : {
                    name: typeof name === 'string' ? name : '',
                    password: typeof password === 'string' ? password : '',
                  },
            );
          }}
        >
          {link.existingAccount ? null : (
            <>
              <Field name="name">
                <FieldLabel>
                  <Trans>Your name</Trans>
                </FieldLabel>
                <Input autoComplete="name" required maxLength={200} />
                <FieldError />
              </Field>
              <Field name="password">
                <FieldLabel>
                  <Trans>Password</Trans>
                </FieldLabel>
                <Input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={128}
                />
                <FieldError />
              </Field>
            </>
          )}
          {problem === undefined ? null : (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <Button type="submit" disabled={accept.isPending}>
            <Trans>Accept invitation</Trans>
          </Button>
        </Form>
      )}
    </SignInLayout>
  );
}
