// Connecting an app: the page an app sends a person to. They choose the business,
// see what the app may change and read there, and Allow & Install (or Allow, when it is
// installed already) or Cancel. Either way the app is told: the API gives the address with
// the code, or with access_denied. A request the server can't send back to the app (an app
// it doesn't know, an address the app didn't register) is only shown here.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  grantOAuthAuthorization,
  readOAuthAuthorization,
  type BusinessSummary,
  type OAuthAuthorizationRequest,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useId, useState, type ReactElement } from 'react';
import { EventList, ReadList } from './marketplace-app';
import { scopeName } from './marketplace-rules';
import { SignInLayout } from './shell/sign-in-layout';

export interface OAuthConsentPageProps {
  /** The OAuth parameters from the page's address. */
  readonly request: OAuthAuthorizationRequest;
  /** The businesses the person may enter, from GET /me. */
  readonly businesses: readonly BusinessSummary[];
  /** The API in a business. */
  readonly clientIn: (businessId: string) => Client;
  /** Sends the browser to the app: a page of another site. */
  readonly leave: (url: string) => void;
}

const reasonOf = (error: unknown, fallback: string): string =>
  error instanceof ApiError && error.problem.detail !== undefined ? error.problem.detail : fallback;

export function OAuthConsentPage({
  request,
  businesses,
  clientIn,
  leave,
}: OAuthConsentPageProps): ReactElement {
  const { t } = useLingui();
  const open = businesses.filter((each) => each.status === 'active');
  const [businessId, setBusinessId] = useState(open[0]?.id);
  const pickerId = useId();
  const business = open.find((each) => each.id === businessId);

  const view = useQuery({
    queryKey: ['oauth-authorize', businessId, request],
    queryFn: () => clientIn(businessId ?? '').request(readOAuthAuthorization, { query: request }),
    enabled: businessId !== undefined,
    retry: false,
  });
  const allow = useMutation({
    mutationFn: () =>
      clientIn(businessId ?? '').request(grantOAuthAuthorization, { body: request }),
    onSuccess: ({ redirectUrl }) => {
      leave(redirectUrl);
    },
  });

  if (business === undefined)
    return (
      <SignInLayout title={t`Connect an app`}>
        <p className="text-md">
          <Trans>You don’t work in a business an app could be connected to.</Trans>
        </p>
      </SignInLayout>
    );

  return (
    <SignInLayout title={t`Connect an app`}>
      {open.length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={pickerId} className="text-sm font-medium">
            <Trans>Business</Trans>
          </label>
          <select
            id={pickerId}
            value={business.id}
            onChange={(event) => {
              allow.reset();
              setBusinessId(event.target.value);
            }}
            className="h-11 rounded-control border bg-background px-3 text-md"
          >
            {open.map((each) => (
              <option key={each.id} value={each.id}>
                {each.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {view.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Checking the app’s request…</Trans>
        </p>
      ) : view.isError ? (
        <div role="alert" className="flex flex-col gap-2">
          <p className="text-md font-medium">
            <Trans>This connection link doesn’t work.</Trans>
          </p>
          <p className="text-sm">
            {reasonOf(view.error, t`It couldn’t be checked. Check your connection and try again.`)}
          </p>
        </div>
      ) : view.data.kind === 'refused' ? (
        <Refusal
          description={view.data.description}
          onBack={() => {
            if (view.data.kind === 'refused') leave(view.data.redirectUrl);
          }}
        />
      ) : (
        <Consent
          view={view.data}
          businessName={business.name}
          busy={allow.isPending}
          problem={
            allow.isError
              ? reasonOf(
                  allow.error,
                  t`The app wasn’t connected. Check your connection and try again.`,
                )
              : undefined
          }
          onAllow={() => {
            allow.mutate();
          }}
          onCancel={(url) => {
            leave(url);
          }}
        />
      )}
    </SignInLayout>
  );
}

/** What is wrong with the app's request, and the way back to tell it. */
function Refusal({
  description,
  onBack,
}: {
  readonly description: string;
  readonly onBack: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <p role="alert" className="text-md">
        <Trans>The app’s request can’t be accepted: {description}</Trans>
      </p>
      <div>
        <Button variant="secondary" onClick={onBack}>
          <Trans>Back to the app</Trans>
        </Button>
      </div>
    </div>
  );
}

function Consent({
  view,
  businessName,
  busy,
  problem,
  onAllow,
  onCancel,
}: {
  readonly view: {
    readonly app: {
      readonly name: string;
      readonly developer: string;
      readonly iconUrl: string | null;
    };
    readonly scopes: readonly string[];
    readonly readGroups: readonly string[];
    readonly webhookEvents: readonly string[];
    readonly missingScopes: readonly string[];
    readonly canInstall: boolean;
    readonly installed: boolean;
    readonly denyUrl: string;
  };
  readonly businessName: string;
  readonly busy: boolean;
  readonly problem: string | undefined;
  readonly onAllow: () => void;
  readonly onCancel: (url: string) => void;
}): ReactElement {
  const { i18n } = useLingui();
  const { name, developer } = view.app;
  const blocked = !view.canInstall || view.missingScopes.length > 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        {view.app.iconUrl === null ? null : (
          <img src={view.app.iconUrl} alt="" className="size-12 rounded-card border" />
        )}
        <div className="min-w-0">
          <p className="text-lg font-semibold wrap-anywhere">
            <Trans>
              {name} wants to connect to {businessName}
            </Trans>
          </p>
          <p className="text-sm text-muted-foreground">
            <Trans>By {developer}</Trans>
          </p>
        </div>
      </div>
      {view.scopes.length === 0 ? (
        <p className="text-sm">
          <Trans>It asks to change nothing.</Trans>
        </p>
      ) : (
        <>
          <p className="text-sm">
            <Trans>It asks to:</Trans>
          </p>
          <ul className="list-disc pl-5 text-sm">
            {view.scopes.map((scope) => (
              <li key={scope}>{scopeName(scope, i18n)}</li>
            ))}
          </ul>
        </>
      )}
      <ReadList
        groups={view.readGroups}
        lead={<Trans>It may read:</Trans>}
        none={<Trans>It reads nothing.</Trans>}
      />
      <EventList events={view.webhookEvents} />
      {!view.canInstall ? (
        <p role="alert" className="flex items-start gap-2 text-sm font-medium">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={1.8} />
          <Trans>Only people who can manage apps and API keys connect apps here.</Trans>
        </p>
      ) : view.missingScopes.length > 0 ? (
        <div role="alert" className="flex flex-col gap-1 text-sm">
          <p className="font-medium">
            <Trans>It asks for permissions you don’t have here:</Trans>
          </p>
          <ul className="list-disc pl-5">
            {view.missingScopes.map((scope) => (
              <li key={scope}>{scopeName(scope, i18n)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">
        <Trans>You can disconnect it at any time by uninstalling it.</Trans>
      </p>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2.5">
        <Button disabled={busy || blocked} onClick={onAllow}>
          {view.installed ? <Trans>Allow</Trans> : <Trans>Allow & Install</Trans>}
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            onCancel(view.denyUrl);
          }}
        >
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </div>
  );
}
