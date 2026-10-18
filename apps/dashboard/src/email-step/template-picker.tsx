// Choosing an email template: a list that is searched by a template's name and by its
// subject, under the folders the templates are filed in, each row with its subject and
// whether it is formatted or plain text, the chosen one ticked. A business with up to a
// hundred templates has them all in hand, and the list narrows as the person types; with
// more, each search asks the server, and the list says that it shows only the first of
// them. Under the list: a way to write a new template, and the page where templates are
// kept.
//
// Its words are in the email catalog (lingui.config.ts, email-words.ts).
import { Trans, useLingui } from '@lingui/react/macro';
import { listMessageTemplates } from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactElement } from 'react';
import { SearchPicker } from '../search-picker';
import { namedTemplate, SEARCH_REST, TEMPLATE_PAGE, templateItems } from './template-picker-rules';

/** Where the business's templates are kept between panels, by what was searched. */
export const templatePickerKey = (businessId: string, q: string): readonly unknown[] => [
  'b',
  businessId,
  'message-templates',
  'picker',
  q,
];

export interface TemplatePickerProps {
  readonly id?: string | undefined;
  readonly label: string;
  /** The template chosen, by id (or by name, as an older step may hold it). */
  readonly value: string | undefined;
  /** The templates the builder already knows by name, for a chosen one the list lacks. */
  readonly known: readonly { readonly id: string; readonly name: string }[];
  readonly client: Client;
  readonly businessId: string;
  /** The address of Marketing → Emails → Templates. */
  readonly manageHref: string;
  /** Opens the editor on a new template; left out for someone who may not write one. */
  readonly onCreate?: (() => void) | undefined;
  readonly invalid?: boolean | undefined;
  readonly describedBy?: string | undefined;
  readonly control?: boolean;
  /** Given the template's id, and its name when the list holds it. */
  readonly onChange: (template: string, name?: string) => void;
}

export default function TemplatePicker({
  id,
  label,
  value,
  known,
  client,
  businessId,
  manageHref,
  onCreate,
  invalid,
  describedBy,
  control = false,
  onChange,
}: TemplatePickerProps): ReactElement {
  const { t } = useLingui();
  const [typed, setTyped] = useState('');
  const [asked, setAsked] = useState('');
  // Everything the business has, when one read brings it all.
  const all = useQuery({
    queryKey: templatePickerKey(businessId, ''),
    queryFn: () => client.request(listMessageTemplates, { query: { limit: TEMPLATE_PAGE } }),
    staleTime: 30_000,
  });
  const more = all.data !== undefined && all.data.nextCursor !== null;
  // Typing rests a moment before the server is asked.
  useEffect(() => {
    if (!more) return undefined;
    const timer = setTimeout(() => {
      setAsked(typed.trim());
    }, SEARCH_REST);
    return () => {
      clearTimeout(timer);
    };
  }, [typed, more]);
  const found = useQuery({
    queryKey: templatePickerKey(businessId, asked),
    queryFn: () =>
      client.request(listMessageTemplates, { query: { limit: TEMPLATE_PAGE, q: asked } }),
    enabled: more && asked !== '',
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const searching = more && asked !== '';
  const list = searching ? found.data : all.data;
  const items = templateItems(list?.items ?? [], {
    formatted: t`Formatted`,
    plain: t`Plain text`,
  });
  const chosen = namedTemplate(list?.items ?? [], value) ?? namedTemplate(known, value);
  const read = searching ? found : all;
  const cut = list !== undefined && list.nextCursor !== null;
  const shown = items.length;

  return (
    <SearchPicker
      id={id}
      control={control}
      label={label}
      placeholder={t`Choose a template`}
      searchLabel={t`Search by name or subject`}
      items={items}
      selected={value === undefined || value === '' ? [] : [chosen?.id ?? value]}
      unlisted={(written) => chosen?.name ?? t`${written} (not found)`}
      loading={read.isPending && read.fetchStatus !== 'idle'}
      onRetry={
        read.isError
          ? () => {
              void read.refetch();
            }
          : undefined
      }
      {...(more ? { onSearch: setTyped } : {})}
      empty={
        cut
          ? t`Showing the first ${shown} templates. Type more of the name or subject to find the rest.`
          : t`No templates match.`
      }
      none={t`There are no templates yet.`}
      invalid={invalid}
      describedBy={describedBy}
      onChange={([next]) => {
        if (next !== undefined)
          onChange(next, list?.items.find((template) => template.id === next)?.name);
      }}
      footer={
        <>
          {cut && shown > 0 ? (
            <span className="basis-full text-muted-foreground">
              {t`Showing the first ${shown} templates. Type to search them all.`}
            </span>
          ) : null}
          {onCreate === undefined ? null : (
            <button
              type="button"
              className="min-h-9 font-medium text-link underline-offset-2 hover:underline"
              onClick={onCreate}
            >
              <Trans>Create a template</Trans>
            </button>
          )}
          <a
            href={manageHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-9 items-center font-medium text-link underline-offset-2 hover:underline"
          >
            <Trans>Manage templates</Trans>
          </a>
        </>
      }
    />
  );
}
