import { Trans, useLingui } from '@lingui/react/macro';
import {
  getMailboxSendingSettings,
  updateMailboxSendingSettings,
  mailboxSendingInput,
  type MailboxSendingSettings,
  type MailboxSendingInput,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { issuesOf, noRejection, rejection } from './problems';

interface Props {
  readonly client: Client;
  readonly businessId: string;
  readonly mailboxId: string;
}

export function EmailSending(props: Props): ReactElement {
  const { t } = useLingui();
  const current = useQuery({
    queryKey: ['mailbox-sending', props.businessId, props.mailboxId],
    queryFn: () =>
      props.client.request(getMailboxSendingSettings, { params: { id: props.mailboxId } }),
    refetchInterval: 60_000,
  });
  if (current.isPending)
    return <p role="status" className="mt-4 text-sm">{t`Loading sending settings…`}</p>;
  if (current.isError)
    return (
      <p role="alert" className="mt-4 text-sm">
        {t`We couldn't load sending settings.`}{' '}
        <Button
          variant="quiet"
          onClick={() => {
            void current.refetch();
          }}
        >{t`Try again`}</Button>
      </p>
    );
  return <SendingForm {...props} settings={current.data} />;
}

function SendingForm({
  client,
  businessId,
  mailboxId,
  settings,
}: Props & { readonly settings: MailboxSendingSettings }): ReactElement {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [daily, setDaily] = useState(String(settings.dailyLimit));
  const [pacing, setPacing] = useState(String(settings.pacingPerMinute));
  const [warmup, setWarmup] = useState(settings.warmupEnabled);
  const [conversations, setConversations] = useState(settings.useForConversations);
  const [campaigns, setCampaigns] = useState(settings.useForCampaigns);
  const [problem, setProblem] = useState(noRejection);
  const [notice, setNotice] = useState<string>();
  const save = useMutation({
    mutationFn: (body: MailboxSendingInput) =>
      client.request(updateMailboxSendingSettings, { params: { id: mailboxId }, body }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['mailbox-sending', businessId, mailboxId], saved);
      setProblem(noRejection);
      setNotice(t`Sending settings saved.`);
    },
    onError: (error) => {
      const issues = error instanceof ApiError ? (error.problem.errors ?? []) : [];
      setProblem(
        issues.length > 0
          ? rejection(issues)
          : {
              fields: {},
              form:
                error instanceof ApiError
                  ? error.message
                  : t`Sending settings weren't saved. Check your connection and try again.`,
            },
      );
    },
  });
  return (
    <div className="mt-6 border-t border-border pt-5">
      <Form<Record<string, unknown>>
        errors={problem.fields}
        onFormSubmit={() => {
          setNotice(undefined);
          const parsed = mailboxSendingInput.safeParse({
            dailyLimit: Number(daily),
            pacingPerMinute: Number(pacing),
            warmupEnabled: warmup,
            useForConversations: conversations,
            useForCampaigns: campaigns,
          });
          if (!parsed.success) {
            setProblem(rejection(issuesOf(parsed.error)));
            return;
          }
          setProblem(noRejection);
          save.mutate(parsed.data);
        }}
      >
        <fieldset disabled={save.isPending} className="flex min-w-0 flex-col gap-4 border-0 p-0">
          <legend className="mb-3 text-md font-semibold">
            <Trans>Sending limits</Trans>
          </legend>
          <p className="text-sm leading-relaxed text-muted-foreground">
            <Trans>
              The daily cap covers send attempts over a rolling 24 hours. Replies go ahead of
              campaigns and still count toward this cap.
            </Trans>
          </p>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Field name="dailyLimit">
              <FieldLabel>
                <Trans>Daily cap</Trans>
              </FieldLabel>
              <Input
                type="number"
                min={1}
                max={100000}
                step={1}
                required
                value={daily}
                onValueChange={setDaily}
              />
              <FieldError />
            </Field>
            <Field name="pacingPerMinute">
              <FieldLabel>
                <Trans>Messages per minute</Trans>
              </FieldLabel>
              <Input
                type="number"
                min={1}
                max={600}
                step={1}
                required
                value={pacing}
                onValueChange={setPacing}
              />
              <FieldError />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={warmup}
              onChange={(event) => {
                setWarmup(event.target.checked);
              }}
            />
            <Trans>Warm up automated sending</Trans>
          </label>
          <p className="text-sm leading-relaxed text-muted-foreground">
            <Trans>
              Automated sending starts at 50 a day, or your lower cap, and reaches the cap over 28
              days. This doesn't guarantee inbox delivery.
            </Trans>
          </p>
          <p className="text-sm">
            <Trans>Current automated allowance:</Trans> {settings.effectiveAutomatedDailyLimit}{' '}
            <Trans>per 24 hours</Trans>
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:gap-6">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={conversations}
                onChange={(event) => {
                  setConversations(event.target.checked);
                }}
              />
              <Trans>Use for conversations</Trans>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={campaigns}
                onChange={(event) => {
                  setCampaigns(event.target.checked);
                }}
              />
              <Trans>Use for campaigns</Trans>
            </label>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            <Trans>Use a separate mailbox for campaigns to protect your everyday email.</Trans>
          </p>
          {settings.pausedUntil === null ? null : (
            <div className="rounded-card bg-secondary p-3 text-sm">
              <p>
                <Trans>Your provider temporarily refused a send.</Trans>
              </p>
              <p>
                <Trans>Queued sends can resume after:</Trans>{' '}
                <time dateTime={settings.pausedUntil}>
                  {new Date(settings.pausedUntil).toLocaleString()}
                </time>
              </p>
              <p>
                <Trans>
                  Saving settings keeps this pause in place. Receiving email is still available.
                </Trans>
              </p>
            </div>
          )}
          {problem.form === undefined ? null : (
            <p role="alert" className="text-sm text-destructive">
              {problem.form}
            </p>
          )}
          <Button type="submit" className="self-start">
            {save.isPending ? t`Saving…` : t`Save sending settings`}
          </Button>
          {notice === undefined ? null : (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}
        </fieldset>
      </Form>
    </div>
  );
}
