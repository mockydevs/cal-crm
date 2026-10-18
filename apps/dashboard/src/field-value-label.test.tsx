// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { FieldDefinition } from '@repo/contracts';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, expect, it } from 'vitest';
import { useValueLabel } from './field-value-label';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const definition = (
  valueType: FieldDefinition['valueType'],
  options: FieldDefinition['options'] = [],
): FieldDefinition => ({
  id: 'fld_01h455vb4pex5vsknk084sn02q',
  objectKey: 'contact',
  key: 'refs',
  label: 'Refs',
  description: 'A sanitized test field.',
  valueType,
  currency: null,
  revision: '1',
  archived: false,
  aiFillSources: [],
  aiOverwrite: 'ask',
  options,
});
const box = (key: string, label: string, archived = false) => ({
  key,
  label,
  description: '',
  archived,
});

function label() {
  const { result } = renderHook(() => useValueLabel(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <I18nProvider i18n={i18n}>{children}</I18nProvider>
    ),
  });
  return result.current;
}

it("reads a text box list's boxes in the field's order, each with its name", () => {
  const field = definition('text_list', [
    box('first', 'First reference'),
    box('second', 'Second reference'),
    box('old', 'Old box', true),
  ]);
  expect(label()({ definition: field, value: { second: 'Bo', first: 'Ann', old: 'Kept' } })).toBe(
    'First reference: Ann; Second reference: Bo; Old box (archived): Kept',
  );
});

it('reads a file upload field as how many files it holds', () => {
  const field = definition('file');
  expect(label()({ definition: field, value: ['file_01h455vb4pex5vsknk084sn02q'] })).toBe('1 file');
  expect(
    label()({
      definition: field,
      value: ['file_01h455vb4pex5vsknk084sn02q', 'file_01h455vb4pex5vsknk084sn02r'],
    }),
  ).toBe('2 files');
  expect(label()({ definition: field, value: null })).toBe('Not set');
});

it('reads a radio or checkbox field as its choices, as a dropdown reads them', () => {
  const field = {
    ...definition('multi_choice', [box('a', 'Lights'), box('b', 'Sound')]),
    display: 'checkbox' as const,
  };
  expect(label()({ definition: field, value: ['b', 'a'] })).toBe('Sound, Lights');
});
