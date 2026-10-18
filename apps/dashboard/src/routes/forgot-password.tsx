import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Field, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { AuthError, sendPasswordReset } from '../auth';
import { SignInLayout } from '../shell/sign-in-layout';

export const Route = createFileRoute('/forgot-password')({ component: ForgotPasswordPage });

function ForgotPasswordPage(): ReactElement {
  const { t } = useLingui();
  const [sentTo, setSentTo] = useState<string>();
  const [problem, setProblem] = useState<string>();

  const send = useMutation({
    mutationFn: (email: string) => sendPasswordReset(email),
    onSuccess: (_data, email) => {
      setSentTo(email);
    },
    onError: (caught) => {
      setProblem(
        caught instanceof AuthError && caught.status === 429
          ? t`Too many requests. Wait a minute, then try again.`
          : t`We couldn't reach the server. Check your connection and try again.`,
      );
    },
  });

  return (
    <SignInLayout title={t`Reset your password`}>
      {sentTo === undefined ? (
        <Form<Record<string, unknown>>
          onFormSubmit={(values) => {
            setProblem(undefined);
            send.mutate(typeof values['email'] === 'string' ? values['email'].trim() : '');
          }}
        >
          <p className="text-md leading-normal text-secondary-foreground">
            <Trans>We'll email you a link to choose a new password.</Trans>
          </p>
          <Field name="email">
            <FieldLabel>
              <Trans>Email</Trans>
            </FieldLabel>
            <Input type="email" autoComplete="username" required />
            <FieldError />
          </Field>
          {problem === undefined ? null : (
            <p role="alert" className="text-sm font-medium text-destructive">
              {problem}
            </p>
          )}
          <Button type="submit" disabled={send.isPending}>
            <Trans>Send the link</Trans>
          </Button>
        </Form>
      ) : (
        <p role="status" className="text-md leading-normal">
          <Trans>
            Check your email. If {sentTo} has an account here, we've sent it a link to choose a new
            password. It works once, within an hour.
          </Trans>
        </p>
      )}
      <Link to="/sign-in" className="self-start text-sm text-link underline">
        <Trans>Back to signing in</Trans>
      </Link>
    </SignInLayout>
  );
}
