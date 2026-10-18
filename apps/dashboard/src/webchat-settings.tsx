// Settings for web chat: the widgets a business puts on its websites. Each has a name, the
// websites that may show it, what it says to a visitor, and one line of code to paste.
// Everything is the API's: the form checks with the API's own schema first, and the API
// stores each website in its one canonical form.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createWebchatWidget,
  listWebchatWidgets,
  rotateWebchatWidgetKey,
  updateWebchatWidget,
  WEBCHAT_LIMITS,
  webchatWidgetInput,
  type WebchatWidget,
  type WebchatWidgetInput,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { issuesOf } from './problems';
import { Page } from './shell/page';
import {
  draftOf,
  emptyDraft,
  inputOf,
  noWidgetProblem,
  widgetProblem,
  type WidgetDraft,
  type WidgetProblem,
} from './webchat-settings-rules';
import { useBusiness } from './workspace';

const widgetsKey = (businessId: string): readonly string[] => ['b', businessId, 'webchat-widgets'];

export function WebchatSettingsPage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const client = apiIn(business.id);
  const [adding, setAdding] = useState(false);
  const widgets = useQuery({
    queryKey: widgetsKey(business.id),
    queryFn: () => client.request(listWebchatWidgets, {}),
  });
  const forbidden = widgets.error instanceof ApiError && widgets.error.problem.status === 403;
  return (
    <Page title={t`Web chat`}>
      <p className="max-w-[760px] text-md leading-relaxed text-muted-foreground">
        <Trans>
          Put a chat on your website. Visitors write to you there, and their messages arrive in
          Conversations.
        </Trans>
      </p>
      {widgets.isPending ? (
        <p role="status">
          <Trans>Loading web chat…</Trans>
        </p>
      ) : null}
      {widgets.isError ? (
        <p role="alert">
          {forbidden ? t`You need permission to manage web chat.` : t`We couldn't load web chat.`}{' '}
          {forbidden ? null : (
            <Button
              variant="quiet"
              onClick={() => {
                void widgets.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          )}
        </p>
      ) : null}
      {widgets.data === undefined ? null : (
        <>
          {adding ? (
            <WidgetForm
              client={client}
              businessId={business.id}
              close={() => {
                setAdding(false);
              }}
            />
          ) : (
            <Button
              className="self-start"
              onClick={() => {
                setAdding(true);
              }}
            >
              <Trans>Add a chat widget</Trans>
            </Button>
          )}
          {widgets.data.data.length === 0 ? (
            <p className="text-muted-foreground">
              <Trans>No chat widget yet. Add one to get the code for your website.</Trans>
            </p>
          ) : (
            <ul aria-label={t`Chat widgets`} className="flex list-none flex-col gap-3 p-0">
              {widgets.data.data.map((widget) => (
                <li key={widget.id}>
                  <WidgetCard widget={widget} client={client} businessId={business.id} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Page>
  );
}

/** What a failed request says: the API's own words when it gave some. */
const said = (error: unknown, fallback: string): string =>
  error instanceof ApiError ? error.message : fallback;

function WidgetCard({
  widget,
  client,
  businessId,
}: {
  readonly widget: WebchatWidget;
  readonly client: Client;
  readonly businessId: string;
}): ReactElement {
  const { t } = useLingui();
  const headingId = useId();
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const refresh = (): Promise<void> =>
    cache.invalidateQueries({ queryKey: widgetsKey(businessId) });
  const begin = (): void => {
    setNotice(undefined);
    setProblem(undefined);
  };
  const toggle = useMutation({
    mutationFn: () => {
      const body: WebchatWidgetInput = {
        name: widget.name,
        allowedOrigins: widget.allowedOrigins,
        enabled: !widget.enabled,
        settings: widget.settings,
      };
      return client.request(updateWebchatWidget, { params: { id: widget.id }, body });
    },
    onMutate: begin,
    onSuccess: async (saved) => {
      setNotice(saved.enabled ? t`Chat is on.` : t`Chat is off.`);
      await refresh();
    },
    onError: (error) => {
      setProblem(said(error, t`The widget wasn't changed. Check your connection and try again.`));
    },
  });
  const replace = useMutation({
    mutationFn: () => client.request(rotateWebchatWidgetKey, { params: { id: widget.id } }),
    onMutate: begin,
    onSuccess: async () => {
      setReplacing(false);
      setNotice(t`The key was replaced. Paste the new code into your website.`);
      await refresh();
    },
    onError: (error) => {
      setProblem(said(error, t`The key wasn't replaced. Check your connection and try again.`));
    },
  });
  const busy = toggle.isPending || replace.isPending;
  if (editing)
    return (
      <WidgetForm
        widget={widget}
        client={client}
        businessId={businessId}
        close={() => {
          setEditing(false);
        }}
      />
    );
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-[22px]"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={headingId} className="text-lg font-semibold">
          {widget.name}
        </h2>
        <Badge variant={widget.enabled ? 'neutral' : 'attention'}>
          {widget.enabled ? t`On` : t`Off`}
        </Badge>
      </div>
      {widget.allowedOrigins.length === 0 ? (
        <p className="rounded-card bg-secondary p-3 text-sm text-secondary-foreground">
          <Trans>
            No website is listed, so this chat answers nowhere. Edit the widget and add your
            website's address.
          </Trans>
        </p>
      ) : (
        <div className="text-sm">
          <p className="font-semibold">
            <Trans>Websites that may show this chat</Trans>
          </p>
          <ul className="mt-1 list-none p-0">
            {widget.allowedOrigins.map((origin) => (
              <li key={origin} className="break-all font-mono text-xs">
                {origin}
              </li>
            ))}
          </ul>
        </div>
      )}
      <EmbedCode code={widget.embedSnippet} />
      {replacing ? (
        <div className="flex flex-col gap-3 rounded-card bg-secondary p-3 text-sm text-secondary-foreground">
          <p>
            <Trans>
              Replace the key if someone is misusing this chat. The code on your website stops
              working at once, and so does every chat that is open now. You then paste the new code
              into your website.
            </Trans>
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              size="small"
              disabled={busy}
              onClick={() => {
                replace.mutate();
              }}
            >
              {replace.isPending ? t`Replacing…` : t`Replace the key now`}
            </Button>
            <Button
              size="small"
              variant="quiet"
              disabled={busy}
              onClick={() => {
                setReplacing(false);
              }}
            >
              <Trans>Keep the key</Trans>
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              begin();
              setEditing(true);
            }}
          >
            <Trans>Edit</Trans>
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              toggle.mutate();
            }}
          >
            {widget.enabled ? t`Turn chat off` : t`Turn chat on`}
          </Button>
          <Button
            size="small"
            variant="quiet"
            disabled={busy}
            onClick={() => {
              begin();
              setReplacing(true);
            }}
          >
            <Trans>Replace key…</Trans>
          </Button>
        </div>
      )}
      <p role="status" className="text-sm empty:sr-only">
        {notice}
      </p>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </section>
  );
}

/** The one line a website needs, shown as text, with a button that copies it. */
function EmbedCode({ code }: { readonly code: string }): ReactElement {
  const { t } = useLingui();
  const [copied, setCopied] = useState<'copied' | 'failed'>();
  return (
    <div className="text-sm">
      <p className="font-semibold">
        <Trans>Code for your website</Trans>
      </p>
      <p className="mt-1 text-muted-foreground">
        <Trans>
          Paste it once, just before the closing body tag of every page that should show the chat.
        </Trans>
      </p>
      {/* As text: the code is shown, never run or parsed here. It wraps, so it never scrolls. */}
      <p className="mt-2 rounded-xl bg-secondary p-3 font-mono text-xs break-all">{code}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button
          size="small"
          variant="secondary"
          onClick={() => {
            navigator.clipboard.writeText(code).then(
              () => {
                setCopied('copied');
              },
              () => {
                setCopied('failed');
              },
            );
          }}
        >
          <Trans>Copy the code</Trans>
        </Button>
        <span role="status" className="empty:sr-only">
          {copied === 'copied'
            ? t`Copied.`
            : copied === 'failed'
              ? t`Couldn't copy. Select the code and copy it yourself.`
              : null}
        </span>
      </div>
    </div>
  );
}

function WidgetForm({
  widget,
  client,
  businessId,
  close,
}: {
  /** The widget being changed; left out for a new one. */
  readonly widget?: WebchatWidget;
  readonly client: Client;
  readonly businessId: string;
  readonly close: () => void;
}): ReactElement {
  const { t } = useLingui();
  const headingId = useId();
  const cache = useQueryClient();
  const [draft, setDraft] = useState<WidgetDraft>(() =>
    widget === undefined
      ? emptyDraft(t`Chat with us`, t`Hello. How can we help?`)
      : draftOf(widget),
  );
  const [problem, setProblem] = useState<WidgetProblem>(noWidgetProblem);
  const name = widget?.name ?? '';
  const set = (change: Partial<WidgetDraft>): void => {
    setDraft((value) => ({ ...value, ...change }));
  };
  const about = (website: string, message: string): string => t`${website}: ${message}`;
  const save = useMutation({
    mutationFn: (body: WebchatWidgetInput) =>
      widget === undefined
        ? client.request(createWebchatWidget, { body })
        : client.request(updateWebchatWidget, { params: { id: widget.id }, body }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: widgetsKey(businessId) });
      close();
    },
    onError: (error) => {
      const issues = error instanceof ApiError ? (error.problem.errors ?? []) : [];
      setProblem(
        issues.length > 0
          ? widgetProblem(issues, draft.websites, about)
          : {
              fields: {},
              form:
                error instanceof ApiError
                  ? error.message
                  : t`The widget wasn't saved. Check your connection and try again.`,
            },
      );
    },
  });
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-card border border-border bg-card p-[22px]"
    >
      <h2 id={headingId} className="mb-4 text-lg font-semibold">
        {widget === undefined ? t`New chat widget` : t`Edit ${name}`}
      </h2>
      <Form<Record<string, unknown>>
        errors={problem.fields}
        onFormSubmit={() => {
          const parsed = webchatWidgetInput.safeParse(inputOf(draft));
          if (!parsed.success) {
            setProblem(widgetProblem(issuesOf(parsed.error), draft.websites, about));
            return;
          }
          setProblem(noWidgetProblem);
          save.mutate(parsed.data);
        }}
      >
        <fieldset disabled={save.isPending} className="flex min-w-0 flex-col gap-4 border-0 p-0">
          <Field name="name">
            <FieldLabel>
              <Trans>Name</Trans>
            </FieldLabel>
            <Input
              value={draft.name}
              required
              maxLength={120}
              onValueChange={(name) => {
                set({ name });
              }}
            />
            <FieldDescription>
              <Trans>Only your team sees it, to tell one widget from another.</Trans>
            </FieldDescription>
            <FieldError />
          </Field>
          <Field name="websites">
            <FieldLabel>
              <Trans>Websites that may show this chat</Trans>
            </FieldLabel>
            <Textarea
              rows={3}
              value={draft.websites}
              placeholder="https://www.example.com"
              spellCheck={false}
              onValueChange={(websites) => {
                set({ websites });
              }}
            />
            <FieldDescription>
              <Trans>
                One address a line, exactly as in the browser: https://www.example.com and
                https://example.com are two websites. The chat answers on these and nowhere else.
              </Trans>
            </FieldDescription>
            <FieldError />
          </Field>
          <Field name="title">
            <FieldLabel>
              <Trans>Heading of the chat</Trans>
            </FieldLabel>
            <Input
              value={draft.title}
              required
              maxLength={WEBCHAT_LIMITS.titleLength}
              onValueChange={(title) => {
                set({ title });
              }}
            />
            <FieldError />
          </Field>
          <Field name="greeting">
            <FieldLabel>
              <Trans>Greeting</Trans>
            </FieldLabel>
            <Input
              value={draft.greeting}
              maxLength={WEBCHAT_LIMITS.greetingLength}
              onValueChange={(greeting) => {
                set({ greeting });
              }}
            />
            <FieldDescription>
              <Trans>Shown above the visitor's first message. Leave it empty to show none.</Trans>
            </FieldDescription>
            <FieldError />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={draft.emailRequired}
              onChange={(event) => {
                set({ emailRequired: event.target.checked });
              }}
            />
            <Trans>Ask every visitor for an email address before they write</Trans>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={draft.offerMarketing}
              onChange={(event) => {
                set({ offerMarketing: event.target.checked });
              }}
            />
            <Trans>Offer visitors a box to tick for marketing email</Trans>
          </label>
          {draft.offerMarketing ? (
            <Field name="marketingWording">
              <FieldLabel>
                <Trans>Words beside the box</Trans>
              </FieldLabel>
              <Input
                value={draft.marketingWording}
                required
                maxLength={WEBCHAT_LIMITS.consentWordingLength}
                placeholder={t`Email me news and offers.`}
                onValueChange={(marketingWording) => {
                  set({ marketingWording });
                }}
              />
              <FieldDescription>
                <Trans>
                  The box is never ticked for the visitor. These exact words are kept with their
                  consent, as proof of what they agreed to.
                </Trans>
              </FieldDescription>
              <FieldError />
            </Field>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={draft.enabled}
              onChange={(event) => {
                set({ enabled: event.target.checked });
              }}
            />
            <Trans>Chat is on</Trans>
          </label>
        </fieldset>
        {problem.form === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {problem.form}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? t`Saving…` : widget === undefined ? t`Add the widget` : t`Save`}
          </Button>
          <Button type="button" variant="quiet" disabled={save.isPending} onClick={close}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </Form>
    </section>
  );
}
