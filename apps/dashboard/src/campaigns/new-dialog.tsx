// "New campaign": a name, and where it starts from: blank, a message template (its subject
// and text are copied, and the template is not changed by what follows), or a copy of
// another campaign (everything but its schedule and results). The draft is made at once
// and opened in the editor.
//
// It shows the template list, whose words are the email catalog's: fetched with them
// (list-page.tsx).
import { Trans, useLingui } from '@lingui/react/macro';
import { createEmailCampaign, listEmailCampaigns, type EmailCampaign } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState, type ReactElement, type RefObject } from 'react';
import { apiIn } from '../api';
import TemplatePicker from '../email-step/template-picker';
import { useSettled } from '../list-table';
import { SearchPicker } from '../search-picker';
import { SmallDialog } from './controls';
import { campaignKeys, saidBy } from './data';
import { labelClassName, problemClassName } from './parts';
import { statusWords } from './rules';

type Source = 'blank' | 'template' | 'campaign';

export default function NewCampaignDialog({
  businessId,
  slug,
  folderId,
  returnFocus,
  onClose,
  onCreated,
}: {
  readonly businessId: string;
  readonly slug: string;
  /** The folder the list shows, where the new campaign is filed. */
  readonly folderId: string | null;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onCreated: (campaign: EmailCampaign) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const client = useMemo(() => apiIn(businessId), [businessId]);
  const nameId = useId();
  const templateId = useId();
  const [name, setName] = useState('');
  const [source, setSource] = useState<Source>('blank');
  const [template, setTemplate] = useState<string>();
  const [campaign, setCampaign] = useState<{ id: string; name: string }>();
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string>();
  const q = useSettled(typed.trim());
  const campaigns = useQuery({
    queryKey: campaignKeys.list(businessId, { picker: q }),
    queryFn: () =>
      client.request(listEmailCampaigns, { query: { limit: 50, ...(q === '' ? {} : { q }) } }),
    enabled: source === 'campaign',
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const create = useMutation({
    mutationFn: () =>
      client.request(createEmailCampaign, {
        body: {
          name: name.trim(),
          folderId,
          source:
            source === 'template' && template !== undefined
              ? { kind: 'template', templateId: template }
              : source === 'campaign' && campaign !== undefined
                ? { kind: 'campaign', campaignId: campaign.id }
                : { kind: 'blank' },
        },
      }),
    onSuccess: onCreated,
    onError: (error) => {
      setProblem(saidBy(error, t`The campaign wasn't made. Check your connection and try again.`));
    },
  });
  const choices: readonly (readonly [Source, string, string])[] = [
    ['blank', t`Blank`, t`An empty email to write from nothing.`],
    [
      'template',
      t`From a template`,
      t`Its subject and text are copied. Changing the template later changes nothing here.`,
    ],
    [
      'campaign',
      t`Copy of a campaign`,
      t`Everything but its schedule and results: the email, the mailbox and the audience.`,
    ],
  ];
  const submit = (): void => {
    if (name.trim() === '') {
      setProblem(t`Give the campaign a name.`);
      return;
    }
    if (source === 'template' && template === undefined) {
      setProblem(t`Choose the template to start from.`);
      return;
    }
    if (source === 'campaign' && campaign === undefined) {
      setProblem(t`Choose the campaign to copy.`);
      return;
    }
    setProblem(undefined);
    create.mutate();
  };
  return (
    <SmallDialog
      open
      title={t`New campaign`}
      returnFocus={returnFocus}
      onClose={() => {
        if (!create.isPending) onClose();
      }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className={labelClassName}>
            <Trans>Campaign name</Trans>
          </label>
          <Input
            id={nameId}
            value={name}
            maxLength={120}
            autoComplete="off"
            disabled={create.isPending}
            onChange={(event) => {
              setName(event.target.value);
              setProblem(undefined);
            }}
          />
          <p className="text-xs text-muted-foreground">
            <Trans>Only your team sees the name. Recipients see the subject.</Trans>
          </p>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className={`${labelClassName} mb-1`}>
            <Trans>Start from</Trans>
          </legend>
          {choices.map(([value, label, hint]) => (
            <div key={value} className="flex min-w-0 flex-col">
              <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-md font-medium lg:min-h-0">
                <input
                  type="radio"
                  name="source"
                  className="size-4 shrink-0 accent-primary"
                  aria-describedby={`${nameId}-${value}`}
                  checked={source === value}
                  disabled={create.isPending}
                  onChange={() => {
                    setSource(value);
                    setProblem(undefined);
                  }}
                />
                {label}
              </label>
              <p id={`${nameId}-${value}`} className="pl-6.5 text-sm text-muted-foreground">
                {hint}
              </p>
            </div>
          ))}
        </fieldset>
        {source === 'template' ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={templateId} className={labelClassName}>
              <Trans>Template</Trans>
            </label>
            <TemplatePicker
              id={templateId}
              label={t`Template`}
              value={template}
              known={[]}
              client={client}
              businessId={businessId}
              manageHref={`/b/${slug}/marketing/emails/templates`}
              onChange={(next) => {
                setTemplate(next);
                setProblem(undefined);
              }}
            />
          </div>
        ) : null}
        {source === 'campaign' ? (
          <div className="flex flex-col gap-1">
            <span className={labelClassName}>
              <Trans>Campaign to copy</Trans>
            </span>
            <SearchPicker
              label={t`Campaign to copy`}
              placeholder={t`Choose a campaign`}
              searchLabel={t`Search campaign names`}
              items={(campaigns.data?.items ?? []).map((each) => ({
                id: each.id,
                name: each.name,
                detail: each.subject === '' ? undefined : each.subject,
                mark: i18n._(statusWords[each.status]),
              }))}
              selected={campaign === undefined ? [] : [campaign.id]}
              unlisted={() => campaign?.name ?? ''}
              loading={campaigns.isPending}
              onRetry={
                campaigns.isError
                  ? () => {
                      void campaigns.refetch();
                    }
                  : undefined
              }
              onSearch={setTyped}
              empty={t`No campaigns match.`}
              none={t`There are no campaigns to copy yet.`}
              onChange={([id]) => {
                const found = campaigns.data?.items.find((each) => each.id === id);
                setCampaign(found === undefined ? undefined : { id: found.id, name: found.name });
                setProblem(undefined);
              }}
            />
          </div>
        ) : null}
        {problem === undefined ? null : (
          <p role="alert" className={problemClassName}>
            {problem}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={create.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? t`Making the draft…` : t`Create campaign`}
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}
