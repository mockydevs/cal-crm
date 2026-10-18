import { Trans, useLingui } from '@lingui/react/macro';
import {
  getContactMemory,
  getRecordFields,
  type RecordField,
  type RecordFields as RecordFieldsData,
} from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { createContext, use, useId, type ReactElement, type ReactNode } from 'react';
import { apiIn } from './api';
import { EventExplanation, useActorLabel } from './activity';
import { useValueLabel } from './field-value-label';
import { useBusiness } from './workspace';
import { RecordFieldActions } from './record-field-editor';

/**
 * How a panel is drawn where it stands: a card of its own (a company's page), a titled
 * part of a pane that is already a card (the contact page's panes), or with no title of
 * its own, under a heading that already names it (an accordion on the contact page).
 */
export type PanelFrameKind = 'card' | 'plain' | 'bare';

const PanelFrameContext = createContext<PanelFrameKind>('card');

export function PanelFrame({
  frame,
  children,
}: {
  readonly frame: PanelFrameKind;
  readonly children: ReactNode;
}): ReactElement {
  return <PanelFrameContext value={frame}>{children}</PanelFrameContext>;
}

export function ContactPanel({
  title,
  beside,
  action,
  children,
}: {
  readonly title: string;
  /** Right after the title, such as the small plus that adds a tag. */
  readonly beside?: ReactNode;
  /** Beside the title: the one thing the panel adds, such as "Add note". */
  readonly action?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  const frame = use(PanelFrameContext);
  const headingId = useId();
  if (frame === 'bare')
    return (
      <section aria-label={title} className="flex min-w-0 flex-col gap-4">
        {beside}
        {action}
        {children}
      </section>
    );
  return (
    <section
      aria-labelledby={headingId}
      className={
        frame === 'card'
          ? 'flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-[22px]'
          : 'flex min-w-0 flex-col gap-4'
      }
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-2">
        <h2
          id={headingId}
          className={frame === 'card' ? 'text-lg font-semibold' : 'text-base font-medium'}
        >
          {title}
        </h2>
        {beside}
        {action === undefined ? null : <div className="ml-auto pl-2">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** What a panel shows before it has anything in it: an icon, what's missing, and a way to add it. */
export function PanelEmpty({
  icon,
  title,
  description,
  action,
}: {
  /** A decorative icon, such as a Lucide icon. */
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col items-center gap-3 px-3 py-8 text-center">
      <span
        aria-hidden
        className="flex size-11 items-center justify-center rounded-full bg-secondary text-secondary-foreground [&_svg]:size-5"
      >
        {icon}
      </span>
      <div className="flex max-w-prose flex-col gap-1">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}
export function ReadProblem({
  text,
  retry,
}: {
  readonly text: string;
  readonly retry: () => void;
}): ReactElement {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 text-sm">
      <p>{text}</p>
      <Button variant="secondary" size="small" onClick={retry}>
        <Trans>Try again</Trans>
      </Button>
    </div>
  );
}
/**
 * What the assistant has summarised about a contact, above the contact's activity. It takes
 * no room until there is a summary: a contact without one shows nothing here.
 */
export function ContactMemory({ contactId }: { readonly contactId: string }): ReactElement | null {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const headingId = useId();
  const memory = useQuery({
    queryKey: ['b', business.id, 'contact-memory', contactId],
    queryFn: () => apiIn(business.id).request(getContactMemory, { params: { id: contactId } }),
  });
  const summary = memory.data?.summary;
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  if (!memory.isError && (summary === undefined || summary === null)) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3"
    >
      <h3 id={headingId} className="text-sm font-medium">
        <Trans>What your assistant knows</Trans>
      </h3>
      {memory.isError ? (
        <ReadProblem
          text={t`The summary couldn't be loaded.`}
          retry={() => {
            void memory.refetch();
          }}
        />
      ) : null}
      {summary === undefined || summary === null ? null : (
        <>
          <p className="leading-relaxed whitespace-pre-wrap break-words text-body">
            {summary.text}
          </p>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="assistant">
              <Trans>AI assistant</Trans>
            </Badge>
            <span>
              <Trans>Updated</Trans>{' '}
              <time dateTime={summary.updatedAt}>{dates.format(new Date(summary.updatedAt))}</time>
            </span>
          </div>
          {summary.throughEventId === null ? null : (
            <EventExplanation
              eventId={summary.throughEventId}
              label={t`Why this summary was updated`}
            />
          )}
        </>
      )}
    </section>
  );
}
// A field's value in words, shared with the contact list.
export { useValueLabel };
/** A record's field values as the server has them, and how a saved one is put among them. */
export function useRecordFieldValues(recordId: string): {
  readonly fields: UseQueryResult<RecordFieldsData>;
  readonly saved: (value: RecordField) => Promise<void>;
} {
  const business = useBusiness();
  const cache = useQueryClient();
  const key = ['b', business.id, 'record-fields', recordId];
  const fields = useQuery({
    queryKey: key,
    queryFn: () => apiIn(business.id).request(getRecordFields, { params: { id: recordId } }),
  });
  const saved = async (value: RecordField) => {
    await cache.cancelQueries({ queryKey: key });
    cache.setQueryData<RecordFieldsData>(key, (current) =>
      current === undefined
        ? undefined
        : {
            ...current,
            items: current.items.map((field) =>
              field.definition.id === value.definition.id ? value : field,
            ),
          },
    );
    await Promise.all([
      cache.invalidateQueries({ queryKey: key }),
      cache.invalidateQueries({ queryKey: ['b', business.id, 'activity', recordId] }),
      cache.invalidateQueries({ queryKey: ['b', business.id, 'contacts', 'list'] }),
      cache.invalidateQueries({ queryKey: ['b', business.id, 'companies', 'list'] }),
      cache.invalidateQueries({ queryKey: ['deals', business.id] }),
    ]);
  };
  return { fields, saved };
}
export function RecordFields({
  recordId,
  readOnly = false,
}: {
  readonly recordId: string;
  readonly readOnly?: boolean;
}): ReactElement {
  const { t, i18n } = useLingui();
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const actorLabel = useActorLabel();
  const valueLabel = useValueLabel();
  const { fields, saved } = useRecordFieldValues(recordId);
  return (
    <ContactPanel title={t`Fields`}>
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
      {fields.data?.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No fields have been added for this record.</Trans>
        </p>
      ) : null}
      <dl className="flex min-w-0 flex-col gap-5">
        {fields.data?.items.map((field) => {
          const label = field.definition.label;
          const confirmerName = field.confirmedBy?.name;
          return (
            <div key={field.definition.id} className="flex min-w-0 flex-col gap-1">
              <dt className="text-sm text-muted-foreground">
                {label}{' '}
                {field.definition.archived ? (
                  <Badge variant="neutral">
                    <Trans>Archived</Trans>
                  </Badge>
                ) : null}
              </dt>
              <dd className="flex min-w-0 flex-col items-start gap-2">
                <p className="max-w-full whitespace-pre-wrap break-words">{valueLabel(field)}</p>
                <p className="text-sm text-muted-foreground break-words">
                  {field.definition.description}
                </p>
                {field.source === null ? null : (
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <Badge variant={field.source.kind === 'ai_agent' ? 'assistant' : 'neutral'}>
                      {actorLabel({ ...field.source, name: field.source.name ?? null })}
                    </Badge>
                    {field.updatedAt === null ? null : (
                      <time dateTime={field.updatedAt}>
                        {dates.format(new Date(field.updatedAt))}
                      </time>
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
                  </div>
                )}
                {field.source?.eventId === null || field.source?.eventId === undefined ? null : (
                  <EventExplanation
                    eventId={field.source.eventId}
                    label={t`Why ${label} has this value`}
                  />
                )}
                {!readOnly && fields.data.canManage && !field.definition.archived ? (
                  <RecordFieldActions
                    recordId={recordId}
                    field={field}
                    canConfirm={fields.data.canConfirm}
                    saved={saved}
                  />
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </ContactPanel>
  );
}
