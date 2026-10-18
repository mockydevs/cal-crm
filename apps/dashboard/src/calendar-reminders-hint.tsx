// Reminders, in a calendar's Notifications: GoHighLevel sends appointment reminders from a
// workflow, and so does this CRM. The line opens "Start from a recipe" on "Appointment
// reminders" with this calendar chosen (automation-search.ts). A calendar not saved yet has
// no id to choose, so it says to save first.
import { Trans } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';

export function RemindersHint({
  businessSlug,
  calendarId,
  className,
}: {
  readonly businessSlug: string;
  /** The saved calendar's id; none for a calendar not saved yet. */
  readonly calendarId: string | undefined;
  readonly className: string;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-t border-border pt-4">
      <h3 className="text-md font-medium">
        <Trans>Reminders</Trans>
      </h3>
      <p className={className}>
        <Trans>
          Reminders before an appointment are sent by a workflow: an email 24 hours and 1 hour
          before, and a text when you have a phone number. A reschedule moves them; a cancellation
          stops them.
        </Trans>
      </p>
      {calendarId === undefined ? (
        <p className={className}>
          <Trans>Save the calendar first, then create its reminder workflow here.</Trans>
        </p>
      ) : (
        <Link
          to="/b/$slug/automations"
          params={{ slug: businessSlug }}
          search={{ recipe: 'appointment_reminders', calendar: calendarId }}
          className="self-start text-md font-medium text-link underline-offset-2 hover:underline"
        >
          <Trans>Create reminder workflow</Trans>
        </Link>
      )}
    </div>
  );
}
