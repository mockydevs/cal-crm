// The words of the Forms page: the list, the builder, a form's submissions and numbers. A
// catalog of its own (lingui.config.ts), fetched with the page, so the sentences only it
// says are not in the catalog every page downloads, which is at its budget
// (scripts/check-budget.mjs). The catalog is merged into the language in use: nothing is
// replaced, and a word that both catalogs hold is the same word.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const forms: Catalogs = {
  en: () => import('./forms-locales/en/messages.po'),
};

export async function loadFormsWords(): Promise<void> {
  const load = forms[i18n.locale] ?? forms['en'];
  if (load === undefined) return;
  const { messages } = await load();
  i18n.load(i18n.locale, messages);
}
