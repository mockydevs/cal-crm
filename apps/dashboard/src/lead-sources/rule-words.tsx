// A rule said in words (rules.ts, ruleSentence), with the names the page has for what a
// rule holds by key or by id: a session source, what took the lead, a tag, a custom field.
import { Trans, useLingui } from '@lingui/react/macro';
import type { FieldDefinition, TagDefinition } from '@repo/contracts';
import type { ReactElement } from 'react';
import { useReportWords } from '../reporting/words';
import type { RuleSentence, SentenceWords } from './rules';

/** The contact's custom fields a rule may fill: text and long text, not archived. */
export const fillableFields = (fields: readonly FieldDefinition[]): FieldDefinition[] =>
  fields.filter(
    (field) =>
      field.objectKey === 'contact' &&
      !field.archived &&
      (field.valueType === 'text' || field.valueType === 'long_text'),
  );

export function useSentenceWords(
  tags: readonly Pick<TagDefinition, 'id' | 'name'>[],
  fields: readonly Pick<FieldDefinition, 'id' | 'label'>[],
): SentenceWords {
  const { t, i18n } = useLingui();
  const report = useReportWords();
  return {
    choice: (fact, value) =>
      fact === 'session_source'
        ? report.sessionSource(value)
        : fact === 'medium'
          ? report.medium(value)
          : value,
    tagName: (id) => tags.find((tag) => tag.id === id)?.name ?? t`a deleted tag`,
    fieldName: (id) => fields.find((field) => field.id === id)?.label ?? t`a field that is gone`,
    has: (label) => t`has a ${label}`,
    hasNo: (label) => t`has no ${label}`,
    parameter: (name) => (name === '' ? t`an address parameter` : t`address parameter ${name}`),
    either: (values) =>
      new Intl.ListFormat(i18n.locale, { style: 'long', type: 'disjunction' }).format(values),
    quoted: (value) => t`“${value}”`,
  };
}

/** The sentence as one text, for a screen reader's name of a rule and for tests. */
export function useSentenceText(): (sentence: RuleSentence) => string {
  const { t, i18n } = useLingui();
  return (sentence) => {
    const when = new Intl.ListFormat(i18n.locale, { style: 'long', type: 'conjunction' }).format(
      sentence.when,
    );
    const source = sentence.source ?? '';
    const tags = sentence.tags.join(', ');
    const then = [
      ...(sentence.source === undefined ? [] : [t`Source: ${source}`]),
      ...(sentence.tags.length === 0 ? [] : [t`tags: ${tags}`]),
      ...sentence.fills.map(({ field, value }) => t`fills ${field}: ${value}`),
    ].join(' · ');
    return then === '' ? t`When ${when}` : t`When ${when} → ${then}`;
  };
}

export function RuleSentenceLine({ sentence }: { readonly sentence: RuleSentence }): ReactElement {
  const { t, i18n } = useLingui();
  const when = new Intl.ListFormat(i18n.locale, { style: 'long', type: 'conjunction' }).format(
    sentence.when,
  );
  const tags = sentence.tags.join(', ');
  const acts =
    sentence.source !== undefined || sentence.tags.length > 0 || sentence.fills.length > 0;
  return (
    <p className="min-w-0 text-sm wrap-anywhere text-body">
      <span className="text-muted-foreground">
        <Trans>When</Trans>
      </span>{' '}
      {when}
      {acts ? (
        <>
          {' '}
          <span aria-hidden className="text-muted-foreground">
            →
          </span>
          <span className="sr-only">
            <Trans>then</Trans>
          </span>{' '}
          {sentence.source === undefined ? null : (
            <>
              <span className="text-muted-foreground">
                <Trans>Source:</Trans>
              </span>{' '}
              <span className="font-medium text-foreground">{sentence.source}</span>
            </>
          )}
          {sentence.tags.length === 0 ? null : (
            <>
              {sentence.source === undefined ? null : ' · '}
              <span className="text-muted-foreground">
                <Trans>tags:</Trans>
              </span>{' '}
              <span className="font-medium text-foreground">{tags}</span>
            </>
          )}
          {sentence.fills.map(({ field, value }, index) => (
            <span key={field}>
              {index === 0 && sentence.source === undefined && sentence.tags.length === 0
                ? null
                : ' · '}
              <span className="text-muted-foreground">{t`fills ${field}:`}</span>{' '}
              <span className="font-medium text-foreground">{value}</span>
            </span>
          ))}
        </>
      ) : null}
    </p>
  );
}
