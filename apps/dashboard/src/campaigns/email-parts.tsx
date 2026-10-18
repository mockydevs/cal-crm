// What a campaign's email is written and shown with: the merge fields a campaign can fill
// in (the contact's own, the business's custom fields of contacts, and the email's own
// unsubscribe link), and the email drawn as the server renders it.
//
// A campaign's body is its author's: nothing but an unsubscribe line is ever added to it.
// So the preview asks for the content alone, without the footer a workflow email is sent
// with.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  contactMergeFields,
  EMAIL_UNSUBSCRIBE_MERGE_FIELD,
  getFields,
  type RenderedEmailPreview,
} from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useMemo, type ReactElement } from 'react';
import type { FieldGroupChoice } from '../email-editor/rules';
import { EmailFrame, PreviewProblem, useEmailPreview } from '../email-step/preview';
import { hintClassName } from './parts';

export interface CampaignFields {
  readonly fields: readonly FieldGroupChoice[];
  readonly isKnown: (path: string) => boolean;
}

/** The fields "Insert a field" lists for a campaign, and whether a path is one of them. */
export function useCampaignFields(client: Client, businessId: string): CampaignFields {
  const { t } = useLingui();
  const custom = useQuery({
    queryKey: ['b', businessId, 'fields'],
    queryFn: () => client.request(getFields, {}),
    staleTime: 60_000,
  });
  return useMemo(() => {
    const own = (custom.data?.items ?? []).filter(
      (field) => field.objectKey === 'contact' && !field.archived,
    );
    const fields: FieldGroupChoice[] = [
      { label: t`Contact`, fields: contactMergeFields.map((path) => ({ path, label: path })) },
      ...(own.length === 0
        ? []
        : [
            {
              label: t`Contact custom fields`,
              fields: own.map((field) => ({
                path: `contact.custom.${field.key}`,
                label: field.label,
              })),
            },
          ]),
      {
        label: t`This email`,
        fields: [{ path: EMAIL_UNSUBSCRIBE_MERGE_FIELD, label: t`Unsubscribe link` }],
      },
    ];
    const paths = new Set(fields.flatMap((group) => group.fields.map((field) => field.path)));
    return {
      fields,
      // Until the business's own fields are read, a custom field is not called unknown.
      isKnown: (path: string): boolean =>
        paths.has(path) ||
        path.startsWith('custom_values.') ||
        path.startsWith('trigger_link.') ||
        (custom.data === undefined && path.startsWith('contact.custom.')),
    };
  }, [custom.data, t]);
}

export interface PreviewedEmail {
  readonly subject: string;
  readonly preheader: string;
  readonly html: string | undefined;
  readonly text: string;
}

/** A campaign's email as the server renders it, merge fields as written. */
export function useCampaignPreview(
  client: Client,
  businessId: string,
  email: PreviewedEmail,
  enabled = true,
): UseQueryResult<RenderedEmailPreview> {
  return useEmailPreview(client, businessId, { ...email, footer: false }, enabled);
}

/** The email in a frame of its own, or why there is nothing to show. */
export function CampaignPreview({
  preview,
  empty,
  title,
}: {
  readonly preview: UseQueryResult<RenderedEmailPreview>;
  /** True when nothing is written yet. */
  readonly empty: boolean;
  readonly title: string;
}): ReactElement {
  if (empty)
    return (
      <p className={hintClassName}>
        <Trans>Nothing is written yet.</Trans>
      </p>
    );
  if (preview.isError) return <PreviewProblem preview={preview} />;
  if (preview.data === undefined)
    return (
      <p role="status" className={hintClassName}>
        <Trans>Loading the preview…</Trans>
      </p>
    );
  return (
    <div className="flex min-w-0 justify-center rounded-xl border border-input bg-muted p-2">
      <EmailFrame
        title={title}
        html={preview.data.html}
        text={preview.data.text}
        className="h-[420px] max-w-[640px] rounded-lg"
      />
    </div>
  );
}
