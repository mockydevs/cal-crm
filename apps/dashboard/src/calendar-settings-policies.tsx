// Notifications & policies, as GoHighLevel's section in the owner's screenshot. The
// vendor's rows of notifications by channel are not built here, so no "Status labels" are
// drawn; the one real setting is who the public confirmation is sent from. Then the two
// assignment switches, and whether the person who booked may reschedule or cancel, and
// until how long before the meeting.
import { Trans, useLingui } from '@lingui/react/macro';
import { listCalendarSenders } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import {
  AmountField,
  Labeled,
  noteClassName,
  SectionCard,
  SwitchRow,
  type SectionProps,
} from './calendar-settings-parts';
import { noticeUnits } from './calendar-settings-rules';
import { RemindersHint } from './calendar-reminders-hint';

export default function PoliciesSection({
  client,
  businessId,
  businessSlug,
  draft,
  change,
  problems,
  off,
  canManage,
  saved,
}: SectionProps): ReactElement {
  const { t } = useLingui();
  const senders = useInfiniteQuery({
    queryKey: ['calendar-senders', businessId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      client.request(listCalendarSenders, { query: { after: pageParam, limit: 25 } }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: canManage,
  });
  const senderChoices = senders.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SectionCard
        title={<Trans>Notifications</Trans>}
        description={<Trans>Who the confirmation of a public booking is sent from.</Trans>}
      >
        <div className="flex min-w-0 flex-col gap-2 sm:max-w-xl">
          <Labeled label={t`Confirmation sender`} problem={problems['confirmationSenderId']}>
            {(control) => (
              <Select
                {...control}
                disabled={off}
                value={draft.confirmationSenderId ?? ''}
                onValueChange={(value) => {
                  change({ confirmationSenderId: value === '' ? null : value });
                }}
              >
                <option value="">{t`No public confirmation sender`}</option>
                {draft.confirmationSenderId !== null &&
                !senderChoices.some((sender) => sender.id === draft.confirmationSenderId) ? (
                  <option value={draft.confirmationSenderId} disabled>{t`Saved sender`}</option>
                ) : null}
                {senderChoices.map((sender) => (
                  <option key={sender.id} value={sender.id}>
                    {sender.name} · {sender.email}
                  </option>
                ))}
              </Select>
            )}
          </Labeled>
          {draft.confirmationSenderId === null ? (
            <p className={noteClassName}>
              <Trans>
                Public bookings are still taken. Confirmations are emailed only when a sender is
                chosen.
              </Trans>
            </p>
          ) : null}
          {canManage && senders.isPending ? (
            <p role="status" className={noteClassName}>
              <Trans>Loading senders…</Trans>
            </p>
          ) : null}
          {senders.isError ? (
            <p role="alert" className="text-sm text-destructive">
              <Trans>We couldn't load confirmation senders. Try again.</Trans>
            </p>
          ) : null}
          {senders.hasNextPage ? (
            <Button
              variant="quiet"
              className="self-start"
              disabled={senders.isFetchingNextPage}
              onClick={() => {
                void senders.fetchNextPage();
              }}
            >
              <Trans>Load more senders</Trans>
            </Button>
          ) : null}
        </div>
        <RemindersHint
          businessSlug={businessSlug}
          calendarId={saved?.calendar.id}
          className={noteClassName}
        />
      </SectionCard>
      <SectionCard
        title={<Trans>Additional settings</Trans>}
        description={<Trans>Configure additional settings for your calendar.</Trans>}
      >
        <SwitchRow
          label={
            <Trans>
              Assign contacts to their respective calendar team members each time an appointment is
              booked.
            </Trans>
          }
          description={
            <Trans>
              When enabled, a booking from the public booking page makes its host the contact's
              assigned user.
            </Trans>
          }
          checked={draft.assignContactToMember}
          disabled={off}
          onChange={(assignContactToMember) => {
            change({ assignContactToMember });
          }}
        />
        <SwitchRow
          label={<Trans>Skip assigning Contact if the Contact has already an assigned user.</Trans>}
          description={
            <Trans>
              When enabled, a Contact's assigned user will remain the same, even if the appointment
              owner is different.
            </Trans>
          }
          checked={draft.assignContactToMember && draft.skipAssignIfOwned}
          disabled={off || !draft.assignContactToMember}
          onChange={(skipAssignIfOwned) => {
            change({ skipAssignIfOwned });
          }}
        />
        <section
          aria-label={t`Cancellation and reschedule policy`}
          className="flex min-w-0 flex-col gap-4 border-t border-border pt-5"
        >
          <h3 className="text-md font-medium">
            <Trans>Cancellation and reschedule policy:</Trans>
          </h3>
          <SwitchRow
            label={<Trans>Allow rescheduling of meeting</Trans>}
            checked={draft.allowReschedule}
            disabled={off}
            onChange={(allowReschedule) => {
              change({ allowReschedule });
            }}
          />
          <AmountField
            label={t`Rescheduling link will expire`}
            amount={draft.rescheduleCutoff}
            offered={noticeUnits}
            problem={problems['rescheduleCutoffMinutes']}
            disabled={off || !draft.allowReschedule}
            className="sm:max-w-xl"
            description={<Trans>before the meeting. Empty: no time limit.</Trans>}
            onChange={(rescheduleCutoff) => {
              change({ rescheduleCutoff });
            }}
          />
          <SwitchRow
            label={<Trans>Allow cancellation of meeting</Trans>}
            checked={draft.allowCancel}
            disabled={off}
            onChange={(allowCancel) => {
              change({ allowCancel });
            }}
          />
          <AmountField
            label={t`Cancellation link will expire`}
            amount={draft.cancelCutoff}
            offered={noticeUnits}
            problem={problems['cancelCutoffMinutes']}
            disabled={off || !draft.allowCancel}
            className="sm:max-w-xl"
            description={<Trans>before the meeting. Empty: no time limit.</Trans>}
            onChange={(cancelCutoff) => {
              change({ cancelCutoff });
            }}
          />
        </section>
      </SectionCard>
    </div>
  );
}
