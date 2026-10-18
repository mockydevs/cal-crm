import { Trans, useLingui } from '@lingui/react/macro';
import { restoreContact, trashContact } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link, useLocation } from '@tanstack/react-router';
import { Pencil, Trash2 } from 'lucide-react';
import { useRef, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { contactSearch, contactSearchString } from '../contact-search';
import { ContactActionButton, ContactWorkspace } from '../contact-workspace';
import { ContactLoading, contactKey, contactTitle, useContact } from '../contacts';
import { Page, usePageTitle } from '../shell/page';
import { useBusiness } from '../workspace';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/contacts/$contactId/');

// A contact in three panes: its details, its conversation, and one panel beside them.
// ?view= says which panel, and ?tab= which part of the details, so a reload or a shared
// link opens the same thing.
export const Route = createFileRoute('/_app/b/$slug/contacts/$contactId/')({
  validateSearch: contactSearch,
  component: ContactPage,
});

function ContactPage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const { contactId } = route.useParams();
  const current = useContact(business.id, contactId);
  if (current.data === undefined)
    return (
      <Page title={t`Contact`}>
        <ContactLoading query={current} />
      </Page>
    );
  return <LoadedContact key={`${business.id}:${contactId}`} contactId={contactId} />;
}

function LoadedContact({ contactId }: { readonly contactId: string }): ReactElement | null {
  const { t } = useLingui();
  const business = useBusiness();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const cache = useQueryClient();
  const client = apiIn(business.id);
  const contact = useContact(business.id, contactId).data;
  const [notice, setNotice] = useState<string>();
  const [problem, setProblem] = useState<string>();
  // The button that replaces the one just used, so the keyboard stays where it was.
  const focusNextRef = useRef<'trash' | 'restore'>(undefined);
  const move = useMutation({
    mutationFn: (toTrash: boolean) =>
      toTrash
        ? client.request(trashContact, { params: { id: contactId } })
        : client.request(restoreContact, { params: { id: contactId } }),
    onMutate: () => {
      setNotice(undefined);
      setProblem(undefined);
    },
    onSuccess: (saved, toTrash) => {
      focusNextRef.current = toTrash ? 'restore' : 'trash';
      cache.setQueryData(contactKey(business.id, contactId), saved);
      setNotice(toTrash ? t`Moved to trash.` : t`Contact restored.`);
    },
    onError: (error, toTrash) => {
      setProblem(
        error instanceof ApiError
          ? error.message
          : toTrash
            ? t`The contact wasn't moved to the trash. Try again.`
            : t`The contact wasn't restored. Try again.`,
      );
    },
  });
  const focusIf = (which: 'trash' | 'restore') => (element: HTMLElement | null) => {
    if (element !== null && focusNextRef.current === which) {
      focusNextRef.current = undefined;
      element.focus();
    }
  };
  usePageTitle(contact === undefined ? t`Contact` : (contactTitle(contact) ?? t`Unnamed contact`));
  if (contact === undefined) return null;

  const trashed = contact.trashedAt !== null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {trashed ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-secondary px-4 py-3 text-secondary-foreground">
          <p className="text-md">
            <Trans>This contact is in the trash.</Trans>
          </p>
          {contact.canManage ? (
            <Button
              ref={focusIf('restore')}
              variant="secondary"
              size="small"
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
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      <p role="status" className="text-sm empty:sr-only">
        {move.isPending ? t`Saving…` : notice}
      </p>
      <ContactWorkspace
        contact={contact}
        search={search}
        navigation={{
          hrefFor: (to) => `${pathname}${contactSearchString(to)}`,
          go: (to) => {
            void navigate({ search: to, replace: true });
          },
        }}
        actions={
          contact.canManage && !trashed ? (
            <>
              <Link
                to="/b/$slug/contacts/$contactId/edit"
                params={{ slug: business.slug, contactId }}
                aria-label={t`Edit`}
                title={t`Edit`}
                className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground lg:size-9"
              >
                <Pencil aria-hidden className="size-[18px]" strokeWidth={1.8} />
              </Link>
              <ContactActionButton
                ref={focusIf('trash')}
                label={t`Move to trash`}
                icon={Trash2}
                disabled={move.isPending}
                onClick={() => {
                  move.mutate(true);
                }}
              />
            </>
          ) : null
        }
      />
    </div>
  );
}
