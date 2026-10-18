// The popup email editor, as GoHighLevel's: a large window (the whole screen on a phone)
// named with the email's name, with Preview, Save as new template, Save and Close along its
// top; under them the subject, the preview text, and the message as formatted text or as
// its plain-text part. The workflow builder's Send email action and the Templates page open
// the same one. The formatted-text editor itself is fetched when the window opens
// (rich-text.tsx).
//
// It saves nothing by itself: whoever opened it says what Save does (a template, a step's
// own content, or the template a syncing step sends), and it shows what that refused under
// the part it is about.
//
// Its words are in the email catalog (lingui.config.ts, email-words.ts).
import { Trans, useLingui } from '@lingui/react/macro';
import { EMAIL_CONTENT_LIMITS, listContacts, listMessageTemplateFolders } from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useQuery } from '@tanstack/react-query';
import { Check, Eye, Monitor, Pencil, Smartphone, X } from 'lucide-react';
import { lazy, Suspense, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { EmailFrame, PreviewProblem, useEmailPreview } from '../email-step/preview';
import { SearchPicker } from '../search-picker';
import { folderLabels } from '../template-folder-rules';
import { htmlOfText, textOfHtml, tokenOf } from './email-html';
import { FieldPicker } from './field-picker';
import {
  documentProblems,
  sameDocument,
  sizeOf,
  textPartOf,
  unknownFields,
  type DocumentProblem,
  type EmailDocument,
  type FieldGroupChoice,
} from './rules';

const RichText = lazy(() => import('./rich-text'));

/** Takes the keyboard as it is drawn: for a box that appears because it was asked for. */
const focusOnMount = (node: HTMLElement | null): void => {
  node?.focus();
};

export interface EmailEditorProps {
  /** What the email is called: a template's name, or the action's. */
  readonly name: string;
  /** Lets the name be changed here; the new name goes with the next Save. */
  readonly renamable?: boolean;
  readonly document: EmailDocument;
  readonly fields: readonly FieldGroupChoice[];
  readonly isKnown: (path: string) => boolean;
  readonly client: Client;
  readonly businessId: string;
  /** A step that sends a template may leave the subject to the template. */
  readonly subjectRequired?: boolean;
  /** The longest subject: 255 for a template, 998 for a step's own. */
  readonly subjectLimit?: number;
  /** Said under the top bar: what a save here changes, when that is more than this email. */
  readonly note?: ReactNode;
  /**
   * Said at the foot in place of what a workflow email leaves with, where the email is not
   * a workflow's: a campaign's own rule about its unsubscribe line.
   */
  readonly footerNote?: ReactNode;
  /** False where the email is sent without a workflow email's footer: previewed without it. */
  readonly previewFooter?: boolean;
  /** Opens on the preview, for "Preview with a contact". */
  readonly startInPreview?: boolean;
  /** Whether the person may change it; without, it can be read and previewed. */
  readonly editable?: boolean;
  /** Saves the email. A refusal is thrown, and shown here. */
  readonly onSave: (document: EmailDocument, name: string) => Promise<void>;
  /** Saves the email as a new template in the library; left out where that is not offered. */
  readonly onSaveAsTemplate?:
    | ((name: string, folderId: string | undefined, document: EmailDocument) => Promise<void>)
    | undefined;
  readonly onClose: () => void;
}

type View = 'formatted' | 'plain' | 'preview';

const problemWords = (
  problem: DocumentProblem,
  t: ReturnType<typeof useLingui>['t'],
  subjectLimit: number,
): string => {
  const { html, text, preheader } = EMAIL_CONTENT_LIMITS;
  const number = (value: number): string => value.toLocaleString('en-US');
  const htmlLimit = number(html);
  const textLimit = number(text);
  switch (problem) {
    case 'subject_missing':
      return t`Give the email a subject.`;
    case 'subject_long':
      return t`Use at most ${subjectLimit} characters in the subject.`;
    case 'body_missing':
      return t`Write the message.`;
    case 'html_long':
      return t`The formatted message is over ${htmlLimit} characters. Shorten it, or take out some formatting.`;
    case 'text_long':
      return t`The plain-text part is over ${textLimit} characters.`;
    case 'preheader_long':
      return t`Use at most ${preheader} characters in the preview text.`;
  }
};

export default function EmailEditor({
  name: givenName,
  renamable = false,
  document: given,
  fields,
  isKnown,
  client,
  businessId,
  subjectRequired = true,
  subjectLimit = 255,
  note,
  footerNote,
  previewFooter = true,
  editable = true,
  startInPreview = false,
  onSave,
  onSaveAsTemplate,
  onClose,
}: EmailEditorProps): ReactElement {
  const { t } = useLingui();
  const subjectId = useId();
  const preheaderId = useId();
  const plainId = useId();
  const panelId = useId();
  const popupRef = useRef<HTMLDivElement>(null);
  // What Save was last given: the email is "changed" against this.
  const [base, setBase] = useState({ document: given, name: givenName });
  const [draft, setDraft] = useState(given);
  const [name, setName] = useState(givenName);
  const [renaming, setRenaming] = useState(false);
  const [view, setView] = useState<View>(
    startInPreview ? 'preview' : given.html === undefined ? 'plain' : 'formatted',
  );
  // The formatted editor reads its content once: a new key gives it new content.
  const [formattedKey, setFormattedKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<{ fields: Record<string, string>; form?: string }>();
  const [notice, setNotice] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [contact, setContact] = useState<{ id: string; name: string }>();
  const [contactSearch, setContactSearch] = useState('');

  const changed = editable && (!sameDocument(draft, base.document) || name !== base.name);
  const problems = documentProblems(draft, subjectRequired, subjectLimit);
  const [firstProblem] = problems;
  // The formatted part, for a formatted email: the editor is shown only for one.
  const html = draft.html ?? '';
  const size = sizeOf(draft);
  const unknown = unknownFields(draft, isKnown);
  const formatted = draft.html !== undefined;
  const change = (patch: Partial<EmailDocument>): void => {
    setDraft((before) => ({ ...before, ...patch }));
    setRefused(undefined);
    setNotice(undefined);
  };
  const close = (): void => {
    if (saving) return;
    if (changed) setLeaving(true);
    else onClose();
  };
  const refusalOf = (error: unknown, fallback: string): NonNullable<typeof refused> => {
    if (!(error instanceof ApiError)) return { fields: {}, form: fallback };
    const placed: Record<string, string> = {};
    let form: string | undefined;
    for (const issue of error.problem.errors ?? []) {
      const [, first = ''] = issue.path.split('/');
      const field = first === 'content' || first === 'body' || first === 'html' ? 'body' : first;
      if (['subject', 'preheader', 'body', 'name'].includes(field)) placed[field] ??= issue.message;
      else form ??= issue.message;
    }
    return Object.keys(placed).length === 0 && form === undefined
      ? { fields: {}, form: error.message }
      : { fields: placed, ...(form === undefined ? {} : { form }) };
  };
  const save = async (): Promise<void> => {
    if (saving) return;
    if (problems.length > 0 || name.trim() === '') {
      setRefused({
        fields: {
          ...(name.trim() === '' ? { name: t`Give it a name.` } : {}),
          ...Object.fromEntries(
            problems.map((problem) => [
              problem.startsWith('subject')
                ? 'subject'
                : problem === 'preheader_long'
                  ? 'preheader'
                  : 'body',
              problemWords(problem, t, subjectLimit),
            ]),
          ),
        },
      });
      return;
    }
    setSaving(true);
    setRefused(undefined);
    try {
      await onSave(draft, name.trim());
      setBase({ document: draft, name: name.trim() });
      setName(name.trim());
      setNotice(t`Saved.`);
    } catch (error) {
      setRefused(refusalOf(error, t`The email wasn't saved. Check your connection and try again.`));
    } finally {
      setSaving(false);
    }
  };

  const preview = useEmailPreview(
    client,
    businessId,
    {
      subject: draft.subject,
      preheader: formatted ? draft.preheader : '',
      html: draft.html,
      text: textPartOf(draft),
      contact: contact?.id,
      ...(previewFooter ? {} : { footer: false }),
    },
    view === 'preview',
  );
  const contacts = useQuery({
    queryKey: ['b', businessId, 'email-preview-contacts', contactSearch],
    queryFn: () =>
      client.request(listContacts, {
        query: { limit: 20, ...(contactSearch === '' ? {} : { q: contactSearch }) },
      }),
    enabled: view === 'preview',
    staleTime: 30_000,
  });

  const fieldItems = fields.flatMap((group) =>
    group.fields.map((field) => ({
      id: field.path,
      name: field.label,
      detail: tokenOf(field.path),
      group: group.label,
    })),
  );
  const subjectRef = useRef<HTMLInputElement>(null);
  const tab = (to: View, label: string, icon?: ReactNode): ReactElement => (
    <button
      type="button"
      role="tab"
      aria-selected={view === to}
      aria-controls={panelId}
      tabIndex={view === to ? 0 : -1}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-control px-3 text-sm font-medium text-body outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-selected:bg-card aria-selected:text-link aria-selected:shadow-[0_1px_2px_rgb(16_24_40/0.05)] lg:min-h-8"
      onClick={() => {
        setView(to);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        const tabs = [
          ...(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ??
            []),
        ];
        const next =
          (tabs.indexOf(event.currentTarget) +
            (event.key === 'ArrowRight' ? 1 : -1) +
            tabs.length) %
          tabs.length;
        tabs[next]?.focus();
        tabs[next]?.click();
      }}
    >
      {icon}
      {label}
    </button>
  );
  const used = size.used.toLocaleString('en-US');
  const limit = size.limit.toLocaleString('en-US');
  const unknownList = unknown.map(tokenOf).join(', ');
  const missing = preview.data?.missingFields.map(tokenOf).join(', ') ?? '';
  const contactName = contact?.name ?? '';
  const shownName = name.trim() === '' ? t`Untitled email` : name;

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-60 bg-foreground/40" />
        {/* The same layer as the builder's panels: the editor comes after the panel it was
            opened from, and the media picker it opens comes after it. */}
        <Dialog.Popup
          ref={popupRef}
          initialFocus={() => subjectRef.current ?? true}
          className="fixed inset-0 z-60 flex min-w-0 flex-col bg-card text-card-foreground shadow-xl outline-none sm:inset-4 sm:rounded-card lg:inset-x-[max(2rem,calc(50vw-36rem))] lg:inset-y-6"
        >
          <header className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {renaming ? (
                <>
                  <Dialog.Title className="sr-only">{shownName}</Dialog.Title>
                  <Input
                    aria-label={t`Name`}
                    ref={focusOnMount}
                    maxLength={120}
                    value={name}
                    aria-invalid={refused?.fields['name'] !== undefined}
                    onChange={(event) => {
                      setName(event.target.value);
                      setRefused(undefined);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') setRenaming(false);
                    }}
                  />
                  <Button
                    variant="quiet"
                    size="small"
                    className="px-2.5"
                    aria-label={t`Done renaming`}
                    onClick={() => {
                      setRenaming(false);
                    }}
                  >
                    <Check aria-hidden className="size-4" strokeWidth={2} />
                  </Button>
                </>
              ) : (
                <>
                  <Dialog.Title className="min-w-0 truncate text-lg font-semibold">
                    {shownName}
                  </Dialog.Title>
                  {renamable && editable ? (
                    <Button
                      variant="quiet"
                      size="small"
                      className="px-2.5"
                      aria-label={t`Rename`}
                      title={t`Rename`}
                      onClick={() => {
                        setRenaming(true);
                      }}
                    >
                      <Pencil aria-hidden className="size-4" strokeWidth={1.8} />
                    </Button>
                  ) : null}
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {onSaveAsTemplate === undefined ? null : (
                <Button
                  variant="secondary"
                  size="small"
                  disabled={saving}
                  onClick={() => {
                    setCopying(true);
                  }}
                >
                  <Trans>Save as new template</Trans>
                </Button>
              )}
              {editable ? (
                <Button
                  size="small"
                  disabled={saving}
                  onClick={() => {
                    void save();
                  }}
                >
                  {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
                </Button>
              ) : null}
              <Button
                variant="quiet"
                size="small"
                className="px-2.5"
                aria-label={t`Close`}
                title={t`Close`}
                onClick={close}
              >
                <X aria-hidden className="size-5" strokeWidth={1.8} />
              </Button>
            </div>
          </header>

          {leaving ? (
            <div
              role="alertdialog"
              aria-label={t`Leave without saving?`}
              className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-background px-4 py-3"
            >
              <p className="text-md font-medium">
                <Trans>This email has changes that aren't saved. Close without them?</Trans>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="small"
                  ref={focusOnMount}
                  onClick={() => {
                    setLeaving(false);
                  }}
                >
                  <Trans>Keep editing</Trans>
                </Button>
                <Button size="small" onClick={onClose}>
                  <Trans>Discard changes</Trans>
                </Button>
              </div>
            </div>
          ) : null}
          {copying && onSaveAsTemplate !== undefined ? (
            <SaveAsTemplate
              client={client}
              businessId={businessId}
              suggested={renamable ? name : ''}
              blocked={
                firstProblem === undefined ? undefined : problemWords(firstProblem, t, subjectLimit)
              }
              onCancel={() => {
                setCopying(false);
              }}
              onSave={async (newName, folderId) => {
                await onSaveAsTemplate(newName, folderId, draft);
                setCopying(false);
                setNotice(t`Saved “${newName}” as a new template. This email is unchanged.`);
              }}
            />
          ) : null}
          {note === undefined ? null : (
            <p className="border-b border-border bg-background px-4 py-2 text-sm text-body">
              {note}
            </p>
          )}

          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
            <div className="grid min-w-0 gap-3 lg:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor={subjectId} className="text-xs font-medium text-muted-foreground">
                  <Trans>Subject</Trans>
                </label>
                <div className="flex min-w-0 items-center gap-1">
                  <Input
                    id={subjectId}
                    ref={subjectRef}
                    readOnly={!editable}
                    aria-required={subjectRequired}
                    aria-invalid={refused?.fields['subject'] !== undefined}
                    value={draft.subject}
                    onChange={(event) => {
                      change({ subject: event.target.value.replace(/[\r\n]+/g, ' ') });
                    }}
                  />
                  {editable ? (
                    <SearchPicker
                      label={t`Insert a field into the subject`}
                      placeholder={t`Insert a field`}
                      searchLabel={t`Search fields`}
                      items={fieldItems}
                      selected={[]}
                      empty={t`No fields match.`}
                      none={t`There are no fields to insert.`}
                      tool={
                        <span aria-hidden className="font-mono text-sm">
                          {'{}'}
                        </span>
                      }
                      onChange={([path]) => {
                        if (path === undefined) return;
                        const box = subjectRef.current;
                        const at = box?.selectionStart ?? draft.subject.length;
                        const end = box?.selectionEnd ?? at;
                        change({
                          subject:
                            draft.subject.slice(0, at) + tokenOf(path) + draft.subject.slice(end),
                        });
                      }}
                    />
                  ) : null}
                </div>
                {refused?.fields['subject'] === undefined ? null : (
                  <p className="text-sm font-medium text-destructive">
                    {refused.fields['subject']}
                  </p>
                )}
              </div>
              {formatted ? (
                <div className="flex min-w-0 flex-col gap-1">
                  <label
                    htmlFor={preheaderId}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    <Trans>Preview text (optional)</Trans>
                  </label>
                  <Input
                    id={preheaderId}
                    readOnly={!editable}
                    maxLength={EMAIL_CONTENT_LIMITS.preheader}
                    aria-invalid={refused?.fields['preheader'] !== undefined}
                    value={draft.preheader}
                    onChange={(event) => {
                      change({ preheader: event.target.value.replace(/[\r\n]+/g, ' ') });
                    }}
                  />
                  {refused?.fields['preheader'] === undefined ? null : (
                    <p className="text-sm font-medium text-destructive">
                      {refused.fields['preheader']}
                    </p>
                  )}
                </div>
              ) : null}
            </div>

            <div
              role="tablist"
              aria-label={t`Views of the email`}
              className="inline-flex self-start rounded-lg bg-muted p-1"
            >
              {formatted ? tab('formatted', t`Formatted`) : null}
              {tab('plain', t`Plain text`)}
              {tab('preview', t`Preview`, <Eye aria-hidden className="size-4" strokeWidth={1.8} />)}
            </div>

            <div id={panelId} role="tabpanel" className="flex min-w-0 flex-col gap-2">
              {view === 'formatted' && formatted ? (
                editable ? (
                  <Suspense
                    fallback={
                      <p role="status" className="text-sm text-muted-foreground">
                        <Trans>Loading the editor…</Trans>
                      </p>
                    }
                  >
                    <RichText
                      key={formattedKey}
                      label={t`Email body`}
                      html={html}
                      fieldPicker={(insert) => (
                        <FieldPicker
                          worded
                          label={t`Insert a field`}
                          fields={fields}
                          onInsert={insert}
                        />
                      )}
                      isKnown={isKnown}
                      businessId={businessId}
                      invalid={refused?.fields['body'] !== undefined}
                      onChange={(html) => {
                        change({ html });
                      }}
                    />
                  </Suspense>
                ) : (
                  <EmailFrame
                    title={t`The email as it is written`}
                    html={html}
                    text=""
                    className="h-[60dvh] rounded-xl border border-input"
                  />
                )
              ) : null}
              {view === 'plain' ? (
                <>
                  {formatted && editable ? (
                    <label className="flex min-h-9 items-center gap-2.5 text-md">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={draft.ownText}
                        onChange={(event) => {
                          change({
                            ownText: event.target.checked,
                            text: event.target.checked ? textOfHtml(html) : draft.text,
                          });
                        }}
                      />
                      <Trans>Write the plain-text part myself</Trans>
                    </label>
                  ) : null}
                  <label htmlFor={plainId} className="text-xs font-medium text-muted-foreground">
                    {formatted ? (
                      <Trans>Plain-text part</Trans>
                    ) : (
                      <Trans>Message (plain text)</Trans>
                    )}
                  </label>
                  <Textarea
                    id={plainId}
                    rows={14}
                    readOnly={!editable || (formatted && !draft.ownText)}
                    aria-invalid={!formatted && refused?.fields['body'] !== undefined}
                    value={formatted && !draft.ownText ? textOfHtml(html) : draft.text}
                    onChange={(event) => {
                      change({ text: event.target.value });
                    }}
                  />
                  <p className="text-sm text-muted-foreground">
                    {formatted ? (
                      draft.ownText ? (
                        <Trans>
                          Mail apps that show no formatting show this instead. It no longer follows
                          the formatted message: keep the two saying the same.
                        </Trans>
                      ) : (
                        <Trans>
                          Mail apps that show no formatting show this instead. It is written from
                          the formatted message each time you save.
                        </Trans>
                      )
                    ) : (
                      <Trans>
                        Plain text: sent exactly as written, with merge fields filled in.
                      </Trans>
                    )}
                  </p>
                  {!formatted && editable ? (
                    <Button
                      variant="secondary"
                      size="small"
                      className="self-start"
                      onClick={() => {
                        change({ html: htmlOfText(draft.text), ownText: false });
                        setFormattedKey((key) => key + 1);
                        setView('formatted');
                      }}
                    >
                      <Trans>Convert to formatted</Trans>
                    </Button>
                  ) : null}
                </>
              ) : null}
              {view === 'preview' ? (
                <div className="flex min-w-0 flex-col gap-3">
                  <div className="flex min-w-0 flex-wrap items-end gap-3">
                    <div className="flex w-64 max-w-full min-w-0 flex-col gap-1">
                      <span className="text-xs font-medium text-muted-foreground">
                        <Trans>Fill the fields in for</Trans>
                      </span>
                      <SearchPicker
                        label={t`Contact to preview with`}
                        placeholder={t`Nobody: fields as written`}
                        searchLabel={t`Search contacts`}
                        items={[
                          { id: '', name: t`Nobody: fields as written` },
                          ...(contacts.data?.items ?? []).map((each) => ({
                            id: each.id,
                            name: each.name ?? each.email ?? each.id,
                            detail: each.email ?? undefined,
                          })),
                        ]}
                        selected={[contact?.id ?? '']}
                        unlisted={() => contact?.name ?? ''}
                        loading={contacts.isPending}
                        onSearch={setContactSearch}
                        empty={t`No contacts match.`}
                        none={t`No contacts match.`}
                        onChange={([id]) => {
                          const found = contacts.data?.items.find((each) => each.id === id);
                          setContact(
                            found === undefined
                              ? undefined
                              : { id: found.id, name: found.name ?? found.email ?? found.id },
                          );
                        }}
                      />
                    </div>
                    <div role="group" aria-label={t`Width`} className="flex gap-1">
                      <Button
                        variant={device === 'desktop' ? 'primary' : 'secondary'}
                        size="small"
                        aria-pressed={device === 'desktop'}
                        onClick={() => {
                          setDevice('desktop');
                        }}
                      >
                        <Monitor aria-hidden className="size-4" strokeWidth={1.8} />
                        <Trans>Desktop</Trans>
                      </Button>
                      <Button
                        variant={device === 'mobile' ? 'primary' : 'secondary'}
                        size="small"
                        aria-pressed={device === 'mobile'}
                        onClick={() => {
                          setDevice('mobile');
                        }}
                      >
                        <Smartphone aria-hidden className="size-4" strokeWidth={1.8} />
                        <Trans>Mobile</Trans>
                      </Button>
                    </div>
                  </div>
                  {problems.includes('body_missing') ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>There is no message to preview yet.</Trans>
                    </p>
                  ) : preview.isError ? (
                    <PreviewProblem preview={preview} />
                  ) : preview.data === undefined ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      <Trans>Loading the preview…</Trans>
                    </p>
                  ) : (
                    <>
                      <dl className="flex min-w-0 flex-col gap-1 text-md">
                        <div className="flex min-w-0 gap-2">
                          <dt className="shrink-0 text-xs leading-6 font-medium text-muted-foreground">
                            <Trans>Subject</Trans>
                          </dt>
                          <dd className="min-w-0 font-medium wrap-anywhere">
                            {preview.data.subject}
                          </dd>
                        </div>
                        {preview.data.preheader === null ? null : (
                          <div className="flex min-w-0 gap-2">
                            <dt className="shrink-0 text-xs leading-6 font-medium text-muted-foreground">
                              <Trans>Preview text</Trans>
                            </dt>
                            <dd className="min-w-0 text-body wrap-anywhere">
                              {preview.data.preheader}
                            </dd>
                          </div>
                        )}
                      </dl>
                      {preview.data.missingFields.length === 0 ? null : (
                        <p
                          role="status"
                          className="rounded-xl bg-secondary px-3 py-2 text-sm text-secondary-foreground"
                        >
                          {contact === undefined
                            ? t`Not filled in here: ${missing}. Choose a contact to see their values.`
                            : t`${contactName} has no value for ${missing}. A send to them would stop there rather than leave a gap.`}
                        </p>
                      )}
                      {preview.data.subjectLineBreak.length === 0 ? null : (
                        <p role="alert" className="text-sm text-destructive">
                          <Trans>
                            A value in the subject holds a line break, which a subject can't. A send
                            would stop.
                          </Trans>
                        </p>
                      )}
                      <div className="flex min-w-0 justify-center rounded-xl border border-input bg-muted p-2">
                        <EmailFrame
                          title={t`Preview of the email`}
                          html={preview.data.html}
                          text={preview.data.text}
                          className={`h-[55dvh] rounded-lg ${device === 'mobile' ? 'max-w-[375px]' : ''}`}
                        />
                      </div>
                    </>
                  )}
                </div>
              ) : null}
              {refused?.fields['body'] === undefined || view === 'preview' ? null : (
                <p className="text-sm font-medium text-destructive">{refused.fields['body']}</p>
              )}
            </div>
          </div>

          <footer className="flex min-w-0 flex-col gap-1 border-t border-border px-4 py-2 text-sm">
            {refused?.form === undefined && refused?.fields['name'] === undefined ? null : (
              <p role="alert" className="font-medium text-destructive">
                {refused.form ?? refused.fields['name']}
              </p>
            )}
            {unknown.length === 0 ? null : (
              <p role="status" className="text-destructive">
                {t`No send can fill in ${unknownList}. A send stops at a field it can't fill in.`}
              </p>
            )}
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 text-muted-foreground">
              <span className={size.over ? 'font-medium text-destructive' : ''}>
                {size.near
                  ? t`${used} of ${limit} characters: close to the most an email can hold.`
                  : t`${used} of ${limit} characters`}
              </span>
              <span role="status" className="text-foreground">
                {notice ?? ''}
              </span>
              {/* As the server sends a workflow's email (messaging, email-compose.ts). */}
              <span className="basis-full">
                {footerNote ?? (
                  <Trans>
                    A workflow email leaves with a footer: your postal address, when your business
                    profile has one, and an unsubscribe line. A message that has an unsubscribe link
                    of its own gets no second one.
                  </Trans>
                )}
              </span>
            </div>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SaveAsTemplate({
  client,
  businessId,
  suggested,
  blocked,
  onSave,
  onCancel,
}: {
  readonly client: Client;
  readonly businessId: string;
  readonly suggested: string;
  /** Why the email can't be saved as it stands, when it can't. */
  readonly blocked: string | undefined;
  readonly onSave: (name: string, folderId: string | undefined) => Promise<void>;
  readonly onCancel: () => void;
}): ReactElement {
  const { t } = useLingui();
  const nameId = useId();
  const folderId = useId();
  const [name, setName] = useState(suggested === '' ? '' : t`${suggested} (copy)`);
  const [folder, setFolder] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState(blocked);
  const folders = useQuery({
    queryKey: ['b', businessId, 'message-template-folders'],
    queryFn: () => client.request(listMessageTemplateFolders, {}),
    staleTime: 30_000,
  });
  const labels = folderLabels(folders.data?.items ?? []);
  const save = async (): Promise<void> => {
    if (saving) return;
    if (blocked !== undefined) return;
    if (name.trim() === '') {
      setProblem(t`Give the template a name.`);
      return;
    }
    setSaving(true);
    try {
      await onSave(name.trim(), folder === '' ? undefined : folder);
    } catch (error) {
      setProblem(
        error instanceof ApiError
          ? (error.problem.errors?.[0]?.message ?? error.message)
          : t`The template wasn't saved. Check your connection and try again.`,
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      aria-label={t`Save as new template`}
      className="flex min-w-0 flex-wrap items-end gap-3 border-b border-border bg-background px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void save();
      }}
    >
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground">
          <Trans>New template name</Trans>
        </label>
        <Input
          id={nameId}
          ref={focusOnMount}
          maxLength={120}
          value={name}
          aria-invalid={problem !== undefined && blocked === undefined}
          onChange={(event) => {
            setName(event.target.value);
            setProblem(blocked);
          }}
        />
      </div>
      {(folders.data?.items.length ?? 0) === 0 ? null : (
        <div className="flex min-w-40 flex-col gap-1">
          <label htmlFor={folderId} className="text-xs font-medium text-muted-foreground">
            <Trans>Folder</Trans>
          </label>
          <Select id={folderId} value={folder} onValueChange={setFolder}>
            <option value="">{t`No folder`}</option>
            {folders.data?.items.map((each) => (
              <option key={each.id} value={each.id}>
                {labels.get(each.id) ?? each.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <Button type="submit" size="small" disabled={saving || blocked !== undefined}>
        {saving ? <Trans>Saving…</Trans> : <Trans>Save template</Trans>}
      </Button>
      <Button type="button" variant="quiet" size="small" onClick={onCancel}>
        <Trans>Cancel</Trans>
      </Button>
      {problem === undefined ? null : (
        <p role="alert" className="basis-full text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
    </form>
  );
}
