// Settings for forms: the forms a business puts on its websites, the builder for one, and
// what people sent. The design places forms under Marketing; until that area exists they
// are configured here, at a route that will not move.
import { ArrowLeft, Plus } from 'lucide-react';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createForm,
  createFormInput,
  FORM_LIMITS,
  getFields,
  getForm,
  listForms,
  type Form,
  type FormSummary,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { FormEditor, useStatusName } from './forms-editor';
import { FormAnalytics } from './forms-extras';
import { FormSubmissions } from './forms-submissions';
import { issuesOf } from './problems';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

const listKey = (businessId: string, archived: boolean): readonly unknown[] => [
  'b',
  businessId,
  'forms',
  archived,
];
const formKey = (businessId: string, id: string): readonly string[] => [
  'b',
  businessId,
  'form',
  id,
];

export interface FormsPageProps {
  /** The open form, where the page's address says which (forms-search.ts). */
  readonly form?: string | undefined;
  /** Opens a form, or goes back to the list; with it the address holds which form is open. */
  readonly onForm?: (form: string | undefined) => void;
}

export function FormsPage(props: FormsPageProps): ReactElement {
  const business = useBusiness();
  // A page of its own for each business: nothing typed in one is carried into another.
  return <FormsWorkspace key={business.id} {...props} />;
}

function FormsWorkspace({ form, onForm }: FormsPageProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const client = apiIn(business.id);
  const cache = useQueryClient();
  // Which form is open is the address's to say where the page has one, and the page's own
  // otherwise.
  const [own, setOwn] = useState<string>();
  const selected = onForm === undefined ? own : form;
  const setSelected = onForm ?? setOwn;
  const [archived, setArchived] = useState(false);
  // "Add a form" is on the title's line, as "New funnel" is; its form opens under it.
  const [adding, setAdding] = useState(false);
  const [canAdd, setCanAdd] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const refreshList = (): void => {
    void cache.invalidateQueries({ queryKey: ['b', business.id, 'forms'] });
  };
  return (
    <Page
      title={t`Forms`}
      actions={
        selected === undefined && canAdd && !archived && !adding ? (
          <Button
            ref={addRef}
            onClick={() => {
              setAdding(true);
            }}
          >
            <Plus aria-hidden className="size-[18px]" strokeWidth={2} />
            <Trans>Add a form</Trans>
          </Button>
        ) : undefined
      }
    >
      {selected === undefined ? (
        <FormList
          client={client}
          businessId={business.id}
          archived={archived}
          adding={adding}
          onAddingDone={() => {
            setAdding(false);
            // The button comes back a frame later; the keyboard returns to it.
            requestAnimationFrame(() => addRef.current?.focus());
          }}
          onCanAdd={setCanAdd}
          onArchived={setArchived}
          onOpen={(id) => {
            setAdding(false);
            setSelected(id);
          }}
        />
      ) : (
        <FormDetail
          key={selected}
          id={selected}
          client={client}
          businessId={business.id}
          onBack={() => {
            setSelected(undefined);
            refreshList();
          }}
          onChanged={refreshList}
        />
      )}
    </Page>
  );
}

function FormList({
  client,
  businessId,
  archived,
  adding,
  onAddingDone,
  onCanAdd,
  onArchived,
  onOpen,
}: {
  readonly client: Client;
  readonly businessId: string;
  readonly archived: boolean;
  /** The form that names a new form is open. */
  readonly adding: boolean;
  readonly onAddingDone: () => void;
  /** Tells the page whether this person may add a form, once the list has said. */
  readonly onCanAdd: (can: boolean) => void;
  readonly onArchived: (archived: boolean) => void;
  readonly onOpen: (id: string) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const statusName = useStatusName();
  const forms = useInfiniteQuery({
    queryKey: listKey(businessId, archived),
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      client.request(listForms, {
        query: {
          limit: 50,
          archived: archived ? 'true' : 'false',
          ...(pageParam === '' ? {} : { after: pageParam }),
        },
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = forms.data?.pages.flatMap((page) => page.items) ?? [];
  const canManage = forms.data?.pages[0]?.canManage === true;
  useEffect(() => {
    onCanAdd(canManage);
  }, [canManage, onCanAdd]);
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const listHeadingId = useId();
  const count = (form: FormSummary): string =>
    form.submissionCount === 0
      ? t`No submissions yet`
      : plural(form.submissionCount, { one: '# submission', other: '# submissions' });
  return (
    <>
      <p className="-mt-3 max-w-[760px] text-md leading-relaxed text-muted-foreground">
        <Trans>
          Put a form on your website. What people send becomes a contact, or updates the contact
          they already are, with their consent kept as proof.
        </Trans>
      </p>
      {canManage && !archived && adding ? (
        <NewForm client={client} onCreated={onOpen} onCancel={onAddingDone} />
      ) : null}
      <section
        aria-labelledby={listHeadingId}
        className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-4"
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <h2 id={listHeadingId} className="text-base font-medium">
            {archived ? t`Archived forms` : t`Forms in use`}
          </h2>
          <Button
            variant="quiet"
            size="small"
            onClick={() => {
              onArchived(!archived);
            }}
          >
            {archived ? t`Show forms in use` : t`Show archived forms`}
          </Button>
        </div>
        {forms.isPending ? (
          <p role="status">
            <Trans>Loading forms…</Trans>
          </p>
        ) : null}
        {forms.isError ? (
          <p role="alert">
            <Trans>We couldn't load forms.</Trans>{' '}
            <Button
              variant="quiet"
              onClick={() => {
                void forms.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          </p>
        ) : null}
        {forms.data !== undefined && items.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground">
            {archived ? t`No archived forms.` : t`No form yet. Add one to start building it.`}
          </p>
        ) : null}
        {items.length === 0 ? null : (
          <ul
            aria-label={archived ? t`Archived forms` : t`Forms`}
            className="flex list-none flex-col gap-2 p-0"
          >
            {items.map((form) => {
              const formName = form.name;
              const lastOn =
                form.lastSubmissionAt === null
                  ? undefined
                  : dates.format(new Date(form.lastSubmissionAt));
              return (
                <li
                  key={form.id}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 hover:bg-muted/50"
                >
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-base font-medium break-words">{form.name}</span>
                    <span className="text-sm text-muted-foreground">
                      {count(form)}
                      {lastOn === undefined ? null : <> · {t`last on ${lastOn}`}</>}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Badge variant={form.status === 'published' ? 'neutral' : 'attention'}>
                      {statusName(form)}
                    </Badge>
                    <Button
                      variant="secondary"
                      aria-label={t`Open ${formName}`}
                      onClick={() => {
                        onOpen(form.id);
                      }}
                    >
                      <Trans>Open</Trans>
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {forms.hasNextPage ? (
          <Button
            variant="secondary"
            className="self-start"
            disabled={forms.isFetchingNextPage}
            onClick={() => {
              void forms.fetchNextPage();
            }}
          >
            <Trans>Show more forms</Trans>
          </Button>
        ) : null}
      </section>
    </>
  );
}

function NewForm({
  client,
  onCreated,
  onCancel,
}: {
  readonly client: Client;
  readonly onCreated: (id: string) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  // The field appears because its button was pressed: typing continues there.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string>();
  const create = useMutation({
    mutationFn: (body: { name: string }) => client.request(createForm, { body }),
    onSuccess: (form) => {
      onCreated(form.id);
    },
    onError: (error) => {
      setProblem(
        error instanceof ApiError
          ? error.message
          : t`The form wasn't added. Check your connection and try again.`,
      );
    },
  });
  return (
    <form
      noValidate
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-[22px]"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = createFormInput.safeParse({ name });
        if (!parsed.success) {
          setProblem(issuesOf(parsed.error)[0]?.message);
          return;
        }
        setProblem(undefined);
        create.mutate(parsed.data);
      }}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          <Trans>Name of the new form</Trans>
        </label>
        <Input
          id={id}
          ref={nameRef}
          value={name}
          required
          maxLength={FORM_LIMITS.nameLength}
          aria-describedby={problem === undefined ? undefined : `${id}-problem`}
          aria-invalid={problem === undefined ? undefined : true}
          onValueChange={setName}
        />
        {problem === undefined ? null : (
          <p id={`${id}-problem`} role="alert" className="text-sm font-medium text-destructive">
            {problem}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? t`Adding…` : t`Add the form`}
        </Button>
        <Button
          type="button"
          variant="quiet"
          disabled={create.isPending}
          onClick={() => {
            setProblem(undefined);
            onCancel();
          }}
        >
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </form>
  );
}

// The two views as one switch: the pressed one stands out on the bar's grey.
const viewClassName =
  'min-h-11 rounded-[calc(var(--radius-control)-2px)] px-3.5 text-sm font-medium text-body outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-xs lg:min-h-8';

function FormDetail({
  id,
  client,
  businessId,
  onBack,
  onChanged,
}: {
  readonly id: string;
  readonly client: Client;
  readonly businessId: string;
  readonly onBack: () => void;
  readonly onChanged: () => void;
}): ReactElement {
  const { t } = useLingui();
  const cache = useQueryClient();
  const [view, setView] = useState<'build' | 'submissions' | 'analytics'>('build');
  const form = useQuery({
    queryKey: formKey(businessId, id),
    queryFn: () => client.request(getForm, { params: { id } }),
    // The builder holds the form while it is open; it asks again when it needs to.
    staleTime: Infinity,
  });
  const fields = useQuery({
    queryKey: ['b', businessId, 'fields'],
    queryFn: () => client.request(getFields, {}),
  });
  const keep = (saved: Form): void => {
    cache.setQueryData(formKey(businessId, id), saved);
    onChanged();
  };
  const submissions = form.data?.submissionCount ?? 0;
  return (
    <>
      {/* One bar: the way back on the left, the two views of the form on the right. */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border pb-3">
        <Button variant="quiet" className="-ml-2 gap-1.5 px-2 text-body" onClick={onBack}>
          <ArrowLeft aria-hidden className="size-[18px]" strokeWidth={1.8} />
          <Trans>Back to all forms</Trans>
        </Button>
        {form.data === undefined || fields.data === undefined ? null : (
          <div className="flex gap-0.5 rounded-control bg-secondary p-0.5">
            <button
              type="button"
              className={viewClassName}
              aria-pressed={view === 'build'}
              onClick={() => {
                setView('build');
              }}
            >
              <Trans>Build</Trans>
            </button>
            <button
              type="button"
              className={viewClassName}
              aria-pressed={view === 'submissions'}
              onClick={() => {
                setView('submissions');
              }}
            >
              {t`Submissions (${submissions})`}
            </button>
            <button
              type="button"
              className={viewClassName}
              aria-pressed={view === 'analytics'}
              onClick={() => {
                setView('analytics');
              }}
            >
              <Trans>Analytics</Trans>
            </button>
          </div>
        )}
      </div>
      {form.isPending || fields.isPending ? (
        <p role="status">
          <Trans>Loading the form…</Trans>
        </p>
      ) : null}
      {form.isError || fields.isError ? (
        <p role="alert">
          <Trans>We couldn't load this form.</Trans>{' '}
          <Button
            variant="quiet"
            onClick={() => {
              void form.refetch();
              void fields.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </p>
      ) : null}
      {form.data === undefined || fields.data === undefined ? null : (
        <>
          {/* Hidden, not removed: what is typed in the builder is still there on the way back. */}
          <div hidden={view !== 'build'}>
            <FormEditor
              form={form.data}
              contactFields={fields.data.items}
              client={client}
              onSaved={keep}
              onReload={async () => (await form.refetch()).data}
            />
          </div>
          {view === 'analytics' ? <FormAnalytics form={form.data} client={client} /> : null}
          {view === 'submissions' ? (
            <FormSubmissions
              form={form.data}
              client={client}
              onChanged={() => {
                void form.refetch();
                onChanged();
              }}
            />
          ) : null}
        </>
      )}
    </>
  );
}
