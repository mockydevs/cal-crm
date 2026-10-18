// The settings of a Send email action, laid out as GoHighLevel's: who it is from, Cc and
// Bcc behind their buttons, the subject, the preview text, then the email itself — written
// here (Quick compose) or taken from a template that is found by searching — shown as it
// will look, with its attachments, and "Sync edits to template" for an email that is linked
// to one. The email is edited in the popup editor (email-editor/editor-dialog.tsx).
//
// It holds the step's settings in the contract's own four forms (config.ts) and never
// guesses one from another.
//
// Its words are in the email catalog (lingui.config.ts, email-words.ts).
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createMessageTemplate,
  EMAIL_CONTENT_LIMITS,
  getMediaFile,
  getMessageTemplate,
  type MessageTemplate,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { EllipsisVertical, Paperclip, X } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { apiIn } from '../api';
import type { BuilderSetup } from '../automation-submission';
import { htmlOfText, isEmptyHtml, textOfHtml, tokenOf } from '../email-editor/email-html';
import { FieldPicker } from '../email-editor/field-picker';
import {
  contentOf,
  documentOf,
  textPartOf,
  type EmailDocument,
  type FieldGroupChoice,
} from '../email-editor/rules';
import { withEmailWords } from '../email-words';
import { SearchPicker } from '../search-picker';
import { useBusiness } from '../workspace';
import {
  addAddresses,
  emailStepOf,
  envelopeOf,
  mergePathOf,
  withContent,
  withCopy,
  withEnvelope,
  withSync,
  withTemplate,
  type AddressProblem,
} from './config';
import { EmailFrame, PreviewProblem, useEmailPreview } from './preview';
import type { EmailFields } from './fields';
import { ATTACHMENTS_BYTES, fileSizeWords } from './rules';
import TemplatePicker from './template-picker';
import { namedTemplate } from './template-picker-rules';

const EmailEditor = lazy(() => withEmailWords(import('../email-editor/editor-dialog')));
const RichText = lazy(() => withEmailWords(import('../email-editor/rich-text')));
const MediaPicker = lazy(() => import('../media/picker'));
const OtherUses = lazy(() => import('./other-uses'));

/** Until the fields are read: none to insert, and no field called unknown. */
const noFields: EmailFields = { fields: [], isKnown: () => true };

/** Takes the keyboard as it is drawn: for the way back out of a question just asked. */
const focusOnMount = (node: HTMLElement | null): void => {
  node?.focus();
};

type Config = Readonly<Record<string, unknown>>;

/** What the builder gives a saved action's panel, to act on the draft it is part of. */
export interface EmailStepContext {
  readonly automationId: string;
  /** The action's key in the draft; nothing while it is being added. */
  readonly step: string | undefined;
  /** The action's settings as the draft holds them. */
  readonly saved: Config | undefined;
  /**
   * Saves the template a syncing action sends, with the draft; answers the template as it
   * is then. Left out where the person may not, or the action is not in the draft yet.
   */
  readonly saveSynced?:
    | ((edit: {
        readonly revision: string;
        readonly subject: string;
        readonly content: ReturnType<typeof contentOf>;
        readonly preheader: string | null;
      }) => Promise<MessageTemplate>)
    | undefined;
}

export interface EmailPanelProps {
  readonly id: string;
  readonly config: Config;
  readonly setup: BuilderSetup;
  /** What the action is called, for the editor's title. */
  readonly actionName: string;
  /** What the checks said of the settings, by the member each names. */
  readonly problems: Readonly<Record<string, string>>;
  readonly context?: EmailStepContext | undefined;
  readonly onChange: (config: Record<string, unknown>) => void;
}

const labelClassName = 'text-xs font-medium text-muted-foreground';
const hintClassName = 'text-sm text-muted-foreground';
function Problem({ children }: { readonly children: string | undefined }): ReactElement | null {
  return children === undefined ? null : (
    <p className="text-sm font-medium text-destructive wrap-anywhere">{children}</p>
  );
}

/** The list that puts a merge field into a line of text, where the caret was. */
function InsertField({
  label,
  fields,
  onInsert,
}: {
  readonly label: string;
  readonly fields: readonly FieldGroupChoice[];
  readonly onInsert: (path: string) => void;
}): ReactElement {
  const { t } = useLingui();
  return (
    <SearchPicker
      label={label}
      placeholder={t`Insert a field`}
      searchLabel={t`Search fields`}
      items={fields.flatMap((group) =>
        group.fields.map((field) => ({
          id: field.path,
          name: field.label,
          detail: tokenOf(field.path),
          group: group.label,
        })),
      )}
      selected={[]}
      empty={t`No fields match.`}
      none={t`There are no fields to insert.`}
      tool={
        <span aria-hidden className="font-mono text-sm">
          {'{}'}
        </span>
      }
      onChange={([path]) => {
        if (path !== undefined) onInsert(path);
      }}
    />
  );
}

/** A line of text that takes merge fields, under its small grey name. */
function MergeLine({
  id,
  label,
  value,
  fields,
  maxLength,
  required = false,
  hint,
  problem,
  onChange,
}: {
  readonly id: string;
  readonly label: ReactNode;
  readonly value: string;
  readonly fields: readonly FieldGroupChoice[];
  readonly maxLength: number;
  readonly required?: boolean;
  readonly hint?: ReactNode;
  readonly problem: string | undefined;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { t } = useLingui();
  const boxRef = useRef<HTMLInputElement>(null);
  const name = typeof label === 'string' ? label : '';
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className={labelClassName}>
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-1">
        <Input
          id={id}
          ref={boxRef}
          data-field-control
          maxLength={maxLength}
          aria-required={required}
          aria-invalid={problem !== undefined}
          aria-describedby={hint === undefined ? undefined : `${id}-hint`}
          value={value}
          onChange={(event) => {
            onChange(event.target.value.replace(/[\r\n]+/g, ' '));
          }}
        />
        <InsertField
          label={t`Insert a field into: ${name}`}
          fields={fields}
          onInsert={(path) => {
            const box = boxRef.current;
            const at = box?.selectionStart ?? value.length;
            const end = box?.selectionEnd ?? at;
            onChange(value.slice(0, at) + tokenOf(path) + value.slice(end));
          }}
        />
      </div>
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className={hintClassName}>
          {hint}
        </p>
      )}
      <Problem>{problem}</Problem>
    </div>
  );
}

/** Cc or Bcc: the addresses as chips, a box that adds one, and a merge field for one. */
function Addresses({
  id,
  label,
  held,
  fields,
  problem,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly held: readonly string[];
  readonly fields: readonly FieldGroupChoice[];
  readonly problem: string | undefined;
  readonly onChange: (next: readonly string[]) => void;
}): ReactElement {
  const { t } = useLingui();
  const [typed, setTyped] = useState('');
  const [refused, setRefused] = useState<AddressProblem>();
  const most = EMAIL_CONTENT_LIMITS.copies;
  const add = (text: string): void => {
    const next = addAddresses(held, text);
    setRefused(next.problem);
    if (next.problem !== undefined) return;
    onChange(next.list);
    setTyped('');
  };
  const refusal =
    refused === 'not_an_address'
      ? t`Give an email address, or insert one field that holds one.`
      : refused === 'already_there'
        ? t`That address is already listed.`
        : refused === 'too_many'
          ? t`At most ${most} addresses.`
          : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className={labelClassName}>
        {label}
      </label>
      {held.length === 0 ? null : (
        <ul aria-label={label} className="flex min-w-0 list-none flex-wrap gap-1.5 p-0">
          {held.map((address) => {
            const field = mergePathOf(address);
            return (
              <li
                key={address}
                className={`flex max-w-full min-w-0 items-center gap-0.5 rounded-full bg-secondary py-0.5 pr-0.5 pl-2.5 text-sm font-medium text-secondary-foreground ${field === undefined ? '' : 'font-mono'}`}
              >
                <span className="min-w-0 wrap-anywhere">{address}</span>
                <button
                  type="button"
                  aria-label={t`Remove ${address}`}
                  title={t`Remove ${address}`}
                  className="flex size-6 shrink-0 items-center justify-center rounded-full outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    onChange(held.filter((each) => each !== address));
                  }}
                >
                  <X aria-hidden className="size-3.5" strokeWidth={2.2} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex min-w-0 items-center gap-1">
        <Input
          id={id}
          type="text"
          inputMode="email"
          autoComplete="off"
          placeholder={t`name@example.com`}
          aria-invalid={refusal !== undefined || problem !== undefined}
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
            setRefused(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ',') return;
            event.preventDefault();
            add(typed);
          }}
          onBlur={() => {
            if (typed.trim() !== '') add(typed);
          }}
        />
        <InsertField
          label={t`Insert a field into: ${label}`}
          fields={fields}
          onInsert={(path) => {
            add(tokenOf(path));
          }}
        />
      </div>
      <Problem>{refusal ?? problem}</Problem>
    </div>
  );
}

export default function EmailPanel({
  id,
  config,
  setup,
  actionName,
  problems,
  context,
  onChange,
}: EmailPanelProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const client = useMemo(() => apiIn(business.id), [business.id]);
  const cache = useQueryClient();
  const modeId = useId();
  const pickerId = `${id}-template`;
  // The panel itself: its menu is drawn inside it, since the panel is a dialog and a menu
  // at the end of the page would be under it.
  const rootRef = useRef<HTMLDivElement>(null);
  const step = emailStepOf(config);
  const composing = step.mode === 'inline' || (step.mode === 'copy' && step.source === undefined);
  // What each way of writing the email last held, so switching between them loses nothing.
  const stashRef = useRef<{ compose?: Config; template?: Config }>({});
  const [shown, setShown] = useState({
    cc: step.cc.length > 0,
    bcc: step.bcc.length > 0,
    replyTo: step.replyTo !== '',
  });
  const [editing, setEditing] = useState<{
    readonly document: EmailDocument;
    readonly synced: MessageTemplate | undefined;
    readonly preview: boolean;
  }>();
  const [creating, setCreating] = useState(false);
  const [confirmingSync, setConfirmingSync] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [failure, setFailure] = useState<string>();
  // The names of templates chosen or made here, which the builder's own list may lack.
  const [names, setNames] = useState<Readonly<Record<string, string>>>({});

  // The fields a workflow email can insert come with the builder's own rules for them,
  // fetched beside the panel (fields.ts).
  const [fieldSet, setFieldSet] = useState<EmailFields>();
  const linksHeading = t`Trigger links`;
  useEffect(() => {
    let current = true;
    void import('./fields').then((module) => {
      if (current) setFieldSet(module.emailFields(setup, linksHeading));
    });
    return () => {
      current = false;
    };
  }, [setup, linksHeading]);
  const { fields, isKnown } = fieldSet ?? noFields;

  const set = (next: Record<string, unknown>): void => {
    setNotice(undefined);
    setFailure(undefined);
    onChange(next);
  };
  // The template the email is linked to, by id: a reference may name it by what it is called.
  const linked = namedTemplate(setup.emailTemplates, step.template);
  // A template just chosen is named by its id, though the builder's list may not hold it yet.
  const templateId =
    linked?.id ??
    step.source?.id ??
    (step.template?.startsWith('tmpl_') === true ? step.template : undefined);
  const templateName =
    linked?.name ??
    (templateId === undefined ? undefined : names[templateId]) ??
    step.template ??
    '';
  const savedStep = context?.saved === undefined ? undefined : emailStepOf(context.saved);
  const savedSync =
    savedStep?.mode === 'sync' && step.mode === 'sync' && savedStep.source?.id === step.source?.id;
  const savedReference =
    step.mode === 'reference' &&
    savedStep?.mode === 'reference' &&
    savedStep.template === step.template;

  const preview = useEmailPreview(
    client,
    business.id,
    composing || step.mode === 'copy'
      ? {
          subject: step.subject,
          preheader: step.preheader,
          html: step.html,
          text: step.body,
        }
      : {
          template: templateId,
          subject: step.subject,
          preheader: step.preheader,
          html: undefined,
          text: '',
        },
    !composing && (step.mode === 'copy' || templateId !== undefined),
  );
  const files = useQueries({
    queries: step.attachments.map((file) => ({
      queryKey: ['b', business.id, 'media-file', file],
      queryFn: () => client.request(getMediaFile, { params: { id: file } }),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const attachedBytes = files.reduce((sum, file) => sum + (file.data?.size ?? 0), 0);

  const readTemplate = async (): Promise<MessageTemplate | undefined> => {
    if (templateId === undefined) return undefined;
    setBusy(true);
    setFailure(undefined);
    try {
      return await client.request(getMessageTemplate, { params: { id: templateId } });
    } catch (error) {
      setFailure(
        error instanceof ApiError
          ? error.message
          : t`The template couldn't be read. Check your connection and try again.`,
      );
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const contentOfTemplate = (template: MessageTemplate) => ({
    subject: template.subject,
    body: template.content.text,
    html: template.content.format === 'html' ? template.content.html : undefined,
  });
  /** The template's content written into this action, as an independent copy. */
  const copyHere = async (): Promise<Record<string, unknown> | undefined> => {
    const template = await readTemplate();
    if (template === undefined) return undefined;
    const base =
      step.preheader === '' && template.preheader !== null
        ? withEnvelope(config, 'preheader', template.preheader)
        : config;
    const next = withCopy(
      base,
      { id: template.id, revision: template.revision },
      contentOfTemplate(template),
    );
    set(next);
    return next;
  };
  const edit = async (inPreview = false): Promise<void> => {
    if (step.mode === 'sync') {
      const template = await readTemplate();
      if (template === undefined) return;
      setEditing({
        document: documentOf({
          subject: template.subject,
          preheader: template.preheader,
          html: template.content.format === 'html' ? template.content.html : undefined,
          text: template.content.text,
        }),
        synced: template,
        preview: inPreview || !savedSync || context?.saveSynced === undefined,
      });
      return;
    }
    const own = step.mode === 'reference' ? await copyHere() : config;
    if (own === undefined) return;
    const held = emailStepOf(own);
    setEditing({
      document: documentOf({
        subject: held.subject,
        preheader: held.preheader,
        html: held.html,
        text: held.body,
      }),
      synced: undefined,
      preview: inPreview,
    });
  };
  const saveAsTemplate = async (
    name: string,
    folderId: string | undefined,
    document: EmailDocument,
  ): Promise<void> => {
    await client.request(createMessageTemplate, {
      body: {
        name,
        subject: document.subject,
        content: contentOf(document),
        ...(document.html !== undefined && document.preheader.trim() !== ''
          ? { preheader: document.preheader.trim() }
          : {}),
        ...(folderId === undefined ? {} : { folderId }),
      },
    });
    void cache.invalidateQueries({ queryKey: ['b', business.id, 'message-templates'] });
    void cache.invalidateQueries({ queryKey: ['b', business.id, 'automation-catalog'] });
  };

  const mailboxKnown = setup.mailboxes.some(
    (mailbox) => mailbox.id === step.mailbox || mailbox.name === step.mailbox,
  );
  const [onlyMailbox] = setup.mailboxes;
  const onlyMailboxName = onlyMailbox?.name ?? '';
  const heldMailbox = step.mailbox;
  const syncedName = editing?.synced?.name ?? '';
  const mostFiles = EMAIL_CONTENT_LIMITS.attachments;
  const reveal = (key: keyof typeof shown, label: string): ReactElement | null =>
    shown[key] ? null : (
      <Button
        type="button"
        variant="secondary"
        size="small"
        onClick={() => {
          setShown((before) => ({ ...before, [key]: true }));
        }}
      >
        {label}
      </Button>
    );

  return (
    <div ref={rootRef} data-setting="email" className="flex min-w-0 flex-col gap-4">
      <MergeLine
        id={`${id}-fromName`}
        label={t`From name`}
        value={step.fromName}
        fields={fields}
        maxLength={EMAIL_CONTENT_LIMITS.fromName}
        problem={problems['fromName']}
        onChange={(value) => {
          set(withEnvelope(config, 'fromName', value));
        }}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${id}-mailbox`} className={labelClassName}>
          <Trans>From email</Trans>
        </label>
        <Select
          id={`${id}-mailbox`}
          data-field-control
          aria-invalid={problems['mailbox'] !== undefined}
          aria-describedby={`${id}-mailbox-hint`}
          value={step.mailbox}
          onValueChange={(next) => {
            set(withEnvelope(config, 'mailbox', next));
          }}
        >
          <option value="">
            {setup.mailboxes.length === 1 && onlyMailbox !== undefined
              ? t`Your mailbox: ${onlyMailboxName}`
              : setup.mailboxes.length === 0
                ? t`No mailbox is connected`
                : t`Choose a mailbox`}
          </option>
          {step.mailbox !== '' && !mailboxKnown ? (
            <option value={step.mailbox}>{t`${heldMailbox} (not found)`}</option>
          ) : null}
          {setup.mailboxes.map((mailbox) => (
            <option key={mailbox.id} value={mailbox.id}>
              {mailbox.name}
            </option>
          ))}
        </Select>
        <p id={`${id}-mailbox-hint`} className={hintClassName}>
          {setup.mailboxes.length > 1 ? (
            <Trans>
              An email is sent from one of your connected mailboxes: choose which. With From name
              empty, the mailbox's own name is used.
            </Trans>
          ) : (
            <Trans>
              An email is sent from your connected mailbox. With From name empty, the mailbox's own
              name is used.
            </Trans>
          )}
        </p>
        <Problem>{problems['mailbox']}</Problem>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${id}-purpose`} className={labelClassName}>
          <Trans>Message type</Trans>
        </label>
        <Select
          id={`${id}-purpose`}
          aria-invalid={problems['purpose'] !== undefined}
          aria-describedby={`${id}-purpose-hint`}
          value={config['purpose'] === 'transactional' ? 'transactional' : ''}
          onValueChange={(next) => {
            set(withEnvelope(config, 'purpose', next));
          }}
        >
          <option value="">{t`Marketing`}</option>
          <option value="transactional">{t`Transactional: about the appointment they booked`}</option>
        </Select>
        <p id={`${id}-purpose-hint`} className={hintClassName}>
          <Trans>
            Marketing email needs marketing consent and ends with your address and an unsubscribe
            link. A transactional email, such as an appointment reminder, goes to people who agreed
            to booking notifications. Only a workflow that starts from an appointment can send one.
          </Trans>
        </p>
        <Problem>{problems['purpose']}</Problem>
      </div>

      {shown.cc && shown.bcc && shown.replyTo ? null : (
        <div className="flex flex-wrap gap-2">
          {reveal('cc', t`Cc`)}
          {reveal('bcc', t`Bcc`)}
          {reveal('replyTo', t`Reply-To`)}
        </div>
      )}
      {shown.cc ? (
        <Addresses
          id={`${id}-cc`}
          label={t`Cc`}
          held={step.cc}
          fields={fields}
          problem={problems['cc']}
          onChange={(next) => {
            set(withEnvelope(config, 'cc', next));
          }}
        />
      ) : null}
      {shown.bcc ? (
        <Addresses
          id={`${id}-bcc`}
          label={t`Bcc`}
          held={step.bcc}
          fields={fields}
          problem={problems['bcc']}
          onChange={(next) => {
            set(withEnvelope(config, 'bcc', next));
          }}
        />
      ) : null}
      {shown.replyTo ? (
        <MergeLine
          id={`${id}-replyTo`}
          label={t`Reply-To`}
          value={step.replyTo}
          fields={fields}
          maxLength={EMAIL_CONTENT_LIMITS.address}
          hint={t`One email address, or one field that holds one. Empty, replies go to the mailbox.`}
          problem={problems['replyTo']}
          onChange={(value) => {
            set(withEnvelope(config, 'replyTo', value.trim()));
          }}
        />
      ) : null}

      <MergeLine
        id={`${id}-subject`}
        label={composing || step.mode === 'copy' ? t`Subject` : t`Subject (optional)`}
        value={step.subject}
        fields={fields}
        maxLength={998}
        required={composing || step.mode === 'copy'}
        hint={
          composing || step.mode === 'copy'
            ? undefined
            : t`Leave this empty to use the template's own subject.`
        }
        problem={problems['subject']}
        onChange={(value) => {
          set({ ...config, subject: value });
        }}
      />
      {step.html !== undefined || step.mode === 'sync' || step.mode === 'reference' ? (
        <MergeLine
          id={`${id}-preheader`}
          label={t`Preview text (optional)`}
          value={step.preheader}
          fields={fields}
          maxLength={EMAIL_CONTENT_LIMITS.preheader}
          hint={
            step.html !== undefined
              ? t`Some mail apps show this after the subject.`
              : t`Some mail apps show this after the subject. Empty, the template's own is used; a plain-text template has none.`
          }
          problem={problems['preheader']}
          onChange={(value) => {
            set(withEnvelope(config, 'preheader', value));
          }}
        />
      ) : null}

      <fieldset className="flex min-w-0 flex-col gap-3 border-0 p-0">
        <legend className={`mb-1.5 ${labelClassName}`}>
          <Trans>Create email</Trans>
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <label className="flex min-h-9 items-center gap-2 text-md">
            <input
              type="radio"
              name={modeId}
              className="size-4 accent-primary"
              checked={composing}
              onChange={() => {
                stashRef.current.template = config;
                const held = stashRef.current.compose;
                set(
                  held === undefined
                    ? { ...envelopeOf(config), subject: '', body: '' }
                    : { ...held, ...envelopeOf(config) },
                );
              }}
            />
            <Trans>Quick compose</Trans>
          </label>
          <label className="flex min-h-9 items-center gap-2 text-md">
            <input
              type="radio"
              name={modeId}
              className="size-4 accent-primary"
              checked={!composing}
              onChange={() => {
                stashRef.current.compose = config;
                const held = stashRef.current.template;
                const envelope = envelopeOf(config);
                set(held === undefined ? withTemplate(envelope, '') : { ...held, ...envelope });
              }}
            />
            <Trans>Select existing template</Trans>
          </label>
        </div>

        {composing ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={`${id}-body`} className={labelClassName}>
              <Trans>Message</Trans>
            </label>
            {step.html === undefined ? (
              <>
                <Textarea
                  id={`${id}-body`}
                  data-field-control
                  rows={5}
                  aria-required
                  aria-invalid={problems['body'] !== undefined}
                  value={step.body}
                  onChange={(event) => {
                    set(
                      withContent(config, {
                        subject: step.subject,
                        body: event.target.value,
                        html: undefined,
                      }),
                    );
                  }}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    onClick={() => {
                      set(
                        withContent(config, {
                          subject: step.subject,
                          body: step.body,
                          html: step.body.trim() === '' ? '<p></p>' : htmlOfText(step.body),
                        }),
                      );
                    }}
                  >
                    <Trans>Add formatting</Trans>
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    onClick={() => {
                      void edit();
                    }}
                  >
                    <Trans>Open in the editor</Trans>
                  </Button>
                </div>
              </>
            ) : (
              <Suspense
                fallback={
                  <p role="status" className={hintClassName}>
                    <Trans>Loading the editor…</Trans>
                  </p>
                }
              >
                <RichText
                  // The fields are read once, as the editor opens: it waits for them.
                  key={fieldSet === undefined ? 'waiting' : 'ready'}
                  compact
                  label={t`Message`}
                  html={step.html}
                  fieldPicker={(insert) => (
                    <FieldPicker
                      label={t`Insert a field into: Message`}
                      fields={fields}
                      onInsert={insert}
                    />
                  )}
                  isKnown={isKnown}
                  businessId={business.id}
                  invalid={problems['body'] !== undefined || problems['html'] !== undefined}
                  onExpand={() => {
                    void edit();
                  }}
                  onChange={(html) => {
                    set(
                      withContent(config, {
                        subject: step.subject,
                        body: isEmptyHtml(html) ? '' : textOfHtml(html),
                        html,
                      }),
                    );
                  }}
                />
              </Suspense>
            )}
            <Problem>{problems['body'] ?? problems['html']}</Problem>
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor={pickerId} className={labelClassName}>
              <Trans>Email template</Trans>
            </label>
            <TemplatePicker
              id={pickerId}
              control
              label={t`Email template`}
              value={step.template}
              known={[
                ...setup.emailTemplates,
                ...Object.entries(names).map(([each, name]) => ({ id: each, name })),
              ]}
              client={client}
              businessId={business.id}
              manageHref={`/b/${business.slug}/marketing/emails/templates`}
              onCreate={() => {
                setCreating(true);
              }}
              invalid={problems['template'] !== undefined}
              onChange={(template, name) => {
                if (name !== undefined) setNames((before) => ({ ...before, [template]: name }));
                set(withTemplate(config, template));
              }}
            />
            <Problem>{problems['template']}</Problem>
            {step.template === undefined || step.template === '' ? null : (
              <p className={hintClassName}>
                {step.mode === 'copy'
                  ? t`This action holds its own copy of “${templateName}”. A later edit to the template doesn't change it.`
                  : step.mode === 'sync'
                    ? t`Syncing with “${templateName}”: every send uses the template as it is then.`
                    : savedReference
                      ? t`This action sends “${templateName}” as the template is at each send.`
                      : t`“${templateName}” is copied into this action when you save it. After that, a later edit to the template doesn't change it.`}
              </p>
            )}
          </div>
        )}
      </fieldset>

      {composing || step.template === undefined || step.template === '' ? null : (
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className={labelClassName}>
              <Trans>Email</Trans>
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="quiet"
                    size="small"
                    className="px-2.5"
                    aria-label={t`Email options`}
                    title={t`Email options`}
                    disabled={busy}
                  />
                }
              >
                <EllipsisVertical aria-hidden className="size-4" strokeWidth={1.8} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" container={rootRef}>
                <DropdownMenuItem
                  disabled={
                    step.mode === 'sync' && !(savedSync && context?.saveSynced !== undefined)
                  }
                  onClick={() => {
                    void edit();
                  }}
                >
                  {step.mode === 'sync' ? (
                    <Trans>Edit the template</Trans>
                  ) : step.mode === 'reference' ? (
                    <Trans>Edit a copy in this action</Trans>
                  ) : (
                    <Trans>Edit</Trans>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    void edit(true);
                  }}
                >
                  <Trans>Preview with a contact…</Trans>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    document.getElementById(pickerId)?.click();
                  }}
                >
                  <Trans>Replace with a template</Trans>
                </DropdownMenuItem>
                {step.mode === 'sync' || step.mode === 'reference' ? (
                  <DropdownMenuItem
                    onClick={() => {
                      void copyHere();
                    }}
                  >
                    <Trans>Make a copy in this action</Trans>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  onClick={() => {
                    stashRef.current = {};
                    set({ ...envelopeOf(config), subject: '', body: '' });
                  }}
                >
                  <Trans>Clear</Trans>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="relative min-w-0 overflow-hidden rounded-xl border border-input bg-white">
            {preview.isError ? (
              <PreviewProblem preview={preview} />
            ) : preview.data === undefined ? (
              <p role="status" className={`p-3 ${hintClassName}`}>
                <Trans>Loading the preview…</Trans>
              </p>
            ) : (
              <>
                <EmailFrame
                  title={t`Preview of the email`}
                  html={preview.data.html}
                  text={preview.data.text}
                  className="pointer-events-none h-56"
                />
                {step.mode === 'sync' &&
                !(savedSync && context?.saveSynced !== undefined) ? null : (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={t`Edit the email`}
                    className="absolute inset-0 flex items-end justify-end p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    onClick={() => {
                      void edit();
                    }}
                  >
                    <span className="rounded-control bg-foreground/80 px-2.5 py-1 text-xs font-medium text-background">
                      <Trans>Edit</Trans>
                    </span>
                  </button>
                )}
              </>
            )}
          </div>
          {step.mode === 'sync' && !(savedSync && context?.saveSynced !== undefined) ? (
            <p className={hintClassName}>
              <Trans>
                Save the action to link it. After that, the template can be edited from here.
              </Trans>
            </p>
          ) : null}
        </div>
      )}

      <div className="flex min-w-0 flex-col gap-1.5">
        <span className={labelClassName}>
          <Trans>Attachments</Trans>
        </span>
        {step.attachments.length === 0 ? null : (
          <ul aria-label={t`Attachments`} className="flex min-w-0 list-none flex-col gap-1 p-0">
            {step.attachments.map((file, index) => {
              const read = files[index];
              const name = read?.data?.name ?? (read?.isError === true ? t`File not found` : file);
              return (
                <li
                  key={file}
                  className="flex min-w-0 items-center gap-2 rounded-xl border border-border px-3 py-1.5 text-md"
                >
                  <Paperclip aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  {read?.data === undefined ? null : (
                    <span className="shrink-0 text-sm text-muted-foreground">
                      {fileSizeWords(read.data.size)}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={t`Remove ${name}`}
                    title={t`Remove ${name}`}
                    className="flex size-9 shrink-0 items-center justify-center rounded-control text-body outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      set(
                        withEnvelope(
                          config,
                          'attachments',
                          step.attachments.filter((each) => each !== file),
                        ),
                      );
                    }}
                  >
                    <X aria-hidden className="size-4" strokeWidth={2} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <Button
          type="button"
          variant="secondary"
          size="small"
          className="self-start"
          disabled={step.attachments.length >= mostFiles}
          onClick={() => {
            setAttaching(true);
          }}
        >
          <Paperclip aria-hidden className="size-4" strokeWidth={1.8} />
          <Trans>Add attachments</Trans>
        </Button>
        <p
          className={
            attachedBytes > ATTACHMENTS_BYTES
              ? 'text-sm font-medium text-destructive'
              : hintClassName
          }
        >
          {attachedBytes > ATTACHMENTS_BYTES
            ? t`These files are over 15 MB together, which is the most one email can carry. Remove one.`
            : t`Up to ${mostFiles} files from Media Storage, 15 MB together.`}
        </p>
        <Problem>{problems['attachments']}</Problem>
      </div>

      {composing || templateId === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border p-3">
          <label className="flex min-w-0 items-start gap-2.5 text-md font-medium">
            <input
              type="checkbox"
              className="mt-1 size-4 shrink-0 accent-primary"
              checked={step.mode === 'sync'}
              disabled={busy}
              aria-describedby={`${id}-sync-hint`}
              onChange={(event) => {
                if (event.target.checked) setConfirmingSync(true);
                else if (step.source !== undefined) set(withTemplate(config, step.source.id));
              }}
            />
            <Trans>Sync edits to template</Trans>
          </label>
          <p id={`${id}-sync-hint`} className={hintClassName}>
            <Trans>
              While this is on, the action holds no email of its own: every send uses the template
              as it is then. An edit to the template reaches this action, and an edit made here is
              an edit to the template. Turning it off copies the template into this action when you
              save it.
            </Trans>
          </p>
          {confirmingSync ? (
            <div
              role="alertdialog"
              aria-label={t`Sync with the template?`}
              className="flex min-w-0 flex-col gap-2 rounded-xl bg-background p-3"
            >
              <p className="text-md">
                {t`This action's own email is replaced by “${templateName}” as the template is now. The template itself isn't changed. Who the email is from, its Cc, Bcc, attachments and your own subject stay.`}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="small"
                  disabled={busy}
                  onClick={() => {
                    void (async () => {
                      const template = await readTemplate();
                      setConfirmingSync(false);
                      if (template === undefined) return;
                      set(withSync(config, { id: template.id, revision: template.revision }));
                    })();
                  }}
                >
                  <Trans>Turn on sync</Trans>
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  ref={focusOnMount}
                  onClick={() => {
                    setConfirmingSync(false);
                  }}
                >
                  <Trans>Cancel</Trans>
                </Button>
              </div>
            </div>
          ) : null}
          {step.mode !== 'sync' ? null : (
            <Suspense fallback={null}>
              <OtherUses
                templateId={templateId}
                automationId={context?.automationId}
                step={context?.step}
              />
            </Suspense>
          )}
        </div>
      )}

      {failure === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {failure}
        </p>
      )}
      <p role="status" className="text-sm empty:hidden">
        {notice}
      </p>

      {attaching ? (
        <Suspense fallback={null}>
          <MediaPicker
            businessId={business.id}
            title={<Trans>Attach a file</Trans>}
            onClose={() => {
              setAttaching(false);
            }}
            onChoose={(file) => {
              setAttaching(false);
              cache.setQueryData(['b', business.id, 'media-file', file.id], file);
              if (!step.attachments.includes(file.id))
                set(withEnvelope(config, 'attachments', [...step.attachments, file.id]));
            }}
          />
        </Suspense>
      ) : null}
      {editing === undefined ? null : (
        <Suspense fallback={null}>
          <EmailEditor
            name={editing.synced?.name ?? (actionName.trim() === '' ? t`Email` : actionName)}
            document={editing.document}
            fields={fields}
            isKnown={isKnown}
            client={client}
            businessId={business.id}
            startInPreview={editing.preview}
            editable={
              editing.synced === undefined || (savedSync && context?.saveSynced !== undefined)
            }
            subjectLimit={editing.synced === undefined ? 998 : 255}
            note={
              editing.synced === undefined ? (
                <Trans>
                  Save puts the email into this action. Save the action, then the workflow, to keep
                  it.
                </Trans>
              ) : (
                t`This action syncs with the template “${syncedName}”. Saving here changes the template, for every workflow action that syncs with it, and saves this workflow's draft.`
              )
            }
            onSave={async (document) => {
              const synced = editing.synced;
              if (synced === undefined) {
                const next = withContent(config, {
                  subject: document.subject,
                  body: textPartOf(document),
                  html: document.html,
                });
                set(
                  withEnvelope(
                    next,
                    'preheader',
                    document.html === undefined ? '' : document.preheader.trim(),
                  ),
                );
                return;
              }
              if (context?.saveSynced === undefined) return;
              const template = await context.saveSynced({
                revision: synced.revision,
                subject: document.subject.trim(),
                content: contentOf(document),
                preheader:
                  document.html === undefined || document.preheader.trim() === ''
                    ? null
                    : document.preheader.trim(),
              });
              setEditing({ ...editing, document, synced: template });
              set(withSync(config, { id: template.id, revision: template.revision }));
              void cache.invalidateQueries({ queryKey: ['b', business.id, 'email-preview'] });
              void cache.invalidateQueries({ queryKey: ['b', business.id, 'message-templates'] });
            }}
            onSaveAsTemplate={saveAsTemplate}
            onClose={() => {
              setEditing(undefined);
            }}
          />
        </Suspense>
      )}
      {creating ? (
        <Suspense fallback={null}>
          <EmailEditor
            name=""
            renamable
            document={{ subject: '', preheader: '', html: '', text: '', ownText: false }}
            fields={fields}
            isKnown={isKnown}
            client={client}
            businessId={business.id}
            note={
              <Trans>
                A new template for your library. Once saved, it is chosen for this action.
              </Trans>
            }
            onSave={async (document, name) => {
              const created = await client.request(createMessageTemplate, {
                body: {
                  name,
                  subject: document.subject.trim(),
                  content: contentOf(document),
                  ...(document.html !== undefined && document.preheader.trim() !== ''
                    ? { preheader: document.preheader.trim() }
                    : {}),
                },
              });
              void cache.invalidateQueries({ queryKey: ['b', business.id, 'message-templates'] });
              void cache.invalidateQueries({ queryKey: ['b', business.id, 'automation-catalog'] });
              setNames((before) => ({ ...before, [created.id]: created.name }));
              set(
                withCopy(
                  config,
                  { id: created.id, revision: created.revision },
                  contentOfTemplate(created),
                ),
              );
              setCreating(false);
              const createdName = created.name;
              setNotice(t`Template “${createdName}” saved, and copied into this action.`);
            }}
            onClose={() => {
              setCreating(false);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
