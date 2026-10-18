import { Trans, useLingui } from '@lingui/react/macro';
import { updateContact } from '@repo/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { apiIn } from '../api';
import {
  ContactForm,
  ContactLoading,
  contactKey,
  contactTitle,
  draftOf,
  quietLinkClassName,
  useContact,
} from '../contacts';
import { Page } from '../shell/page';
import { useBusiness } from '../workspace';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/contacts/$contactId/edit');

export const Route = createFileRoute('/_app/b/$slug/contacts/$contactId/edit')({
  component: EditContactPage,
});

function EditContactPage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const { contactId } = route.useParams();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const client = apiIn(business.id);
  const current = useContact(business.id, contactId);
  const contact = current.data;
  const name = contact === undefined ? undefined : contactTitle(contact);
  const back = (
    <Link
      to="/b/$slug/contacts/$contactId"
      params={{ slug: business.slug, contactId }}
      className={quietLinkClassName}
    >
      <Trans>Cancel</Trans>
    </Link>
  );
  return (
    <Page title={name === undefined ? t`Edit contact` : t`Edit ${name}`}>
      {contact === undefined ? (
        <ContactLoading query={current} />
      ) : contact.trashedAt !== null || !contact.canManage ? (
        <p className="text-md">
          {contact.trashedAt !== null ? (
            <Trans>Restore this contact from the trash before changing it.</Trans>
          ) : (
            <Trans>Only someone with permission can change this contact.</Trans>
          )}{' '}
          {back}
        </p>
      ) : (
        <ContactForm
          initial={draftOf(contact)}
          submitLabel={t`Save changes`}
          save={(body) => client.request(updateContact, { params: { id: contactId }, body })}
          onSaved={async (saved) => {
            cache.setQueryData(contactKey(business.id, contactId), saved);
            await navigate({
              to: '/b/$slug/contacts/$contactId',
              params: { slug: business.slug, contactId },
              replace: true,
            });
          }}
          cancel={back}
        />
      )}
    </Page>
  );
}
