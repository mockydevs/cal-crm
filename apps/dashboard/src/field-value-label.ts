// A custom field's value in words, as the contact page and the contact list show it. In a
// module of its own, so the list can show field values without the contact page's panels.
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import type { RecordField } from '@repo/contracts';
import { useMemo } from 'react';

/** A field and its value: the definition says how the value reads. */
export type ShownField = Pick<RecordField, 'definition' | 'value'>;

/**
 * A field's value in words. An unset one reads "Not set". The same function while the
 * language stays, so a table's columns built on it stay too.
 */
export function useValueLabel(): (field: ShownField) => string {
  const { t, i18n } = useLingui();
  return useMemo(() => {
    const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeZone: 'UTC' });
    const moments = new Intl.DateTimeFormat(i18n.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    return ({ definition, value }: ShownField): string => {
      if (value === null) return t`Not set`;
      if (typeof value === 'boolean') return value ? t`Yes` : t`No`;
      const choice = (key: string) => {
        const option = definition.options.find((item) => item.key === key);
        if (option === undefined) return key;
        const label = option.label;
        return option.archived ? t`${label} (archived)` : label;
      };
      if (Array.isArray(value)) {
        // A file upload field's value is its files' ids: how many is what a line can say.
        if (definition.valueType === 'file')
          return plural(value.length, { one: '# file', other: '# files' });
        return value.map(choice).join(', ');
      }
      // A text box list: each box's name and its text, in the field's order of boxes.
      if (typeof value === 'object')
        return definition.options
          .flatMap((option) => {
            const text = value[option.key];
            return text === undefined ? [] : [`${choice(option.key)}: ${text}`];
          })
          .join('; ');
      switch (definition.valueType) {
        case 'money':
          return `${definition.currency ?? ''} ${value}`.trim();
        case 'single_choice':
          return choice(value);
        case 'date':
          return dates.format(new Date(value));
        case 'datetime':
          return moments.format(new Date(value));
        case 'boolean':
        case 'email':
        case 'long_text':
        case 'multi_choice':
        case 'number':
        case 'phone':
        case 'text':
        case 'url':
        case 'text_list':
        case 'file':
          return value;
      }
    };
  }, [t, i18n.locale]);
}
