// The Providers section of Settings → AI models, for a business and for the agency alike:
// add a key or a model server, test it, replace the key, remove it. A key goes one way: the
// field is cleared once it is sent, and nothing the API answers has it. A test is queued
// and polled, and its result is said in plain words with what to do.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  connectAiProvider,
  connectAiProviderInput,
  getAiConnectionTest,
  listAiConnections,
  removeAiConnection,
  startAiConnectionTest,
  updateAiConnection,
  updateAiConnectionInput,
  type AiConnection,
  type AiConnectionTest,
  type AiProviderKey,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import {
  addressProblem,
  addressProblemText,
  CLAUDE_MODEL_NAMES,
  formatDollars,
  hostAndPort,
  operatorCanAllow,
  outcomeText,
  ownConnection,
  PROVIDERS,
  providerNames,
  secondsOf,
} from './ai-settings-rules';
import { issuesOf, noRejection, rejection, type Issue, type Rejection } from './problems';

/** Where the section is shown: one business's Settings, or the agency's. */
export interface Place {
  readonly client: Client;
  /** What the cache is keyed by: the business's id, or "agency". */
  readonly scope: string;
  readonly kind: 'business' | 'agency';
  readonly agencyName: string;
}

export const connectionsKey = (scope: string): readonly string[] => ['ai', scope, 'connections'];
const testKey = (scope: string, id: string): readonly string[] => ['ai', scope, 'test', id];

const cardClassName =
  'flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-[22px]';

export function ProvidersSection({ place }: { readonly place: Place }): ReactElement {
  const { t } = useLingui();
  const headingId = useId();
  const { client, scope } = place;
  const connections = useQuery({
    queryKey: connectionsKey(scope),
    queryFn: () => client.request(listAiConnections, {}),
  });
  // The latest test of each connection that this page asked for, by the connection's id.
  const [tests, setTests] = useState<Readonly<Record<string, string>>>({});
  const watch = (test: AiConnectionTest): void => {
    setTests((current) => ({ ...current, [test.connectionId]: test.id }));
  };
  const shared = (connections.data?.data ?? []).filter((each) => !each.canManage);
  return (
    <section aria-labelledby={headingId} className={cardClassName}>
      <h2 id={headingId} className="text-lg font-semibold">
        <Trans>Providers</Trans>
      </h2>
      {connections.isPending ? (
        <p role="status">
          <Trans>Loading providers…</Trans>
        </p>
      ) : null}
      {connections.isError ? (
        <p role="alert">
          <Trans>We couldn't load the providers.</Trans>{' '}
          <Button
            variant="quiet"
            size="small"
            onClick={() => {
              void connections.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </p>
      ) : null}
      {connections.data === undefined ? null : (
        <>
          <ul className="flex flex-col gap-3">
            {PROVIDERS.map((provider) => (
              <ProviderRow
                key={provider}
                place={place}
                provider={provider}
                connection={ownConnection(connections.data.data, provider)}
                testId={tests}
                watch={watch}
              />
            ))}
            <li className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{t`Google Gemini`}</span>
                <span className="text-sm text-muted-foreground">
                  <Trans>Not available in this version yet.</Trans>
                </span>
              </span>
            </li>
          </ul>
          {shared.length === 0 ? null : (
            <SharedConnections place={place} connections={shared} testId={tests} watch={watch} />
          )}
        </>
      )}
    </section>
  );
}

const statusVariant = { working: 'assistant', failing: 'attention', untested: 'neutral' } as const;

function StatusBadge({ status }: { readonly status: AiConnection['status'] }): ReactElement {
  return (
    <Badge variant={statusVariant[status]}>
      {status === 'working' ? (
        <Trans>Connected</Trans>
      ) : status === 'failing' ? (
        <Trans>Not working</Trans>
      ) : (
        <Trans>Not tested yet</Trans>
      )}
    </Badge>
  );
}

interface RowProps {
  readonly place: Place;
  readonly testId: Readonly<Record<string, string>>;
  readonly watch: (test: AiConnectionTest) => void;
}

function ProviderRow({
  place,
  provider,
  connection,
  testId,
  watch,
}: RowProps & {
  readonly provider: AiProviderKey;
  readonly connection: AiConnection | undefined;
}): ReactElement {
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState<'add' | 'replace' | 'remove'>();
  const name = i18n._(providerNames[provider]);
  const close = (): void => {
    setOpen(undefined);
  };
  if (connection === undefined)
    return (
      <li className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <span className="flex min-w-0 flex-col">
            <span className="font-medium">{name}</span>
            <span className="text-sm text-muted-foreground">
              {provider === 'openai_compatible'
                ? t`Ollama, or any server that works like the OpenAI API`
                : t`Not connected`}
            </span>
          </span>
          <Button
            variant="secondary"
            size="small"
            aria-expanded={open === 'add'}
            onClick={() => {
              setOpen(open === 'add' ? undefined : 'add');
            }}
          >
            {provider === 'openai_compatible' ? t`Add server` : t`Add ${name} key`}
          </Button>
        </div>
        {open === 'add' ? (
          <ConnectionForm place={place} provider={provider} close={close} watch={watch} />
        ) : null}
      </li>
    );

  const added = new Intl.DateTimeFormat(i18n.locale, { day: 'numeric', month: 'long' }).format(
    new Date(connection.createdAt),
  );
  const who = connection.addedBy;
  const ending = connection.keyLast4;
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{name}</span>
          <span className="text-sm break-words text-muted-foreground">
            {ending !== null
              ? t`Key ending ${ending}`
              : connection.hasKey
                ? t`Key saved`
                : t`No key needed`}
            {' · '}
            {who === null ? t`added on ${added}` : t`added by ${who} on ${added}`}
          </span>
        </span>
        <StatusBadge status={connection.status} />
      </div>
      <p className="text-sm break-all text-muted-foreground">
        {provider === 'anthropic'
          ? CLAUDE_MODEL_NAMES.join(', ')
          : connection.baseUrl === null
            ? (connection.model ?? '')
            : `${connection.model ?? ''} · ${connection.baseUrl}`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <TestButton place={place} connection={connection} name={name} watch={watch} />
        <Button
          variant="secondary"
          size="small"
          aria-expanded={open === 'replace'}
          onClick={() => {
            setOpen(open === 'replace' ? undefined : 'replace');
          }}
        >
          {provider === 'openai_compatible' ? t`Change ${name}` : t`Replace ${name} key`}
        </Button>
        <Button
          variant="quiet"
          size="small"
          aria-expanded={open === 'remove'}
          onClick={() => {
            setOpen(open === 'remove' ? undefined : 'remove');
          }}
        >
          {t`Remove ${name}`}
        </Button>
      </div>
      <TestResult place={place} connection={connection} testId={testId[connection.id]} />
      {open === 'replace' ? (
        <ConnectionForm
          place={place}
          provider={provider}
          existing={connection}
          close={close}
          watch={watch}
        />
      ) : null}
      {open === 'remove' ? (
        <RemoveConfirmation place={place} connection={connection} name={name} close={close} />
      ) : null}
    </li>
  );
}

/** The agency's connections, as a business sees them: usable and testable, not its own. */
function SharedConnections({
  place,
  connections,
  testId,
  watch,
}: RowProps & { readonly connections: readonly AiConnection[] }): ReactElement {
  const { t, i18n } = useLingui();
  const headingId = useId();
  const agency = place.agencyName;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h3 id={headingId} className="text-md font-semibold">
        {t`${agency}’s keys`}
      </h3>
      <p className="text-sm text-muted-foreground">
        <Trans>
          These are managed in the agency's settings. You can use and test them, but not see or
          change them.
        </Trans>
      </p>
      <ul aria-labelledby={headingId} className="flex flex-col gap-3">
        {connections.map((connection) => {
          const name = i18n._(providerNames[connection.provider]);
          return (
            <li
              key={connection.id}
              className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-4"
            >
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{name}</span>
                  <span className="text-sm break-all text-muted-foreground">
                    {connection.provider === 'anthropic'
                      ? CLAUDE_MODEL_NAMES.join(', ')
                      : (connection.model ?? '')}
                  </span>
                </span>
                <StatusBadge status={connection.status} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <TestButton
                  place={place}
                  connection={connection}
                  name={t`${agency}’s ${name}`}
                  watch={watch}
                />
              </div>
              <TestResult place={place} connection={connection} testId={testId[connection.id]} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TestButton({
  place,
  connection,
  name,
  watch,
}: {
  readonly place: Place;
  readonly connection: AiConnection;
  readonly name: string;
  readonly watch: (test: AiConnectionTest) => void;
}): ReactElement {
  const { t } = useLingui();
  const cache = useQueryClient();
  const start = useMutation({
    mutationFn: () =>
      place.client.request(startAiConnectionTest, { body: { connectionId: connection.id } }),
    onSuccess: (test) => {
      cache.setQueryData(testKey(place.scope, test.id), test);
      watch(test);
    },
  });
  return (
    <>
      <Button
        variant="secondary"
        size="small"
        disabled={start.isPending}
        onClick={() => {
          start.mutate();
        }}
      >
        {t`Test ${name}`}
      </Button>
      {start.isError ? (
        <span role="alert" className="text-sm text-destructive">
          {start.error instanceof ApiError
            ? start.error.message
            : t`The test couldn't start. Check your connection and try again.`}
        </span>
      ) : null}
    </>
  );
}

/**
 * What the latest test found. While this page waits for one it asked for, that test is
 * shown; otherwise what the connection remembers of its last one.
 */
function TestResult({
  place,
  connection,
  testId,
}: {
  readonly place: Place;
  readonly connection: AiConnection;
  readonly testId: string | undefined;
}): ReactElement | null {
  const { t, i18n } = useLingui();
  const cache = useQueryClient();
  const { client, scope } = place;
  const test = useQuery({
    queryKey: testKey(scope, testId ?? ''),
    enabled: testId !== undefined,
    queryFn: async () => {
      const value = await client.request(getAiConnectionTest, { params: { id: testId ?? '' } });
      if (value.status === 'finished') {
        // What a finished test changes: the connection's state, and the month's calls.
        await cache.invalidateQueries({ queryKey: connectionsKey(scope) });
        await cache.invalidateQueries({ queryKey: ['ai', scope, 'usage'] });
      }
      return value;
    },
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 750 : false),
  });
  if (testId !== undefined && test.isError)
    return (
      <p role="alert" className="text-sm">
        <Trans>We couldn't read the test's result.</Trans>{' '}
        <Button
          variant="quiet"
          size="small"
          onClick={() => {
            void test.refetch();
          }}
        >
          <Trans>Try again</Trans>
        </Button>
      </p>
    );
  if (testId !== undefined && (test.data === undefined || test.data.status === 'pending'))
    return (
      <p role="status" className="text-sm text-muted-foreground">
        <Trans>Testing…</Trans>
      </p>
    );
  // What this page's own test found, or else what the connection remembers of its last.
  const found = test.data ?? connection.lastTest;
  const outcome = found?.outcome ?? null;
  if (found === null || outcome === null) return null;
  if (outcome === 'ok') {
    const { latencyMs } = found;
    const seconds = secondsOf(latencyMs ?? 0, i18n.locale);
    const call = test.data?.call ?? null;
    const estimate = call?.costEstimate ?? null;
    const cost = estimate === null ? undefined : formatDollars(estimate, i18n.locale);
    return (
      <p role="status" className="text-sm">
        {latencyMs === null ? t`Working` : t`Working · answered in ${seconds} seconds`}
        {call === null ? null : (
          <>
            {' · '}
            {cost === undefined
              ? t`This test call's cost is unknown: the model has no price.`
              : t`This test call cost ${cost}.`}
          </>
        )}
        {test.data?.kind === 'key_check' ? (
          <>
            {' '}
            <Trans>
              The provider accepted the key. No model was called, so this cost nothing; to try a
              real answer, press Test in a business's own settings.
            </Trans>
          </>
        ) : null}
      </p>
    );
  }
  const text = outcomeText[outcome];
  return (
    <p role="alert" className="text-sm leading-relaxed">
      <span className="font-medium text-destructive">{i18n._(text.what)}</span>
      {text.fix === undefined ? null : <> {i18n._(text.fix)}</>}
    </p>
  );
}

function RemoveConfirmation({
  place,
  connection,
  name,
  close,
}: {
  readonly place: Place;
  readonly connection: AiConnection;
  readonly name: string;
  readonly close: () => void;
}): ReactElement {
  const { t } = useLingui();
  const cache = useQueryClient();
  const remove = useMutation({
    mutationFn: () => place.client.request(removeAiConnection, { params: { id: connection.id } }),
    onSuccess: async () => {
      close();
      await cache.invalidateQueries({ queryKey: ['ai', place.scope] });
    },
  });
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl bg-secondary p-4 text-sm">
      <p>
        {connection.hasKey
          ? t`Remove ${name} and destroy its key? Jobs that use its models will stop until you choose others.`
          : t`Remove ${name}? Jobs that use its models will stop until you choose others.`}
      </p>
      {remove.isError ? (
        <p role="alert" className="text-destructive">
          {remove.error instanceof ApiError
            ? remove.error.message
            : t`It wasn't removed. Check your connection and try again.`}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="small"
          disabled={remove.isPending}
          onClick={() => {
            remove.mutate();
          }}
        >
          {remove.isPending ? t`Removing…` : t`Yes, remove ${name}`}
        </Button>
        <Button variant="quiet" size="small" onClick={close}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </div>
  );
}

interface Draft {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

/**
 * What the person who runs the install has to do for a refused address, said with the
 * host and port that were typed. Which servers are already listed is never shown.
 */
function OperatorStep({ address }: { readonly address: string }): ReactElement {
  const listed = hostAndPort(address);
  return (
    <p className="rounded-xl bg-secondary p-3 text-sm leading-relaxed">
      {listed === undefined ? (
        <Trans>
          For a model server on your own network, ask whoever runs this install to add its host and
          port to the setting AI_LOCAL_SERVERS and restart, then save the address again.
        </Trans>
      ) : (
        <Trans>
          For a model server on your own network, ask whoever runs this install to add{' '}
          <code className="break-all">{listed}</code> to the setting AI_LOCAL_SERVERS and restart.
          Then save this address again, with the same host and port.
        </Trans>
      )}
    </p>
  );
}

/** Adds a provider, or changes the one given: its key, and for a server its address and model. */
function ConnectionForm({
  place,
  provider,
  existing,
  close,
  watch,
}: {
  readonly place: Place;
  readonly provider: AiProviderKey;
  readonly existing?: AiConnection;
  readonly close: () => void;
  readonly watch: (test: AiConnectionTest) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const cache = useQueryClient();
  const name = i18n._(providerNames[provider]);
  const [draft, setDraft] = useState<Draft>({
    apiKey: '',
    baseUrl: existing?.baseUrl ?? '',
    model: existing?.model ?? '',
  });
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const [refusedAddress, setRefusedAddress] = useState<string>();
  const own = provider === 'openai_compatible';
  const named = provider !== 'anthropic';

  /** The API's issues, with a refused address said in the page's own words. */
  const explain = (issues: readonly Issue[], codes: readonly string[]): void => {
    const translated = issues.map((issue, index) => {
      const reason = addressProblem(codes[index] ?? '');
      return reason === undefined
        ? issue
        : { ...issue, message: i18n._(addressProblemText[reason]) };
    });
    const reason = codes.map(addressProblem).find((each) => each !== undefined);
    setRefusedAddress(reason !== undefined && operatorCanAllow(reason) ? draft.baseUrl : undefined);
    setProblem(rejection(translated));
  };

  const save = useMutation({
    mutationFn: () => {
      if (existing !== undefined) {
        const changes = updateAiConnectionInput.parse({
          ...(draft.apiKey === '' ? {} : { apiKey: draft.apiKey }),
          ...(own && draft.baseUrl !== existing.baseUrl ? { baseUrl: draft.baseUrl } : {}),
          ...(named && draft.model !== existing.model ? { model: draft.model } : {}),
        });
        return place.client.request(updateAiConnection, {
          params: { id: existing.id },
          body: changes,
        });
      }
      return place.client.request(connectAiProvider, {
        body: connectAiProviderInput.parse(inputOf()),
      });
    },
    onSuccess: async (saved) => {
      // The key has gone one way: it is not kept in the page.
      setDraft((current) => ({ ...current, apiKey: '' }));
      cache.setQueryData(testKey(place.scope, saved.test.id), saved.test);
      watch(saved.test);
      close();
      await cache.invalidateQueries({ queryKey: ['ai', place.scope] });
    },
    onError: (error) => {
      const errors = error instanceof ApiError ? (error.problem.errors ?? []) : [];
      if (errors.length > 0) {
        explain(
          errors,
          errors.map((each) => each.code),
        );
        return;
      }
      setRefusedAddress(undefined);
      setProblem({
        fields: {},
        form:
          error instanceof ApiError
            ? error.message
            : t`It wasn't saved. Check your connection and try again.`,
      });
    },
  });

  function inputOf(): unknown {
    if (provider === 'anthropic') return { provider, apiKey: draft.apiKey };
    if (provider === 'openai') return { provider, apiKey: draft.apiKey, model: draft.model };
    return {
      provider,
      baseUrl: draft.baseUrl,
      model: draft.model,
      ...(draft.apiKey === '' ? {} : { apiKey: draft.apiKey }),
    };
  }

  function submit(): void {
    const changed =
      existing === undefined ||
      draft.apiKey !== '' ||
      (own && draft.baseUrl !== existing.baseUrl) ||
      (named && draft.model !== existing.model);
    if (!changed) {
      setProblem({ fields: {}, form: t`Change the key, the address or the model first.` });
      return;
    }
    const parsed =
      existing === undefined
        ? connectAiProviderInput.safeParse(inputOf())
        : updateAiConnectionInput.safeParse({
            ...(draft.apiKey === '' ? {} : { apiKey: draft.apiKey }),
            ...(own ? { baseUrl: draft.baseUrl } : {}),
            ...(named ? { model: draft.model } : {}),
          });
    if (!parsed.success) {
      setRefusedAddress(undefined);
      setProblem(rejection(issuesOf(parsed.error)));
      return;
    }
    setProblem(noRejection);
    setRefusedAddress(undefined);
    save.mutate();
  }

  const set = (field: keyof Draft) => (value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };
  const keyLabel: ReactNode = own
    ? t`API key (if the server needs one)`
    : existing === undefined
      ? t`${name} API key`
      : t`New ${name} API key`;
  return (
    <Form<Record<string, unknown>>
      className="min-w-0"
      errors={problem.fields}
      onFormSubmit={submit}
      aria-label={existing === undefined ? t`Add ${name}` : t`Change ${name}`}
    >
      <fieldset disabled={save.isPending} className="flex min-w-0 flex-col gap-4 border-0 p-0">
        {own ? (
          <Field name="baseUrl">
            <FieldLabel>
              <Trans>Server address</Trans>
            </FieldLabel>
            <Input
              type="url"
              value={draft.baseUrl}
              required
              autoComplete="off"
              placeholder={t`http://ollama:11434/v1`}
              onValueChange={set('baseUrl')}
            />
            <FieldDescription>
              <Trans>
                Where the server's API starts. A public address must start with https://. A server
                on your own network must first be listed by whoever runs this install.
              </Trans>
            </FieldDescription>
            <FieldError />
          </Field>
        ) : null}
        {refusedAddress === undefined ? null : <OperatorStep address={refusedAddress} />}
        {named ? (
          <Field name="model">
            <FieldLabel>
              <Trans>Model name</Trans>
            </FieldLabel>
            <Input
              value={draft.model}
              required
              autoComplete="off"
              placeholder={own ? t`As your server lists it` : t`As OpenAI lists it`}
              onValueChange={set('model')}
            />
            <FieldError />
          </Field>
        ) : null}
        <Field name="apiKey">
          <FieldLabel>{keyLabel}</FieldLabel>
          <Input
            type="password"
            value={draft.apiKey}
            required={!own && existing === undefined}
            autoComplete="off"
            onValueChange={set('apiKey')}
          />
          <FieldDescription>
            {existing === undefined ? (
              <Trans>It is stored encrypted and can't be shown again, here or anywhere else.</Trans>
            ) : (
              <Trans>Leave this empty to keep the key that is saved now.</Trans>
            )}
          </FieldDescription>
          <FieldError />
        </Field>
        {own ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            <Trans>
              Smaller models can struggle with bigger jobs like building automations. Every
              automation is checked before it can be published, whichever model wrote it.
            </Trans>
          </p>
        ) : null}
        {problem.form === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {problem.form}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="small" disabled={save.isPending}>
            {save.isPending ? t`Saving…` : t`Save and test`}
          </Button>
          <Button type="button" variant="quiet" size="small" onClick={close}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </fieldset>
    </Form>
  );
}
