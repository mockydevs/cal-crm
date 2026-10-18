// The contact page's "All fields": a search box over groups that fold, each field a label
// above its value. The contact's own details come first and are changed on the contact's
// form; the fields the business added follow, each changed where it stands, with where its
// value came from and why.
import { Trans, useLingui } from '@lingui/react/macro';
import { listFieldFolders, type Contact, type RecordField } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Input } from '@repo/ui/components/input';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import { lazy, Suspense, useId, useState, type ReactElement, type ReactNode } from 'react';
import { EventExplanation, useActorLabel } from './activity';
import { apiIn } from './api';
import { useContactDetails } from './contact-details-data';
import { matchingGroups, type FieldGroup } from './contact-fields-rules';
import { ReadProblem, useRecordFieldValues, useValueLabel } from './contact-panels';
import { RecordFieldActions } from './record-field-editor';
import { useBusiness } from './workspace';

// Each address with its label and the ways to change it: fetched once the details are.
const ContactAddresses = lazy(async () => ({
  default: (await import('./contact-details')).ContactAddresses,
}));
// Where the contact came from: a group of its own, fetched apart from this page.
const ContactAttribution = lazy(() => import('./reporting/contact-attribution'));
// A file upload field's files and its upload button, fetched when the contact has one.
const RecordFieldFiles = lazy(() => import('./record-field-files'));
// The contact's engagement score and its changes, with the scoring words: both fetched apart
// from this page, side by side.
const ContactScore = lazy(async () => {
  const [score] = await Promise.all([
    import('./scoring/contact-score'),
    import('./scoring/words-loader').then((words) => words.loadScoringWords()),
  ]);
  return score;
});

interface Row {
  readonly id: string;
  readonly label: string;
  readonly body: ReactNode;
  /** A custom field's row: its name and value on the left, its small buttons on the right. */
  readonly tight?: boolean;
}

/** Two dashes to look at, and "Not set" to hear. */
function Unset(): ReactElement {
  return (
    <>
      <span aria-hidden>--</span>
      <span className="sr-only">
        <Trans>Not set</Trans>
      </span>
    </>
  );
}

function Value({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <dd className="min-w-0 font-medium break-words whitespace-pre-wrap text-foreground">
      {children}
    </dd>
  );
}

function Group({
  group,
  open,
  onToggle,
}: {
  readonly group: FieldGroup<Row>;
  readonly open: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  const headingId = useId();
  const listId = useId();
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="min-w-0 overflow-clip rounded-lg border border-border bg-card"
    >
      <h3>
        <button
          type="button"
          id={headingId}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          className="flex min-h-11 w-full items-center justify-between gap-2 px-3.5 text-left font-medium hover:bg-muted"
          onClick={onToggle}
        >
          {group.name}
          <Chevron aria-hidden className="size-4 shrink-0" strokeWidth={2} />
        </button>
      </h3>
      {open ? (
        <dl id={listId} className="flex min-w-0 flex-col gap-3 border-t border-border p-3.5">
          {group.items.map((row) => (
            <div
              key={row.id}
              className={
                row.tight === true
                  ? 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-0.5'
                  : 'relative flex min-w-0 flex-col gap-0.5'
              }
            >
              {row.body}
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

export function ContactFields({
  contact,
  readOnly = false,
}: {
  readonly contact: Contact;
  readonly readOnly?: boolean;
}): ReactElement {
  const { t, i18n } = useLingui();
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const actorLabel = useActorLabel();
  const valueLabel = useValueLabel();
  const { fields, saved } = useRecordFieldValues(contact.id);
  const business = useBusiness();
  const folders = useQuery({
    queryKey: ['b', business.id, 'field-folders', 'contact'],
    queryFn: () =>
      apiIn(business.id).request(listFieldFolders, { query: { objectKey: 'contact' } }),
    staleTime: 60_000,
  });
  // With the details, each address shows its label and can be changed where it stands;
  // until they arrive, or if they don't, the contact's own lists show.
  const detailed = useContactDetails(contact.id).data !== undefined;
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const label = (text: string, extra?: ReactNode) => (
    <dt className="text-sm text-muted-foreground">
      {text} {extra}
    </dt>
  );

  // The contact's own lists: what shows until its details arrive, or if they don't.
  const emailList =
    contact.emails.length === 0 ? (
      <Unset />
    ) : (
      <ul className="flex flex-col gap-1">
        {contact.emails.map((email) => (
          <li key={email}>
            <a href={`mailto:${email}`} className="break-all text-link underline">
              {email}
            </a>
          </li>
        ))}
      </ul>
    );
  const phoneList =
    contact.phones.length === 0 ? (
      <Unset />
    ) : (
      <ul className="flex flex-col gap-1">
        {contact.phones.map((phone) => (
          <li key={phone.number}>
            <a href={`tel:${phone.number}`} className="text-link underline">
              {phone.display}
            </a>
          </li>
        ))}
      </ul>
    );

  const own: readonly Row[] = [
    {
      id: 'firstName',
      label: t`First name`,
      body: (
        <>
          {label(t`First name`)}
          <Value>{contact.firstName ?? <Unset />}</Value>
        </>
      ),
    },
    {
      id: 'lastName',
      label: t`Last name`,
      body: (
        <>
          {label(t`Last name`)}
          <Value>{contact.lastName ?? <Unset />}</Value>
        </>
      ),
    },
    {
      id: 'emails',
      label: t`Email`,
      body: (
        <>
          {label(t`Email`)}
          <Value>
            {detailed ? (
              <Suspense fallback={emailList}>
                {contact.emails.length === 0 ? <Unset /> : null}
                <ContactAddresses contactId={contact.id} kind="email" readOnly={readOnly} />
              </Suspense>
            ) : (
              emailList
            )}
          </Value>
        </>
      ),
    },
    {
      id: 'phones',
      label: t`Phone`,
      body: (
        <>
          {label(t`Phone`)}
          <Value>
            {detailed ? (
              <Suspense fallback={phoneList}>
                {contact.phones.length === 0 ? <Unset /> : null}
                <ContactAddresses contactId={contact.id} kind="phone" readOnly={readOnly} />
              </Suspense>
            ) : (
              phoneList
            )}
          </Value>
        </>
      ),
    },
  ];

  const added = (field: RecordField): Row => {
    const name = field.definition.label;
    const confirmerName = field.confirmedBy?.name;
    const editable = !readOnly && fields.data?.canManage === true && !field.definition.archived;
    return {
      id: field.definition.id,
      label: name,
      tight: true,
      body: (
        <>
          <dt
            className="col-start-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground"
            title={field.definition.description}
          >
            {name}
            {field.definition.archived ? (
              <Badge variant="neutral" className="px-2 py-0 text-xs">
                <Trans>Archived</Trans>
              </Badge>
            ) : null}
          </dt>
          <dd className="col-start-1 min-w-0 font-medium break-words whitespace-pre-wrap text-foreground">
            {field.definition.valueType === 'file' ? (
              <Suspense fallback={field.value === null ? <Unset /> : valueLabel(field)}>
                <RecordFieldFiles recordId={contact.id} field={field} editable={editable} />
              </Suspense>
            ) : field.value === null ? (
              <Unset />
            ) : (
              valueLabel(field)
            )}
          </dd>
          {/* Read out, and shown when the pointer rests on the name: never a line of its own. */}
          <dd className="sr-only">{field.definition.description}</dd>
          {field.source === null ? null : (
            <dd className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
              <Badge
                variant={field.source.kind === 'ai_agent' ? 'assistant' : 'neutral'}
                className="px-2 py-0.5 text-xs"
              >
                {actorLabel({ ...field.source, name: field.source.name ?? null })}
              </Badge>
              {field.updatedAt === null ? null : (
                <time dateTime={field.updatedAt}>{dates.format(new Date(field.updatedAt))}</time>
              )}
              {field.confirmedAt === null ? null : (
                <span>
                  {field.confirmedBy?.you === true ? (
                    <Trans>Confirmed by you</Trans>
                  ) : confirmerName === null || confirmerName === undefined ? (
                    <Trans>Confirmed</Trans>
                  ) : (
                    t`Confirmed by ${confirmerName}`
                  )}
                </span>
              )}
              {field.source.eventId === null ? null : (
                <div className="min-w-0 has-[[aria-expanded=true]]:basis-full">
                  <EventExplanation
                    eventId={field.source.eventId}
                    label={t`Why ${name} has this value`}
                  />
                </div>
              )}
            </dd>
          )}
          {/* A file upload field's files are uploaded and deleted where they are listed. */}
          {editable && field.definition.valueType !== 'file' ? (
            <dd className="col-start-2 row-span-2 row-start-1 self-start has-[form]:col-span-2 has-[form]:col-start-1 has-[form]:row-auto">
              <RecordFieldActions
                recordId={contact.id}
                field={field}
                canConfirm={fields.data?.canConfirm === true}
                saved={saved}
                compact
              />
            </dd>
          ) : null}
        </>
      ),
    };
  };

  const items = fields.data?.items ?? [];
  // One group for each folder that holds a field of this contact, in the folders' own order
  // (Settings → Custom Fields). Until the folders are known, or if they can't be read, the
  // fields still show, together.
  const inFolders = folders.data?.items
    .map((folder) => ({
      id: folder.system ? 'additional' : folder.id,
      name: folder.name,
      items: items.filter((item) => item.definition.folderId === folder.id).map(added),
    }))
    .filter((group) => group.items.length > 0);
  const placed = new Set(folders.data?.items.map((folder) => folder.id));
  const unplaced = items.filter(
    (item) => item.definition.folderId === undefined || !placed.has(item.definition.folderId),
  );
  const groups: readonly FieldGroup<Row>[] = [
    { id: 'contact', name: t`Contact`, items: own },
    ...(inFolders ?? []),
    ...(unplaced.length === 0
      ? []
      : [
          {
            id: inFolders === undefined ? 'additional' : 'other',
            name: inFolders === undefined ? t`Additional Info` : t`Other fields`,
            items: unplaced.map(added),
          },
        ]),
  ];
  const shown = matchingGroups(groups, query);
  const searching = query.trim() !== '';
  return (
    <section aria-label={t`Fields`} className="flex min-w-0 flex-col gap-3">
      {/* Read, not seen: the folders below are third-level headings and need one above them. */}
      <h2 className="sr-only">
        <Trans>Fields</Trans>
      </h2>
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          strokeWidth={2}
        />
        <Input
          type="search"
          aria-label={t`Search fields and folders`}
          placeholder={t`Search fields and folders`}
          maxLength={200}
          className="pl-9"
          value={query}
          onValueChange={setQuery}
        />
      </div>
      {shown.map((group) => (
        <Group
          key={group.id}
          group={group}
          // What was searched for shows, even in a group that was folded away.
          open={searching || !closed.has(group.id)}
          onToggle={() => {
            setClosed((current) => {
              const next = new Set(current);
              if (!next.delete(group.id)) next.add(group.id);
              return next;
            });
          }}
        />
      ))}
      <Suspense fallback={null}>
        <ContactAttribution contactId={contact.id} query={query} />
      </Suspense>
      <Suspense fallback={null}>
        <ContactScore contactId={contact.id} readOnly={readOnly} />
      </Suspense>
      {searching && shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No fields match your search.</Trans>
        </p>
      ) : null}
      {fields.isPending ? (
        <p aria-live="polite">
          <Trans>Loading fields…</Trans>
        </p>
      ) : null}
      {fields.isError ? (
        <ReadProblem
          text={t`The fields couldn't be loaded.`}
          retry={() => {
            void fields.refetch();
          }}
        />
      ) : null}
      {fields.data !== undefined && items.length === 0 && !searching ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No fields have been added for this record.</Trans>
        </p>
      ) : null}
    </section>
  );
}
