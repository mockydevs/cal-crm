// The right-hand pane of Conversations: the details of the contact whose conversation is
// open, the same parts as the contact page's left pane and kept in step with it, since both
// read and change the contact through the same code. Owner, followers and tags; then All
// fields, DND and Actions, one at a time. This file is fetched when the pane is first
// shown, so the Inbox's own code stays small.
import { Trans, useLingui } from '@lingui/react/macro';
import { Avatar } from '@repo/ui/components/avatar';
import { Button } from '@repo/ui/components/button';
import { Link } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { lazy, Suspense, useState, type ReactElement, type ReactNode } from 'react';
import { RecordAutomationRunsLoader } from './automation-record-runs-loader';
import { tintOf } from './avatar-tint';
import { ContactFields } from './contact-fields';
import { PanelFrame } from './contact-panels';
import { ContactLoading, contactTitle, useContact } from './contacts';
import { initialsOf, useBusiness } from './workspace';

// As on the contact page, what isn't needed to show the contact is fetched after it: the
// people it belongs to, and each tab other than the first when it is opened.
// Its popovers stay out of the page's first chunk.
const RecordTags = lazy(async () => ({ default: (await import('./record-tags')).RecordTags }));
const People = lazy(async () => ({
  default: (await import('./contact-details')).ContactPeople,
}));
const Dnd = lazy(() => import('./contact-dnd'));
const Deals = lazy(async () => ({ default: (await import('./contact-deals')).ContactDeals }));

const loading = (
  <p role="status" className="p-1">
    <Trans>Loading…</Trans>
  </p>
);

const tabs = ['fields', 'dnd', 'actions'] as const;
type Tab = (typeof tabs)[number];

const tabClassName =
  'inline-flex min-h-11 min-w-0 items-center justify-center rounded px-2 text-center text-[13px] font-medium text-body hover:text-foreground aria-pressed:bg-card aria-pressed:text-link aria-pressed:shadow-[0_1px_2px_rgb(16_24_40/0.08)] lg:min-h-8';

export interface InboxContactProps {
  readonly contactId: string;
  readonly onClose: () => void;
}

export default function InboxContact({ contactId, onClose }: InboxContactProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const query = useContact(business.id, contactId);
  const contact = query.data;
  const [tab, setTab] = useState<Tab>('fields');
  // A tab is drawn when it is first opened and then stays, hidden, so what someone was
  // changing in it is still there when they come back.
  const [seen, setSeen] = useState<ReadonlySet<Tab>>(() => new Set(['fields']));
  const tabWords: Readonly<Record<Tab, string>> = {
    fields: t`All fields`,
    dnd: t`DND`,
    actions: t`Actions`,
  };
  const trashed = contact !== undefined && contact.trashedAt !== null;
  const title = contact === undefined ? '' : (contactTitle(contact) ?? t`Unnamed contact`);

  return (
    <>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h2 className="min-w-0 text-base font-medium">
          <Trans>Contact Details</Trans>
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          {contact === undefined || trashed ? null : (
            <Link
              to="/b/$slug/contacts/$contactId"
              params={{ slug: business.slug, contactId }}
              className="inline-flex min-h-11 items-center rounded-control px-2 text-sm text-link underline-offset-2 hover:underline lg:min-h-9"
            >
              <Trans>Open contact</Trans>
            </Link>
          )}
          <Button
            variant="quiet"
            size="small"
            className="w-10 px-0 lg:w-8"
            aria-label={t`Close contact details`}
            title={t`Close contact details`}
            onClick={onClose}
          >
            <X aria-hidden className="size-[18px]" strokeWidth={1.8} />
          </Button>
        </div>
      </div>

      {contact === undefined ? (
        <ContactLoading query={query} />
      ) : (
        <>
          <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <Avatar fallback={initialsOf(title, '?')} tint={tintOf(contact.id)} size="medium" />
              <p className="min-w-0 flex-1 text-base font-medium wrap-anywhere">{title}</p>
            </div>
            {trashed ? (
              <p className="text-sm text-muted-foreground">
                <Trans>This contact is in the trash.</Trans>
              </p>
            ) : null}
            <Suspense fallback={null}>
              <People contactId={contact.id} readOnly={trashed} />
            </Suspense>
            <PanelFrame frame="plain">
              <Suspense fallback={null}>
                <RecordTags recordId={contact.id} readOnly={trashed} />
              </Suspense>
            </PanelFrame>
          </div>

          <div
            role="group"
            aria-label={t`Contact details`}
            className="grid grid-cols-3 gap-0.5 rounded-control bg-secondary p-0.5"
          >
            {tabs.map((each) => (
              <button
                key={each}
                type="button"
                aria-pressed={each === tab}
                className={tabClassName}
                onClick={() => {
                  setTab(each);
                  setSeen(new Set([...seen, each]));
                }}
              >
                {tabWords[each]}
              </button>
            ))}
          </div>

          <div hidden={tab !== 'fields'}>
            <ContactFields contact={contact} readOnly={trashed} />
          </div>
          {seen.has('dnd') ? (
            <div hidden={tab !== 'dnd'}>
              <PanelFrame frame="plain">
                <Suspense fallback={loading}>
                  <Dnd contactId={contact.id} readOnly={trashed} />
                </Suspense>
              </PanelFrame>
            </div>
          ) : null}
          {seen.has('actions') ? (
            <div hidden={tab !== 'actions'} className="flex min-w-0 flex-col gap-3">
              <Part title={t`Workflows`}>
                <PanelFrame frame="bare">
                  <RecordAutomationRunsLoader recordId={contact.id} />
                </PanelFrame>
              </Part>
              <Part title={t`Opportunities`}>
                <Suspense fallback={loading}>
                  <Deals contactId={contact.id} />
                </Suspense>
              </Part>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

/** A part of Actions under its own heading. */
function Part({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="min-w-0 overflow-clip rounded-lg border border-border bg-card">
      <h3 className="border-b border-border px-3.5 py-2.5 font-medium">{title}</h3>
      <div className="p-3.5">{children}</div>
    </div>
  );
}
