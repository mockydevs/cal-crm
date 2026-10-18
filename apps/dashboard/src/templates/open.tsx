// A template opened from the library: a designed one in the popup email editor, the one
// the workflow builder opens too; a plain-text one in the page's own form, until its author
// chooses to design it. Fetched when a template is first opened.
import { Trans, useLingui } from '@lingui/react/macro';
import { getMessageTemplate, type MessageTemplate } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { lazy, Suspense, type ReactElement } from 'react';
import { apiIn } from '../api';
import { withEmailWords } from '../email-words';
import { TemplateEditor } from '../template-editor';
import { useBusiness } from '../workspace';
import { retryRead } from './retry';

const FormattedTemplate = lazy(() => withEmailWords(import('../email-step/template-screen')));

/** What is open: a template in the page's plain-text form, or in the popup editor. */
export type Opened =
  | { readonly kind: 'new'; readonly folderId: string | undefined }
  | { readonly kind: 'saved'; readonly id: string }
  | { readonly kind: 'formatted'; readonly id: string | undefined; readonly folderId?: string }
  /** A plain-text template its author chose to design, with what was typed. */
  | {
      readonly kind: 'convert';
      readonly id: string | undefined;
      readonly folderId?: string | undefined;
      readonly subject: string;
      readonly body: string;
    };

export function useTemplate(id: string | undefined): UseQueryResult<MessageTemplate> {
  const business = useBusiness();
  return useQuery({
    queryKey: ['b', business.id, 'message-template', id],
    queryFn: () => apiIn(business.id).request(getMessageTemplate, { params: { id: id ?? '' } }),
    enabled: id !== undefined,
    retry: retryRead,
    // A form keeps its own copy: a refetch behind it must not replace what is typed.
    staleTime: Infinity,
    gcTime: 0,
  });
}

/** A template in the popup editor: read first when it is a saved one. */
export function OpenFormatted({
  opened,
  onClose,
  onSaved,
}: {
  readonly opened: Extract<Opened, { kind: 'formatted' | 'convert' }>;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): ReactElement | null {
  const template = useTemplate(opened.id);
  if (opened.id !== undefined && template.data === undefined)
    return template.isError ? (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm">
        <p>
          <Trans>We couldn't load this template.</Trans>
        </p>
        <Button variant="secondary" size="small" onClick={onClose}>
          <Trans>Back to templates</Trans>
        </Button>
      </div>
    ) : null;
  return (
    <Suspense fallback={null}>
      <FormattedTemplate
        template={template.data}
        convert={opened.kind === 'convert' ? opened : undefined}
        folderId={opened.folderId}
        onClose={onClose}
        onSaved={onSaved}
      />
    </Suspense>
  );
}

/** A plain-text template in the page's own form, in place of the library. */
export function OpenPlain({
  opened,
  onClose,
  onSaved,
  onConvert,
}: {
  readonly opened: Extract<Opened, { kind: 'new' | 'saved' }>;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  /** Takes what is typed to the popup editor, with the template it is of, if saved. */
  readonly onConvert: (
    draft: { readonly subject: string; readonly body: string },
    id: string | undefined,
  ) => void;
}): ReactElement {
  const { t } = useLingui();
  const id = opened.kind === 'saved' ? opened.id : undefined;
  const template = useTemplate(id);
  if (id === undefined)
    return (
      <TemplateEditor
        template={undefined}
        initialFolderId={opened.kind === 'new' ? opened.folderId : undefined}
        onClose={onClose}
        onSaved={onSaved}
        onConvert={(draft) => {
          onConvert(draft, undefined);
        }}
      />
    );
  if (template.data !== undefined)
    return (
      <TemplateEditor
        template={template.data}
        onClose={onClose}
        onSaved={onSaved}
        {...(template.data.canManage && template.data.archivedAt === null
          ? {
              onConvert: (draft) => {
                onConvert(draft, template.data.id);
              },
            }
          : {})}
      />
    );
  return (
    <div className="flex min-w-0 flex-col items-start gap-3 text-sm">
      {template.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p>{t`We couldn't load this template.`}</p>
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void template.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : (
        <p role="status">{t`Loading the template…`}</p>
      )}
      <Button variant="quiet" size="small" onClick={onClose}>
        <Trans>Back to templates</Trans>
      </Button>
    </div>
  );
}
