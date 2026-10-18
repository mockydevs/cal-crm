import { Trans, useLingui } from '@lingui/react/macro';
import {
  connectSms,
  connectSmsInput,
  getSmsConnectionAttempt,
  listPhoneNumbers,
  listSmsConnections,
  listSmsProviderNumbers,
  refreshSmsProviderNumbers,
  registerPhoneNumber,
  registerPhoneNumberInput,
  type ConnectSmsInput,
  type PhoneNumber,
  type RegisterPhoneNumberInput,
  type SmsConnection,
  type SmsConnectionAttempt,
  type SmsProviderNumber,
  type SmsUnavailableCode,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Field, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { issuesOf, noRejection, rejection, type Rejection } from './problems';
import { useBusiness } from './workspace';

// Numbers may take a few seconds to read back from Twilio after a refresh is queued; stop
// polling for a fresher list past this point rather than waiting forever.
const REFRESH_POLL_TIMEOUT_MS = 20_000;

/**
 * The Twilio accounts a business sends and receives text messages through, and the numbers
 * on each it can register, shown by Settings → Phone System (phone-system.tsx). Someone
 * who manages calls too sees the registered numbers in its inventory; someone who manages
 * only SMS sees them listed here.
 */
export function SmsConnections({
  registeredNumbers,
}: {
  /** Whether to list the registered numbers, which needs no more than SMS management. */
  readonly registeredNumbers: boolean;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const client = apiIn(business.id);
  const [adding, setAdding] = useState(false);
  const connections = useQuery({
    queryKey: ['sms-connections', business.id],
    queryFn: () => client.request(listSmsConnections, {}),
  });
  const forbidden =
    connections.error instanceof ApiError && connections.error.problem.status === 403;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="max-w-[760px] text-md leading-relaxed text-muted-foreground">
        <Trans>
          Connect a Twilio account to send and receive SMS, then register the numbers you want to
          use.
        </Trans>
      </p>
      {connections.isPending ? (
        <p role="status">
          <Trans>Loading SMS connections…</Trans>
        </p>
      ) : null}
      {connections.isError ? (
        <p role="alert">
          {forbidden
            ? t`You need permission to manage SMS.`
            : t`We couldn't load your SMS connections.`}{' '}
          {!forbidden ? (
            <Button
              variant="quiet"
              onClick={() => {
                void connections.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          ) : null}
        </p>
      ) : null}
      {connections.data === undefined ? null : (
        <>
          {connections.data.unavailable === null ? null : (
            <UnavailableNotice code={connections.data.unavailable.code} />
          )}
          <Button
            className="self-start"
            aria-expanded={adding}
            onClick={() => {
              setAdding((value) => !value);
            }}
          >
            <Trans>Connect Twilio</Trans>
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
          {connections.data.data.length === 0 ? (
            <p className="text-muted-foreground">
              <Trans>No SMS connections yet. Connect Twilio to get started.</Trans>
            </p>
          ) : (
            <section aria-label={t`SMS connections`} className="flex flex-col gap-3">
              {connections.data.data.map((connection) => (
                <ConnectionCard
                  key={connection.id}
                  connection={connection}
                  client={client}
                  businessId={business.id}
                />
              ))}
            </section>
          )}
          {registeredNumbers ? (
            <PhoneNumbersSection
              client={client}
              businessId={business.id}
              connections={connections.data.data}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Why this install can send and receive no text message, in the page's own words for the
 * server's code: said before anything is connected, and for as long as it is true.
 */
function UnavailableNotice({ code }: { readonly code: SmsUnavailableCode }): ReactElement {
  const { t } = useLingui();
  const text = {
    public_address_unsuitable: t`Text messages can't be sent or received on this install yet. Twilio reports deliveries and incoming messages to the install's public address, and it only reports to a secure one: an https address with no underscore in its name. Ask whoever runs this install to set its public address (PUBLIC_URL) to one. You can still connect an account and register numbers now; they will start working once the address is set.`,
  } satisfies Record<SmsUnavailableCode, string>;
  return (
    <p
      role="alert"
      className="rounded-xl border border-destructive bg-card px-4 py-3 text-md leading-relaxed"
    >
      {text[code]}
    </p>
  );
}

function useFailureText(): (
  failure: Extract<SmsConnectionAttempt, { status: 'failed' }>['failure'],
) => string {
  const { t } = useLingui();
  const text = {
    authentication: t`Twilio rejected the Account SID or token.`,
    account_inactive: t`This Twilio account isn't active.`,
    provider_unavailable: t`Twilio couldn't be reached. Check your connection and try again.`,
    already_connected: t`This Twilio account is already connected.`,
    expired: t`The connection attempt expired. Enter your credentials and try again.`,
    credentials_unreadable: t`The credentials couldn't be opened. Enter your credentials and try again.`,
  } satisfies Record<Extract<SmsConnectionAttempt, { status: 'failed' }>['failure'], string>;
  return (failure) => text[failure];
}

function initialSettings(): ConnectSmsInput {
  return { provider: 'twilio', label: '', accountSid: '', authToken: '' };
}

function fieldRejection(error: Parameters<typeof issuesOf>[0]): Rejection {
  return rejection(issuesOf(error));
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
  const failureText = useFailureText();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState(initialSettings);
  const [useApiKey, setUseApiKey] = useState(false);
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const [busy, setBusy] = useState(false);
  const [attemptId, setAttemptId] = useState<string>();
  // Shown once, from the connect answer itself; never re-fetched or stored elsewhere.
  const [webhookUrl, setWebhookUrl] = useState<string | null>();
  const attempt = useQuery({
    queryKey: ['sms-connection-attempt', businessId, attemptId],
    enabled: attemptId !== undefined,
    queryFn: async () => {
      const value = await client.request(getSmsConnectionAttempt, {
        params: { id: attemptId ?? '' },
      });
      if (value.status === 'connected')
        await queryClient.invalidateQueries({ queryKey: ['sms-connections', businessId] });
      return value;
    },
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 750 : false),
  });
  const testing = busy || attempt.data?.status === 'pending';
  function clearSecrets(): void {
    setSettings((value) => ({
      ...value,
      authToken: '',
      apiKey: value.apiKey === undefined ? undefined : { ...value.apiKey, secret: '' },
    }));
  }
  async function connect(): Promise<void> {
    const parsed = connectSmsInput.safeParse({
      ...settings,
      apiKey: useApiKey ? settings.apiKey : undefined,
    });
    if (!parsed.success) {
      setProblem(fieldRejection(parsed.error));
      return;
    }
    setProblem(noRejection);
    setBusy(true);
    try {
      const started = await client.request(connectSms, { body: parsed.data });
      clearSecrets();
      setWebhookUrl(started.inboundWebhookUrl);
      queryClient.setQueryData(
        ['sms-connection-attempt', businessId, started.attempt.id],
        started.attempt,
      );
      setAttemptId(started.attempt.id);
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.problem.errors !== undefined
          ? rejection(error.problem.errors)
          : {
              fields: {},
              form:
                error instanceof ApiError
                  ? error.message
                  : t`The connection couldn't start. Check your connection and try again.`,
            },
      );
    } finally {
      setBusy(false);
    }
  }
  function closeAndReset(): void {
    setWebhookUrl(undefined);
    close();
  }
  if (attempt.data?.status === 'connected')
    return (
      <section className="rounded-card border border-border bg-card p-[22px]">
        <p role="status">
          <Trans>Twilio connected.</Trans>
        </p>
        {webhookUrl === null || webhookUrl === undefined ? null : (
          <WebhookUrlNotice url={webhookUrl} />
        )}
        <Button variant="quiet" onClick={closeAndReset}>
          <Trans>Close</Trans>
        </Button>
      </section>
    );
  return (
    <section
      className="rounded-card border border-border bg-card p-[22px]"
      aria-label={t`Connect Twilio`}
    >
      <h3 className="mb-2 text-lg font-semibold">
        <Trans>Connect Twilio</Trans>
      </h3>
      <p className="mb-5 text-sm text-muted-foreground">
        <Trans>
          Use the Account SID and Auth Token from your Twilio console. Twilio's Auth Token signs
          webhooks even if you also add an API key for sending.
        </Trans>
      </p>
      <Form<Record<string, unknown>>
        errors={problem.fields}
        onFormSubmit={() => {
          void connect();
        }}
      >
        <fieldset disabled={testing} className="flex min-w-0 flex-col gap-4 border-0 p-0">
          <Field name="label">
            <FieldLabel>
              <Trans>Label</Trans>
            </FieldLabel>
            <Input
              value={settings.label}
              required
              maxLength={80}
              onValueChange={(label) => {
                setSettings((value) => ({ ...value, label }));
              }}
            />
            <FieldError />
          </Field>
          <Field name="accountSid">
            <FieldLabel>
              <Trans>Account SID</Trans>
            </FieldLabel>
            <Input
              value={settings.accountSid}
              required
              autoComplete="off"
              placeholder={t`ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`}
              onValueChange={(accountSid) => {
                setSettings((value) => ({ ...value, accountSid }));
              }}
            />
            <FieldError />
          </Field>
          <Field name="authToken">
            <FieldLabel>
              <Trans>Auth Token</Trans>
            </FieldLabel>
            <Input
              type="password"
              value={settings.authToken}
              required
              autoComplete="off"
              onValueChange={(authToken) => {
                setSettings((value) => ({ ...value, authToken }));
              }}
            />
            <FieldError />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={useApiKey}
              onChange={(event) => {
                setUseApiKey(event.target.checked);
                setSettings((value) => ({
                  ...value,
                  apiKey: event.target.checked ? { sid: '', secret: '' } : undefined,
                }));
              }}
              className="size-4"
            />
            <Trans>Use an API key instead of the Auth Token for sending and reading</Trans>
          </label>
          {useApiKey ? (
            <fieldset className="flex min-w-0 flex-col gap-4 rounded-xl border border-border p-4">
              <legend className="px-1 text-sm font-semibold">
                <Trans>API key</Trans>
              </legend>
              <Field name="apiKey-sid">
                <FieldLabel>
                  <Trans>Key SID</Trans>
                </FieldLabel>
                <Input
                  value={settings.apiKey?.sid ?? ''}
                  required
                  autoComplete="off"
                  placeholder={t`SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`}
                  onValueChange={(sid) => {
                    setSettings((value) => ({
                      ...value,
                      apiKey: { sid, secret: value.apiKey?.secret ?? '' },
                    }));
                  }}
                />
                <FieldError />
              </Field>
              <Field name="apiKey-secret">
                <FieldLabel>
                  <Trans>Key secret</Trans>
                </FieldLabel>
                <Input
                  type="password"
                  value={settings.apiKey?.secret ?? ''}
                  required
                  autoComplete="off"
                  onValueChange={(secret) => {
                    setSettings((value) => ({
                      ...value,
                      apiKey: { sid: value.apiKey?.sid ?? '', secret },
                    }));
                  }}
                />
                <FieldError />
              </Field>
            </fieldset>
          ) : null}
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
          <p role="alert">{failureText(attempt.data.failure)}</p>
        ) : null}
        {testing ? (
          <p role="status">
            <Trans>Checking the Twilio account…</Trans>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={testing}>
            <Trans>Test and connect</Trans>
          </Button>
          <Button type="button" variant="quiet" onClick={closeAndReset}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </Form>
    </section>
  );
}

function WebhookUrlNotice({ url }: { readonly url: string }): ReactElement {
  return (
    <div className="mt-3 rounded-xl bg-secondary p-3 text-sm">
      <p className="font-semibold">
        <Trans>Inbound webhook URL</Trans>
      </p>
      <p className="mt-1">
        <Trans>
          Paste this into Twilio's number configuration as the webhook for incoming messages. It is
          shown only this once and can't be read back later.
        </Trans>
      </p>
      <p className="mt-2 break-all font-mono text-xs">{url}</p>
    </div>
  );
}

const connectionStatusVariant = {
  connected: 'assistant',
  failing: 'attention',
  disconnected: 'neutral',
} as const;

function ConnectionCard({
  connection,
  client,
  businessId,
}: {
  readonly connection: SmsConnection;
  readonly client: Client;
  readonly businessId: string;
}): ReactElement {
  const { t, i18n } = useLingui();
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const warningText = {
    trial_account: t`This is a Twilio trial account. Sending may be limited to verified numbers.`,
    account_not_active: t`This Twilio account isn't active. Check it in the Twilio console.`,
  } satisfies Record<SmsConnection['warnings'][number], string>;
  return (
    <article className="rounded-card border border-border bg-card p-[22px]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold">{connection.label}</h3>
          <p className="break-all text-muted-foreground">{connection.accountSid}</p>
        </div>
        <Badge variant={connectionStatusVariant[connection.status]}>
          {connection.status === 'connected' ? (
            <Trans>Connected</Trans>
          ) : connection.status === 'failing' ? (
            <Trans>Failing</Trans>
          ) : (
            <Trans>Disconnected</Trans>
          )}
        </Badge>
      </div>
      {connection.warnings.length === 0 ? null : (
        <ul className="mt-3 flex flex-col gap-2 rounded-xl bg-secondary p-3 text-sm text-secondary-foreground">
          {connection.warnings.map((warning) => (
            <li key={warning}>{warningText[warning]}</li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-sm text-muted-foreground">
        {connection.lastCheckedAt === null ? (
          <Trans>Never checked.</Trans>
        ) : (
          <>
            <Trans>Last checked</Trans>{' '}
            <time dateTime={connection.lastCheckedAt}>
              {dates.format(new Date(connection.lastCheckedAt))}
            </time>
          </>
        )}
      </p>
      <ProviderNumbers connection={connection} client={client} businessId={businessId} />
    </article>
  );
}

function ProviderNumbers({
  connection,
  client,
  businessId,
}: {
  readonly connection: SmsConnection;
  readonly client: Client;
  readonly businessId: string;
}): ReactElement {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [refreshRequestedAt, setRefreshRequestedAt] = useState<number>();
  const numbers = useQuery({
    queryKey: ['sms-provider-numbers', businessId, connection.id],
    queryFn: () => client.request(listSmsProviderNumbers, { params: { id: connection.id } }),
    // Bounded here, not in render: the worker reads Twilio again asynchronously, so keep
    // polling only while nothing has been fetched since the request, up to a time limit.
    refetchInterval: (query) => {
      if (refreshRequestedAt === undefined) return false;
      if (query.state.dataUpdatedAt > refreshRequestedAt) return false;
      if (Date.now() - refreshRequestedAt > REFRESH_POLL_TIMEOUT_MS) return false;
      return 1500;
    },
  });
  const refresh = useMutation({
    mutationFn: () => client.request(refreshSmsProviderNumbers, { params: { id: connection.id } }),
    onSuccess: () => {
      setRefreshRequestedAt(Date.now());
    },
  });
  // Pure in render: compares the query's own last-fetched timestamp against the request
  // time captured when the refresh was started, with no clock read here.
  const refreshing =
    refreshRequestedAt !== undefined && numbers.dataUpdatedAt <= refreshRequestedAt;
  return (
    <details className="mt-4 min-w-0 text-sm">
      <summary className="flex min-h-10 cursor-pointer items-center font-medium">
        <Trans>Numbers from Twilio</Trans>
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={refresh.isPending}
            onClick={() => {
              refresh.mutate();
            }}
          >
            {refresh.isPending ? t`Starting refresh…` : t`Refresh numbers`}
          </Button>
          {refreshing ? (
            <span role="status" className="text-muted-foreground">
              <Trans>Refreshing from Twilio…</Trans>
            </span>
          ) : null}
        </div>
        {refresh.isError ? (
          <p role="alert">
            {refresh.error instanceof ApiError
              ? refresh.error.message
              : t`The refresh couldn't start. Check your connection and try again.`}
          </p>
        ) : null}
        {numbers.isPending ? (
          <p role="status">
            <Trans>Loading numbers…</Trans>
          </p>
        ) : null}
        {numbers.isError ? (
          <p role="alert">
            <Trans>We couldn't load these numbers.</Trans>{' '}
            <Button
              type="button"
              variant="quiet"
              onClick={() => {
                void numbers.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          </p>
        ) : null}
        {numbers.data === undefined ? null : numbers.data.data.length === 0 ? (
          <p className="text-muted-foreground">
            <Trans>Twilio reports no numbers on this account.</Trans>
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {numbers.data.data.map((number) => (
              <ProviderNumberRow
                key={number.providerNumberRef}
                number={number}
                connection={connection}
                client={client}
                onRegistered={() => {
                  void queryClient.invalidateQueries({
                    queryKey: ['sms-provider-numbers', businessId, connection.id],
                  });
                  void queryClient.invalidateQueries({ queryKey: ['phone-numbers', businessId] });
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function ProviderNumberRow({
  number,
  connection,
  client,
  onRegistered,
}: {
  readonly number: SmsProviderNumber;
  readonly connection: SmsConnection;
  readonly client: Client;
  readonly onRegistered: () => void;
}): ReactElement {
  const { t } = useLingui();
  const [registering, setRegistering] = useState(false);
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium break-all">{number.e164}</span>
        {number.registeredAs === null ? null : (
          <Badge variant="assistant">
            <Trans>Registered</Trans>
          </Badge>
        )}
      </div>
      <p className="break-all text-muted-foreground">{number.friendlyName}</p>
      <div className="flex flex-wrap gap-1.5">
        {number.capabilities.map((capability) => (
          <Badge key={capability} variant="neutral">
            {capability.toUpperCase()}
          </Badge>
        ))}
      </div>
      {number.registeredAs !== null ? null : registering ? (
        <RegisterForm
          connection={connection}
          number={number}
          client={client}
          close={(registered) => {
            setRegistering(false);
            if (registered) onRegistered();
          }}
        />
      ) : (
        <Button
          type="button"
          variant="secondary"
          size="small"
          className="self-start"
          disabled={!number.capabilities.includes('sms')}
          onClick={() => {
            setRegistering(true);
          }}
        >
          <Trans>Register</Trans>
        </Button>
      )}
      {number.capabilities.includes('sms') ? null : (
        <p className="text-muted-foreground">{t`This number can't send or receive SMS.`}</p>
      )}
    </li>
  );
}

function RegisterForm({
  connection,
  number,
  client,
  close,
}: {
  readonly connection: SmsConnection;
  readonly number: SmsProviderNumber;
  readonly client: Client;
  readonly close: (registered: boolean) => void;
}): ReactElement {
  const { t } = useLingui();
  const [name, setName] = useState(number.friendlyName);
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const register = useMutation({
    mutationFn: (body: RegisterPhoneNumberInput) => client.request(registerPhoneNumber, { body }),
    onSuccess: () => {
      close(true);
    },
    onError: (error) => {
      setProblem(
        error instanceof ApiError && error.problem.errors !== undefined
          ? rejection(error.problem.errors)
          : {
              fields: {},
              form:
                error instanceof ApiError
                  ? error.message
                  : t`The number wasn't registered. Check your connection and try again.`,
            },
      );
    },
  });
  return (
    <Form<Record<string, unknown>>
      className="min-w-0"
      errors={problem.fields}
      onFormSubmit={() => {
        const parsed = registerPhoneNumberInput.safeParse({
          connectionId: connection.id,
          providerNumberRef: number.providerNumberRef,
          name,
        });
        if (!parsed.success) {
          setProblem(rejection(issuesOf(parsed.error)));
          return;
        }
        setProblem(noRejection);
        register.mutate(parsed.data);
      }}
    >
      <fieldset disabled={register.isPending} className="flex min-w-0 flex-col gap-3 border-0 p-0">
        <Field name="name">
          <FieldLabel>
            <Trans>Name</Trans>
          </FieldLabel>
          <Input
            value={name}
            required
            maxLength={120}
            onValueChange={(value) => {
              setName(value);
            }}
          />
          <FieldError />
        </Field>
        {problem.form === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {problem.form}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="small" disabled={register.isPending}>
            {register.isPending ? t`Registering…` : t`Register`}
          </Button>
          <Button
            type="button"
            variant="quiet"
            size="small"
            onClick={() => {
              close(false);
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </fieldset>
    </Form>
  );
}

const phoneStatusVariant = {
  active: 'assistant',
  paused: 'neutral',
  failing: 'attention',
  disconnected: 'attention',
} as const;

function PhoneNumbersSection({
  client,
  businessId,
  connections,
}: {
  readonly client: Client;
  readonly businessId: string;
  readonly connections: readonly SmsConnection[];
}): ReactElement {
  const numbers: UseQueryResult<{ data: PhoneNumber[] }> = useQuery({
    queryKey: ['phone-numbers', businessId],
    queryFn: () => client.request(listPhoneNumbers, {}),
  });
  const labelOf = (connectionId: string): string =>
    connections.find((connection) => connection.id === connectionId)?.label ?? connectionId;
  return (
    <section
      aria-labelledby={`${businessId}-registered-numbers`}
      className="rounded-card border border-border bg-card p-[22px]"
    >
      <h3 id={`${businessId}-registered-numbers`} className="mb-3 text-lg font-semibold">
        <Trans>Registered phone numbers</Trans>
      </h3>
      {numbers.isPending ? (
        <p role="status">
          <Trans>Loading phone numbers…</Trans>
        </p>
      ) : null}
      {numbers.isError ? (
        <p role="alert">
          <Trans>We couldn't load your phone numbers.</Trans>{' '}
          <Button
            variant="quiet"
            onClick={() => {
              void numbers.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </p>
      ) : null}
      {numbers.data === undefined ? null : numbers.data.data.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>No phone numbers registered yet. Register one from a connection above.</Trans>
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {numbers.data.data.map((number) => (
            <li
              key={number.id}
              className="flex min-w-0 flex-col gap-2 rounded-xl border border-border p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium break-all">{number.name}</span>
                <Badge variant={phoneStatusVariant[number.status]}>
                  {number.status === 'active' ? (
                    <Trans>Active</Trans>
                  ) : number.status === 'paused' ? (
                    <Trans>Paused</Trans>
                  ) : number.status === 'failing' ? (
                    <Trans>Failing</Trans>
                  ) : (
                    <Trans>Disconnected</Trans>
                  )}
                </Badge>
              </div>
              <p className="break-all text-muted-foreground">{number.e164}</p>
              <p className="text-muted-foreground">
                <Trans>Through</Trans> {labelOf(number.connectionId)}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {number.capabilities.map((capability) => (
                  <Badge key={capability} variant="neutral">
                    {capability.toUpperCase()}
                  </Badge>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
