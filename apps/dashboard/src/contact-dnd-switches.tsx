// Do not disturb as the DND part of the contact page shows it: "DND all channels", then
// "OR", then one checkbox per channel, then inbound do not disturb on its own. Only the
// channels whose sends the server stops are offered: email, text messages, calls and web
// chat. A channel stored some other way (WhatsApp, which sends nothing yet) is kept as it
// is when this saves. A change is sent with why, which the audit log keeps.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  dndChannelsOf,
  offeredDndChannels,
  setContactDnd,
  type ContactDnd,
  type DndChannel,
  type OfferedDndChannel,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldLabel } from '@repo/ui/components/field';
import { Textarea } from '@repo/ui/components/textarea';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';

import { apiIn } from './api';
import { reasonIsValid } from './contact-add-rules';
import { useContactDetails, useDetailsChange } from './contact-details-data';
import { ContactPanel, ReadProblem } from './contact-panels';
import { REASON_MAX, REASON_MIN } from './contact-preferences-rules';
import { useBusiness } from './workspace';

const checkboxClassName = 'size-4 shrink-0 accent-primary';
const checkLabelClassName = 'flex min-h-11 items-center gap-2.5 text-sm lg:min-h-8';

interface Draft {
  readonly all: boolean;
  readonly channels: readonly DndChannel[];
  readonly inbound: boolean;
}

const draftOf = (saved: ContactDnd): Draft => ({
  all: saved.all,
  channels: saved.channels,
  inbound: saved.inbound,
});

const sameDraft = (draft: Draft, saved: ContactDnd): boolean =>
  draft.all === saved.all &&
  draft.inbound === saved.inbound &&
  JSON.stringify(dndChannelsOf(draft.channels)) === JSON.stringify(dndChannelsOf(saved.channels));

export function ContactDndSwitches({
  contactId,
  readOnly,
}: {
  readonly contactId: string;
  readonly readOnly: boolean;
}): ReactElement {
  const { t } = useLingui();
  const details = useContactDetails(contactId);
  return (
    <ContactPanel title={t`Do not disturb`}>
      {details.isPending ? (
        <p aria-live="polite">
          <Trans>Loading settings…</Trans>
        </p>
      ) : null}
      {details.data === undefined && details.isError ? (
        <ReadProblem
          text={t`Do not disturb couldn't be loaded.`}
          retry={() => {
            void details.refetch();
          }}
        />
      ) : null}
      {details.data === undefined ? null : (
        <Switches
          // Starts again from what is saved whenever that changes, here or elsewhere.
          key={details.data.dnd.revision}
          contactId={contactId}
          saved={details.data.dnd}
          canManage={details.data.canManage && !readOnly}
        />
      )}
    </ContactPanel>
  );
}

function Switches({
  contactId,
  saved,
  canManage,
}: {
  readonly contactId: string;
  readonly saved: ContactDnd;
  readonly canManage: boolean;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const change = useDetailsChange(contactId);
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved));
  const inboundHintId = useId();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const changed = !sameDraft(draft, saved);
  // GoHighLevel's names for its channels; web chat is this product's own.
  const channelNames: Readonly<Record<OfferedDndChannel, string>> = {
    email: t`Email`,
    sms: t`Text messages`,
    call: t`Calls & Voicemails`,
    webchat: t`Web chat`,
  };
  return (
    <form
      className="flex min-w-0 flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (!changed || !reasonIsValid(reason) || change.pending) return;
        change.run(async () => {
          const answer = await apiIn(business.id).request(setContactDnd, {
            params: { id: contactId },
            body: {
              all: draft.all,
              channels: dndChannelsOf(draft.channels),
              inbound: draft.inbound,
              reason,
              revision: saved.revision,
            },
          });
          // Consent's panel and the inbox say what stops a send too.
          await cache.invalidateQueries({ queryKey: ['b', business.id, 'consent', contactId] });
          return answer;
        });
      }}
    >
      <fieldset disabled={!canManage || change.pending} className="flex min-w-0 flex-col gap-1">
        <legend className="sr-only">
          <Trans>Do not disturb</Trans>
        </legend>
        <label className={checkLabelClassName}>
          <input
            type="checkbox"
            className={checkboxClassName}
            checked={draft.all}
            onChange={(event) => {
              setDraft({ ...draft, all: event.target.checked });
            }}
          />
          <Trans>DND all channels</Trans>
        </label>
        <p className="flex items-center gap-3 text-xs font-medium text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
          <Trans>OR</Trans>
        </p>
        {offeredDndChannels.map((channel) => (
          <label key={channel} className={checkLabelClassName}>
            <input
              type="checkbox"
              className={checkboxClassName}
              disabled={draft.all}
              checked={draft.all || draft.channels.includes(channel)}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  channels: event.target.checked
                    ? [...draft.channels, channel]
                    : draft.channels.filter((each) => each !== channel),
                });
              }}
            />
            {channelNames[channel]}
          </label>
        ))}
        <p className="mt-1 flex items-center gap-3 text-xs font-medium text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
          <Trans>Inbound</Trans>
        </p>
        <label className={checkLabelClassName}>
          <input
            type="checkbox"
            className={checkboxClassName}
            checked={draft.inbound}
            aria-describedby={inboundHintId}
            onChange={(event) => {
              setDraft({ ...draft, inbound: event.target.checked });
            }}
          />
          <Trans>Inbound Calls and SMS</Trans>
        </label>
        <p id={inboundHintId} className="text-xs text-muted-foreground">
          <Trans>
            Text messages from this contact are blocked and not shown in conversations. Blocking
            their calls is not available yet.
          </Trans>
        </p>
        {changed ? (
          <>
            <Field invalid={touched && !reasonIsValid(reason)} className="mt-2 min-w-0">
              <FieldLabel>
                <Trans>Reason</Trans>
              </FieldLabel>
              <Textarea
                rows={2}
                required
                maxLength={REASON_MAX}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
              <FieldDescription>
                <Trans>
                  Say why, in at least {REASON_MIN} characters. It is kept with the change.
                </Trans>
              </FieldDescription>
            </Field>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="submit" size="small" disabled={!reasonIsValid(reason)}>
                {change.pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
              </Button>
              <Button
                variant="quiet"
                size="small"
                onClick={() => {
                  setDraft(draftOf(saved));
                  setReason('');
                  setTouched(false);
                  change.clear();
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </>
        ) : null}
      </fieldset>
      {change.problem === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {change.problem}
        </p>
      )}
    </form>
  );
}
