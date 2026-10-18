import { Trans, useLingui } from '@lingui/react/macro';
import { restoreCompany, trashCompany } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useActorLabel } from '../activity';
import { apiIn } from '../api';
import { CompanyLoading, companyKey, useCompany } from '../companies';
import { countryName, websiteHref } from '../company-rules';
import { ContactPanel, RecordFields } from '../contact-panels';
import { quietLinkClassName } from '../contacts';
import { Page } from '../shell/page';
import { useBusiness } from '../workspace';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/contacts/companies/$companyId/');

// The edit panel, fetched when Edit is first pressed: the page itself carries no panel.
// Its popovers stay out of the page's first chunk.
const RecordTags = lazy(async () => ({ default: (await import('../record-tags')).RecordTags }));
// Fetched when the page is drawn, as the contact page and an opportunity fetch them.
const RecordNotes = lazy(async () => ({ default: (await import('../record-notes')).RecordNotes }));
const RecordActivity = lazy(async () => ({
  default: (await import('../record-activity')).RecordActivity,
}));
const RecordTasks = lazy(async () => ({ default: (await import('../record-tasks')).RecordTasks }));
const CompanyEditPanel = lazy(() => import('../company-panel'));

export const Route = createFileRoute('/_app/b/$slug/contacts/companies/$companyId/')({
  component: CompanyPage,
});
function CompanyPage(): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const { companyId } = route.useParams();
  const cache = useQueryClient();
  const actorLabel = useActorLabel();
  const current = useCompany(business.id, companyId);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  // Whether Edit was ever pressed: from then on the panel stays, to close and reopen itself.
  const [asked, setAsked] = useState(false);
  const editRef = useRef<HTMLButtonElement | null>(null);
  const trashRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  const focusNextRef = useRef<'trash' | 'restore' | null>(null);
  const move = useMutation({
    mutationFn: (trashed: boolean) =>
      trashed
        ? apiIn(business.id).request(trashCompany, { params: { id: companyId } })
        : apiIn(business.id).request(restoreCompany, { params: { id: companyId } }),
    onMutate: () => {
      setNotice('');
    },
    onSuccess: async (company, trashed) => {
      cache.setQueryData(companyKey(business.id, companyId), company);
      focusNextRef.current = trashed ? 'restore' : 'trash';
      setNotice(trashed ? t`Moved to trash.` : t`Company restored.`);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['b', business.id, 'companies', 'list'] }),
        cache.invalidateQueries({ queryKey: ['b', business.id, 'activity', companyId] }),
      ]);
    },
  });
  const company = current.data;
  const trashed = company?.trashedAt !== null && company !== undefined;
  const moment = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const linked = (href: string, text: string): ReactElement => (
    <a href={href} className="break-all text-link underline">
      {text}
    </a>
  );
  // What the Companies table shows of a company, in its order, then our own domain.
  // The server always sends these four; a company read before they existed has none.
  const email = company?.email ?? null;
  const website = company?.website ?? null;
  const description = company?.description ?? null;
  const country = company?.country ?? null;
  const details: readonly {
    readonly key: string;
    readonly label: ReactNode;
    readonly value: ReactNode;
  }[] =
    company === undefined
      ? []
      : [
          {
            key: 'phone',
            label: <Trans>Phone</Trans>,
            value: company.phone === null ? null : linked(`tel:${company.phone}`, company.phone),
          },
          {
            key: 'email',
            label: <Trans>Email</Trans>,
            value: email === null ? null : linked(`mailto:${email}`, email),
          },
          {
            key: 'website',
            label: <Trans>Website</Trans>,
            value: website === null ? null : linked(websiteHref(website), website),
          },
          { key: 'address', label: <Trans>Address</Trans>, value: company.address },
          { key: 'state', label: <Trans>State</Trans>, value: company.state },
          { key: 'city', label: <Trans>City</Trans>, value: company.city },
          {
            key: 'description',
            label: <Trans>Description</Trans>,
            value:
              description === null ? null : (
                <span className="whitespace-pre-line">{description}</span>
              ),
          },
          { key: 'postalCode', label: <Trans>Postal Code</Trans>, value: company.postalCode },
          {
            key: 'country',
            label: <Trans>Country</Trans>,
            value: country === null ? null : countryName(country, i18n.locale),
          },
          {
            key: 'domain',
            label: <Trans>Domain</Trans>,
            value:
              company.domain === null ? null : linked(`https://${company.domain}`, company.domain),
          },
          {
            key: 'created',
            label: <Trans>Created At</Trans>,
            value: (
              <time dateTime={company.createdAt}>{moment.format(new Date(company.createdAt))}</time>
            ),
          },
          {
            key: 'updated',
            label: <Trans>Updated At</Trans>,
            value: (
              <time dateTime={company.updatedAt}>{moment.format(new Date(company.updatedAt))}</time>
            ),
          },
          {
            key: 'createdBy',
            label: <Trans>Created By</Trans>,
            value: company.createdBy === undefined ? null : actorLabel(company.createdBy),
          },
        ];
  useEffect(() => {
    if (move.isPending) return;
    const next = focusNextRef.current;
    focusNextRef.current = null;
    if (next === 'trash') trashRef.current?.focus();
    if (next === 'restore') restoreRef.current?.focus();
  }, [move.isPending, company?.trashedAt]);
  return (
    <Page
      title={company?.name ?? t`Company`}
      actions={
        company?.canManage && !trashed ? (
          <div className="flex flex-wrap gap-2">
            <Button
              ref={editRef}
              variant="secondary"
              onClick={() => {
                setNotice('');
                setAsked(true);
                setEditing(true);
              }}
            >
              <Trans>Edit</Trans>
            </Button>
            <Button
              ref={trashRef}
              variant="secondary"
              disabled={move.isPending}
              onClick={() => {
                move.mutate(true);
              }}
            >
              <Trans>Move to trash</Trans>
            </Button>
          </div>
        ) : undefined
      }
    >
      <Link
        to="/b/$slug/contacts/companies"
        params={{ slug: business.slug }}
        className={`${quietLinkClassName} self-start`}
      >
        <Trans>All companies</Trans>
      </Link>
      {company === undefined ? (
        <CompanyLoading query={current} />
      ) : (
        <>
          {trashed ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-secondary p-4">
              <p>
                <Trans>This company is in the trash.</Trans>
              </p>
              {company.canManage ? (
                <Button
                  ref={restoreRef}
                  variant="secondary"
                  disabled={move.isPending}
                  onClick={() => {
                    move.mutate(false);
                  }}
                >
                  <Trans>Restore</Trans>
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(260px,1fr)]">
            <div className="flex min-w-0 flex-col gap-6">
              <ContactPanel title={t`Details`}>
                <dl className="grid min-w-0 gap-3 sm:grid-cols-[120px_minmax(0,1fr)]">
                  {details.map((detail) => (
                    <div key={detail.key} className="contents">
                      <dt>{detail.label}</dt>
                      <dd className="min-w-0 wrap-anywhere">
                        {detail.value ?? (
                          <span className="text-muted-foreground">
                            <Trans>Not set</Trans>
                          </span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </ContactPanel>
              <Suspense fallback={null}>
                <RecordNotes
                  key={`${business.id}:${companyId}:notes`}
                  recordId={companyId}
                  readOnly={trashed}
                />
                <RecordActivity key={`${business.id}:${companyId}:activity`} recordId={companyId} />
                <RecordTasks
                  key={`${business.id}:${companyId}:tasks`}
                  recordId={companyId}
                  readOnly={trashed}
                />
              </Suspense>
            </div>
            <aside className="flex min-w-0 flex-col gap-6" aria-label={t`Company fields and tags`}>
              <RecordFields
                key={`${business.id}:${companyId}:fields`}
                recordId={companyId}
                readOnly={trashed}
              />
              <Suspense fallback={null}>
                <RecordTags
                  key={`${business.id}:${companyId}:tags`}
                  recordId={companyId}
                  readOnly={trashed}
                />
              </Suspense>
            </aside>
          </div>
        </>
      )}
      {move.isError ? (
        <p role="alert">
          {move.error instanceof ApiError
            ? (move.error.problem.errors?.map((issue) => issue.message).join(' ') ??
              move.error.message)
            : t`The company wasn't changed. Check your connection and try again.`}
        </p>
      ) : null}
      <p role="status" aria-live="polite">
        {notice}
      </p>
      {asked && company !== undefined ? (
        <Suspense fallback={null}>
          <CompanyEditPanel
            company={company}
            open={editing && !trashed}
            returnFocus={editRef}
            onClose={() => {
              setEditing(false);
            }}
            onSaved={async (saved) => {
              cache.setQueryData(companyKey(business.id, companyId), saved);
              await Promise.all([
                cache.invalidateQueries({ queryKey: ['b', business.id, 'companies', 'list'] }),
                cache.invalidateQueries({ queryKey: ['b', business.id, 'activity', companyId] }),
              ]);
              setEditing(false);
              setNotice(t`Company saved.`);
            }}
          />
        </Suspense>
      ) : null}
    </Page>
  );
}
