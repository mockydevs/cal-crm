// A draft campaign's email: shown as the server renders it, and opened in the same popup
// editor the workflow builder and the Templates page use (formatted text or plain text).
// "Start from a template" copies a template's subject and text into the draft: the
// template is not changed by what follows, and a later change to it changes nothing here.
//
// Every campaign email shows an unsubscribe link: where the author puts it, or on a
// standard line added at the end. This section says so, and offers the link.
import { Trans, useLingui } from '@lingui/react/macro';
import { EMAIL_UNSUBSCRIBE_MERGE_FIELD, getMessageTemplate } from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useMutation } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { lazy, Suspense, useId, useRef, useState, type ReactElement } from 'react';
import { isEmptyHtml, tokenOf } from '../email-editor/email-html';
import { documentOf, type EmailDocument, type FieldGroupChoice } from '../email-editor/rules';
import TemplatePicker from '../email-step/template-picker';
import { ConfirmDialog } from './controls';
import { saidBy } from './data';
import { CampaignPreview, useCampaignPreview } from './email-parts';
import { hintClassName, labelClassName, Pill, problemClassName } from './parts';
import { textPartOfDraft, type CampaignDraft } from './draft';

const EmailEditor = lazy(() => import('../email-editor/editor-dialog'));

type Written = Pick<CampaignDraft, 'subject' | 'preheader' | 'html' | 'text' | 'ownText'>;

const unsubscribeToken = tokenOf(EMAIL_UNSUBSCRIBE_MERGE_FIELD);

/** Whether the draft has no message yet. */
export const isUnwritten = (draft: Pick<CampaignDraft, 'html' | 'text'>): boolean =>
  draft.html === undefined ? draft.text.trim() === '' : isEmptyHtml(draft.html);

export default function ContentSection({
  client,
  businessId,
  slug,
  draft,
  fields,
  isKnown,
  onChange,
  onSave,
}: {
  readonly client: Client;
  readonly businessId: string;
  readonly slug: string;
  readonly draft: CampaignDraft;
  readonly fields: readonly FieldGroupChoice[];
  readonly isKnown: (path: string) => boolean;
  readonly onChange: (patch: Partial<CampaignDraft>) => void;
  /** Takes what the popup editor holds and saves the draft; a refusal is thrown. */
  readonly onSave: (patch: Partial<CampaignDraft>) => Promise<void>;
}): ReactElement {
  const { t } = useLingui();
  const templateId = useId();
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  // Each opening of the popup starts from the draft as it then is.
  const [editing, setEditing] = useState(0);
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState<{ id: string; written: Written }>();
  const [problem, setProblem] = useState<string>();
  const unwritten = isUnwritten(draft);
  const formatted = draft.html !== undefined;
  const text = textPartOfDraft(draft);
  const preview = useCampaignPreview(
    client,
    businessId,
    { subject: draft.subject, preheader: formatted ? draft.preheader : '', html: draft.html, text },
    !unwritten,
  );
  const placed = formatted
    ? draft.html.includes(unsubscribeToken)
    : draft.text.includes(unsubscribeToken);

  const copy = useMutation({
    mutationFn: (id: string) => client.request(getMessageTemplate, { params: { id } }),
    onSuccess: (read) => {
      const document = documentOf({
        subject: read.subject,
        preheader: read.preheader,
        html: read.content.format === 'html' ? read.content.html : undefined,
        text: read.content.text,
      });
      const written: Written = { ...document };
      // Nothing written here yet: the template is copied at once. Otherwise the person says.
      if (unwritten && draft.subject.trim() === '') onChange(written);
      else setTemplate({ id: read.id, written });
    },
    onError: (error) => {
      setProblem(
        saidBy(error, t`The template couldn't be read. Check your connection and try again.`),
      );
    },
  });

  const document: EmailDocument = {
    subject: draft.subject,
    preheader: draft.preheader,
    html: draft.html,
    text: draft.text,
    ownText: draft.ownText,
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Pill tone="neutral">
            {formatted ? <Trans>Formatted</Trans> : <Trans>Plain text</Trans>}
          </Pill>
          <Button
            ref={editButtonRef}
            onClick={() => {
              setEditing((count) => count + 1);
              setOpen(true);
            }}
          >
            <Pencil aria-hidden className="size-4" strokeWidth={1.8} />
            {unwritten ? <Trans>Write the email</Trans> : <Trans>Edit the email</Trans>}
          </Button>
        </div>
        <div className="flex w-72 max-w-full min-w-0 flex-col gap-1">
          <label htmlFor={templateId} className={labelClassName}>
            <Trans>Start from a template</Trans>
          </label>
          <TemplatePicker
            id={templateId}
            label={t`Start from a template`}
            value={undefined}
            known={[]}
            client={client}
            businessId={businessId}
            manageHref={`/b/${slug}/marketing/emails/templates`}
            onChange={(next) => {
              setProblem(undefined);
              copy.mutate(next);
            }}
          />
        </div>
      </div>
      {problem === undefined ? null : (
        <p role="alert" className={problemClassName}>
          {problem}
        </p>
      )}
      <CampaignPreview preview={preview} empty={unwritten} title={t`The email as it is written`} />
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <p className={`${hintClassName} min-w-0 flex-1 basis-72`}>
          {placed ? (
            <Trans>
              This email places its own unsubscribe link, so no other is added. Each recipient gets
              their own link.
            </Trans>
          ) : (
            <Trans>
              Every campaign email shows an unsubscribe link. This one has none of its own, so a
              standard unsubscribe line is added at its end when it is sent.
            </Trans>
          )}
        </p>
        {placed || unwritten || formatted ? null : (
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              const line = t`Unsubscribe: ${unsubscribeToken}`;
              onChange({ text: `${draft.text.trimEnd()}\n\n${line}\n` });
            }}
          >
            <Trans>Add my own unsubscribe line</Trans>
          </Button>
        )}
      </div>
      {!placed && formatted && !unwritten ? (
        <p className={hintClassName}>
          <Trans>
            To place it yourself, edit the email and use “Insert an unsubscribe link” in the
            toolbar.
          </Trans>
        </p>
      ) : null}
      {open ? (
        <Suspense fallback={null}>
          <EmailEditor
            key={editing}
            name={draft.name}
            renamable
            document={document}
            fields={fields}
            isKnown={isKnown}
            client={client}
            businessId={businessId}
            subjectRequired={false}
            previewFooter={false}
            footerNote={
              <Trans>
                A campaign email leaves as it is written here. One thing is added when it has none
                of its own: an unsubscribe line at its end.
              </Trans>
            }
            onSave={async (saved, name) => {
              await onSave({
                name,
                subject: saved.subject,
                preheader: saved.preheader,
                html: saved.html,
                text: saved.text,
                ownText: saved.ownText,
              });
            }}
            onClose={() => {
              setOpen(false);
              editButtonRef.current?.focus();
            }}
          />
        </Suspense>
      ) : null}
      {template === undefined ? null : (
        <ConfirmDialog
          open
          title={t`Replace what is written?`}
          description={t`The template's subject and text take the place of this campaign's. The template itself is not changed.`}
          confirmLabel={t`Replace with the template`}
          busy={false}
          problem={undefined}
          returnFocus={editButtonRef}
          onConfirm={() => {
            onChange(template.written);
            setTemplate(undefined);
          }}
          onClose={() => {
            setTemplate(undefined);
          }}
        />
      )}
    </div>
  );
}
