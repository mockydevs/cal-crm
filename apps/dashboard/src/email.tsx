import { Select } from '@repo/ui/components/select';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  connectMailbox,
  connectMailboxInput,
  discoverMailboxServers,
  getMailboxConnectionAttempt,
  listMailboxes,
  type ConnectMailboxInput,
  type MailboxConnectionResult,
  type MailboxDiscovery,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { withCampaignsWords } from './campaigns-words';
import { issuesOf, noRejection, rejection, type Rejection } from './problems';
import { Page } from './shell/page';
import { useBusiness } from './workspace';
import { EmailChecks } from './email-checks';
import { withEmailVerificationWords } from './email-verification/words';
import { EmailSending } from './email-sending';
import { QuietHoursSettings } from './quiet-hours-settings';

// The business's ceiling on campaign email, with its words: fetched beside the page, for
// someone who may manage mailboxes.
const CampaignLimit = lazy(() => withCampaignsWords(import('./campaigns/settings-limit')));
// Email verification and its provider, with their words: fetched beside the page, for
// someone who may manage email verification.
const EmailVerificationSettings = lazy(() =>
  withEmailVerificationWords(import('./email-verification/settings')),
);

export function EmailPage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const client = apiIn(business.id);
  const [adding, setAdding] = useState(false);
  const current = useQuery({
    queryKey: ['mailboxes', business.id],
    queryFn: () => client.request(listMailboxes, {}),
  });
  const forbidden = current.error instanceof ApiError && current.error.problem.status === 403;
  return (
    <Page title={t`Email Services`}>
      <p className="max-w-[760px] text-md leading-relaxed text-muted-foreground">
        <Trans>Connect your mailbox to send and receive email through your own provider.</Trans>
      </p>
      {current.isPending ? (
        <p role="status">
          <Trans>Loading mailboxes…</Trans>
        </p>
      ) : null}
      {current.isError ? (
        <p role="alert">
          {forbidden
            ? t`You need permission to manage mailboxes.`
            : t`We couldn't load your mailboxes.`}{' '}
          {!forbidden ? (
            <Button
              variant="quiet"
              onClick={() => {
                void current.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          ) : null}
        </p>
      ) : null}
      {current.data === undefined ? null : (
        <>
          <Button
            className="self-start"
            aria-expanded={adding}
            onClick={() => {
              setAdding((value) => !value);
            }}
          >
            <Trans>Add a mailbox</Trans>
          </Button>
          {adding ? (
            <ConnectForm
              key={business.id}
              client={client}
              businessId={business.id}
              close={() => {
                setAdding(false);
              }}
            />
          ) : null}
          {current.data.data.length === 0 ? (
            <p className="text-muted-foreground">
              <Trans>No mailboxes connected yet. Add a mailbox to get started.</Trans>
            </p>
          ) : (
            <section aria-label={t`Connected mailboxes`} className="flex flex-col gap-3">
              {current.data.data.map((mailbox) => (
                <article
                  key={mailbox.id}
                  className="rounded-card border border-border bg-card p-[22px]"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="text-lg font-semibold">{mailbox.name}</h2>
                      <p className="break-all text-muted-foreground">{mailbox.email}</p>
                    </div>
                    <span className="rounded-full bg-secondary px-3 py-1 text-sm">
                      <Trans>Connected</Trans>
                    </span>
                  </div>
                  <p className="mt-3 break-all text-sm text-muted-foreground">
                    <Trans>SMTP:</Trans> {mailbox.smtp.host}:{mailbox.smtp.port} ·{' '}
                    <Trans>IMAP:</Trans> {mailbox.imap.host}:{mailbox.imap.port}
                  </p>
                  <EmailChecks
                    client={client}
                    businessId={business.id}
                    mailboxId={mailbox.id}
                    mailboxName={mailbox.name}
                    active={mailbox.status === 'active'}
                  />
                  <EmailSending client={client} businessId={business.id} mailboxId={mailbox.id} />
                </article>
              ))}
            </section>
          )}
        </>
      )}
      {current.data === undefined ? null : (
        <Suspense fallback={null}>
          <CampaignLimit />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <EmailVerificationSettings />
      </Suspense>
      <QuietHoursSettings />
    </Page>
  );
}

function initialSettings(): ConnectMailboxInput {
  return {
    name: '',
    email: '',
    displayName: '',
    smtp: { host: '', port: 465, security: 'tls', username: '', password: '' },
    imap: { host: '', port: 993, security: 'tls', username: '', password: '' },
  };
}

function fieldRejection(error: Parameters<typeof issuesOf>[0]): Rejection {
  return rejection(
    issuesOf(error).map((issue) => ({
      ...issue,
      path: issue.path.replaceAll('/', '-').replace(/^-/, '/'),
    })),
  );
}

function ConnectionResult({ result }: { readonly result: MailboxConnectionResult }): ReactElement {
  const { t } = useLingui();
  const explain = (check: MailboxConnectionResult['smtp']): string => {
    if (check.status === 'pass') return t`Sign-in succeeded.`;
    const port = check.port;
    switch (check.code) {
      case 'authentication':
        return t`The server rejected the password.`;
      case 'certificate':
        return t`The server's certificate could not be verified. Check the server name and certificate.`;
      case 'timeout':
        return t`Port ${port} didn't answer in time.`;
      case 'unreachable':
        return t`Port ${port} couldn't be reached. Check the server and port.`;
      case 'tls_required':
        return t`The server did not offer the required encrypted connection.`;
      case 'private_address':
        return t`This server address is not allowed. Use your provider's public mail server.`;
      case 'invalid_host':
        return t`The server name is invalid. Enter the hostname from your provider.`;
      case 'dns':
        return t`The server name couldn't be resolved. Check the hostname and try again.`;
      case 'connection':
        return t`The connection failed. Check your server settings and try again.`;
    }
  };
  return (
    <ul className="space-y-1 text-sm" aria-label={t`Connection results`}>
      {(['smtp', 'imap'] as const).map((protocol) => (
        <li key={protocol}>
          {protocol.toUpperCase()}: {explain(result[protocol])}
        </li>
      ))}
    </ul>
  );
}

function ConnectForm({
  client,
  businessId,
  close,
}: {
  readonly client: Client;
  readonly businessId: string;
  readonly close: () => void;
}): ReactElement {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState(initialSettings);
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const [busy, setBusy] = useState(false);
  const [attemptId, setAttemptId] = useState<string>();
  const [suggestion, setSuggestion] = useState<MailboxDiscovery>();
  const [confirmed, setConfirmed] = useState(false);
  const discovery = useMutation({
    mutationFn: (email: string) => client.request(discoverMailboxServers, { body: { email } }),
    onSuccess: (found) => {
      setSuggestion(found);
      setConfirmed(false);
      setProblem(noRejection);
      setSettings((value) => ({
        ...value,
        smtp: {
          ...value.smtp,
          ...(found.smtp === null
            ? {}
            : { host: found.smtp.host, port: found.smtp.port, security: found.smtp.security }),
          username: value.email,
        },
        imap: {
          ...value.imap,
          ...(found.imap === null
            ? {}
            : { host: found.imap.host, port: found.imap.port, security: found.imap.security }),
          username: value.email,
        },
      }));
    },
    onError: () => {
      setProblem({
        fields: {},
        form: t`We couldn't find server settings. Enter the details from your provider.`,
      });
    },
  });
  const attempt = useQuery({
    queryKey: ['mailbox-attempt', businessId, attemptId],
    enabled: attemptId !== undefined,
    queryFn: async () => {
      const value = await client.request(getMailboxConnectionAttempt, {
        params: { id: attemptId ?? '' },
      });
      if (value.status === 'connected')
        await queryClient.invalidateQueries({ queryKey: ['mailboxes', businessId] });
      return value;
    },
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 750 : false),
  });
  const testing = busy || attempt.data?.status === 'pending';
  const needsConfirmation =
    suggestion?.smtp?.requiresConfirmation === true ||
    suggestion?.imap?.requiresConfirmation === true;
  async function connect(): Promise<void> {
    const parsed = connectMailboxInput.safeParse(settings);
    if (!parsed.success) {
      setProblem(fieldRejection(parsed.error));
      return;
    }
    if (needsConfirmation && !confirmed) {
      setProblem({
        fields: {},
        form: t`Confirm the suggested servers with your provider before connecting.`,
      });
      return;
    }
    setProblem(noRejection);
    setBusy(true);
    try {
      const pending = await client.request(connectMailbox, { body: parsed.data });
      setSettings((value) => ({
        ...value,
        smtp: { ...value.smtp, password: '' },
        imap: { ...value.imap, password: '' },
      }));
      queryClient.setQueryData(['mailbox-attempt', businessId, pending.id], pending);
      setAttemptId(pending.id);
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.problem.errors !== undefined
          ? rejection(
              error.problem.errors.map((issue) => ({
                ...issue,
                path: issue.path.replaceAll('/', '-').replace(/^-/, '/'),
              })),
            )
          : {
              fields: {},
              form:
                error instanceof ApiError
                  ? error.message
                  : t`The connection test couldn't start. Check your connection and try again.`,
            },
      );
    } finally {
      setBusy(false);
    }
  }
  if (attempt.data?.status === 'connected')
    return (
      <section className="rounded-card border border-border bg-card p-[22px]">
        <p role="status">
          <Trans>Mailbox connected.</Trans>
        </p>
        <Button variant="quiet" onClick={close}>
          <Trans>Close</Trans>
        </Button>
      </section>
    );
  return (
    <section
      className="rounded-card border border-border bg-card p-[22px]"
      aria-label={t`Connect a mailbox`}
    >
      <h2 className="mb-2 text-lg font-semibold">
        <Trans>Connect a mailbox</Trans>
      </h2>
      <p className="mb-5 text-sm text-muted-foreground">
        <Trans>
          Use a password or app password from your mail provider. Both SMTP and IMAP sign-ins must
          succeed before the mailbox is saved.
        </Trans>
      </p>
      <Form<Record<string, unknown>>
        errors={problem.fields}
        onFormSubmit={() => {
          void connect();
        }}
      >
        <fieldset
          disabled={testing || discovery.isPending}
          className="flex min-w-0 flex-col gap-4 border-0 p-0"
        >
          <Field name="email">
            <FieldLabel>
              <Trans>Email address</Trans>
            </FieldLabel>
            <Input
              type="email"
              autoComplete="email"
              value={settings.email}
              required
              onValueChange={(email) => {
                setSettings((value) => ({ ...value, email }));
                setSuggestion(undefined);
                setConfirmed(false);
              }}
            />
            <FieldError />
          </Field>
          <Button
            type="button"
            variant="quiet"
            className="self-start"
            disabled={discovery.isPending || settings.email === ''}
            onClick={() => {
              discovery.mutate(settings.email);
            }}
          >
            {discovery.isPending ? t`Finding server settings…` : t`Find server settings`}
          </Button>
          {suggestion === undefined ? null : (
            <div className="rounded-xl bg-secondary p-3 text-sm">
              <p>
                {suggestion.smtp === null || suggestion.imap === null
                  ? t`Some settings couldn't be found. Enter the details from your provider.`
                  : t`Server settings found. Review them before connecting.`}
              </p>
              {suggestion.authentication === 'app_password_or_oauth' ? (
                <p className="mt-2">
                  <Trans>
                    Google requires an app password with 2-Step Verification for this connection.
                  </Trans>
                </p>
              ) : null}
              {suggestion.authentication === 'oauth_required' ? (
                <p className="mt-2">
                  <Trans>
                    Microsoft requires sign-in with OAuth. Password connections are not supported
                    for these default servers.
                  </Trans>
                </p>
              ) : null}
              {needsConfirmation ? (
                <label className="mt-3 flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => {
                      setConfirmed(event.target.checked);
                    }}
                    className="mt-1 size-4"
                  />
                  <Trans>I confirmed these suggested servers with my provider.</Trans>
                </label>
              ) : null}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field name="name">
              <FieldLabel>
                <Trans>Mailbox name</Trans>
              </FieldLabel>
              <Input
                value={settings.name}
                required
                maxLength={120}
                onValueChange={(name) => {
                  setSettings((value) => ({ ...value, name }));
                }}
              />
              <FieldError />
            </Field>
            <Field name="displayName">
              <FieldLabel>
                <Trans>Sender name</Trans>
              </FieldLabel>
              <Input
                value={settings.displayName}
                maxLength={200}
                onValueChange={(displayName) => {
                  setSettings((value) => ({ ...value, displayName }));
                }}
              />
              <FieldError />
            </Field>
          </div>
          <div className="grid gap-5 xl:grid-cols-2">
            {(['smtp', 'imap'] as const).map((protocol) => (
              <ServerFields
                key={protocol}
                protocol={protocol}
                settings={settings[protocol]}
                change={(value) => {
                  setSettings((current) => ({ ...current, [protocol]: value }));
                }}
              />
            ))}
          </div>
        </fieldset>
        {problem.form === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {problem.form}
          </p>
        )}
        {attempt.isError ? (
          <p role="alert">
            <Trans>We couldn't read the connection result.</Trans>{' '}
            <Button
              type="button"
              variant="quiet"
              onClick={() => {
                void attempt.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          </p>
        ) : null}
        {attempt.data?.status === 'failed' ? (
          <div role="alert" className="space-y-2">
            <p>
              <Trans>The mailbox wasn't connected. Update the settings and test again.</Trans>
            </p>
            {attempt.data.result === null ? (
              <p>
                {attempt.data.failure === 'expired'
                  ? t`The connection test expired. Enter your passwords and try again.`
                  : t`The credentials couldn't be opened. Enter your passwords and try again.`}
              </p>
            ) : (
              <ConnectionResult result={attempt.data.result} />
            )}
          </div>
        ) : null}
        {testing ? (
          <p role="status">
            <Trans>Testing SMTP and IMAP sign-ins…</Trans>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            disabled={testing || discovery.isPending || (needsConfirmation && !confirmed)}
          >
            <Trans>Test and connect</Trans>
          </Button>
          <Button type="button" variant="quiet" onClick={close}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </Form>
    </section>
  );
}

function ServerFields({
  protocol,
  settings,
  change,
}: {
  readonly protocol: 'smtp' | 'imap';
  readonly settings: ConnectMailboxInput['smtp'];
  readonly change: (value: ConnectMailboxInput['smtp']) => void;
}): ReactElement {
  const { t } = useLingui();
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-4">
      <legend className="px-1 text-sm font-semibold">{protocol.toUpperCase()}</legend>
      <Field name={`${protocol}-host`}>
        <FieldLabel>
          <Trans>Server</Trans>
        </FieldLabel>
        <Input
          value={settings.host}
          required
          autoComplete="off"
          onValueChange={(host) => {
            change({ ...settings, host });
          }}
        />
        <FieldError />
      </Field>
      <div className="grid grid-cols-[minmax(80px,1fr)_minmax(0,2fr)] gap-3">
        <Field name={`${protocol}-port`}>
          <FieldLabel>
            <Trans>Port</Trans>
          </FieldLabel>
          <Input
            type="number"
            min={1}
            max={65535}
            value={settings.port}
            required
            onValueChange={(port) => {
              change({ ...settings, port: Number(port) });
            }}
          />
          <FieldError />
        </Field>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${protocol}-security`} className="text-sm font-medium">
            <Trans>Encryption</Trans>
          </label>
          <Select
            id={`${protocol}-security`}
            value={settings.security}
            onValueChange={(selectedValue) => {
              change({
                ...settings,
                security: selectedValue === 'starttls' ? 'starttls' : 'tls',
              });
            }}
            className="min-h-11 min-w-0 rounded-xl border border-input bg-card px-2 text-md"
          >
            <option value="tls">{t`TLS`}</option>
            <option value="starttls">{t`STARTTLS`}</option>
          </Select>
        </div>
      </div>
      <Field name={`${protocol}-username`}>
        <FieldLabel>
          <Trans>Username</Trans>
        </FieldLabel>
        <Input
          value={settings.username}
          required
          autoComplete="off"
          onValueChange={(username) => {
            change({ ...settings, username });
          }}
        />
        <FieldError />
      </Field>
      <Field name={`${protocol}-password`}>
        <FieldLabel>
          <Trans>Password or app password</Trans>
        </FieldLabel>
        <Input
          type="password"
          value={settings.password}
          required
          autoComplete="new-password"
          onValueChange={(password) => {
            change({ ...settings, password });
          }}
        />
        <FieldError />
      </Field>
    </fieldset>
  );
}
