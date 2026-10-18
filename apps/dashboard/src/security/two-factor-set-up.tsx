import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { AuthError, sessionQuery, startTwoFactor, verifyCode, type TwoFactorSetUp } from '../auth';
import { QrCode } from '../shell/qr-code';
import { useFactorChangeProblem } from './factor-change-problem';
import { RecoveryCodes } from './recovery-codes';

export interface TwoFactorSetUpFlowProps {
  /** Whether the person has a password, which setting up asks for first. */
  readonly hasPassword: boolean;
  /** Once two-factor sign-in is on and the recovery codes are saved. */
  readonly onDone: () => void;
}

type Step =
  | { readonly kind: 'start' }
  | { readonly kind: 'scan'; readonly setUp: TwoFactorSetUp }
  | { readonly kind: 'codes'; readonly codes: readonly string[] };

const text = (values: Record<string, unknown>, name: string): string => {
  const value = values[name];
  return typeof value === 'string' ? value : '';
};

/** The key an app takes typed in, in groups of four, for when the camera can't scan. */
function setUpKey(link: string): string {
  const secret = new URL(link).searchParams.get('secret') ?? '';
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * Setting up an authenticator app: the person confirms their password if they have one,
 * scans the QR code, enters the app's first code, then keeps their recovery codes.
 */
export function TwoFactorSetUpFlow({ hasPassword, onDone }: TwoFactorSetUpFlowProps): ReactElement {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: 'start' });
  const [problem, setProblem] = useState<string>();

  const unreachable = t`We couldn't reach the server. Check your connection and try again.`;
  const refused = useFactorChangeProblem();
  const start = useMutation({
    mutationFn: (password: string | undefined) => startTwoFactor(password),
    onSuccess: (setUp) => {
      setProblem(undefined);
      setStep({ kind: 'scan', setUp });
    },
    onError: (caught) => {
      setProblem(refused(caught));
    },
  });
  const confirm = useMutation({
    mutationFn: async ({ code }: { code: string; setUp: TwoFactorSetUp }) => verifyCode(code),
    onSuccess: (_data, { setUp }) => {
      setProblem(undefined);
      setStep({ kind: 'codes', codes: setUp.backupCodes });
    },
    onError: (caught) => {
      if (caught instanceof AuthError && caught.code === 'INVALID_CODE') {
        setProblem(t`That code didn't match. Enter the newest code your app shows.`);
      } else if (caught instanceof AuthError && caught.status === 429) {
        setProblem(t`Too many tries. Wait a moment, then try again.`);
      } else setProblem(unreachable);
    },
  });

  const alert =
    problem === undefined ? null : (
      <p role="alert" className="text-sm font-medium text-destructive">
        {problem}
      </p>
    );

  if (step.kind === 'codes') {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-md leading-normal font-medium">
          <Trans>Two-factor sign-in is on.</Trans>
        </p>
        <RecoveryCodes codes={step.codes} />
        <Button
          className="self-start"
          onClick={() => {
            // Only now, so a page that shows whether it's on doesn't replace the codes before
            // they're saved; and before onDone, so the next page knows it's on.
            void queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey }).then(onDone);
          }}
        >
          <Trans>I've saved my recovery codes</Trans>
        </Button>
      </div>
    );
  }

  if (step.kind === 'scan') {
    const { setUp } = step;
    return (
      <Form<Record<string, unknown>>
        onFormSubmit={(values) => {
          confirm.mutate({ code: text(values, 'code'), setUp });
        }}
      >
        <p className="text-md leading-normal">
          <Trans>
            Open an authenticator app on your phone, such as Google Authenticator, Microsoft
            Authenticator, 1Password or Bitwarden, and scan this code.
          </Trans>
        </p>
        <div className="flex flex-wrap items-center gap-5">
          <QrCode text={setUp.totpURI} label={t`QR code for your authenticator app`} />
          <div className="flex max-w-80 flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">
              <Trans>Can't scan it? Type this key into the app instead:</Trans>
            </span>
            <code data-testid="set-up-key" className="font-mono text-md break-all">
              {setUpKey(setUp.totpURI)}
            </code>
          </div>
        </div>
        <Field name="code">
          <FieldLabel>
            <Trans>The 6-digit code from the app</Trans>
          </FieldLabel>
          <Input inputMode="numeric" autoComplete="one-time-code" required />
          <FieldDescription>
            <Trans>A new code shows every 30 seconds. Enter the one showing now.</Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        {alert}
        <Button type="submit" className="self-start" disabled={confirm.isPending}>
          <Trans>Turn on two-factor sign-in</Trans>
        </Button>
      </Form>
    );
  }

  return (
    <Form<Record<string, unknown>>
      onFormSubmit={(values) => {
        start.mutate(hasPassword ? text(values, 'password') : undefined);
      }}
    >
      {hasPassword ? (
        <Field name="password">
          <FieldLabel>
            <Trans>Your password</Trans>
          </FieldLabel>
          <Input type="password" autoComplete="current-password" required />
          <FieldDescription>
            <Trans>To make sure it's you before changing how you sign in.</Trans>
          </FieldDescription>
          <FieldError />
        </Field>
      ) : null}
      {alert}
      <Button type="submit" className="self-start" disabled={start.isPending}>
        <Trans>Set up two-factor sign-in</Trans>
      </Button>
    </Form>
  );
}
