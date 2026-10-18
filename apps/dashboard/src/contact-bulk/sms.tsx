// Contacts → Send SMS on the contacts selected: one text, filled in for each contact, from
// the number chosen, through the same path as every other message: consent, do not
// disturb, quiet hours and sending limits hold, and a contact skipped says why.
import { Trans, useLingui } from '@lingui/react/macro';
import { CONTACT_BULK_SMS_MAX, listPhoneNumbers } from '@repo/contracts';
import { Field, FieldDescription, FieldLabel } from '@repo/ui/components/field';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';

import { apiIn } from '../api';
import { BulkDialogShell, labelClassName, type BulkDialogProps } from './parts';

const DEFAULT = 'default';

export default function SmsDialog(props: BulkDialogProps): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const [number, setNumber] = useState(DEFAULT);
  const [message, setMessage] = useState('');
  const numbers = useQuery({
    queryKey: ['b', props.businessId, 'phone-numbers'],
    queryFn: () => apiIn(props.businessId).request(listPhoneNumbers, {}),
  });
  const usable = (numbers.data?.data ?? []).filter(
    (each) => each.status === 'active' && each.capabilities.includes('sms'),
  );
  const typed = message.length;
  const mergeField = '{{contact.first_name}}';
  return (
    <BulkDialogShell
      {...props}
      title={t`Send SMS`}
      description={t`Contacts without a phone number, consent or with do not disturb on are skipped, each with its reason.`}
      timing
      missing={message.trim() === '' ? t`Write the message.` : undefined}
      confirm="send"
      bodyOf={(common) => ({
        action: 'send_sms',
        message: message.trim(),
        ...(number === DEFAULT ? {} : { number }),
        ...common,
      })}
    >
      {(pending) => (
        <>
          <label className={labelClassName}>
            <Trans>From number</Trans>
            <Select
              aria-label={t`From number`}
              value={number}
              disabled={pending}
              onValueChange={setNumber}
            >
              <option value={DEFAULT}>{t`The business's only number`}</option>
              {usable.map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name} ({each.e164})
                </option>
              ))}
            </Select>
          </label>
          <Field>
            <FieldLabel htmlFor={`${id}-message`}>
              <Trans>Message</Trans>
            </FieldLabel>
            <Textarea
              id={`${id}-message`}
              value={message}
              disabled={pending}
              maxLength={CONTACT_BULK_SMS_MAX}
              onChange={(event) => {
                setMessage(event.target.value);
              }}
            />
            <FieldDescription>
              <Trans>
                {typed} of {CONTACT_BULK_SMS_MAX} characters. Merge fields such as {mergeField} are
                filled in for each contact.
              </Trans>
            </FieldDescription>
          </Field>
        </>
      )}
    </BulkDialogShell>
  );
}
