// Contacts → Do not disturb on the contacts selected: on or off, for every channel or the
// ones chosen, as GoHighLevel's DND Contact action has it, with the reason the audit log
// keeps. Each contact is changed as its page changes it.
import { Trans, useLingui } from '@lingui/react/macro';
import { dndChannels, DO_NOT_CONTACT_REASON_MIN, type DndChannel } from '@repo/contracts';
import { Field, FieldDescription, FieldLabel } from '@repo/ui/components/field';
import { Textarea } from '@repo/ui/components/textarea';
import { useId, useState, type ReactElement } from 'react';

import { BulkDialogShell, checkClassName, radioClassName, type BulkDialogProps } from './parts';

// WhatsApp sends nothing yet, so do not disturb is not offered for it, as on a contact's page.
const offered = dndChannels.filter((channel) => channel !== 'whatsapp');

export default function DndDialog(props: BulkDialogProps): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const [dnd, setDnd] = useState<'on' | 'off'>('on');
  const [everyChannel, setEveryChannel] = useState(true);
  const [channels, setChannels] = useState<DndChannel[]>([]);
  const [reason, setReason] = useState('');
  const words: Readonly<Record<DndChannel, string>> = {
    call: t`Calls`,
    email: t`Email`,
    sms: t`Text messages`,
    webchat: t`Web chat`,
    whatsapp: t`WhatsApp`,
  };
  const missing =
    !everyChannel && channels.length === 0
      ? t`Choose at least one channel.`
      : reason.trim().length < DO_NOT_CONTACT_REASON_MIN
        ? t`Say why, in at least ${DO_NOT_CONTACT_REASON_MIN} characters.`
        : undefined;
  return (
    <BulkDialogShell
      {...props}
      title={t`Do not disturb`}
      description={t`The change is made on each contact, as on its page.`}
      timing={false}
      missing={missing}
      confirm="apply"
      bodyOf={({ delivery: _now, ...common }) => ({
        action: 'set_dnd',
        dnd,
        channels: everyChannel ? 'all' : channels,
        reason: reason.trim(),
        ...common,
      })}
    >
      {(pending) => (
        <>
          <fieldset className="flex flex-col gap-1">
            <legend className="pb-1.5 text-sm font-medium">
              <Trans>Do not disturb</Trans>
            </legend>
            {(['on', 'off'] as const).map((value) => (
              <label key={value} className={radioClassName}>
                <input
                  type="radio"
                  name={`${id}-dnd`}
                  className="size-4 shrink-0"
                  checked={dnd === value}
                  disabled={pending}
                  onChange={() => {
                    setDnd(value);
                  }}
                />
                {value === 'on' ? <Trans>Turn on</Trans> : <Trans>Turn off</Trans>}
              </label>
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-1">
            <legend className="pb-1.5 text-sm font-medium">
              <Trans>Channels</Trans>
            </legend>
            <label className={checkClassName}>
              <input
                type="checkbox"
                className="size-5 accent-primary"
                checked={everyChannel}
                disabled={pending}
                onChange={(event) => {
                  setEveryChannel(event.target.checked);
                }}
              />
              <Trans>All channels</Trans>
            </label>
            {everyChannel
              ? null
              : offered.map((channel) => (
                  <label key={channel} className={checkClassName}>
                    <input
                      type="checkbox"
                      className="size-5 accent-primary"
                      checked={channels.includes(channel)}
                      disabled={pending}
                      onChange={(event) => {
                        setChannels(
                          event.target.checked
                            ? [...channels.filter((each) => each !== channel), channel]
                            : channels.filter((each) => each !== channel),
                        );
                      }}
                    />
                    {words[channel]}
                  </label>
                ))}
          </fieldset>
          <Field>
            <FieldLabel htmlFor={`${id}-reason`}>
              <Trans>Reason</Trans>
            </FieldLabel>
            <Textarea
              id={`${id}-reason`}
              value={reason}
              disabled={pending}
              maxLength={500}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <FieldDescription>
              <Trans>It is kept in the audit log.</Trans>
            </FieldDescription>
          </Field>
        </>
      )}
    </BulkDialogShell>
  );
}
