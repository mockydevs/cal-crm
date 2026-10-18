// Agency settings → Marketplace apps: the apps the agency publishes to its
// businesses. A new app is a draft; List shows it in every business's App Marketplace,
// Delist stops new installs and leaves existing ones, and Back to draft hides it again.
// The form asks for the listing, the permissions the app asks a business for (those an API
// key may hold), what it may read, and where it may receive codes. Its rules are the API's
// own schema, so its messages match. Connection shows the developer the client id, the
// client secret (shown once when generated) and the authorization address.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  apiKeyScopes,
  apiKeySelectableReadGroups,
  createMarketplaceApp,
  type createMarketplaceAppInput,
  appWebhookEvents,
  generateAppWebhookSecret,
  generateMarketplaceClientSecret,
  listMarketplaceDeliveries,
  redeliverMarketplaceWebhook,
  listAgencyMarketplaceApps,
  marketplaceCategories,
  updateMarketplaceApp,
  type AgencyMarketplaceApp,
  type AppWebhookSecret,
  type MarketplaceClientSecret,
  type MarketplaceDelivery,
  type MarketplaceAppStatus,
  type MarketplaceCategory,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { EmptyState } from '@repo/ui/components/empty-state';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Store } from 'lucide-react';
import { useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type * as z from 'zod';
import {
  appDraftOf,
  appInputOf,
  authorizationUrlOf,
  deliveryStatusNames,
  eventName,
  categoryNames,
  scopeName,
  statusActions,
  statusChangeOf,
  statusNames,
  type AppDraft,
} from './marketplace-rules';
import { issuesOf, noRejection, rejection, type Rejection } from './problems';
import {
  cellClassName,
  headerCellClassName,
  listCardClassName,
  ListProblem,
  retryFaults,
  savingProblem,
  tableClassName,
  tableRegionClassName,
} from './settings-list';
import { Page } from './shell/page';

export interface AgencyMarketplaceAppsPageProps {
  readonly client: Client;
  /** The agency's slug: only a cache identity. */
  readonly agencyId: string;
}

const appsKey = (agencyId: string) => ['agency', agencyId, 'marketplace-apps'] as const;

/** The panel showing: a new app, a saved one being changed, or a saved one's connection. */
type Editing =
  | { readonly kind: 'new' }
  | { readonly kind: 'edit'; readonly app: AgencyMarketplaceApp }
  | { readonly kind: 'connect'; readonly app: AgencyMarketplaceApp };

export function AgencyMarketplaceAppsPage({
  client,
  agencyId,
}: AgencyMarketplaceAppsPageProps): ReactElement {
  const { t } = useLingui();
  const apps = useQuery({
    queryKey: appsKey(agencyId),
    queryFn: () => client.request(listAgencyMarketplaceApps, {}),
    retry: retryFaults,
  });
  const [editing, setEditing] = useState<Editing>();
  const [notice, setNotice] = useState('');
  const addRef = useRef<HTMLButtonElement>(null);

  return (
    <Page
      title={t`Marketplace apps`}
      actions={
        apps.isSuccess && editing === undefined ? (
          <Button
            ref={addRef}
            onClick={() => {
              setNotice('');
              setEditing({ kind: 'new' });
            }}
          >
            <Plus aria-hidden className="size-[18px]" strokeWidth={2} />
            <Trans>Add app</Trans>
          </Button>
        ) : undefined
      }
    >
      <p className="max-w-prose text-md text-muted-foreground">
        <Trans>
          The apps your businesses find in their App Marketplace. A new app is a draft that only
          your agency sees, until you list it.
        </Trans>
      </p>
      <p role="status" className="text-sm font-medium empty:sr-only">
        {notice}
      </p>
      {editing?.kind === 'connect' ? (
        <ConnectionPanel
          key={editing.app.id}
          client={client}
          agencyId={agencyId}
          app={apps.data?.items.find((each) => each.id === editing.app.id) ?? editing.app}
          onClose={() => {
            setEditing(undefined);
            queueMicrotask(() => addRef.current?.focus());
          }}
        />
      ) : editing === undefined ? null : (
        <AppForm
          key={editing.kind === 'new' ? 'new' : editing.app.id}
          client={client}
          agencyId={agencyId}
          editing={editing}
          onSaved={(message) => {
            setEditing(undefined);
            setNotice(message);
          }}
          onCancel={() => {
            setEditing(undefined);
            // The Add app button is back once the form is gone.
            queueMicrotask(() => addRef.current?.focus());
          }}
        />
      )}
      {apps.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading the apps…</Trans>
        </p>
      ) : apps.isError ? (
        <ListProblem
          onRetry={() => {
            void apps.refetch();
          }}
        >
          {apps.error instanceof ApiError && apps.error.problem.detail !== undefined ? (
            apps.error.problem.detail
          ) : (
            <Trans>The apps couldn’t be loaded.</Trans>
          )}
        </ListProblem>
      ) : apps.data.items.length === 0 ? (
        <EmptyState
          icon={<Store strokeWidth={1.8} />}
          title={<Trans>No apps yet</Trans>}
          description={<Trans>Add an app to offer it to your businesses.</Trans>}
        />
      ) : (
        <AppTable
          client={client}
          agencyId={agencyId}
          apps={apps.data.items}
          onNotice={setNotice}
          onEdit={(app) => {
            setNotice('');
            setEditing({ kind: 'edit', app });
          }}
          onConnect={(app) => {
            setNotice('');
            setEditing({ kind: 'connect', app });
          }}
        />
      )}
    </Page>
  );
}

function AppTable({
  client,
  agencyId,
  apps,
  onNotice,
  onEdit,
  onConnect,
}: AgencyMarketplaceAppsPageProps & {
  readonly apps: readonly AgencyMarketplaceApp[];
  readonly onNotice: (notice: string) => void;
  readonly onEdit: (app: AgencyMarketplaceApp) => void;
  readonly onConnect: (app: AgencyMarketplaceApp) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const queryClient = useQueryClient();
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const moved = (name: string, status: MarketplaceAppStatus): string =>
    status === 'listed'
      ? t`${name} is listed. Every business in your agency can install it.`
      : status === 'delisted'
        ? t`${name} is delisted. No new installs; businesses that have it keep it until they uninstall it.`
        : t`${name} is a draft again. Only your agency sees it.`;
  const editLabel = (name: string): string => t`Edit ${name}`;
  const connectLabel = (name: string): string => t`Connection for ${name}`;
  const actionLabel = (name: string, status: MarketplaceAppStatus): string =>
    status === 'listed'
      ? t`List ${name}`
      : status === 'delisted'
        ? t`Delist ${name}`
        : t`Move ${name} back to draft`;

  const move = useMutation({
    mutationFn: async ({
      app,
      status,
    }: {
      readonly app: AgencyMarketplaceApp;
      readonly status: MarketplaceAppStatus;
    }) => {
      const body = statusChangeOf(app, status);
      if (!body.success) throw new Error(body.error.issues[0]?.message);
      return client.request(updateMarketplaceApp, { params: { appId: app.id }, body: body.data });
    },
    onMutate: () => {
      onNotice('');
    },
    onSuccess: async (saved) => {
      onNotice(moved(saved.name, saved.status));
      await queryClient.invalidateQueries({ queryKey: appsKey(agencyId) });
    },
    onError: (error) => {
      onNotice(
        error instanceof ApiError
          ? (error.problem.detail ??
              t`The app wasn’t changed. Check your connection and try again.`)
          : error.message,
      );
    },
  });

  return (
    <div className={listCardClassName}>
      <div className={tableRegionClassName}>
        <table className={tableClassName}>
          <caption className="sr-only">
            <Trans>Marketplace apps</Trans>
          </caption>
          <thead>
            <tr>
              <th scope="col" className={headerCellClassName}>
                <Trans>Name</Trans>
              </th>
              <th scope="col" className={headerCellClassName}>
                <Trans>Status</Trans>
              </th>
              <th scope="col" className={headerCellClassName}>
                <Trans>Installs</Trans>
              </th>
              <th scope="col" className={headerCellClassName}>
                <Trans>Updated</Trans>
              </th>
              <th scope="col" className={headerCellClassName}>
                <span className="sr-only">
                  <Trans>Actions</Trans>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app) => (
              <tr key={app.id}>
                <td className={`${cellClassName} font-medium text-foreground`}>{app.name}</td>
                <td className={cellClassName}>{i18n._(statusNames[app.status])}</td>
                <td className={cellClassName}>{app.installCount}</td>
                <td className={`${cellClassName} whitespace-nowrap`}>
                  {dates.format(new Date(app.updatedAt))}
                </td>
                <td className={cellClassName}>
                  <div className="flex flex-nowrap justify-end gap-2">
                    <Button
                      variant="secondary"
                      size="small"
                      aria-label={editLabel(app.name)}
                      onClick={() => {
                        onEdit(app);
                      }}
                    >
                      <Trans>Edit</Trans>
                    </Button>
                    <Button
                      variant="secondary"
                      size="small"
                      aria-label={connectLabel(app.name)}
                      onClick={() => {
                        onConnect(app);
                      }}
                    >
                      <Trans>Connection</Trans>
                    </Button>
                    {statusActions(app.status).map((action) => (
                      <Button
                        key={action.to}
                        variant="secondary"
                        size="small"
                        aria-label={actionLabel(app.name, action.to)}
                        disabled={move.isPending}
                        onClick={() => {
                          move.mutate({ app, status: action.to });
                        }}
                      >
                        {i18n._(action.label)}
                      </Button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AppForm({
  client,
  agencyId,
  editing,
  onSaved,
  onCancel,
}: AgencyMarketplaceAppsPageProps & {
  readonly editing: Exclude<Editing, { readonly kind: 'connect' }>;
  readonly onSaved: (notice: string) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const queryClient = useQueryClient();
  const headingId = useId();
  const categoriesErrorId = useId();
  const scopesErrorId = useId();
  const readGroupsErrorId = useId();
  const eventsErrorId = useId();
  const saved = editing.kind === 'edit' ? editing.app : undefined;
  const draft: AppDraft = appDraftOf(saved);
  const [categories, setCategories] = useState<readonly MarketplaceCategory[]>(draft.categories);
  const [scopes, setScopes] = useState<readonly string[]>(draft.scopes);
  const [readGroups, setReadGroups] = useState<readonly string[]>(draft.readGroups);
  const [webhookEvents, setWebhookEvents] = useState<readonly string[]>(draft.webhookEvents);
  const [problem, setProblem] = useState<Rejection>(noRejection);
  // Apart from the form's errors: ticking a box mustn't hand the form a new errors object,
  // which would bring back a field error that's been cleared.
  const [categoriesError, setCategoriesError] = useState<string>();
  const [scopesError, setScopesError] = useState<string>();
  const [readGroupsError, setReadGroupsError] = useState<string>();
  const [eventsError, setEventsError] = useState<string>();
  const reject = ({
    fields: {
      categories: forCategories,
      scopes: forScopes,
      readGroups: forReadGroups,
      webhookEvents: forEvents,
      ...fields
    },
    form,
  }: Rejection) => {
    setProblem({ fields, form });
    setCategoriesError(forCategories);
    setScopesError(forScopes);
    setReadGroupsError(forReadGroups);
    setEventsError(forEvents);
  };

  const save = useMutation({
    mutationFn: (input: z.output<typeof createMarketplaceAppInput>) =>
      saved === undefined
        ? client.request(createMarketplaceApp, { body: input })
        : client.request(updateMarketplaceApp, {
            params: { appId: saved.id },
            body: { ...input, status: saved.status },
          }),
    onSuccess: async (app) => {
      const { name } = app;
      onSaved(
        saved === undefined
          ? t`${name} is added as a draft. List it when businesses should see it.`
          : t`${name} is saved.`,
      );
      await queryClient.invalidateQueries({ queryKey: appsKey(agencyId) });
    },
    onError: (error) => {
      reject(savingProblem(error, t`The app wasn’t saved. Check your connection and try again.`));
    },
  });

  const savedName = saved?.name;
  const title = savedName === undefined ? t`Add app` : t`Edit ${savedName}`;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-card border-2 border-primary bg-card p-[22px]"
    >
      <h2 id={headingId} className="text-xl font-semibold">
        {title}
      </h2>
      <Form<Record<string, unknown>>
        errors={problem.fields}
        onFormSubmit={(values) => {
          const parsed = appInputOf(values, { categories, scopes, readGroups, webhookEvents });
          // The server checks the events against what the app may read, and says which field.
          if (parsed.success) save.mutate(parsed.data);
          else reject(rejection(issuesOf(parsed.error)));
        }}
      >
        <TextField name="name" label={t`Name`} value={draft.name} maxLength={80} />
        <TextField
          name="tagline"
          label={t`Tagline`}
          value={draft.tagline}
          maxLength={140}
          hint={<Trans>One line on the app’s card.</Trans>}
        />
        <Field name="description">
          <FieldLabel>
            <Trans>Description</Trans>
          </FieldLabel>
          <Textarea rows={5} maxLength={5000} defaultValue={draft.description} />
          <FieldError />
        </Field>
        <TextField name="developer" label={t`Developer`} value={draft.developer} maxLength={80} />
        <TextField
          name="websiteUrl"
          label={t`Website`}
          value={draft.websiteUrl}
          inputMode="url"
          placeholder="https://"
        />
        <TextField
          name="supportEmail"
          label={t`Support email`}
          value={draft.supportEmail}
          inputMode="email"
        />
        <TextField
          name="iconUrl"
          label={t`Icon URL`}
          value={draft.iconUrl}
          inputMode="url"
          placeholder="https://"
          hint={<Trans>A square picture at an https:// address.</Trans>}
        />
        <Choices
          legend={t`Categories`}
          hint={<Trans>Up to 5.</Trans>}
          options={marketplaceCategories.map((each) => ({
            value: each,
            label: i18n._(categoryNames[each]),
          }))}
          chosen={categories}
          error={categoriesError}
          errorId={categoriesErrorId}
          onChange={(next) => {
            setCategories(next);
            setCategoriesError(undefined);
          }}
        />
        <Choices
          legend={t`Permissions it asks for`}
          hint={
            <Trans>
              A business that installs the app gives it these, if the person installing it has them.
            </Trans>
          }
          options={apiKeyScopes.map((each) => ({ value: each, label: scopeName(each, i18n) }))}
          chosen={scopes}
          error={scopesError}
          errorId={scopesErrorId}
          onChange={(next) => {
            setScopes(next);
            setScopesError(undefined);
          }}
        />
        <Choices
          legend={t`What it may read`}
          hint={
            <Trans>
              The parts of the API the app may read in a business that installs it. It reads nothing
              else.
            </Trans>
          }
          options={apiKeySelectableReadGroups.map((each) => ({ value: each, label: each }))}
          chosen={readGroups}
          error={readGroupsError}
          errorId={readGroupsErrorId}
          onChange={(next) => {
            setReadGroups(next);
            setReadGroupsError(undefined);
          }}
        />
        <Field name="redirectUris">
          <FieldLabel>
            <Trans>Redirect addresses</Trans>
          </FieldLabel>
          <Textarea
            rows={3}
            defaultValue={draft.redirectUris}
            placeholder="https://"
            spellCheck={false}
            className="max-w-lg font-mono text-sm"
          />
          <FieldDescription>
            <Trans>
              Where the app receives a business’s consent, one address a line, up to 10. Use
              https://, or http://localhost while testing.
            </Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        <TextField
          name="webhookUrl"
          label={t`Webhook address`}
          value={draft.webhookUrl}
          inputMode="url"
          placeholder="https://"
          hint={
            <Trans>
              Where the app is told of events, signed. It is told when it is installed and
              uninstalled, and of the events below.
            </Trans>
          }
        />
        <Choices
          legend={t`Events it is told of`}
          hint={<Trans>Each needs the app to be able to read its part of the API.</Trans>}
          options={appWebhookEvents.map((each) => ({ value: each, label: eventName(each, i18n) }))}
          chosen={webhookEvents}
          error={eventsError}
          errorId={eventsErrorId}
          onChange={(next) => {
            setWebhookEvents(next);
            setEventsError(undefined);
          }}
        />
        {problem.form === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem.form}
          </p>
        )}
        <div className="flex flex-wrap gap-2.5">
          <Button type="submit" disabled={save.isPending}>
            {saved === undefined ? <Trans>Add app</Trans> : <Trans>Save changes</Trans>}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </Form>
    </section>
  );
}

function ConnectionPanel({
  client,
  agencyId,
  app,
  onClose,
}: AgencyMarketplaceAppsPageProps & {
  readonly app: AgencyMarketplaceApp;
  readonly onClose: () => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const queryClient = useQueryClient();
  const headingId = useId();
  const [made, setMade] = useState<MarketplaceClientSecret>();
  const [problem, setProblem] = useState<string>();
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const generate = useMutation({
    mutationFn: () =>
      client.request(generateMarketplaceClientSecret, { params: { appId: app.id } }),
    onMutate: () => {
      setProblem(undefined);
    },
    onSuccess: async (secret) => {
      setMade(secret);
      await queryClient.invalidateQueries({ queryKey: appsKey(agencyId) });
    },
    onError: (error) => {
      setProblem(
        error instanceof ApiError && error.problem.detail !== undefined
          ? error.problem.detail
          : t`The secret wasn’t generated. Check your connection and try again.`,
      );
    },
  });
  const { name, clientSecretPrefix: prefix, clientSecretSetAt: setAt } = app;
  const hasSecret = made !== undefined || prefix !== null;
  const generated = setAt === null ? '' : dates.format(new Date(setAt));
  const [redirect] = app.redirectUris;

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-card border-2 border-primary bg-card p-[22px]"
    >
      <h2 id={headingId} className="text-xl font-semibold">
        <Trans>Connect {name}</Trans>
      </h2>
      <p className="max-w-prose text-md text-muted-foreground">
        <Trans>
          The app’s developer uses these to connect it to a business with OAuth. The person who
          connects it allows what it asks for, and the app gets an access token for that business.
        </Trans>
      </p>
      <CopyField label={t`Client ID`} value={app.id} />
      <div className="flex flex-col gap-2">
        <h3 className="text-md font-semibold">
          <Trans>Client secret</Trans>
        </h3>
        {made !== undefined ? (
          <>
            <p className="text-md">
              <Trans>Copy it now: you won’t see it again.</Trans>
            </p>
            <CopyField label={t`New client secret`} value={made.clientSecret} />
          </>
        ) : prefix === null || setAt === null ? (
          <p className="text-md">
            <Trans>None yet. The app can’t connect until it has one.</Trans>
          </p>
        ) : (
          <p className="text-md">
            <Trans>
              Starts with <span className="font-mono">{prefix}</span>, generated {generated}.
            </Trans>
          </p>
        )}
        <div className="flex flex-wrap gap-2.5">
          <Button
            variant={made === undefined ? 'primary' : 'secondary'}
            disabled={generate.isPending}
            onClick={() => {
              generate.mutate();
            }}
          >
            {hasSecret ? (
              <Trans>Replace client secret</Trans>
            ) : (
              <Trans>Generate client secret</Trans>
            )}
          </Button>
        </div>
        {hasSecret ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Replacing it stops the old one at once. Businesses stay connected.</Trans>
          </p>
        ) : null}
        {problem === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-md font-semibold">
          <Trans>Authorization address</Trans>
        </h3>
        {redirect === undefined ? (
          <p className="text-md">
            <Trans>Add a redirect address with Edit first.</Trans>
          </p>
        ) : (
          <CopyField
            label={t`Send people here to connect`}
            value={authorizationUrlOf(window.location.origin, app.id, redirect)}
            multiline
          />
        )}
      </div>
      <Webhooks client={client} agencyId={agencyId} app={app} />
      <div>
        <Button variant="secondary" onClick={onClose}>
          <Trans>Done</Trans>
        </Button>
      </div>
    </section>
  );
}

const deliveriesKey = (agencyId: string, appId: string) =>
  ['agency', agencyId, 'marketplace-deliveries', appId] as const;

/** The app's webhook: where it goes, the secret it is signed with, and what was sent. */
function Webhooks({
  client,
  agencyId,
  app,
}: AgencyMarketplaceAppsPageProps & { readonly app: AgencyMarketplaceApp }): ReactElement {
  const { t, i18n } = useLingui();
  const queryClient = useQueryClient();
  const [made, setMade] = useState<AppWebhookSecret>();
  const [problem, setProblem] = useState<string>();
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const deliveries = useQuery({
    queryKey: deliveriesKey(agencyId, app.id),
    queryFn: () =>
      client.request(listMarketplaceDeliveries, { params: { appId: app.id }, query: {} }),
    enabled: app.webhookUrl !== null,
    retry: retryFaults,
  });
  const generate = useMutation({
    mutationFn: () => client.request(generateAppWebhookSecret, { params: { appId: app.id } }),
    onMutate: () => {
      setProblem(undefined);
    },
    onSuccess: async (secret) => {
      setMade(secret);
      await queryClient.invalidateQueries({ queryKey: appsKey(agencyId) });
    },
    onError: (error) => {
      setProblem(
        error instanceof ApiError && error.problem.detail !== undefined
          ? error.problem.detail
          : t`The secret wasn’t generated. Check your connection and try again.`,
      );
    },
  });
  const { webhookUrl, webhookSecretSetAt: setAt } = app;
  const hasSecret = made !== undefined || setAt !== null;
  const generated = setAt === null ? '' : dates.format(new Date(setAt));

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-md font-semibold">
        <Trans>Webhooks</Trans>
      </h3>
      {webhookUrl === null ? (
        <p className="text-md">
          <Trans>No webhook address. Add one with Edit to tell the app of events.</Trans>
        </p>
      ) : (
        <>
          <p className="text-md wrap-anywhere">
            <Trans>
              Sent to <span className="font-mono">{webhookUrl}</span>, signed with the webhook
              secret.
            </Trans>
          </p>
          {made !== undefined ? (
            <>
              <p className="text-md">
                <Trans>Copy it now: you won’t see it again.</Trans>
              </p>
              <CopyField label={t`New webhook secret`} value={made.secret} />
            </>
          ) : setAt === null ? (
            <p className="text-md">
              <Trans>No webhook secret yet. Nothing is sent until there is one.</Trans>
            </p>
          ) : (
            <p className="text-md">
              <Trans>The webhook secret was generated {generated}.</Trans>
            </p>
          )}
          <div className="flex flex-wrap gap-2.5">
            <Button
              variant={made === undefined ? 'primary' : 'secondary'}
              disabled={generate.isPending}
              onClick={() => {
                generate.mutate();
              }}
            >
              {hasSecret ? (
                <Trans>Replace webhook secret</Trans>
              ) : (
                <Trans>Generate webhook secret</Trans>
              )}
            </Button>
          </div>
          {problem === undefined ? null : (
            <p role="alert" className="text-sm font-medium text-destructive">
              {problem}
            </p>
          )}
          <Deliveries client={client} agencyId={agencyId} appId={app.id} state={deliveries} />
        </>
      )}
    </div>
  );
}

/** The latest deliveries, newest first, with Send again on each that is done. */
function Deliveries({
  client,
  agencyId,
  appId,
  state,
}: AgencyMarketplaceAppsPageProps & {
  readonly appId: string;
  readonly state: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly data: { readonly items: readonly MarketplaceDelivery[] } | undefined;
    readonly refetch: () => unknown;
  };
}): ReactElement {
  const { t, i18n } = useLingui();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState('');
  const times = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const again = useMutation({
    mutationFn: (deliveryId: string) =>
      client.request(redeliverMarketplaceWebhook, { params: { deliveryId } }),
    onMutate: () => {
      setNotice('');
    },
    onSuccess: async () => {
      setNotice(t`It will be sent again in a moment.`);
      await queryClient.invalidateQueries({ queryKey: deliveriesKey(agencyId, appId) });
    },
    onError: (error) => {
      setNotice(
        error instanceof ApiError && error.problem.detail !== undefined
          ? error.problem.detail
          : t`It wasn’t sent again. Check your connection and try again.`,
      );
    },
  });
  const againLabel = (event: string, business: string): string =>
    t`Send ${event} to ${business} again`;

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">
        <Trans>Latest deliveries</Trans>
      </h4>
      <p role="status" className="text-sm font-medium empty:sr-only">
        {notice}
      </p>
      {state.isPending ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Loading the deliveries…</Trans>
        </p>
      ) : state.isError || state.data === undefined ? (
        <ListProblem
          onRetry={() => {
            void state.refetch();
          }}
        >
          <Trans>The deliveries couldn’t be loaded.</Trans>
        </ListProblem>
      ) : state.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Nothing sent yet.</Trans>
        </p>
      ) : (
        <div className={tableRegionClassName}>
          <table className={tableClassName}>
            <caption className="sr-only">
              <Trans>Latest deliveries</Trans>
            </caption>
            <thead>
              <tr>
                <th scope="col" className={headerCellClassName}>
                  <Trans>When</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Event</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Business</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Status</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Last answer</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <span className="sr-only">
                    <Trans>Actions</Trans>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.data.items.map((delivery) => {
                const event = eventName(delivery.eventType, i18n);
                return (
                  <tr key={delivery.id}>
                    <td className={`${cellClassName} whitespace-nowrap`}>
                      {times.format(new Date(delivery.createdAt))}
                    </td>
                    <td className={cellClassName}>{event}</td>
                    <td className={cellClassName}>{delivery.business.name}</td>
                    <td className={cellClassName}>
                      {i18n._(deliveryStatusNames[delivery.status])}
                    </td>
                    <td className={`${cellClassName} wrap-anywhere`}>
                      {delivery.lastStatus === null
                        ? (delivery.lastError ?? '')
                        : String(delivery.lastStatus)}
                    </td>
                    <td className={cellClassName}>
                      {delivery.status === 'pending' ? null : (
                        <Button
                          variant="secondary"
                          size="small"
                          aria-label={againLabel(event, delivery.business.name)}
                          disabled={again.isPending}
                          onClick={() => {
                            again.mutate(delivery.id);
                          }}
                        >
                          <Trans>Send again</Trans>
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** A value to copy, read-only, with a Copy button and what became of the copy. */
function CopyField({
  label,
  value,
  multiline = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly multiline?: boolean;
}): ReactElement {
  const { t } = useLingui();
  const fieldId = useId();
  const [copied, setCopied] = useState<string>();
  const select = (event: { readonly currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
    event.currentTarget.select();
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex flex-wrap items-start gap-2.5">
        {multiline ? (
          <Textarea
            id={fieldId}
            readOnly
            rows={3}
            value={value}
            className="flex-[1_1_240px] font-mono text-sm break-all"
            onFocus={select}
          />
        ) : (
          <Input
            id={fieldId}
            readOnly
            value={value}
            className="flex-[1_1_240px] font-mono text-sm"
            onFocus={select}
          />
        )}
        <Button
          variant="secondary"
          aria-label={t`Copy ${label}`}
          onClick={() => {
            navigator.clipboard.writeText(value).then(
              () => {
                setCopied(t`Copied.`);
              },
              () => {
                setCopied(t`Copying didn’t work: select it and copy it.`);
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
    </div>
  );
}

function TextField({
  name,
  label,
  value,
  maxLength,
  inputMode,
  placeholder,
  hint,
}: {
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly maxLength?: number;
  readonly inputMode?: 'url' | 'email';
  readonly placeholder?: string;
  readonly hint?: ReactNode;
}): ReactElement {
  return (
    <Field name={name}>
      <FieldLabel>{label}</FieldLabel>
      <Input
        defaultValue={value}
        maxLength={maxLength ?? 2048}
        inputMode={inputMode}
        placeholder={placeholder}
        autoComplete="off"
        className="max-w-lg"
      />
      {hint === undefined ? null : <FieldDescription>{hint}</FieldDescription>}
      <FieldError />
    </Field>
  );
}

/** Boxes to tick, with what is wrong with the choice under them. */
function Choices<Value extends string>({
  legend,
  hint,
  options,
  chosen,
  error,
  errorId,
  onChange,
}: {
  readonly legend: string;
  readonly hint: ReactNode;
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly chosen: readonly string[];
  readonly error: string | undefined;
  readonly errorId: string;
  readonly onChange: (next: readonly Value[]) => void;
}): ReactElement {
  return (
    <fieldset
      className="flex flex-col gap-1"
      aria-describedby={error === undefined ? undefined : errorId}
    >
      <legend className="pb-1.5 text-sm font-medium">{legend}</legend>
      <p className="text-sm text-muted-foreground">{hint}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-x-4">
        {options.map((option) => (
          <label key={option.value} className="flex min-h-11 items-center gap-3 text-md">
            <input
              type="checkbox"
              checked={chosen.includes(option.value)}
              onChange={(event) => {
                const { checked } = event.target;
                onChange(
                  options
                    .map((each) => each.value)
                    .filter((each) => (each === option.value ? checked : chosen.includes(each))),
                );
              }}
              className="size-5 shrink-0 accent-primary"
            />
            {option.label}
          </label>
        ))}
      </div>
      {error === undefined ? null : (
        <p id={errorId} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
