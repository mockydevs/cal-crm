import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, redirect, useNavigate } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { AuthError, checkSetupLink, sessionQuery, setUpFirstAdmin } from '../auth';
import { SignInLayout } from '../shell/sign-in-layout';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/setup');

export interface SetupSearch {
  /** From the one-time link the app printed as it started. */
  readonly token?: string;
}

// The first start: the app prints a one-time link while nobody runs the agency, and this
// page uses it to create the first admin, who's then signed in.
export const Route = createFileRoute('/setup')({
  validateSearch: (search: Record<string, unknown>): SetupSearch =>
    typeof search['token'] === 'string' ? { token: search['token'] } : {},
  beforeLoad: async ({ context }) => {
    if ((await context.queryClient.query(sessionQuery)) !== null) {
      redirect({ to: '/', replace: true, throw: true });
    }
  },
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: ({ deps }) => (deps.token === undefined ? false : checkSetupLink(deps.token)),
  component: SetupPage,
});

const text = (values: Record<string, unknown>, name: string): string => {
  const value = values[name];
  return typeof value === 'string' ? value : '';
};

function SetupPage(): ReactElement {
  const { t } = useLingui();
  const { token } = route.useSearch();
  const valid = route.useLoaderData();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [spent, setSpent] = useState(false);
  const [problem, setProblem] = useState<string>();

  const create = useMutation({
    mutationFn: (details: { name: string; email: string; password: string }) =>
      setUpFirstAdmin({ token: token ?? '', ...details }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
      await navigate({ to: '/', replace: true });
    },
    onError: (caught) => {
      const code = caught instanceof AuthError ? caught.code : undefined;
      if (code === 'INVALID_TOKEN' || code === 'SETUP_DONE') setSpent(true);
      else if (code === 'PASSWORD_TOO_SHORT') setProblem(t`Use 8 characters or more.`);
      else if (code === 'PASSWORD_TOO_LONG') setProblem(t`Use 128 characters or fewer.`);
      else if (code === 'EMAIL_TAKEN') setProblem(t`Someone already uses this email address.`);
      else setProblem(t`We couldn't reach the server. Check your connection and try again.`);
    },
  });

  if (!valid || spent) {
    return (
      <SignInLayout title={t`This setup link has run out`}>
        <p role="alert" className="text-md leading-normal">
          <Trans>
            A setup link works once, within 24 hours, and none works once the first admin exists. If
            nobody runs the agency yet, restart the app: it prints a new link in its log each time
            it starts.
          </Trans>
        </p>
      </SignInLayout>
    );
  }

  return (
    <SignInLayout title={t`Create the first admin`}>
      <p className="text-md leading-normal">
        <Trans>
          You'll run the agency in this CRM: you can invite your team and set everything up once
          you're in.
        </Trans>
      </p>
      <Form<Record<string, unknown>>
        onFormSubmit={(values) => {
          setProblem(undefined);
          create.mutate({
            name: text(values, 'name'),
            email: text(values, 'email'),
            password: text(values, 'password'),
          });
        }}
      >
        <Field name="name">
          <FieldLabel>
            <Trans>Your name</Trans>
          </FieldLabel>
          <Input autoComplete="name" required maxLength={200} />
          <FieldError />
        </Field>
        <Field name="email">
          <FieldLabel>
            <Trans>Email</Trans>
          </FieldLabel>
          <Input type="email" autoComplete="username" required />
          <FieldError />
        </Field>
        <Field name="password">
          <FieldLabel>
            <Trans>Password</Trans>
          </FieldLabel>
          <Input type="password" autoComplete="new-password" required minLength={8} />
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
        <Button type="submit" disabled={create.isPending}>
          <Trans>Create my account</Trans>
        </Button>
      </Form>
    </SignInLayout>
  );
}
