// An email as it will look: the server fills in the merge fields, for a contact or with
// nothing, cleans the HTML and adds what a workflow email is sent with; this draws what it
// answered.
//
// The formatted part is drawn in a frame of its own with an empty `sandbox`: the frame has
// no origin, runs no script, sends no form and opens nothing, whatever the HTML holds, and
// a policy inside it lets it load pictures and nothing else. The HTML is the server's own
// cleaned answer, never the editor's; the frame is the second lock, not the only one. A
// shadow root was not used: it would share this page's origin and scripts with the email.
//
// Its words are in the email catalog (lingui.config.ts, email-words.ts).
import { Trans, useLingui } from '@lingui/react/macro';
import { renderEmailPreview, type RenderedEmailPreview } from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { ApiError } from '@repo/sdk';
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ReactElement } from 'react';

const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* eslint-disable lingui/no-unlocalized-strings -- a document's own markup, not words */
/** The document the frame shows: the email alone, on white, as a mail app would start it. */
export function frameDocument(html: string | null, text: string): string {
  const body =
    html ?? `<pre style="margin:0;font:inherit;white-space:pre-wrap">${escapeText(text)}</pre>`;
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'">`,
    '<style>html{background:#fff}body{margin:0;padding:16px;font:15px/1.5 Arial,Helvetica,sans-serif;color:#111827;overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:#1d4ed8}</style>',
    `</head><body>${body}</body></html>`,
  ].join('');
}
/* eslint-enable lingui/no-unlocalized-strings */

export function EmailFrame({
  title,
  html,
  text,
  className = '',
}: {
  /** What the frame is, for a screen reader: "Preview of the email". */
  readonly title: string;
  readonly html: string | null;
  readonly text: string;
  readonly className?: string;
}): ReactElement {
  return (
    <iframe
      title={title}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={frameDocument(html, text)}
      className={`block w-full border-0 bg-white ${className}`}
    />
  );
}

export interface PreviewInput {
  /** A saved template to show as it is, in place of content. */
  readonly template?: string | undefined;
  readonly subject: string;
  readonly preheader: string;
  readonly html: string | undefined;
  readonly text: string;
  /** The contact whose own values fill the merge fields; none shows the fields as written. */
  readonly contact?: string | undefined;
  /**
   * False for the content alone, without the unsubscribe line and postal address a workflow
   * email is sent with: a campaign's body is its author's.
   */
  readonly footer?: boolean | undefined;
}

/** Whether there is anything to preview: a template, or some content. */
export const canPreview = (input: PreviewInput): boolean =>
  input.template !== undefined || input.text.trim() !== '' || (input.html ?? '').trim() !== '';

/** The email filled in by the server. Asked again only when what it shows changed. */
export function useEmailPreview(
  client: Client,
  businessId: string,
  input: PreviewInput,
  enabled = true,
): UseQueryResult<RenderedEmailPreview> {
  return useQuery({
    queryKey: ['b', businessId, 'email-preview', input],
    queryFn: () =>
      client.request(renderEmailPreview, {
        body: {
          ...(input.template === undefined
            ? {
                subject: input.subject,
                content:
                  input.html === undefined || input.html.trim() === ''
                    ? { format: 'text' as const, text: input.text }
                    : { format: 'html' as const, html: input.html, text: input.text },
              }
            : {
                template: input.template,
                ...(input.subject.trim() === '' ? {} : { subject: input.subject }),
              }),
          ...(input.preheader.trim() === '' ? {} : { preheader: input.preheader }),
          ...(input.contact === undefined ? {} : { contact: input.contact }),
          ...(input.footer === false ? { footer: false } : {}),
        },
      }),
    enabled: enabled && canPreview(input),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: (failures, error) =>
      failures < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
  });
}

/** What a preview could not be shown for, in words. */
export function PreviewProblem({
  preview,
}: {
  readonly preview: UseQueryResult<RenderedEmailPreview>;
}): ReactElement {
  const { t } = useLingui();
  return (
    <div role="alert" className="flex flex-col items-start gap-2 p-3 text-sm">
      <p>
        {preview.error instanceof ApiError
          ? preview.error.message
          : t`The preview couldn't be loaded. Check your connection and try again.`}
      </p>
      <button
        type="button"
        className="min-h-9 font-medium text-link underline-offset-2 hover:underline"
        onClick={() => {
          void preview.refetch();
        }}
      >
        <Trans>Try again</Trans>
      </button>
    </div>
  );
}
