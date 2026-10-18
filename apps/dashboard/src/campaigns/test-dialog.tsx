// "Send a test": the campaign's email to yourself, or to up to five named addresses for
// someone who may send campaigns, with a contact's values in the merge fields if one is
// chosen. A test is never counted and nobody in the audience gets it; the server's limits
// are said here in plain words.
import { Trans, useLingui } from '@lingui/react/macro';
import { EMAIL_CAMPAIGN_LIMITS, listContacts, sendEmailCampaignTest } from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Textarea } from '@repo/ui/components/textarea';
import { keepPreviousData, useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useId, useState, type ReactElement, type RefObject } from 'react';
import { useSettled } from '../list-table';
import { SearchPicker } from '../search-picker';
import { meQuery } from '../workspace';
import { SmallDialog } from './controls';
import { saidBy } from './data';
import { hintClassName, labelClassName, problemClassName } from './parts';
import { testRecipients } from './rules';

export default function TestDialog({
  client,
  businessId,
  campaignId,
  canSend,
  returnFocus,
  beforeSend,
  onClose,
}: {
  readonly client: Client;
  readonly businessId: string;
  readonly campaignId: string;
  /** Whether the person may name addresses other than their own. */
  readonly canSend: boolean;
  readonly returnFocus: RefObject<HTMLElement | null>;
  /** Saves what is on screen first; false when it could not be saved. */
  readonly beforeSend: () => Promise<boolean>;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const myAddress = useSuspenseQuery(meQuery).data.user.email;
  const [me, setMe] = useState(true);
  const [others, setOthers] = useState('');
  const [contact, setContact] = useState<{ id: string; name: string }>();
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string>();
  const [sent, setSent] = useState<string>();
  const q = useSettled(typed.trim());
  const contacts = useQuery({
    queryKey: ['b', businessId, 'email-preview-contacts', q],
    queryFn: () =>
      client.request(listContacts, { query: { limit: 20, ...(q === '' ? {} : { q }) } }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const send = useMutation({
    mutationFn: async (to: string[]) => {
      if (!(await beforeSend())) throw new Error('unsaved');
      return client.request(sendEmailCampaignTest, {
        params: { id: campaignId },
        body: { to, ...(contact === undefined ? {} : { contactId: contact.id }) },
      });
    },
    onSuccess: (result) => {
      const list = result.to.join(', ');
      setSent(t`The test is on its way to ${list}. It should arrive within a minute or two.`);
    },
    onError: (error) => {
      setProblem(
        error instanceof Error && error.message === 'unsaved'
          ? t`Your last changes couldn't be saved, so no test was sent. Close this and look at what is marked.`
          : saidBy(error, t`The test wasn't sent. Check your connection and try again.`),
      );
    },
  });
  const limit = EMAIL_CAMPAIGN_LIMITS.testAddresses;
  const hourly = EMAIL_CAMPAIGN_LIMITS.testsPerHour;
  return (
    <SmallDialog
      open
      title={t`Send a test`}
      returnFocus={returnFocus}
      onClose={() => {
        if (!send.isPending) onClose();
      }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const recipients = testRecipients(me, others, canSend);
          setSent(undefined);
          if (recipients.problem !== undefined) {
            setProblem(recipients.problem);
            return;
          }
          setProblem(undefined);
          send.mutate(recipients.to);
        }}
      >
        <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-md lg:min-h-0">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={me}
            disabled={send.isPending}
            onChange={(event) => {
              setMe(event.target.checked);
              setProblem(undefined);
            }}
          />
          <span className="min-w-0 wrap-anywhere">{t`To me (${myAddress})`}</span>
        </label>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-others`} className={labelClassName}>
            <Trans>Other addresses</Trans>
          </label>
          <Textarea
            id={`${id}-others`}
            rows={2}
            value={others}
            disabled={!canSend || send.isPending}
            aria-describedby={`${id}-others-hint`}
            onChange={(event) => {
              setOthers(event.target.value);
              setProblem(undefined);
            }}
          />
          <p id={`${id}-others-hint`} className="text-xs text-muted-foreground">
            {canSend
              ? t`Separate addresses with commas. A test goes to at most ${limit} addresses, yours included.`
              : t`Your role can send a test to yourself only. Ask an owner or admin to send one to someone else.`}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <span className={labelClassName}>
            <Trans>Fill the merge fields in for</Trans>
          </span>
          <SearchPicker
            label={t`Contact whose values fill the merge fields`}
            placeholder={t`Nobody: fields stay as written`}
            searchLabel={t`Search contacts`}
            items={[
              { id: '', name: t`Nobody: fields stay as written` },
              ...(contacts.data?.items ?? []).map((each) => ({
                id: each.id,
                name: each.name ?? each.email ?? each.id,
                detail: each.email ?? undefined,
              })),
            ]}
            selected={[contact?.id ?? '']}
            unlisted={() => contact?.name ?? ''}
            loading={contacts.isPending}
            onSearch={setTyped}
            empty={t`No contacts match.`}
            none={t`No contacts match.`}
            onChange={([chosen]) => {
              const found = contacts.data?.items.find((each) => each.id === chosen);
              setContact(
                found === undefined
                  ? undefined
                  : { id: found.id, name: found.name ?? found.email ?? found.id },
              );
            }}
          />
          <p className="text-xs text-muted-foreground">
            <Trans>Nothing is sent to the contact: only their values are used.</Trans>
          </p>
        </div>
        <p className={hintClassName}>
          {t`A test's subject starts with [Test]. It is counted nowhere, nobody in the audience gets it, and its unsubscribe line is a placeholder. A business can send ${hourly} tests an hour.`}
        </p>
        {problem === undefined ? null : (
          <p role="alert" className={problemClassName}>
            {problem}
          </p>
        )}
        <p
          role="status"
          className={sent === undefined ? 'sr-only' : 'text-sm font-medium text-success'}
        >
          {sent ?? ''}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={send.isPending} onClick={onClose}>
            {sent === undefined ? <Trans>Cancel</Trans> : <Trans>Done</Trans>}
          </Button>
          <Button type="submit" disabled={send.isPending}>
            {send.isPending ? t`Sending the test…` : t`Send test`}
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}
