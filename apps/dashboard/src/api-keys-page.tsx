import type { I18n, MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKey,
  type ApiKeyReadGroup,
  type CreateApiKeyInput,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';

import { apiKeyInputOf } from './api-keys-input';
import { permissionNames } from './permission-names';
import { issuesOf, noRejection, rejection, type Rejection } from './problems';
import { Page } from './shell/page';

const protectedReadNames: Readonly<Record<string, MessageDescriptor>> = {
  'payments.read': msg`View payment data`,
  'reports.view': msg`View reports`,
};

function permissionLabel(scope: string, i18n: I18n): string {
  const label = protectedReadNames[scope] ?? permissionNames[scope];
  return label === undefined ? scope : i18n._(label);
}

/** A key just made, with the key itself: shown until it's been copied. */
interface MadeKey {
  readonly name: string;
  readonly key: string;
}

export interface KeysWorkspace {
  readonly scope: 'agency' | 'business';
  /** Agency slug or business ID: only a cache identity, never connection configuration. */
  readonly id: string;
}
interface KeysPageProps {
  readonly client: Client;
  readonly workspace: KeysWorkspace;
}
const keysKey = ({ scope, id }: KeysWorkspace) => [
  scope === 'business' ? 'b' : 'agency',
  id,
  'api-keys',
];

/** A different workspace destroys drafts and one-time credentials before its first render. */
export function ApiKeysPage(props: KeysPageProps): ReactElement {
  return <KeysPage key={`${props.workspace.scope}:${props.workspace.id}`} {...props} />;
}

/** Settings → Apps and API keys: the keys apps use for the business's API. */
function KeysPage({ client, workspace }: KeysPageProps): ReactElement {
  const { t } = useLingui();
  const keys = useQuery({
    queryKey: keysKey(workspace),
    queryFn: () => client.request(listApiKeys, {}),
  });
  const [adding, setAdding] = useState(false);
  const [made, setMade] = useState<MadeKey>();
  const [notice, setNotice] = useState<string>();
  const newKeyRef = useRef<HTMLButtonElement>(null);

  return (
    <Page
      title={t`Apps and API keys`}
      actions={
        keys.data?.canManage === true && !adding && made === undefined ? (
          <Button
            ref={newKeyRef}
            disabled={keys.data.readGroups === undefined}
            onClick={() => {
              setNotice(undefined);
              setAdding(true);
            }}
          >
            <Plus aria-hidden className="size-[18px]" strokeWidth={2} />
            <Trans>New API key</Trans>
          </Button>
        ) : undefined
      }
    >
      <p className="max-w-prose text-md text-muted-foreground">
        {workspace.scope === 'agency' ? (
          <Trans>Keys that let apps use the CRM across all of the agency’s businesses.</Trans>
        ) : (
          <Trans>Keys that let apps use this business’s CRM data.</Trans>
        )}
      </p>
      {keys.data !== undefined && keys.data.readGroups === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>
            This server does not yet support API-key access policies. Update the server before
            creating keys here. Existing keys can still be revoked.
          </Trans>
        </p>
      ) : null}
      <p role="status" className="text-sm font-medium empty:sr-only">
        {notice}
      </p>
      {made === undefined ? null : (
        <NewKey
          made={made}
          onDone={() => {
            setMade(undefined);
          }}
        />
      )}
      {adding && keys.data?.readGroups !== undefined && keys.data.canManage ? (
        <NewKeyForm
          client={client}
          workspace={workspace}
          scopes={keys.data.scopes}
          readGroups={keys.data.readGroups}
          onMade={(key) => {
            setAdding(false);
            setMade(key);
          }}
          onCancel={() => {
            setAdding(false);
            newKeyRef.current?.focus();
          }}
        />
      ) : null}
      <KeyList client={client} workspace={workspace} onRevoked={setNotice} />
    </Page>
  );
}

function NewKeyForm({
  client,
  workspace,
  scopes,
  readGroups,
  onMade,
  onCancel,
}: KeysPageProps & {
  readonly scopes: readonly string[];
  readonly readGroups: readonly ApiKeyReadGroup[];
  readonly onMade: (made: MadeKey) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const queryClient = useQueryClient();
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);
  const [access, setAccess] = useState<'read-only' | 'custom' | 'full'>('read-only');
  const [selectedGroups, setSelectedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const [problem, setProblem] = useState<Rejection>(noRejection);
  // Apart from the form's errors: changing the permissions mustn't hand the form a new
  // errors object, which would bring back a field error that's been cleared.
  const [scopesError, setScopesError] = useState<string>();
  const [readGroupsError, setReadGroupsError] = useState<string>();
  const scopesErrorId = useId();
  const readGroupsErrorId = useId();
  const reject = ({
    fields: { scopes: forScopes, readGroups: forReadGroups, ...fields },
    form,
  }: Rejection) => {
    setProblem({ fields, form });
    setScopesError(forScopes);
    setReadGroupsError(forReadGroups);
  };
  const chooseScope = (scope: string, checked: boolean) => {
    setChosen((current) => {
      const next = new Set(current);
      if (checked) next.add(scope);
      else next.delete(scope);
      return next;
    });
    setScopesError(undefined);
  };

  const create = useMutation({
    // Return void: a one-time credential must never enter the shared mutation cache.
    gcTime: 0,
    mutationFn: async (input: CreateApiKeyInput) => {
      const made = await client.request(createApiKey, { body: input });
      if (activeRef.current) onMade({ name: made.name, key: made.key });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keysKey(workspace) });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.problem.errors !== undefined) {
        reject(rejection(error.problem.errors));
      } else {
        reject({ fields: {}, form: t`The key wasn't made. Check your connection and try again.` });
      }
    },
  });

  return (
    <section
      aria-labelledby="new-key-heading"
      className="flex flex-col gap-4 rounded-card border-2 border-primary bg-card p-[22px]"
    >
      <h2 id="new-key-heading" className="text-xl font-semibold">
        <Trans>New API key</Trans>
      </h2>
      <Form<Record<string, unknown>>
        errors={problem.fields}
        onFormSubmit={(values) => {
          // The API's own rules, so the messages match the server's.
          const parsed = apiKeyInputOf(values, {
            access,
            scopes,
            readGroups,
            chosen,
            selectedGroups,
          });
          if ('expiryProblem' in parsed) {
            reject({
              fields: {
                expiresAt:
                  parsed.expiryProblem === 'past'
                    ? t`Choose an expiry in the future.`
                    : t`Enter a valid expiry date and time.`,
              },
              form: undefined,
            });
            return;
          }
          if (parsed.success) {
            create.mutate(parsed.data);
          } else {
            reject(rejection(issuesOf(parsed.error)));
          }
        }}
      >
        <Field name="name">
          <FieldLabel>
            <Trans>Name</Trans>
          </FieldLabel>
          <Input maxLength={80} autoComplete="off" className="max-w-sm" />
          <FieldDescription>
            <Trans>Name it after the app that uses it, such as Zapier.</Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        <fieldset className="flex flex-col gap-1">
          <legend className="pb-1.5 text-sm font-medium">
            <Trans>Access</Trans>
          </legend>
          {(
            [
              ['read-only', t`Read-only`],
              ['custom', t`Custom access`],
              ['full', t`Full permitted access`],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex min-h-11 items-center gap-3 text-md">
              <input
                type="radio"
                name="access"
                value={value}
                checked={access === value}
                onChange={() => {
                  setAccess(value);
                  setScopesError(undefined);
                }}
                className="size-5 accent-primary"
              />
              {label}
            </label>
          ))}
          <p className="text-sm text-muted-foreground">
            <Trans>
              Full permitted access includes only your available read groups and permissions.
              Read-only keys cannot change data.
            </Trans>
          </p>
        </fieldset>
        {access === 'full' ? null : (
          <fieldset
            className="flex flex-col gap-1"
            aria-describedby={readGroupsError === undefined ? undefined : readGroupsErrorId}
          >
            <legend className="pb-1.5 text-sm font-medium">
              <Trans>What it may read</Trans>
            </legend>
            {readGroups.map((group) => (
              <label key={group} className="flex min-h-11 items-center gap-3 text-md">
                <input
                  type="checkbox"
                  checked={selectedGroups.has(group)}
                  onChange={(event) => {
                    const next = new Set(selectedGroups);
                    if (event.target.checked) next.add(group);
                    else next.delete(group);
                    setSelectedGroups(next);
                    setReadGroupsError(undefined);
                    setScopesError(undefined);
                  }}
                  className="size-5 accent-primary"
                />
                {group}
              </label>
            ))}
            {readGroupsError === undefined ? null : (
              <p id={readGroupsErrorId} className="text-sm font-medium text-destructive">
                {readGroupsError}
              </p>
            )}
          </fieldset>
        )}
        {access === 'read-only' ? (
          <fieldset
            className="flex flex-col gap-1"
            aria-describedby={scopesError === undefined ? undefined : scopesErrorId}
          >
            <legend className="pb-1.5 text-sm font-medium">
              <Trans>Protected read permissions</Trans>
            </legend>
            <p className="text-sm text-muted-foreground">
              <Trans>
                These permissions allow additional protected payment or report data. Choose them
                explicitly as well as the read groups the app needs.
              </Trans>
            </p>
            {scopes
              .filter((scope) => protectedReadNames[scope] !== undefined)
              .map((scope) => (
                <label key={scope} className="flex min-h-11 items-center gap-3 text-md">
                  <input
                    type="checkbox"
                    checked={chosen.has(scope)}
                    onChange={(event) => {
                      chooseScope(scope, event.target.checked);
                    }}
                    className="size-5 accent-primary"
                  />
                  {permissionLabel(scope, i18n)}
                </label>
              ))}
            {scopesError === undefined ? null : (
              <p id={scopesErrorId} className="text-sm font-medium text-destructive">
                {scopesError}
              </p>
            )}
          </fieldset>
        ) : null}
        <Field name="expiresAt">
          <FieldLabel>
            <Trans>Expiry (optional)</Trans>
          </FieldLabel>
          <Input type="datetime-local" className="max-w-sm" />
          <FieldDescription>
            <Trans>Use your local date and time. Leave blank for no expiry.</Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        <fieldset
          aria-describedby={
            access === 'read-only' || scopesError === undefined ? undefined : scopesErrorId
          }
          className="flex flex-col gap-1"
        >
          <legend className="pb-1.5 text-sm font-medium">
            <Trans>What it may change</Trans>
          </legend>
          {access !== 'custom' ? (
            <p className="text-sm text-muted-foreground">
              {access === 'read-only' ? t`No changes allowed.` : t`All your available permissions.`}
            </p>
          ) : (
            scopes.map((scope) => (
              <label key={scope} className="flex min-h-11 items-center gap-3 text-md">
                <input
                  type="checkbox"
                  checked={chosen.has(scope)}
                  onChange={(event) => {
                    chooseScope(scope, event.target.checked);
                  }}
                  className="size-5 accent-primary"
                />
                {permissionLabel(scope, i18n)}
              </label>
            ))
          )}
          {access === 'read-only' || scopesError === undefined ? null : (
            <p id={scopesErrorId} className="text-sm font-medium text-destructive">
              {scopesError}
            </p>
          )}
        </fieldset>
        {problem.form === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem.form}
          </p>
        )}
        <div className="flex flex-wrap gap-2.5">
          <Button type="submit" disabled={create.isPending}>
            <Trans>Create key</Trans>
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </Form>
    </section>
  );
}

/** The key itself, once: to copy before it goes. */
function NewKey({
  made,
  onDone,
}: {
  readonly made: MadeKey;
  readonly onDone: () => void;
}): ReactElement {
  const { t } = useLingui();
  const [copied, setCopied] = useState<string>();
  const fieldId = useId();
  const { name } = made;

  return (
    <section
      aria-labelledby="made-key-heading"
      className="flex flex-col gap-3 rounded-card border-2 border-primary bg-card p-[22px]"
    >
      <h2 id="made-key-heading" className="text-xl font-semibold">
        <Trans>Your new key</Trans>
      </h2>
      <p className="text-md">
        <Trans>The key for {name}. Copy it now: you won’t see it again.</Trans>
      </p>
      <label htmlFor={fieldId} className="text-sm font-medium">
        <Trans>Key</Trans>
      </label>
      <div className="flex flex-wrap gap-2.5">
        <Input
          id={fieldId}
          readOnly
          value={made.key}
          className="flex-[1_1_240px] font-mono text-sm"
          onFocus={(event) => {
            event.currentTarget.select();
          }}
        />
        <Button
          variant="secondary"
          onClick={() => {
            navigator.clipboard.writeText(made.key).then(
              () => {
                setCopied(t`Copied.`);
              },
              () => {
                setCopied(t`Copying didn’t work: select the key and copy it.`);
              },
            );
          }}
        >
          <Trans>Copy</Trans>
        </Button>
      </div>
      <p role="status" className="text-sm empty:sr-only">
        {copied}
      </p>
      <div>
        <Button onClick={onDone}>
          <Trans>I’ve copied it</Trans>
        </Button>
      </div>
    </section>
  );
}

function KeyList({
  client,
  workspace,
  onRevoked,
}: KeysPageProps & { readonly onRevoked: (notice: string) => void }): ReactElement {
  const { t } = useLingui();
  const keys = useQuery({
    queryKey: keysKey(workspace),
    queryFn: () => client.request(listApiKeys, {}),
  });

  if (keys.isPending) {
    return (
      <p className="text-muted-foreground">
        <Trans>Loading the keys…</Trans>
      </p>
    );
  }
  if (keys.isError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3">
        <span className="text-destructive">
          <Trans>The keys couldn’t be loaded.</Trans>
        </span>
        <Button
          variant="secondary"
          size="small"
          onClick={() => {
            void keys.refetch();
          }}
        >
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  }
  if (keys.data.items.length === 0) {
    return (
      <p className="text-muted-foreground">
        <Trans>No API keys yet.</Trans>
      </p>
    );
  }
  return (
    <ul aria-label={t`API keys`} className="flex flex-col gap-3">
      {keys.data.items.map((key) => (
        <KeyRow
          key={key.id}
          client={client}
          workspace={workspace}
          apiKey={key}
          canManage={keys.data.canManage}
          onRevoked={onRevoked}
        />
      ))}
    </ul>
  );
}

function KeyRow({
  client,
  workspace,
  apiKey,
  canManage,
  onRevoked,
}: KeysPageProps & {
  readonly apiKey: ApiKey;
  readonly canManage: boolean;
  readonly onRevoked: (notice: string) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (apiKey.expiresAt === null || apiKey.expiresAt === undefined) return;
    const remaining = Date.parse(apiKey.expiresAt) - now;
    if (remaining <= 0) return;
    const timer = setTimeout(
      () => {
        setNow(Date.now());
      },
      Math.min(remaining, 2_147_483_647),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [apiKey.expiresAt, now]);
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const { name, createdBy } = apiKey;
  const made = dates.format(new Date(apiKey.createdAt));
  const lastUsed =
    apiKey.lastUsedAt === null ? undefined : dates.format(new Date(apiKey.lastUsedAt));
  const expires =
    apiKey.expiresAt === null || apiKey.expiresAt === undefined
      ? undefined
      : dates.format(new Date(apiKey.expiresAt));
  const expired =
    apiKey.expiresAt !== null &&
    apiKey.expiresAt !== undefined &&
    Date.parse(apiKey.expiresAt) <= now;
  const { readGroups } = apiKey;
  const changes = apiKey.scopes.map((scope) => permissionLabel(scope, i18n));
  const area = readGroups?.[0] ?? '';
  const areaCount = readGroups?.length ?? 0;
  const permission = (changes[0] ?? '').toLowerCase();
  const permissionCount = changes.length;
  const reads =
    readGroups === null || readGroups === undefined
      ? t`Reads everything`
      : areaCount === 0
        ? t`Reads nothing`
        : areaCount === 1
          ? t`Reads ${area}`
          : t`Reads ${areaCount} areas`;
  const changesText =
    permissionCount === 0
      ? t`Changes nothing`
      : permissionCount === 1
        ? t`Can ${permission}`
        : t`${permissionCount} permissions`;

  const revoke = useMutation({
    mutationFn: () => client.request(revokeApiKey, { params: { id: apiKey.id } }),
    onSuccess: async () => {
      onRevoked(t`Key revoked. Apps using it stop working now.`);
      await queryClient.invalidateQueries({ queryKey: keysKey(workspace) });
    },
    onError: () => {
      onRevoked(t`The key wasn't revoked. Check your connection and try again.`);
    },
  });

  return (
    <li className="flex flex-wrap items-start justify-between gap-x-5 gap-y-2 rounded-card border border-border bg-card px-[18px] py-3.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold">{name}</p>
          <Badge className="px-2 py-0.5 text-xs">
            {(apiKey.scope ?? workspace.scope) === 'agency' ? t`Agency` : t`Business`}
          </Badge>
          {apiKey.readOnly === true ? (
            <Badge className="px-2 py-0.5 text-xs">
              <Trans>Read-only</Trans>
            </Badge>
          ) : null}
          {expires === undefined ? null : (
            <Badge variant={expired ? 'attention' : 'neutral'} className="px-2 py-0.5 text-xs">
              {expired ? t`Expired ${expires}` : t`Expires ${expires}`}
            </Badge>
          )}
        </div>
        <p className="flex flex-wrap gap-x-2 text-sm text-muted-foreground">
          <span className="font-mono break-all text-foreground">{apiKey.prefix}…</span>
          <span aria-hidden>·</span>
          <span>
            {createdBy === null ? t`Made on ${made}` : t`Made by ${createdBy} on ${made}`}
            {' · '}
            {lastUsed === undefined ? t`Never used` : t`Last used ${lastUsed}`}
          </span>
        </p>
        <details className="group min-w-0 text-sm">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden
              className="size-4 transition-transform group-open:rotate-90"
              strokeWidth={2}
            />
            {reads} · {changesText}
          </summary>
          <dl className="mt-2 grid gap-3 rounded-control bg-muted/40 p-3">
            <div className="flex flex-col gap-1.5">
              <dt className="text-xs font-medium text-muted-foreground uppercase">
                <Trans>Can read</Trans>
              </dt>
              <dd className="flex flex-wrap gap-1.5">
                {readGroups === null || readGroups === undefined ? (
                  <Trans>Everything (an older key without read limits)</Trans>
                ) : readGroups.length === 0 ? (
                  <Trans>Nothing</Trans>
                ) : (
                  readGroups.map((group) => (
                    <Badge key={group} className="px-2 py-0.5 text-xs">
                      {group}
                    </Badge>
                  ))
                )}
              </dd>
            </div>
            <div className="flex flex-col gap-1.5">
              <dt className="text-xs font-medium text-muted-foreground uppercase">
                <Trans>Can change</Trans>
              </dt>
              <dd className="flex flex-wrap gap-1.5">
                {changes.length === 0 ? (
                  <Trans>Nothing</Trans>
                ) : (
                  changes.map((change) => (
                    <Badge key={change} className="px-2 py-0.5 text-xs">
                      {change}
                    </Badge>
                  ))
                )}
              </dd>
            </div>
          </dl>
        </details>
      </div>
      {!canManage ? null : confirming ? (
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-sm">
            <Trans>Apps using {name} stop working at once.</Trans>
          </span>
          <Button
            size="small"
            disabled={revoke.isPending}
            onClick={() => {
              revoke.mutate();
            }}
          >
            <Trans>Confirm revoke</Trans>
          </Button>
          <Button
            size="small"
            variant="secondary"
            onClick={() => {
              setConfirming(false);
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      ) : (
        <Button
          size="small"
          variant="secondary"
          aria-label={t`Revoke ${name}`}
          onClick={() => {
            setConfirming(true);
          }}
        >
          <Trans>Revoke</Trans>
        </Button>
      )}
    </li>
  );
}
