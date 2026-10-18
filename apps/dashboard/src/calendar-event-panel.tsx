// What the panel at the right says of a blocked slot pressed on the calendar: everything
// `listCalendarEvents` sends of it, and nothing it does not, with "Edit" for someone who may
// manage calendars (blocked-slot-form.tsx). An appointment opens its own details
// (appointment-details.tsx).
import { Trans } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import type { ReactElement, ReactNode } from 'react';
import { useEventTimes, usePersonName, type BlockedEvent } from './calendar-shared';
import { sidePanelBodyClassName, sidePanelFooterClassName } from './conversation-extras-panel';
import { useBusiness } from './workspace';

const factsClassName = 'flex flex-col gap-4';

function Fact({
  label,
  children,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm wrap-anywhere text-foreground">{children}</dd>
    </div>
  );
}

export function BlockedDetails({
  event,
  zone,
  onEdit,
}: {
  readonly event: BlockedEvent;
  /** The business's zone, which the calendar is drawn in. */
  readonly zone: string;
  /** Opens the form, for someone who may manage calendars; none for anyone else. */
  readonly onEdit: (() => void) | undefined;
}): ReactElement {
  const business = useBusiness();
  const times = useEventTimes(zone);
  const personName = usePersonName(business.id);
  const calendar = event.calendar?.name ?? '';
  return (
    <>
      <div className={sidePanelBodyClassName}>
        <dl className={factsClassName}>
          {event.title === null || event.title === '' ? null : (
            <Fact label={<Trans>Title</Trans>}>{event.title}</Fact>
          )}
          <Fact label={<Trans>Team member</Trans>}>
            {personName(event.user) ?? <Trans>Everyone on the calendar</Trans>}
          </Fact>
          <Fact label={<Trans>Calendar</Trans>}>
            {event.calendar === null ? <Trans>All their calendars</Trans> : calendar}
          </Fact>
          <Fact label={<Trans>When</Trans>}>
            <time dateTime={event.startsAt}>{times.span(event)}</time>{' '}
            <span className="text-muted-foreground">({times.zone})</span>
          </Fact>
        </dl>
        <p className="text-sm text-muted-foreground">
          {event.user === null ? (
            <Trans>Nothing new can be booked on {calendar} in this time.</Trans>
          ) : event.calendar === null ? (
            <Trans>Nothing new can be booked with them in this time, on any calendar.</Trans>
          ) : (
            <Trans>Nothing new can be booked with them on {calendar} in this time.</Trans>
          )}
        </p>
      </div>
      {onEdit === undefined ? null : (
        <div className={sidePanelFooterClassName}>
          <Button className="ml-auto" onClick={onEdit}>
            <Trans>Edit</Trans>
          </Button>
        </div>
      )}
    </>
  );
}
