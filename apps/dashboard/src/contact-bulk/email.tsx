// Contacts → Send Email on the contacts selected: an email of the person's own or a
// template, filled in for each contact, from the mailbox chosen, through the same path as
// every other message. It counts against the agency's daily ceiling on campaign emails.
import { Trans, useLingui } from '@lingui/react/macro';
import { listMailboxes, listMessageTemplates } from '@repo/contracts';
import { Field, FieldDescription, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';

import { apiIn } from '../api';
import { BulkDialogShell, labelClassName, type BulkDialogProps } from './parts';

const DEFAULT = 'default';

export default function EmailDialog(props: BulkDialogProps): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const api = apiIn(props.businessId);
  const [mailbox, setMailbox] = useState(DEFAULT);
  const [fromName, setFromName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const mailboxes = useQuery({
    queryKey: ['b', props.businessId, 'mailboxes'],
    queryFn: () => api.request(listMailboxes, {}),
  });
  const templates = useQuery({
    queryKey: ['b', props.businessId, 'message-templates', 'bulk'],
    queryFn: () => api.request(listMessageTemplates, { query: { limit: 100 } }),
  });
  const working = (mailboxes.data?.data ?? []).filter((each) => each.status === 'active');
  const mergeField = '{{contact.first_name}}';
  const own = templateId === '';
  const missing = !own
    ? undefined
    : subject.trim() === ''
      ? t`Enter a subject.`
      : body.trim() === ''
        ? t`Write the email, or choose a template.`
        : undefined;
  return (
    <BulkDialogShell
      {...props}
      title={t`Send email`}
      description={t`Contacts without an email address, consent or with do not disturb on are skipped, each with its reason.`}
      timing
      missing={missing}
      confirm="send"
      bodyOf={(common) => ({
        action: 'send_email',
        ...(mailbox === DEFAULT ? {} : { mailbox }),
        ...(fromName.trim() === '' ? {} : { fromName: fromName.trim() }),
        ...(subject.trim() === '' ? {} : { subject: subject.trim() }),
        ...(own ? { body: body.trim() } : { templateId }),
        ...common,
      })}
    >
      {(pending) => (
        <>
          <label className={labelClassName}>
            <Trans>From mailbox</Trans>
            <Select
              aria-label={t`From mailbox`}
              value={mailbox}
              disabled={pending}
              onValueChange={setMailbox}
            >
              <option value={DEFAULT}>{t`The business's only working mailbox`}</option>
              {working.map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name} ({each.email})
                </option>
              ))}
            </Select>
          </label>
          <Field>
            <FieldLabel htmlFor={`${id}-from`}>
              <Trans>From name (optional)</Trans>
            </FieldLabel>
            <Input
              id={`${id}-from`}
              value={fromName}
              disabled={pending}
              maxLength={120}
              onChange={(event) => {
                setFromName(event.target.value);
              }}
            />
          </Field>
          <label className={labelClassName}>
            <Trans>Template</Trans>
            <Select
              aria-label={t`Template`}
              value={templateId}
              disabled={pending}
              onValueChange={setTemplateId}
            >
              <option value="">{t`Write my own email`}</option>
              {(templates.data?.items ?? []).map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name}
                </option>
              ))}
            </Select>
          </label>
          <Field>
            <FieldLabel htmlFor={`${id}-subject`}>
              {own ? <Trans>Subject</Trans> : <Trans>Subject (optional)</Trans>}
            </FieldLabel>
            <Input
              id={`${id}-subject`}
              value={subject}
              disabled={pending}
              maxLength={998}
              onChange={(event) => {
                setSubject(event.target.value.replace(/[\r\n]+/g, ' '));
              }}
            />
          </Field>
          {own ? (
            <Field>
              <FieldLabel htmlFor={`${id}-body`}>
                <Trans>Message</Trans>
              </FieldLabel>
              <Textarea
                id={`${id}-body`}
                value={body}
                disabled={pending}
                maxLength={100_000}
                onChange={(event) => {
                  setBody(event.target.value);
                }}
              />
              <FieldDescription>
                <Trans>
                  Plain text. Merge fields such as {mergeField} are filled in for each contact.
                </Trans>
              </FieldDescription>
            </Field>
          ) : null}
        </>
      )}
    </BulkDialogShell>
  );
}
