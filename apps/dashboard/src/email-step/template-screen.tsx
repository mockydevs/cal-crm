// What the Templates page (Marketing → Emails → Templates) shows of the formatted emails:
// beside each template, whether it is formatted or plain text and how many workflows use
// it; and a template opened in the popup editor, the same one the workflow builder opens
// (email-editor/editor-dialog.tsx). A plain-text template stays in the page's own
// plain-text form until its author chooses to format it.
//
// Its words are in the email catalog (lingui.config.ts, email-words.ts).
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  contactMergeFields,
  createMessageTemplate,
  getFields,
  listTemplateWorkflowActions,
  updateMessageTemplate,
  type MessageTemplate,
  type MessageTemplateSummary,
} from '@repo/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useMemo, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { htmlOfText } from '../email-editor/email-html';
import {
  contentOf,
  documentOf,
  UNSUBSCRIBE_FIELD,
  type EmailDocument,
  type FieldGroupChoice,
} from '../email-editor/rules';
import { useBusiness } from '../workspace';
import { workflowCount } from './rules';

const EmailEditor = lazy(() => import('../email-editor/editor-dialog'));

/**
 * Beside a template in the list: its format, and how many workflows use it. The list says
 * the number itself (`workflowUses`); a server that does not is asked for the template's
 * workflow actions, as before, and the number is counted from those.
 */
export function TemplateFacts({
  template,
}: {
  readonly template: Pick<MessageTemplateSummary, 'id' | 'format' | 'workflowUses'>;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const told = template.workflowUses ?? undefined;
  const uses = useQuery({
    enabled: told === undefined,
    queryKey: ['b', business.id, 'template-workflow-actions', template.id],
    queryFn: () =>
      apiIn(business.id).request(listTemplateWorkflowActions, {
        params: { id: template.id },
        query: { limit: 100 },
      }),
    staleTime: 60_000,
    retry: false,
  });
  const count = told ?? (uses.data === undefined ? undefined : workflowCount(uses.data.items));
  // The list's own number is exact; one counted from a first page may be short.
  const more = told === undefined && uses.data !== undefined && uses.data.nextCursor !== null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="rounded-full bg-secondary px-2 py-0.5 font-medium text-secondary-foreground">
        {template.format === 'html' ? <Trans>Formatted</Trans> : <Trans>Plain text</Trans>}
      </span>
      {count === undefined ? null : (
        <span>
          {count === 0
            ? t`Not used in a workflow`
            : more
              ? plural(count, {
                  one: 'Used in # workflow or more',
                  other: 'Used in # workflows or more',
                })
              : plural(count, { one: 'Used in # workflow', other: 'Used in # workflows' })}
        </span>
      )}
    </span>
  );
}

export interface FormattedTemplateProps {
  /** The template to edit; none to write a new one. */
  readonly template: MessageTemplate | undefined;
  /** Plain text to start from as formatted content: a plain-text template being converted. */
  readonly convert?: { readonly subject: string; readonly body: string } | undefined;
  /** Where a new template is filed. */
  readonly folderId?: string | undefined;
  readonly onClose: () => void;
  /** After a save, with the template as the server now has it. */
  readonly onSaved: (template: MessageTemplate) => void;
}

/** A template in the popup editor: saved as formatted content, with its revision checked. */
export default function FormattedTemplate({
  template,
  convert,
  folderId,
  onClose,
  onSaved,
}: FormattedTemplateProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const client = useMemo(() => apiIn(business.id), [business.id]);
  const cache = useQueryClient();
  // What the next save is checked against: the template as the server last gave it.
  const [current, setCurrent] = useState(template);
  const custom = useQuery({
    queryKey: ['b', business.id, 'fields'],
    queryFn: () => client.request(getFields, {}),
  });
  const fields: FieldGroupChoice[] = useMemo(() => {
    const own = (custom.data?.items ?? []).filter(
      (field) => field.objectKey === 'contact' && !field.archived,
    );
    return [
      {
        label: t`Contact`,
        fields: contactMergeFields.map((path) => ({ path, label: path })),
      },
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
    ];
  }, [custom.data, t]);
  const isKnown = useMemo(() => {
    const paths = new Set(fields.flatMap((group) => group.fields.map((field) => field.path)));
    // Until the business's own fields are read, a custom field is not called unknown.
    return (path: string): boolean =>
      paths.has(path) ||
      path === UNSUBSCRIBE_FIELD ||
      path.startsWith('custom_values.') ||
      (custom.data === undefined && path.startsWith('contact.custom.'));
  }, [fields, custom.data]);
  const [initial] = useState<EmailDocument>(() =>
    convert !== undefined
      ? {
          subject: convert.subject,
          preheader: '',
          html: htmlOfText(convert.body),
          text: '',
          ownText: false,
        }
      : template === undefined
        ? { subject: '', preheader: '', html: '', text: '', ownText: false }
        : documentOf({
            subject: template.subject,
            preheader: template.preheader,
            html: template.content.format === 'html' ? template.content.html : undefined,
            text: template.content.text,
          }),
  );
  const editable = (current?.canManage ?? true) && (current?.archivedAt ?? null) === null;

  return (
    <Suspense
      fallback={
        <p role="status" className="text-sm">
          <Trans>Loading the editor…</Trans>
        </p>
      }
    >
      <EmailEditor
        name={current?.name ?? ''}
        renamable
        document={initial}
        fields={fields}
        isKnown={isKnown}
        client={client}
        businessId={business.id}
        editable={editable}
        note={
          convert !== undefined ? (
            <Trans>
              The plain text is now formatted content. It stays plain text until you save.
            </Trans>
          ) : current !== undefined && current.usedBy !== null && current.usedBy.length > 0 ? (
            <Trans>
              Workflows that sync with this template, or send it by name, send what you save here
              from then on. Workflow actions that hold their own copy don't change.
            </Trans>
          ) : undefined
        }
        onSave={async (document, name) => {
          const body = {
            name,
            subject: document.subject.trim(),
            content: contentOf(document),
            ...(document.html === undefined
              ? {}
              : { preheader: document.preheader.trim() === '' ? null : document.preheader.trim() }),
          };
          const saved =
            current === undefined
              ? await client.request(createMessageTemplate, {
                  body: { ...body, ...(folderId === undefined ? {} : { folderId }) },
                })
              : await client.request(updateMessageTemplate, {
                  params: { id: current.id },
                  body: { ...body, revision: current.revision },
                });
          setCurrent(saved);
          void cache.invalidateQueries({ queryKey: ['b', business.id, 'email-preview'] });
          onSaved(saved);
        }}
        onSaveAsTemplate={
          editable
            ? async (name, folder, document) => {
                const saved = await client.request(createMessageTemplate, {
                  body: {
                    name,
                    subject: document.subject.trim(),
                    content: contentOf(document),
                    ...(document.html !== undefined && document.preheader.trim() !== ''
                      ? { preheader: document.preheader.trim() }
                      : {}),
                    ...(folder === undefined ? {} : { folderId: folder }),
                  },
                });
                onSaved(saved);
              }
            : undefined
        }
        onClose={onClose}
      />
    </Suspense>
  );
}
