// A contact's page as GoHighLevel lays it out: the contact's details on the left, their
// conversation in the middle, and on the right one panel at a time, chosen from an icon
// rail and kept in the address. Below 1280px the three don't fit beside the sidebar, so one
// section shows at a time under the contact's summary, chosen from a row of links.
//
// Only what the server has is here: the owner and followers, labelled addresses, do not
// disturb by channel, who created the contact and its audit log; the opportunities the
// contact is with, under Actions (contact-deals.tsx); and the contact's appointments, a
// panel of the rail (contact-appointments.tsx). Payments and agent logs join when their
// data does.
import { Trans, useLingui } from '@lingui/react/macro';
import type { Contact } from '@repo/contracts';
import { Avatar } from '@repo/ui/components/avatar';
import { Button } from '@repo/ui/components/button';
import { cn } from '@repo/ui/lib/utils';
import { CatchBoundary, Link } from '@tanstack/react-router';
import {
  ArrowLeft,
  Building2,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  FolderOpen,
  History,
  StickyNote,
  type LucideIcon,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { RecordAutomationRunsLoader } from './automation-record-runs-loader';
import { tintOf } from './avatar-tint';
import { ContactMemory, PanelFrame } from './contact-panels';
import {
  contactPanels,
  panelOf,
  sectionOf,
  tabOf,
  type ContactPanelName,
  type ContactSearch,
  type ContactSection,
  type ContactTab,
} from './contact-search';
import { ContactWalker, useContactWalk } from './contact-walk';
import { contactTitle } from './contacts';
import { initialsOf, useBusiness } from './workspace';

/** How the page reads and changes its address: the route owns it. */
export interface ContactNavigation {
  /** The address a search would have, for a link's href. */
  readonly hrefFor: (search: ContactSearch) => string;
  readonly go: (search: ContactSearch) => void;
}

const WIDE = '(min-width: 1280px)';

function subscribeToWidth(changed: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', changed);
  return () => {
    query.removeEventListener('change', changed);
  };
}

/** Whether the three panes are side by side, as the styles below have them from 1280px. */
function useWide(): boolean {
  return useSyncExternalStore(
    subscribeToWidth,
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

/**
 * What has been in sight so far, the current one included. A part of the page is drawn
 * when it first comes into sight and then stays, hidden, when another takes its place, so
 * what someone was writing in it is still there when they come back.
 */
function useSeen<Name extends string>(current: Name, inSight: boolean): ReadonlySet<Name> {
  const [seen, setSeen] = useState<ReadonlySet<Name>>(() => new Set(inSight ? [current] : []));
  if (!inSight || seen.has(current)) return seen;
  const next = new Set([...seen, current]);
  setSeen(next);
  return next;
}

/** A real link that changes the address in place; modified clicks open as links do. */
function SectionLink({
  to,
  current,
  navigation,
  children,
  ...anchor
}: {
  readonly to: ContactSearch;
  readonly current: boolean;
  readonly navigation: ContactNavigation;
  readonly children: ReactNode;
  readonly className: string;
  readonly title?: string;
  readonly 'aria-label'?: string;
}): ReactElement {
  return (
    <a
      {...anchor}
      href={navigation.hrefFor(to)}
      aria-current={current ? 'true' : undefined}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        navigation.go(to);
      }}
    >
      {children}
    </a>
  );
}

// What isn't on the page when it opens is fetched when it is first shown: the conversation
// after the contact's details, and the parts and panels other than the first when someone
// opens them. The page's own code stays small for it. Its popovers stay out of the page's
// first chunk.
const RecordTags = lazy(async () => ({ default: (await import('./record-tags')).RecordTags }));
const Conversation = lazy(() => import('./contact-conversation'));
const People = lazy(async () => ({
  default: (await import('./contact-details')).ContactPeople,
}));
const Origin = lazy(async () => ({
  default: (await import('./contact-details')).ContactOrigin,
}));
const Dnd = lazy(() => import('./contact-dnd'));
const ContactFields = lazy(async () => ({
  default: (await import('./contact-fields')).ContactFields,
}));
const Activity = lazy(async () => ({
  default: (await import('./record-activity')).RecordActivity,
}));
const Tasks = lazy(async () => ({ default: (await import('./record-tasks')).RecordTasks }));
const Notes = lazy(async () => ({ default: (await import('./record-notes')).RecordNotes }));
const Companies = lazy(async () => ({
  default: (await import('./contact-companies')).ContactCompanies,
}));
const Deals = lazy(async () => ({ default: (await import('./contact-deals')).ContactDeals }));
const Documents = lazy(async () => ({
  default: (await import('./contact-documents')).ContactDocuments,
}));
const Appointments = lazy(async () => ({
  default: (await import('./contact-appointments')).ContactAppointments,
}));
// The contact's files: uploads, file fields' files and the conversation's attachments.
const Files = lazy(() => import('./contact-files'));
// "Possible duplicates (n)", with its words, which are a catalog of their own.
const PossibleDuplicates = lazy(async () => {
  const [chip, words] = await Promise.all([
    import('./contact-duplicates/possible-chip'),
    import('./contact-duplicates/words'),
  ]);
  await words.loadContactDuplicateWords();
  return chip;
});

/** What the boundary shows itself: nothing, since Deferred shows the failure. */
function Nothing(): null {
  return null;
}

/**
 * A part of the page whose code is fetched after the page. If that code doesn't arrive,
 * the part says so in its place and the rest of the page is as it was. Reloading is the
 * way to try again: React keeps a failed lazy component failed (see note-editor-loader.tsx).
 */
function Deferred({
  name,
  children,
}: {
  /** Tells the parts apart, so one that failed doesn't answer for another. */
  readonly name: string;
  readonly children: ReactNode;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <p role="alert" className="p-1 text-sm">
        <Trans>This part of the page couldn't be loaded. Reload the page to try again.</Trans>
      </p>
    );
  return (
    <CatchBoundary
      getResetKey={() => name}
      errorComponent={Nothing}
      onCatch={() => {
        setFailed(true);
      }}
    >
      <Suspense
        fallback={
          <p role="status" className="p-1">
            <Trans>Loading…</Trans>
          </p>
        }
      >
        {children}
      </Suspense>
    </CatchBoundary>
  );
}

/** A part of the details that folds away under its own heading. */
function Accordion({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <div className="min-w-0 overflow-clip rounded-lg border border-border bg-card">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          className="flex min-h-11 w-full items-center justify-between gap-2 px-3.5 text-left font-medium hover:bg-muted"
          onClick={() => {
            setOpen(!open);
          }}
        >
          {title}
          <Chevron aria-hidden className="size-4 shrink-0" strokeWidth={2} />
        </button>
      </h2>
      {open ? (
        <div id={bodyId} className="border-t border-border p-3.5">
          {children}
        </div>
      ) : null}
    </div>
  );
}

const sectionLinkClassName =
  'inline-flex min-h-11 shrink-0 items-center rounded-control px-3 font-medium whitespace-nowrap text-body hover:bg-muted hover:text-foreground aria-[current=true]:bg-accent aria-[current=true]:text-link';

const tabLinkClassName =
  'inline-flex min-h-11 min-w-0 items-center justify-center rounded px-2 text-center text-[13px] font-medium text-body hover:text-foreground aria-[current=true]:bg-card aria-[current=true]:text-link aria-[current=true]:shadow-[0_1px_2px_rgb(16_24_40/0.08)] xl:min-h-8';

const railLinkClassName =
  'flex size-9 items-center justify-center rounded-control text-body hover:bg-muted hover:text-foreground aria-[current=true]:bg-accent aria-[current=true]:text-link';

export function ContactWorkspace({
  contact,
  search,
  navigation,
  actions,
}: {
  readonly contact: Contact;
  readonly search: ContactSearch;
  readonly navigation: ContactNavigation;
  /** Beside the contact's name: the ways to change or remove the contact. */
  readonly actions: ReactNode;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  // The list the contact was opened from, when it was: Back returns to it as it was.
  const walk = useContactWalk();
  const wide = useWide();
  const detailsId = useId();
  const conversationId = useId();
  const trashed = contact.trashedAt !== null;
  const title = contactTitle(contact) ?? t`Unnamed contact`;

  // On a narrow screen one section shows; on a wide one, all three panes, with one panel.
  const section = sectionOf(search);
  const panel = panelOf(search);
  const tab = tabOf(search);
  const detailsInSight = wide || section === 'details';
  const conversationInSight = wide || section === 'conversation';
  const panelInSight = wide || section === panel;
  const seenTabs = useSeen(tab, detailsInSight);
  const seenPanels = useSeen(panel, panelInSight);
  const conversationSeen = useSeen('conversation', conversationInSight).has('conversation');

  // The panes are as tall as the window leaves them, and each scrolls by itself. How much
  // is above them is measured, since the top bar grows when its tabs wrap.
  const frameRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const measure = () => {
      const top = Math.round(frame.getBoundingClientRect().top + window.scrollY);
      frame.style.setProperty('--panes-top', `${String(top)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => {
      observer.disconnect();
    };
  }, []);

  const panels: Readonly<Record<ContactPanelName, { label: string; icon: LucideIcon }>> = {
    activity: { label: t`Activity`, icon: History },
    tasks: { label: t`Tasks`, icon: ClipboardCheck },
    notes: { label: t`Notes`, icon: StickyNote },
    appointments: { label: t`Appointments`, icon: CalendarDays },
    documents: { label: t`Documents`, icon: FolderOpen },
    companies: { label: t`Companies`, icon: Building2 },
  };
  const sections: readonly { readonly name: ContactSection; readonly label: string }[] = [
    { name: 'details', label: t`Details` },
    { name: 'conversation', label: t`Conversation` },
    ...contactPanels.map((name) => ({ name, label: panels[name].label })),
  ];
  const tabs: readonly { readonly name: ContactTab; readonly label: string }[] = [
    { name: 'fields', label: t`All fields` },
    { name: 'dnd', label: t`DND` },
    { name: 'actions', label: t`Actions` },
  ];
  const withTab = (name: ContactTab): ContactSearch => ({
    ...(search.view === undefined ? {} : { view: search.view }),
    ...(name === 'fields' ? {} : { tab: name }),
  });
  const withView = (view: ContactSection): ContactSearch => ({ ...search, view });

  return (
    <div
      ref={frameRef}
      className="flex min-w-0 flex-col gap-3 xl:-mb-16 xl:h-[calc(100dvh-var(--panes-top,124px)-16px)] xl:min-h-[480px] xl:flex-row"
    >
      <section
        aria-labelledby={detailsId}
        className="relative flex min-w-0 flex-col gap-3 rounded-card bg-panel p-3 xl:w-80 xl:shrink-0 xl:overflow-y-auto"
      >
        <div className="flex min-w-0 items-center gap-1">
          <Link
            to="/b/$slug/contacts"
            params={{ slug: business.slug }}
            search={walk?.search ?? {}}
            aria-label={t`Back to contacts`}
            title={t`Back to contacts`}
            className="flex size-11 shrink-0 items-center justify-center rounded-control text-body hover:bg-muted hover:text-foreground lg:size-9"
          >
            <ArrowLeft aria-hidden className="size-[18px]" strokeWidth={2} />
          </Link>
          <p id={detailsId} className="text-base font-medium">
            <Trans>Contact Details</Trans>
          </p>
          <ContactWalker contactId={contact.id} search={search} />
        </div>

        <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar fallback={initialsOf(title, '?')} tint={tintOf(contact.id)} size="medium" />
            <h1 className="min-w-0 flex-1 text-base font-medium wrap-anywhere">{title}</h1>
            {actions}
          </div>
          <div className={cn(section === 'details' ? 'flex' : 'hidden', 'flex-col gap-3 xl:flex')}>
            <Suspense fallback={null}>
              <People
                key={`people:${business.id}:${contact.id}`}
                contactId={contact.id}
                readOnly={trashed}
              />
            </Suspense>
            <PanelFrame frame="plain">
              <Suspense fallback={null}>
                <RecordTags
                  key={`tags:${business.id}:${contact.id}`}
                  recordId={contact.id}
                  readOnly={trashed}
                />
              </Suspense>
            </PanelFrame>
            {trashed ? null : (
              <Suspense fallback={null}>
                <PossibleDuplicates
                  key={`duplicates:${business.id}:${contact.id}`}
                  contactId={contact.id}
                />
              </Suspense>
            )}
          </div>
        </div>

        <nav
          aria-label={t`Contact sections`}
          className="-mx-1 flex gap-1 overflow-x-auto px-1 py-1 xl:hidden"
        >
          {sections.map((each) => (
            <SectionLink
              key={each.name}
              to={withView(each.name)}
              current={each.name === section}
              navigation={navigation}
              className={sectionLinkClassName}
            >
              {each.label}
            </SectionLink>
          ))}
        </nav>

        <div
          className={cn(
            'min-w-0 flex-col gap-3 xl:flex xl:flex-1',
            section === 'details' ? 'flex' : 'hidden',
          )}
        >
          <nav
            aria-label={t`Contact details`}
            className="grid grid-cols-3 gap-0.5 rounded-control bg-secondary p-0.5"
          >
            {tabs.map((each) => (
              <SectionLink
                key={each.name}
                to={withTab(each.name)}
                current={each.name === tab}
                navigation={navigation}
                className={tabLinkClassName}
              >
                {each.label}
              </SectionLink>
            ))}
          </nav>

          {seenTabs.has('fields') ? (
            <div hidden={tab !== 'fields'}>
              <Deferred name="fields">
                <ContactFields
                  key={`fields:${business.id}:${contact.id}`}
                  contact={contact}
                  readOnly={trashed}
                />
              </Deferred>
            </div>
          ) : null}
          {seenTabs.has('dnd') ? (
            <div hidden={tab !== 'dnd'}>
              <PanelFrame frame="plain">
                <Deferred name="dnd">
                  <Dnd
                    key={`dnd:${business.id}:${contact.id}`}
                    contactId={contact.id}
                    readOnly={trashed}
                  />
                </Deferred>
              </PanelFrame>
            </div>
          ) : null}
          {seenTabs.has('actions') ? (
            <div hidden={tab !== 'actions'}>
              <Accordion title={t`Workflows`}>
                <PanelFrame frame="bare">
                  <RecordAutomationRunsLoader
                    key={`automations:${business.id}:${contact.id}`}
                    recordId={contact.id}
                  />
                </PanelFrame>
              </Accordion>
              <div className="mt-3">
                <Accordion title={t`Opportunities`}>
                  <Deferred name="deals">
                    <Deals
                      key={`deals:${business.id}:${contact.id}`}
                      contactId={contact.id}
                      contactName={title}
                    />
                  </Deferred>
                </Accordion>
              </div>
              <div className="mt-3">
                <Accordion title={t`Quotes & Invoices`}>
                  <Deferred name="documents">
                    <Documents
                      key={`documents:${business.id}:${contact.id}`}
                      contactId={contact.id}
                      readOnly={trashed}
                    />
                  </Deferred>
                </Accordion>
              </div>
            </div>
          ) : null}

          <Suspense fallback={null}>
            <Origin
              key={`origin:${business.id}:${contact.id}`}
              contactId={contact.id}
              createdAt={contact.createdAt}
            />
          </Suspense>
        </div>
      </section>

      <section
        aria-labelledby={conversationId}
        className={cn(
          'min-h-0 min-w-0 flex-1 flex-col rounded-card bg-well p-2 xl:flex',
          section === 'conversation' ? 'flex' : 'hidden',
        )}
      >
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col rounded-lg bg-card xl:overflow-y-auto">
          <div className="z-10 rounded-t-lg border-b border-border bg-card px-4 xl:sticky xl:top-0">
            <h2
              id={conversationId}
              className="-mb-px inline-block border-b-2 border-primary px-1 pt-3 pb-2.5 font-medium text-link"
            >
              <Trans>Conversations</Trans>
            </h2>
          </div>
          {conversationSeen ? (
            <Deferred name="conversation">
              <Conversation
                key={`conversation:${business.id}:${contact.id}`}
                contactId={contact.id}
                shown={conversationInSight}
              />
            </Deferred>
          ) : null}
        </div>
      </section>

      <div
        className={cn(
          'min-h-0 min-w-0 gap-2 xl:flex xl:w-[360px] xl:shrink-0 2xl:w-[400px]',
          section === panel ? 'flex' : 'hidden',
        )}
      >
        <div className="relative min-w-0 flex-1 rounded-card bg-panel p-3.5 xl:overflow-y-auto">
          <PanelFrame frame="plain">
            {seenPanels.has('activity') ? (
              <div hidden={panel !== 'activity'}>
                <Deferred name="activity">
                  <Activity
                    key={`activity:${business.id}:${contact.id}`}
                    recordId={contact.id}
                    lead={
                      <ContactMemory
                        key={`memory:${business.id}:${contact.id}`}
                        contactId={contact.id}
                      />
                    }
                  />
                </Deferred>
              </div>
            ) : null}
            {seenPanels.has('tasks') ? (
              <div hidden={panel !== 'tasks'}>
                <Deferred name="tasks">
                  <Tasks
                    key={`tasks:${business.id}:${contact.id}`}
                    recordId={contact.id}
                    readOnly={trashed}
                  />
                </Deferred>
              </div>
            ) : null}
            {seenPanels.has('notes') ? (
              <div hidden={panel !== 'notes'}>
                <Deferred name="notes">
                  <Notes
                    key={`notes:${business.id}:${contact.id}`}
                    recordId={contact.id}
                    readOnly={trashed}
                  />
                </Deferred>
              </div>
            ) : null}
            {seenPanels.has('appointments') ? (
              <div hidden={panel !== 'appointments'}>
                <Deferred name="appointments">
                  <Appointments
                    key={`appointments:${business.id}:${contact.id}`}
                    contactId={contact.id}
                    contactName={title}
                    readOnly={trashed}
                  />
                </Deferred>
              </div>
            ) : null}
            {seenPanels.has('documents') ? (
              <div hidden={panel !== 'documents'}>
                <Deferred name="files">
                  <Files
                    key={`files:${business.id}:${contact.id}`}
                    contactId={contact.id}
                    readOnly={trashed}
                  />
                </Deferred>
              </div>
            ) : null}
            {seenPanels.has('companies') ? (
              <div hidden={panel !== 'companies'}>
                <Deferred name="companies">
                  <Companies
                    key={`companies:${business.id}:${contact.id}`}
                    contactId={contact.id}
                    readOnly={trashed}
                  />
                </Deferred>
              </div>
            ) : null}
          </PanelFrame>
        </div>
        <nav aria-label={t`Contact panels`} className="hidden shrink-0 flex-col gap-1 pt-1 xl:flex">
          {contactPanels.map((name) => {
            const Icon = panels[name].icon;
            return (
              <SectionLink
                key={name}
                to={withView(name)}
                current={name === panel}
                navigation={navigation}
                aria-label={panels[name].label}
                title={panels[name].label}
                className={railLinkClassName}
              >
                <Icon aria-hidden className="size-[18px]" strokeWidth={1.8} />
              </SectionLink>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

/** The contact's own actions as icon buttons: the route gives them what they do. */
export function ContactActionButton({
  label,
  icon: Icon,
  ...button
}: {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly ref?: (element: HTMLElement | null) => void;
}): ReactElement {
  return (
    <Button
      {...button}
      variant="quiet"
      aria-label={label}
      title={label}
      className="w-11 shrink-0 px-0 lg:w-9"
    >
      <Icon aria-hidden className="size-[18px]" strokeWidth={1.8} />
    </Button>
  );
}
