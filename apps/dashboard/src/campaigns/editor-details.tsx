// A draft campaign's details: its name and folder, the mailbox it is sent from (only the
// mailboxes switched on for campaigns are offered, to anyone who may write the campaign), the name recipients see, where replies
// go, and the subject and preview text with the list that inserts a merge field.
import { Trans, useLingui } from '@lingui/react/macro';
import { Input } from '@repo/ui/components/input';
import { Link } from '@tanstack/react-router';
import { useId, useRef, type ReactElement } from 'react';
import { tokenOf } from '../email-editor/email-html';
import { FieldPicker } from '../email-editor/field-picker';
import type { FieldGroupChoice } from '../email-editor/rules';
import { Select } from './controls';
import { useCampaignFolders } from './data';
import type { CampaignDraft, DraftField } from './draft';
import { useCampaignMailboxes } from './mailboxes';
import {
  folderOptions,
  hintClassName,
  labelClassName,
  linkClassName,
  problemClassName,
} from './parts';

export function DetailsSection({
  businessId,
  slug,
  draft,
  problems,
  fields,
  onChange,
}: {
  readonly businessId: string;
  readonly slug: string;
  readonly draft: CampaignDraft;
  readonly problems: Partial<Record<DraftField, string>>;
  readonly fields: readonly FieldGroupChoice[];
  readonly onChange: (patch: Partial<CampaignDraft>) => void;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const subjectRef = useRef<HTMLInputElement>(null);
  const preheaderRef = useRef<HTMLInputElement>(null);
  const folders = useCampaignFolders(businessId);
  const mailboxes = useCampaignMailboxes(businessId);
  const offered = mailboxes.data?.offered ?? [];
  const chosen = mailboxes.data?.all.find((mailbox) => mailbox.id === draft.mailboxId);
  const formatted = draft.html !== undefined;

  /** Puts a merge field where the caret is in a one-line box. */
  const insertInto = (
    box: HTMLInputElement | null,
    field: 'subject' | 'preheader',
    path: string,
  ): void => {
    const value = draft[field];
    const at = box?.selectionStart ?? value.length;
    const end = box?.selectionEnd ?? at;
    onChange({ [field]: value.slice(0, at) + tokenOf(path) + value.slice(end) });
  };
  const chosenName = chosen?.name ?? '';
  const oneLine = (text: string): string => text.replace(/[\r\n]+/g, ' ');

  return (
    <div className="grid min-w-0 gap-x-4 gap-y-3 md:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${id}-name`} className={labelClassName}>
          <Trans>Campaign name</Trans>
        </label>
        <Input
          id={`${id}-name`}
          value={draft.name}
          maxLength={120}
          autoComplete="off"
          aria-invalid={problems.name !== undefined}
          aria-describedby={`${id}-name-hint`}
          onChange={(event) => {
            onChange({ name: event.target.value });
          }}
        />
        {problems.name === undefined ? (
          <p id={`${id}-name-hint`} className="text-xs text-muted-foreground">
            <Trans>Only your team sees it.</Trans>
          </p>
        ) : (
          <p id={`${id}-name-hint`} className={problemClassName}>
            {problems.name}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${id}-folder`} className={labelClassName}>
          <Trans>Folder</Trans>
        </label>
        <Select
          id={`${id}-folder`}
          value={draft.folderId ?? 'root'}
          disabled={!folders.isSuccess}
          onValueChange={(next) => {
            onChange({ folderId: next === 'root' ? null : next });
          }}
        >
          <option value="root">{t`Not in a folder`}</option>
          {folderOptions(folders.data?.items ?? []).map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex min-w-0 flex-col gap-1 md:col-span-2">
        <label htmlFor={`${id}-mailbox`} className={labelClassName}>
          <Trans>From mailbox</Trans>
        </label>
        {mailboxes.isPending ? (
          <p role="status" className={hintClassName}>
            <Trans>Loading mailboxes…</Trans>
          </p>
        ) : mailboxes.isError ? (
          <p role="alert" className="text-sm">
            <Trans>The mailboxes could not be loaded.</Trans>{' '}
            <button
              type="button"
              className={linkClassName}
              onClick={() => {
                void mailboxes.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </button>
          </p>
        ) : offered.length === 0 && draft.mailboxId === null ? (
          <p
            id={`${id}-mailbox`}
            tabIndex={-1}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-body"
          >
            {mailboxes.data.all.length === 0 ? (
              <Trans>
                No mailbox is connected yet. A campaign is sent from one of the business's own
                mailboxes, which someone who manages mailboxes connects.
              </Trans>
            ) : (
              <Trans>
                No mailbox is switched on for campaigns. Someone who manages mailboxes ticks “Use
                for campaigns” for the mailbox campaigns should leave from.
              </Trans>
            )}{' '}
            <Link to="/b/$slug/settings/email" params={{ slug }} className={linkClassName}>
              <Trans>Open Settings → Email Services</Trans>
            </Link>
          </p>
        ) : (
          <>
            <Select
              id={`${id}-mailbox`}
              value={draft.mailboxId ?? ''}
              onValueChange={(next) => {
                onChange({ mailboxId: next === '' ? null : next });
              }}
            >
              <option value="">{t`Choose a mailbox`}</option>
              {draft.mailboxId !== null &&
              !offered.some((mailbox) => mailbox.id === draft.mailboxId) ? (
                <option value={draft.mailboxId}>
                  {chosen === undefined
                    ? t`A mailbox that is gone`
                    : t`${chosenName} (not switched on for campaigns)`}
                </option>
              ) : null}
              {offered.map((mailbox) => (
                <option key={mailbox.id} value={mailbox.id}>
                  {`${mailbox.name} · ${mailbox.email}`}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              <Trans>
                Only mailboxes switched on for campaigns are listed. That switch, the daily limit
                and the setup checks are in
              </Trans>{' '}
              <Link to="/b/$slug/settings/email" params={{ slug }} className={linkClassName}>
                <Trans>Settings → Email Services</Trans>
              </Link>
              .
            </p>
          </>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${id}-from`} className={labelClassName}>
          <Trans>From name</Trans>
        </label>
        <Input
          id={`${id}-from`}
          value={draft.fromName}
          maxLength={120}
          autoComplete="off"
          placeholder={chosen?.displayName === '' ? undefined : chosen?.displayName}
          aria-invalid={problems.fromName !== undefined}
          aria-describedby={`${id}-from-hint`}
          onChange={(event) => {
            onChange({ fromName: oneLine(event.target.value) });
          }}
        />
        <p
          id={`${id}-from-hint`}
          className={
            problems.fromName === undefined ? 'text-xs text-muted-foreground' : problemClassName
          }
        >
          {problems.fromName ?? t`Empty, recipients see the mailbox's own name.`}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${id}-reply`} className={labelClassName}>
          <Trans>Reply-To</Trans>
        </label>
        <Input
          id={`${id}-reply`}
          type="email"
          inputMode="email"
          value={draft.replyTo}
          maxLength={320}
          autoComplete="off"
          aria-invalid={problems.replyTo !== undefined}
          aria-describedby={`${id}-reply-hint`}
          onChange={(event) => {
            onChange({ replyTo: event.target.value.trim() });
          }}
        />
        <p
          id={`${id}-reply-hint`}
          className={
            problems.replyTo === undefined ? 'text-xs text-muted-foreground' : problemClassName
          }
        >
          {problems.replyTo ??
            t`Empty, replies go to the mailbox and show in Conversations. Replies to another address do not.`}
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-1 md:col-span-2">
        <label htmlFor={`${id}-subject`} className={labelClassName}>
          <Trans>Subject</Trans>
        </label>
        <div className="flex min-w-0 items-center gap-1">
          <Input
            id={`${id}-subject`}
            ref={subjectRef}
            value={draft.subject}
            maxLength={255}
            aria-invalid={problems.subject !== undefined}
            onChange={(event) => {
              onChange({ subject: oneLine(event.target.value) });
            }}
          />
          <FieldPicker
            label={t`Insert a field into the subject`}
            fields={fields}
            onInsert={(path) => {
              insertInto(subjectRef.current, 'subject', path);
            }}
          />
        </div>
        {problems.subject === undefined ? null : (
          <p className={problemClassName}>{problems.subject}</p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1 md:col-span-2">
        <label htmlFor={`${id}-preheader`} className={labelClassName}>
          <Trans>Preview text (optional)</Trans>
        </label>
        <div className="flex min-w-0 items-center gap-1">
          <Input
            id={`${id}-preheader`}
            ref={preheaderRef}
            value={formatted ? draft.preheader : ''}
            maxLength={150}
            disabled={!formatted}
            aria-invalid={problems.preheader !== undefined}
            aria-describedby={`${id}-preheader-hint`}
            onChange={(event) => {
              onChange({ preheader: oneLine(event.target.value) });
            }}
          />
          {formatted ? (
            <FieldPicker
              label={t`Insert a field into the preview text`}
              fields={fields}
              onInsert={(path) => {
                insertInto(preheaderRef.current, 'preheader', path);
              }}
            />
          ) : null}
        </div>
        <p
          id={`${id}-preheader-hint`}
          className={
            problems.preheader === undefined ? 'text-xs text-muted-foreground' : problemClassName
          }
        >
          {problems.preheader ??
            (formatted
              ? t`The line mail apps show after the subject.`
              : t`A plain-text email has no preview text: mail apps show its first line.`)}
        </p>
      </div>
    </div>
  );
}
