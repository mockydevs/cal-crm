// The right-hand panel the Calendar view, the Appointment list view and a contact's
// Appointments panel share: one
// appointment's details, the form that books a new one, and the form that moves one. What
// each holds is fetched when it first opens. After a change, everything that lists
// appointments is read again.
import { Trans, useLingui } from '@lingui/react/macro';
import type { AppointmentDetail } from '@repo/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { lazy, useState, type ReactElement, type RefObject } from 'react';
import { appointmentKey, appointmentsKey, eventsKey } from './calendar-shared';
import { RightPanel } from './conversation-extras-panel';
import { PanelContent } from './list-toolbar';
import { useBusiness } from './workspace';

const AppointmentForm = lazy(async () => ({
  default: (await import('./appointment-form')).AppointmentForm,
}));
const AppointmentDetails = lazy(async () => ({
  default: (await import('./appointment-details')).AppointmentDetails,
}));

export type OpenedAppointment =
  | {
      readonly kind: 'new';
      readonly start?: Date;
      /** Who it is for, chosen already: a contact's page books for its contact. */
      readonly contact?: { readonly id: string; readonly name: string };
    }
  | { readonly kind: 'view'; readonly id: string }
  | { readonly kind: 'move'; readonly appointment: AppointmentDetail };

export function AppointmentPanels({
  opened,
  onOpen,
  onClose,
  returnFocus,
}: {
  readonly opened: OpenedAppointment | undefined;
  readonly onOpen: (next: OpenedAppointment) => void;
  readonly onClose: () => void;
  readonly returnFocus: RefObject<HTMLElement | null>;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const [notice, setNotice] = useState('');
  const changed = (): void => {
    void cache.invalidateQueries({ queryKey: eventsKey(business.id) });
    void cache.invalidateQueries({ queryKey: appointmentsKey(business.id) });
  };

  return (
    <>
      <p role="status" className="sr-only">
        {notice}
      </p>
      <RightPanel
        open={opened !== undefined}
        onClose={onClose}
        returnFocus={returnFocus}
        title={
          opened?.kind === 'new' ? (
            <Trans>New appointment</Trans>
          ) : opened?.kind === 'move' ? (
            <Trans>Reschedule appointment</Trans>
          ) : (
            <Trans>Appointment</Trans>
          )
        }
      >
        {opened === undefined ? null : (
          <PanelContent>
            {opened.kind === 'view' ? (
              <AppointmentDetails
                key={opened.id}
                id={opened.id}
                onChanged={changed}
                onMove={(appointment) => {
                  onOpen({ kind: 'move', appointment });
                }}
              />
            ) : (
              <AppointmentForm
                key={opened.kind === 'move' ? opened.appointment.id : 'new'}
                appointment={opened.kind === 'move' ? opened.appointment : undefined}
                start={opened.kind === 'new' ? opened.start : undefined}
                contact={opened.kind === 'new' ? opened.contact : undefined}
                onCancel={() => {
                  if (opened.kind === 'move') onOpen({ kind: 'view', id: opened.appointment.id });
                  else onClose();
                }}
                onSaved={(saved, created) => {
                  cache.setQueryData(appointmentKey(business.id, saved.id), saved);
                  changed();
                  setNotice(created ? t`Appointment booked.` : t`Appointment moved.`);
                  onOpen({ kind: 'view', id: saved.id });
                }}
              />
            )}
          </PanelContent>
        )}
      </RightPanel>
    </>
  );
}
