// Writing one message template: its name, subject and plain-text message, the merge fields
// it uses, and what it would read as for a sample contact. The message is a textarea and
// is only ever shown as text. A save names the revision the form started from, so when
// someone else saved first the form shows what they changed and lets the author reapply.
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  archiveMessageTemplate,
  createMessageTemplate,
  getFields,
  getMessageTemplate,
  mergeTokens,
  messageTemplateInput,
  restoreMessageTemplate,
  updateMessageTemplate,
  type MessageTemplate,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { useEffect, useId, useState, type ReactElement, type SyntheticEvent } from 'react';
import { apiIn } from './api';
import { AutomationDialog } from './automation-dialog';
import { issuesOf, noRejection, rejection } from './problems';
import {
  builtInSamples,
  emptyDraft,
  insertMergeField,
  isChanged,
  mergeFieldsOf,
  previewDraft,
  reapply,
  sampleValuesOf,
  savedChanges,
  unknownFields,
  type DraftField,
  type TemplateDraft,
} from './template-text';
import { useBusiness } from './workspace';

export interface TemplateEditorProps {
  /** The template to edit, or none to write a new one. */
  readonly template: MessageTemplate | undefined;
  /** Destination for a new template; editing keeps its existing placement. */
  readonly initialFolderId?: string | undefined;
  /** Back to the list. */
  readonly onClose: () => void;
  /** After any save, archive or restore, with the template as the server now has it. */
  readonly onSaved: (template: MessageTemplate) => void;
  /**
   * Carries what is typed to the formatted editor, for an author who chooses to format a
   * plain-text template. Left out where there is no such editor to go to.
   */
  readonly onConvert?: ((draft: TemplateDraft) => void) | undefined;
}

type TextTarget = 'subject' | 'body';
type TextControl = HTMLInputElement | HTMLTextAreaElement;
interface Place {
  readonly control: TextControl;
  readonly start: number;
  readonly end: number;
}

const draftOf = (template: MessageTemplate | undefined): TemplateDraft =>
  template === undefined
    ? emptyDraft
    : { name: template.name, subject: template.subject, body: template.body };

export function TemplateEditor({
  template,
  initialFolderId,
  onClose,
  onSaved,
  onConvert,
}: TemplateEditorProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const client = apiIn(business.id);
  const headingId = useId();
  const fieldsId = useId();
  const previewId = useId();
  // What the form is based on: the template as last read from the server.
  const [current, setCurrent] = useState(template);
  const [draft, setDraft] = useState(() => draftOf(template));
  const [samples, setSamples] = useState<Readonly<Record<string, string>>>({});
  const [problem, setProblem] = useState(noRejection);
  const [notice, setNotice] = useState<'saved' | 'archived' | 'restored'>();
  // Someone else's save, read after the server refused this form's.
  const [theirs, setTheirs] = useState<MessageTemplate>();
  const [confirming, setConfirming] = useState<'archive' | 'leave'>();
  const [target, setTarget] = useState<TextTarget>('body');
  // Where the cursor last was in the subject and in the message, for inserting a field.
  const [places, setPlaces] = useState<Partial<Record<TextTarget, Place>>>({});
  const [caret, setCaret] = useState<{ control: TextControl; at: number }>();

  const base = draftOf(current);
  const canManage = current?.canManage ?? true;
  const archived = current !== undefined && current.archivedAt !== null;
  const editable = canManage && !archived;
  const changed = editable && isChanged(draft, base);

  const customFields = useQuery({
    queryKey: ['b', business.id, 'fields'],
    queryFn: () => client.request(getFields, {}),
  });
  const known =
    customFields.data === undefined ? undefined : mergeFieldsOf(customFields.data.items);
  const offered = known ?? mergeFieldsOf([]);
  const used = mergeTokens(draft);
  const unknown = unknownFields(draft, known);
  const defaults = builtInSamples({ firstName: t`Ada`, lastName: t`Lovelace` });
  const sampleValues = sampleValuesOf(draft, samples, defaults);
  const preview = previewDraft(draft, samples, defaults);

  // After a merge field goes in, the keyboard returns to the text, just past it.
  useEffect(() => {
    if (caret === undefined) return;
    const { control } = caret;
    control.focus();
    control.setSelectionRange(caret.at, caret.at);
  }, [caret]);

  const blocker = useBlocker({
    shouldBlockFn: () => changed,
    enableBeforeUnload: () => changed,
    withResolver: true,
  });

  const adopt = (saved: MessageTemplate, said: typeof notice): void => {
    setCurrent(saved);
    setDraft(draftOf(saved));
    setTheirs(undefined);
    setProblem(noRejection);
    setNotice(said);
    onSaved(saved);
  };
  // A refusal: a stale revision shows what was saved meanwhile; anything else is said.
  const refused = async (error: unknown, fallback: string): Promise<void> => {
    if (error instanceof ApiError && error.status === 409 && current !== undefined) {
      try {
        setTheirs(await client.request(getMessageTemplate, { params: { id: current.id } }));
        setProblem(noRejection);
        return;
      } catch {
        // Said below: the save was refused and the saved template couldn't be read.
      }
    }
    const issues = error instanceof ApiError ? (error.problem.errors ?? []) : [];
    setProblem(
      issues.length > 0
        ? rejection(issues)
        : { fields: {}, form: error instanceof ApiError ? error.message : fallback },
    );
  };

  const save = useMutation({
    mutationFn: (input: TemplateDraft) =>
      current === undefined
        ? client.request(createMessageTemplate, {
            body: {
              ...input,
              ...(initialFolderId === undefined ? {} : { folderId: initialFolderId }),
            },
          })
        : client.request(updateMessageTemplate, {
            params: { id: current.id },
            body: { ...input, revision: current.revision },
          }),
    onSuccess: (saved) => {
      adopt(saved, 'saved');
    },
    onError: (error) =>
      refused(error, t`The template wasn't saved. Check your connection and try again.`),
  });
  const archive = useMutation({
    mutationFn: (existing: MessageTemplate) =>
      client.request(archiveMessageTemplate, {
        params: { id: existing.id },
        body: { revision: existing.revision },
      }),
    onSuccess: (saved) => {
      adopt(saved, 'archived');
    },
    onError: (error) =>
      refused(error, t`The template wasn't archived. Check your connection and try again.`),
    onSettled: () => {
      setConfirming(undefined);
    },
  });
  const restore = useMutation({
    mutationFn: (existing: MessageTemplate) =>
      client.request(restoreMessageTemplate, {
        params: { id: existing.id },
        body: { revision: existing.revision },
      }),
    onSuccess: (saved) => {
      adopt(saved, 'restored');
    },
    onError: (error) =>
      refused(error, t`The template wasn't restored. Check your connection and try again.`),
  });
  const busy = save.isPending || archive.isPending || restore.isPending;

  const change = (field: DraftField, value: string): void => {
    setDraft((before) => ({ ...before, [field]: value }));
    setNotice(undefined);
  };
  const remember = (field: TextTarget, event: SyntheticEvent<TextControl>): void => {
    const control = event.currentTarget;
    const start = control.selectionStart ?? control.value.length;
    const end = control.selectionEnd ?? control.value.length;
    setPlaces((before) => ({ ...before, [field]: { control, start, end } }));
    setTarget(field);
  };
  const rememberSubject = (event: SyntheticEvent<TextControl>): void => {
    remember('subject', event);
  };
  const rememberBody = (event: SyntheticEvent<TextControl>): void => {
    remember('body', event);
  };
  const insert = (path: string): void => {
    const text = draft[target];
    const place = places[target];
    const selection = place ?? { start: text.length, end: text.length };
    const next = insertMergeField(text, selection, path);
    change(target, next.text);
    if (place !== undefined)
      setPlaces((before) => ({
        ...before,
        [target]: { control: place.control, start: next.caret, end: next.caret },
      }));
    if (place !== undefined) setCaret({ control: place.control, at: next.caret });
  };

  const labels: Readonly<Record<DraftField, string>> = {
    name: t`Name`,
    subject: t`Subject`,
    body: t`Message`,
  };
  const savedNow: Readonly<Record<DraftField, string>> = {
    name: t`Name as saved now`,
    subject: t`Subject as saved now`,
    body: t`Message as saved now`,
  };
  const unknownList = unknown.join(', ');
  const stopping = preview.ok ? '' : preview.fields.join(', ');
  const theirDraft = draftOf(theirs);
  const theirChanges = theirs === undefined ? [] : savedChanges(base, theirDraft, draft);
  const nowArchived = theirs !== undefined && theirs.archivedAt !== null;
  const uses = current?.usedBy ?? null;

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-5 rounded-card border border-border bg-card p-[22px]"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <h2 id={headingId} className="min-w-0 text-lg font-semibold wrap-anywhere">
            {current === undefined ? <Trans>New template</Trans> : current.name}
          </h2>
          {archived ? (
            <Badge>
              <Trans>Archived</Trans>
            </Badge>
          ) : null}
        </div>
        <Button
          variant="quiet"
          size="small"
          onClick={() => {
            if (changed) setConfirming('leave');
            else onClose();
          }}
        >
          <Trans>Back to templates</Trans>
        </Button>
      </div>

      {theirs === undefined ? null : (
        <div
          role="alert"
          className="flex min-w-0 flex-col gap-3 rounded-card bg-secondary p-4 text-sm text-secondary-foreground"
        >
          <p className="font-semibold">
            <Trans>
              Someone else saved this template while you were editing. Nothing of yours was saved.
            </Trans>
          </p>
          {nowArchived ? (
            <p>
              <Trans>They archived it, so it can't be edited until it's restored.</Trans>
            </p>
          ) : null}
          {theirChanges.length === 0 && !nowArchived ? (
            <p>
              <Trans>The name, subject and message are as you opened them.</Trans>
            </p>
          ) : null}
          <ul className="flex min-w-0 flex-col gap-3">
            {theirChanges.map((each) => (
              <li key={each.field} className="flex min-w-0 flex-col gap-1">
                <span className="font-semibold">
                  {savedNow[each.field]}
                  {each.clashes ? (
                    <>
                      {' '}
                      <Trans>(you changed this too)</Trans>
                    </>
                  ) : null}
                </span>
                {/* Read-only text in a control of its own, so a long message scrolls from the keyboard. */}
                <textarea
                  readOnly
                  rows={each.field === 'body' ? 6 : 2}
                  aria-label={savedNow[each.field]}
                  value={each.saved}
                  className="w-full min-w-0 resize-y rounded-xl border border-input bg-card p-3 text-md text-foreground"
                />
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {nowArchived ? null : (
              <Button
                size="small"
                onClick={() => {
                  // What they alone changed is taken; what was typed here stays, to save again.
                  setDraft(reapply(base, theirDraft, draft));
                  setCurrent(theirs);
                  setTheirs(undefined);
                  onSaved(theirs);
                }}
              >
                <Trans>Keep my changes</Trans>
              </Button>
            )}
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                setDraft(theirDraft);
                setCurrent(theirs);
                setTheirs(undefined);
                onSaved(theirs);
              }}
            >
              <Trans>Use the saved version</Trans>
            </Button>
          </div>
        </div>
      )}

      <Form<Record<string, unknown>>
        errors={problem.fields}
        onFormSubmit={() => {
          setNotice(undefined);
          const parsed = messageTemplateInput.safeParse(draft);
          if (!parsed.success) {
            setProblem(rejection(issuesOf(parsed.error)));
            return;
          }
          setProblem(noRejection);
          // This form writes plain text: the parsed name and subject, with the message.
          save.mutate({ name: parsed.data.name, subject: parsed.data.subject, body: draft.body });
        }}
      >
        <fieldset
          disabled={!editable || busy || theirs !== undefined}
          className="flex min-w-0 flex-col gap-4 border-0 p-0"
        >
          <legend className="sr-only">
            <Trans>Template</Trans>
          </legend>
          <Field name="name">
            <FieldLabel>{labels.name}</FieldLabel>
            <Input
              aria-required
              maxLength={120}
              value={draft.name}
              onValueChange={(value) => {
                change('name', value);
              }}
            />
            <FieldDescription>
              <Trans>Automations show this name. It must differ from your other templates.</Trans>
            </FieldDescription>
            <FieldError />
          </Field>
          <Field name="subject">
            <FieldLabel>{labels.subject}</FieldLabel>
            <Input
              aria-required
              maxLength={255}
              value={draft.subject}
              onValueChange={(value) => {
                change('subject', value);
              }}
              onSelect={rememberSubject}
              onFocus={rememberSubject}
              onBlur={rememberSubject}
            />
            <FieldError />
          </Field>
          <Field name="body">
            <FieldLabel>{labels.body}</FieldLabel>
            <Textarea
              aria-required
              rows={10}
              maxLength={100_000}
              value={draft.body}
              onValueChange={(value) => {
                change('body', value);
              }}
              onSelect={rememberBody}
              onFocus={rememberBody}
              onBlur={rememberBody}
            />
            <FieldDescription>
              <Trans>Plain text. It's sent exactly as written, with merge fields filled in.</Trans>
            </FieldDescription>
            <FieldError />
          </Field>

          <div role="group" aria-labelledby={fieldsId} className="flex min-w-0 flex-col gap-2">
            <span id={fieldsId} className="text-sm font-medium">
              <Trans>Insert a merge field</Trans>
            </span>
            <p className="text-sm text-muted-foreground">
              {target === 'subject'
                ? t`It goes into the subject, where the cursor was.`
                : t`It goes into the message, where the cursor was.`}
            </p>
            <div className="flex min-w-0 flex-wrap gap-2">
              {offered.map((field) => {
                const shown = field.label ?? field.path;
                return (
                  <Button
                    key={field.path}
                    variant="secondary"
                    size="small"
                    className="max-w-full"
                    aria-label={t`Insert ${shown}`}
                    onClick={() => {
                      insert(field.path);
                    }}
                  >
                    <span className="min-w-0 truncate">{shown}</span>
                  </Button>
                );
              })}
            </div>
            {customFields.isError ? (
              <p className="text-sm text-muted-foreground">
                <Trans>
                  Your own contact fields couldn't be loaded, so only the standard ones are listed.
                </Trans>
              </p>
            ) : null}
          </div>
        </fieldset>

        {problem.form === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {problem.form}
          </p>
        )}
        {editable ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy || theirs !== undefined}>
              {save.isPending
                ? t`Saving…`
                : current === undefined
                  ? t`Create template`
                  : t`Save template`}
            </Button>
            {current === undefined ? null : (
              <Button
                variant="secondary"
                disabled={busy || changed || theirs !== undefined}
                onClick={() => {
                  setConfirming('archive');
                }}
              >
                <Trans>Archive</Trans>
              </Button>
            )}
            {onConvert === undefined ? null : (
              <Button
                variant="secondary"
                disabled={busy || theirs !== undefined}
                onClick={() => {
                  onConvert(draft);
                }}
              >
                <Trans>Convert to formatted</Trans>
              </Button>
            )}
            {changed && current !== undefined ? (
              <span className="text-sm text-muted-foreground">
                <Trans>Save or undo your changes before archiving.</Trans>
              </span>
            ) : null}
          </div>
        ) : null}
        {archived && canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={busy || theirs !== undefined}
              onClick={() => {
                setNotice(undefined);
                restore.mutate(current);
              }}
            >
              {restore.isPending ? t`Restoring…` : t`Restore template`}
            </Button>
            <span className="text-sm text-muted-foreground">
              <Trans>An archived template can't be edited or sent.</Trans>
            </span>
          </div>
        ) : null}
        {canManage ? null : (
          <p className="text-sm text-muted-foreground">
            <Trans>You can read this template, but your role can't change it.</Trans>
          </p>
        )}
      </Form>
      <p role="status" className="text-sm empty:sr-only">
        {notice === 'saved'
          ? t`Template saved.`
          : notice === 'archived'
            ? t`Template archived.`
            : notice === 'restored'
              ? t`Template restored.`
              : null}
      </p>

      <section aria-labelledby={previewId} className="flex min-w-0 flex-col gap-3">
        <h3 id={previewId} className="text-md font-semibold">
          <Trans>Preview</Trans>
        </h3>
        {used.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>This template uses no merge fields: everyone gets the same text.</Trans>
          </p>
        ) : (
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              <Plural
                value={used.length}
                one="It uses # merge field. Change the sample value to see how it reads."
                other="It uses # merge fields. Change the sample values to see how it reads."
              />
            </p>
            <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
              {used.map((path) => (
                <li key={path} className="min-w-0">
                  <label className="flex min-w-0 flex-col gap-1 text-sm">
                    <span className="font-medium wrap-anywhere">{path}</span>
                    <input
                      className="min-h-10 w-full min-w-0 rounded-xl border border-input bg-card px-3 text-md"
                      value={sampleValues[path] ?? ''}
                      placeholder={t`No sample value`}
                      onChange={(event) => {
                        setSamples((before) => ({ ...before, [path]: event.target.value }));
                      }}
                    />
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
        {unknown.length === 0 ? null : (
          <p
            role="alert"
            className="rounded-card bg-secondary p-3 text-sm text-secondary-foreground"
          >
            {t`Not a contact field here: ${unknownList}. A send stops at a field it can't fill in, so nobody would get this email.`}
          </p>
        )}
        {preview.ok ? (
          <dl className="flex min-w-0 flex-col gap-2 rounded-card bg-background p-4">
            <div className="min-w-0">
              <dt className="text-xs font-semibold text-muted-foreground">
                <Trans>Subject</Trans>
              </dt>
              <dd className="font-medium wrap-anywhere">{preview.subject}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-semibold text-muted-foreground">
                <Trans>Message</Trans>
              </dt>
              <dd>
                <pre className="min-w-0 font-sans text-md whitespace-pre-wrap wrap-anywhere">
                  {preview.body}
                </pre>
              </dd>
            </div>
          </dl>
        ) : (
          <p className="rounded-card bg-background p-4 text-sm">
            {preview.code === 'missing_values'
              ? t`No value for ${stopping}. A contact without one doesn't get this email: the send stops rather than leaving a gap.`
              : t`The sample for ${stopping} has a line break, which can't go in a subject. A send with one stops.`}
          </p>
        )}
      </section>

      <AutomationDialog
        open={confirming === 'archive' && current !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
        title={
          uses !== null && uses.length > 0 ? (
            <Trans>This template is in use</Trans>
          ) : (
            <Trans>Archive this template?</Trans>
          )
        }
        description={
          uses !== null && uses.length > 0 ? (
            <Trans>
              A send treats an archived template as gone, so it can't be archived while these
              automations send it.
            </Trans>
          ) : (
            <Trans>Its name becomes free for another template. You can restore it later.</Trans>
          )
        }
      >
        {uses === null ? (
          <p className="text-md">
            <Trans>
              Any automation that sends this template will fail at that step until you restore it or
              choose another template there.
            </Trans>
          </p>
        ) : uses.length === 0 ? (
          <p className="text-md">
            <Trans>No published automation sends this template.</Trans>
          </p>
        ) : (
          <div className="flex min-w-0 flex-col gap-2 text-md">
            <p>
              <Trans>
                Take it out of their Send email step first. Runs still in progress finish before it
                can go.
              </Trans>
            </p>
            <ul className="flex min-w-0 list-disc flex-col gap-1 pl-5">
              {uses.map(({ id, name, status, runsInProgress }) => (
                <li key={id} className="wrap-anywhere">
                  {runsInProgress === true
                    ? t`${name} (runs still in progress)`
                    : status === 'active'
                      ? t`${name} (active)`
                      : t`${name} (paused)`}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {uses !== null && uses.length > 0 ? (
            <Button
              variant="secondary"
              data-initial-focus
              onClick={() => {
                setConfirming(undefined);
              }}
            >
              <Trans>OK</Trans>
            </Button>
          ) : (
            <>
              <Button
                variant="quiet"
                data-initial-focus
                onClick={() => {
                  setConfirming(undefined);
                }}
              >
                <Trans>Keep it</Trans>
              </Button>
              <Button
                disabled={archive.isPending}
                onClick={() => {
                  if (current !== undefined) archive.mutate(current);
                }}
              >
                {archive.isPending ? t`Archiving…` : t`Archive template`}
              </Button>
            </>
          )}
        </div>
      </AutomationDialog>

      <AutomationDialog
        open={blocker.status === 'blocked' || confirming === 'leave'}
        onOpenChange={(open) => {
          if (open) return;
          blocker.reset?.();
          setConfirming(undefined);
        }}
        title={<Trans>Leave without saving?</Trans>}
        description={<Trans>Your changes to this template haven't been saved.</Trans>}
      >
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="quiet"
            onClick={() => {
              if (blocker.status === 'blocked') blocker.proceed();
              else onClose();
            }}
          >
            <Trans>Leave and drop my changes</Trans>
          </Button>
          <Button
            data-initial-focus
            onClick={() => {
              blocker.reset?.();
              setConfirming(undefined);
            }}
          >
            <Trans>Stay here</Trans>
          </Button>
        </div>
      </AutomationDialog>
    </section>
  );
}
