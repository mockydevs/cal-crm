import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { AuthError, resetPassword } from '../auth';
import { SignInLayout } from '../shell/sign-in-layout';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/reset-password');

export interface ResetSearch {
  /** From the emailed link, through Better Auth, which checked it first. */
  readonly token?: string;
  /** Set instead when the link was used or ran out. */
  readonly error?: string;
}

export const Route = createFileRoute('/reset-password')({
  validateSearch: (search: Record<string, unknown>): ResetSearch => ({
    ...(typeof search['token'] === 'string' ? { token: search['token'] } : {}),
    ...(typeof search['error'] === 'string' ? { error: search['error'] } : {}),
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage(): ReactElement {
  const { t } = useLingui();
  const { token, error } = route.useSearch();
  const [spent, setSpent] = useState(false);
  const [problem, setProblem] = useState<string>();

  const reset = useMutation({
    mutationFn: (newPassword: string) => resetPassword(token ?? '', newPassword),
    onError: (caught) => {
      if (caught instanceof AuthError && caught.code === 'INVALID_TOKEN') setSpent(true);
      else if (caught instanceof AuthError && caught.code === 'PASSWORD_TOO_SHORT') {
        setProblem(t`Use 8 characters or more.`);
      } else if (caught instanceof AuthError && caught.code === 'PASSWORD_TOO_LONG') {
        setProblem(t`Use 128 characters or fewer.`);
      } else setProblem(t`We couldn't reach the server. Check your connection and try again.`);
    },
  });

  if (token === undefined || error !== undefined || spent) {
    return (
      <SignInLayout title={t`This link has run out`}>
        <p role="alert" className="text-md leading-normal">
          <Trans>
            A link to reset your password works once, within an hour, and stops working when your
            password changes.
          </Trans>
        </p>
        <Link to="/forgot-password" className="self-start text-sm text-link underline">
          <Trans>Ask for a new link</Trans>
        </Link>
      </SignInLayout>
    );
  }

  if (reset.isSuccess) {
    return (
      <SignInLayout title={t`Your password is changed`}>
        <p role="status" className="text-md leading-normal">
          <Trans>You're signed out everywhere else. Sign in with your new password.</Trans>
        </p>
        <Link to="/sign-in" className="self-start text-sm text-link underline">
          <Trans>Sign in</Trans>
        </Link>
      </SignInLayout>
    );
  }

  return (
    <SignInLayout title={t`Choose a new password`}>
      <Form<Record<string, unknown>>
        onFormSubmit={(values) => {
          setProblem(undefined);
          reset.mutate(typeof values['password'] === 'string' ? values['password'] : '');
        }}
      >
        <Field name="password">
          <FieldLabel>
            <Trans>New password</Trans>
          </FieldLabel>
          <Input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={128}
          />
          <FieldDescription>
            <Trans>8 characters or more. A few unrelated words make a strong one.</Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        {problem === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem}
          </p>
        )}
        <Button type="submit" disabled={reset.isPending}>
          <Trans>Save the new password</Trans>
        </Button>
      </Form>
    </SignInLayout>
  );
}
