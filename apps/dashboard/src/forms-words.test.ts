import { i18n } from '@lingui/core';
import { expect, it } from 'vitest';
import { loadFormsWords } from './forms-words';

it('adds the Forms catalog to the language in use, and keeps what was there', async () => {
  i18n.loadAndActivate({ locale: 'en', messages: { kept: 'Kept' } });
  const before = Object.keys(i18n.messages).length;
  await loadFormsWords();
  expect(Object.keys(i18n.messages).length).toBeGreaterThan(before + 100);
  expect(i18n._('kept')).toBe('Kept');
});

it('falls back to English words for a language that has no Forms catalog yet', async () => {
  i18n.loadAndActivate({ locale: 'sw', messages: {} });
  await loadFormsWords();
  expect(Object.keys(i18n.messages).length).toBeGreaterThan(100);
});
