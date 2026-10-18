import { Trans, useLingui } from '@lingui/react/macro';
import { getTwoFactorRequirement, setTwoFactorRequirement } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState, type ReactElement, type ReactNode } from 'react';
import { api } from '../api';
import {
  addPasskey,
  AuthError,
  newRecoveryCodes,
  passkeysQuery,
  removePasskey,
  securityQuery,
  sessionQuery,
  turnOffTwoFactor,
} from '../auth';
import { useFactorChangeProblem } from '../security/factor-change-problem';
import { RecoveryCodes } from '../security/recovery-codes';
import { TwoFactorSetUpFlow } from '../security/two-factor-set-up';
import { Page } from '../shell/page';

export const Route = createFileRoute('/_app/b/$slug/settings/sign-in')({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.query(sessionQuery),
      context.queryClient.query(securityQuery),
    ]),
  component: SignInSettingsPage,
});

/** The agency's rule, which only agency staff outside a business may read (403 otherwise). */
const requirementQuery = queryOptions({
  queryKey: ['agency', 'two-factor-requirement'],
  queryFn: async () => {
    try {
      return await api.request(getTwoFactorRequirement, {});
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 403) return null;
      throw caught;
    }
  },
});

const text = (values: Record<string, unknown>, name: string): string => {
  const value = values[name];
  return typeof value === 'string' ? value : '';
};

interface SectionProps {
  readonly id: string;
  readonly title: ReactNode;
  readonly badge?: ReactNode;
  readonly children: ReactNode;
}

function Section({ id, title, badge, children }: SectionProps): ReactElement {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-4 rounded-card border bg-card p-5 sm:p-[22px]"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {badge}
      </div>
      {children}
    </section>
  );
}

/** A password field, for people who have one, to confirm a change to how they sign in. */
function PasswordField({ hasPassword }: { readonly hasPassword: boolean }): ReactElement | null {
  if (!hasPassword) return null;
  return (
    <Field name="password">
      <FieldLabel>
        <Trans>Your password</Trans>
      </FieldLabel>
      <Input type="password" autoComplete="current-password" required />
      <FieldError />
    </Field>
  );
}

function Alert({ message }: { readonly message: string | undefined }): ReactElement | null {
  return message === undefined ? null : (
    <p role="alert" className="text-sm font-medium text-destructive">
      {message}
    </p>
  );
}

function SignInSettingsPage(): ReactElement {
  const { t } = useLingui();
  const { data: session } = useSuspenseQuery(sessionQuery);
  const { data: security } = useSuspenseQuery(securityQuery);
  const enabled = session?.user.twoFactorEnabled === true;
  return (
    <Page title={t`Sign-in and security`}>
      <TwoFactorSection
        enabled={enabled}
        required={security.twoFactorRequired}
        hasPassword={security.hasPassword}
      />
      <PasskeysSection />
      <AgencySection enabled={enabled} />
    </Page>
  );
}

interface TwoFactorSectionProps {
  readonly enabled: boolean;
  readonly required: boolean;
  readonly hasPassword: boolean;
}

function TwoFactorSection({ enabled, required, hasPassword }: TwoFactorSectionProps): ReactElement {
  const queryClient = useQueryClient();
  const [action, setAction] = useState<'codes' | 'off'>();
  const [codes, setCodes] = useState<readonly string[]>();
  const [problem, setProblem] = useState<string>();

  const refused = useFactorChangeProblem();
  const failed = (caught: unknown): void => {
    setProblem(refused(caught));
  };
  const getCodes = useMutation({
    mutationFn: (password: string | undefined) => newRecoveryCodes(password),
    onSuccess: (fresh) => {
      setAction(undefined);
      setCodes(fresh);
    },
    onError: failed,
  });
  const turnOff = useMutation({
    mutationFn: (password: string | undefined) => turnOffTwoFactor(password),
    onSuccess: async () => {
      setAction(undefined);
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
    onError: failed,
  });

  const title = <Trans>Two-factor sign-in</Trans>;
  if (!enabled) {
    return (
      <Section id="two-factor-heading" title={title}>
        <p className="text-md leading-normal">
          <Trans>
            Sign in with a code from an authenticator app on your phone as well as your password or
            a sign-in link, so someone who learns your password still can't get in.
          </Trans>
        </p>
        <TwoFactorSetUpFlow
          hasPassword={hasPassword}
          onDone={() => {
            void queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
          }}
        />
      </Section>
    );
  }

  return (
    <Section
      id="two-factor-heading"
      title={title}
      badge={
        <Badge>
          <Trans>On</Trans>
        </Badge>
      }
    >
      <p className="text-md leading-normal">
        <Trans>You sign in with a code from your authenticator app as well.</Trans>
      </p>
      {required ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Your agency requires two-factor sign-in, so it stays on.</Trans>
        </p>
      ) : null}
      {codes === undefined ? null : <RecoveryCodes codes={codes} />}
      {action === undefined ? (
        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              setProblem(undefined);
              setCodes(undefined);
              if (hasPassword) setAction('codes');
              else getCodes.mutate(undefined);
            }}
          >
            <Trans>Get new recovery codes</Trans>
          </Button>
          {required ? null : (
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                setProblem(undefined);
                setAction('off');
              }}
            >
              <Trans>Turn off</Trans>
            </Button>
          )}
        </div>
      ) : (
        <Form<Record<string, unknown>>
          onFormSubmit={(values) => {
            const password = hasPassword ? text(values, 'password') : undefined;
            if (action === 'codes') getCodes.mutate(password);
            else turnOff.mutate(password);
          }}
        >
          <p className="text-md leading-normal">
            {action === 'codes' ? (
              <Trans>New recovery codes replace the ones you have now.</Trans>
            ) : (
              <Trans>Without it, your password or a sign-in link is enough to get in.</Trans>
            )}
          </p>
          <PasswordField hasPassword={hasPassword} />
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={getCodes.isPending || turnOff.isPending}>
              {action === 'codes' ? (
                <Trans>Get new recovery codes</Trans>
              ) : (
                <Trans>Turn off two-factor sign-in</Trans>
              )}
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setAction(undefined);
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </Form>
      )}
      <Alert message={problem} />
    </Section>
  );
}

/** The browser's answer when someone closes its passkey prompt (WebAuthn's NotAllowedError). */
const cancelled = (caught: unknown): boolean =>
  caught instanceof Error && (caught.name === 'NotAllowedError' || caught.name === 'AbortError');

function PasskeysSection(): ReactElement {
  const { t, i18n } = useLingui();
  const queryClient = useQueryClient();
  const passkeys = useQuery(passkeysQuery);
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const [problem, setProblem] = useState<string>();

  const add = useMutation({
    mutationFn: (name: string) => addPasskey(name),
    onSuccess: async () => {
      setProblem(undefined);
      await queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey });
    },
    onError: (caught) => {
      if (cancelled(caught)) return;
      if (caught instanceof AuthError && caught.code === 'USER_NOT_VERIFIED') {
        setProblem(t`Use a passkey that asks for your PIN, fingerprint or face.`);
      } else if (caught instanceof Error && caught.name === 'InvalidStateError') {
        setProblem(t`This device already has a passkey for you.`);
      } else setProblem(t`The passkey wasn't added. Try again.`);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => removePasskey(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey }),
    onError: () => {
      setProblem(t`We couldn't reach the server. Check your connection and try again.`);
    },
  });

  return (
    <Section id="passkeys-heading" title={<Trans>Passkeys</Trans>}>
      <p className="text-md leading-normal">
        <Trans>
          A passkey signs you in with your fingerprint, face or device PIN instead of a password and
          code. It works only on this site, so it can't be phished.
        </Trans>
      </p>
      {passkeys.data === undefined || passkeys.data.length === 0 ? null : (
        <ul aria-label={t`Your passkeys`} className="flex flex-col divide-y rounded-md border">
          {passkeys.data.map((each) => {
            const name = each.name ?? t`Passkey`;
            const added = each.createdAt === undefined ? undefined : dates.format(each.createdAt);
            return (
              <li key={each.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium break-words">{name}</span>
                  {added === undefined ? null : (
                    <span className="text-sm text-muted-foreground">
                      <Trans>Added {added}</Trans>
                    </span>
                  )}
                </div>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={remove.isPending}
                  aria-label={t`Remove ${name}`}
                  onClick={() => {
                    remove.mutate(each.id);
                  }}
                >
                  <Trans>Remove</Trans>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <Form<Record<string, unknown>>
        onFormSubmit={(values) => {
          setProblem(undefined);
          add.mutate(text(values, 'name').trim());
        }}
      >
        <Field name="name">
          <FieldLabel>
            <Trans>Name it (optional)</Trans>
          </FieldLabel>
          <Input maxLength={60} />
          <FieldDescription>
            <Trans>Such as "Work laptop", so you can tell your passkeys apart.</Trans>
          </FieldDescription>
        </Field>
        <Button type="submit" variant="secondary" className="self-start" disabled={add.isPending}>
          <Trans>Add a passkey</Trans>
        </Button>
      </Form>
      <Alert message={problem} />
    </Section>
  );
}

function AgencySection({ enabled }: { readonly enabled: boolean }): ReactElement | null {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const requirement = useQuery(requirementQuery);
  const [problem, setProblem] = useState<string>();
  const change = useMutation({
    mutationFn: (required: boolean) => api.request(setTwoFactorRequirement, { body: { required } }),
    onSuccess: async (saved) => {
      setProblem(undefined);
      queryClient.setQueryData(requirementQuery.queryKey, saved);
      await queryClient.invalidateQueries({ queryKey: securityQuery.queryKey });
    },
    onError: () => {
      setProblem(t`We couldn't reach the server. Check your connection and try again.`);
    },
  });

  // Only agency staff, at the agency rather than in a business, set this.
  if (requirement.data === undefined || requirement.data === null) return null;
  const { required } = requirement.data;
  return (
    <Section id="agency-heading" title={<Trans>Your agency</Trans>}>
      <p className="text-md leading-normal">
        {required ? (
          <Trans>
            Everyone on the agency's team must sign in with two factors. Anyone who hasn't set it up
            is asked to before they can do anything else.
          </Trans>
        ) : (
          <Trans>
            The agency's team may sign in with two factors, but doesn't have to. Requiring it means
            a stolen password alone can't open your clients' data.
          </Trans>
        )}
      </p>
      {required ? (
        <Button
          variant="secondary"
          className="self-start"
          disabled={change.isPending}
          onClick={() => {
            change.mutate(false);
          }}
        >
          <Trans>Stop requiring two-factor sign-in</Trans>
        </Button>
      ) : (
        <>
          {enabled ? null : (
            <p className="text-sm text-muted-foreground">
              <Trans>Set up your own two-factor sign-in above first.</Trans>
            </p>
          )}
          <Button
            className="self-start"
            disabled={!enabled || change.isPending}
            onClick={() => {
              change.mutate(true);
            }}
          >
            <Trans>Require two-factor sign-in for the team</Trans>
          </Button>
        </>
      )}
      <Alert message={problem} />
    </Section>
  );
}
