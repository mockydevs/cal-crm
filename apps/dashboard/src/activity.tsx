import { Trans, useLingui } from '@lingui/react/macro';
import { explainEvent, type Actor } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { useId, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { useBusiness } from './workspace';

export function useActorLabel(): (actor: Actor) => string {
  const { t } = useLingui();
  const names = {
    user: t`Team member`,
    ai_agent: t`AI assistant`,
    automation: t`Automation`,
    api_key: t`API key`,
    system: t`System`,
    contact: t`Contact`,
    form: t`Form`,
    import: t`Import`,
  } satisfies Record<Actor['kind'], string>;
  return (actor) => (actor.you ? t`You` : (actor.name ?? names[actor.kind]));
}

export function useEventLabel(): (type: string) => string {
  const { t } = useLingui();
  const names: Readonly<Record<string, string>> = {
    'contact.created': t`Contact created`,
    'contact.updated': t`Contact updated`,
    'contact.trashed': t`Contact moved to trash`,
    'contact.restored': t`Contact restored`,
    'contact.do_not_contact_set': t`Do not contact turned on`,
    'contact.do_not_contact_cleared': t`Do not contact turned off`,
    'contact.dnd_changed': t`Do not disturb changed`,
    'contact.score_changed': t`Engagement score changed`,
    'contact.inbound_dnd_set': t`Inbound do not disturb turned on`,
    'contact.inbound_dnd_cleared': t`Inbound do not disturb turned off`,
    'contact.owner_assigned': t`Owner assigned`,
    'contact.owner_unassigned': t`Owner removed`,
    'contact.follower_added': t`Follower added`,
    'contact.follower_removed': t`Follower removed`,
    'consent.granted': t`Consent given`,
    'consent.withdrawn': t`Consent withdrawn`,
    'company.created': t`Company created`,
    'company.updated': t`Company updated`,
    'company.trashed': t`Company moved to trash`,
    'company.restored': t`Company restored`,
    'contact.company_linked': t`Company linked`,
    'contact.company_link_changed': t`Primary company changed`,
    'contact.company_unlinked': t`Company link removed`,
    'tag.assigned': t`Tag assigned`,
    'tag.removed': t`Tag removed`,
    'tag.created': t`Tag created`,
    'tag.updated': t`Tag updated`,
    'deal.created': t`Deal created`,
    'deal.updated': t`Deal updated`,
    'deal.stage_changed': t`Deal stage changed`,
    'field.value_set': t`Field value set`,
    'field.value_cleared': t`Field value cleared`,
    'field.value_confirmed': t`AI field value confirmed`,
    'record.file_added': t`Document uploaded`,
    'record.file_removed': t`Document deleted`,
    'note.created': t`Note added`,
    'note.updated': t`Note updated`,
    'note.deleted': t`Note deleted`,
    'form.submitted': t`Form submitted`,
    'external_tracking.form_submitted': t`External form submitted`,
    'external_tracking.page_viewed': t`Page visited`,
    'external_tracking.visitor_identified': t`Earlier page visits linked`,
    'appointment.booked': t`Appointment booked`,
    'appointment.rescheduled': t`Appointment rescheduled`,
    'appointment.cancelled': t`Appointment cancelled`,
    'quote.created': t`Quote started`,
    'quote.updated': t`Quote draft changed`,
    'quote.deleted': t`Quote draft deleted`,
    'quote.issued': t`Quote issued`,
    'quote.revised': t`Quote returned to a draft`,
    'quote.sent': t`Quote sent to the customer`,
    'quote.accepted': t`Quote accepted`,
    'quote.declined': t`Quote declined`,
    'quote.converted': t`Quote converted to an invoice`,
    'quote.note_updated': t`Quote's internal note changed`,
    'quote.link_created': t`Link to the quote created`,
    'invoice.created': t`Invoice started`,
    'invoice.updated': t`Invoice draft changed`,
    'invoice.deleted': t`Invoice draft deleted`,
    'invoice.issued': t`Invoice issued`,
    'invoice.revised': t`Invoice returned to a draft`,
    'invoice.sent': t`Invoice sent to the customer`,
    'invoice.paid': t`Invoice paid in full`,
    'invoice.voided': t`Invoice voided`,
    'invoice.note_updated': t`Invoice's internal note changed`,
    'invoice.link_created': t`Link to the invoice created`,
    'payment.recorded': t`Payment recorded`,
    'payment.reversed': t`Payment reversed`,
    'payment.receipt_sent': t`Receipt sent to the customer`,
    'automation.run.continued': t`Workflow wait ended early by a person`,
  };
  return (type) => names[type] ?? type.replace(/[._]/g, ' ');
}

/** An event's readable causal chain; shared by source labels and record activity. */
export function EventExplanation({
  eventId,
  label,
}: {
  readonly eventId: string;
  readonly label: string;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const actorLabel = useActorLabel();
  const eventLabel = useEventLabel();
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const chain = useQuery({
    queryKey: ['b', business.id, 'why', eventId],
    queryFn: () => apiIn(business.id).request(explainEvent, { params: { id: eventId } }),
    enabled: open,
  });
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="min-w-0">
      <Button
        ref={triggerRef}
        variant="quiet"
        size="small"
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Trans>Why?</Trans>
      </Button>
      {open ? (
        <section
          aria-labelledby={headingId}
          className="mt-2 flex min-w-0 flex-col gap-3 rounded-control bg-secondary p-4"
        >
          <h3 id={headingId} className="font-medium break-words">
            {label}
          </h3>
          {chain.isPending ? (
            <p aria-live="polite">
              <Trans>Loading explanation…</Trans>
            </p>
          ) : null}
          {chain.isError ? (
            <div role="alert">
              <p>
                <Trans>The explanation couldn't be loaded.</Trans>
              </p>
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  void chain.refetch();
                }}
              >
                <Trans>Try again</Trans>
              </Button>
            </div>
          ) : null}
          {chain.data === undefined ? null : (
            <>
              <ol className="flex flex-col gap-3">
                {chain.data.items.map((entry) => (
                  <li key={entry.id} className="flex min-w-0 flex-col items-start gap-1">
                    <p className="font-medium break-words">{eventLabel(entry.type)}</p>
                    <Badge
                      variant={entry.actor.kind === 'ai_agent' ? 'assistant' : 'neutral'}
                      className="max-w-full whitespace-normal break-words"
                    >
                      {actorLabel(entry.actor)}
                    </Badge>
                    <time className="text-sm text-muted-foreground" dateTime={entry.occurredAt}>
                      {dates.format(new Date(entry.occurredAt))}
                    </time>
                  </li>
                ))}
              </ol>
              {chain.data.reachesOrigin ? null : (
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    Earlier causes are unavailable. This is the part of the history you can read.
                  </Trans>
                </p>
              )}
            </>
          )}
          <Button
            className="self-start"
            variant="secondary"
            size="small"
            onClick={() => {
              setOpen(false);
              triggerRef.current?.focus();
            }}
          >{t`Close explanation`}</Button>
        </section>
      ) : null}
    </div>
  );
}
