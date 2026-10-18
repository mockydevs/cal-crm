// The words of Marketing → Emails → Templates (the library, its menus and dialogs, and the
// plain-text template form): a catalog of their own (lingui.config.ts), fetched with the
// page, so they are not in the catalog every page downloads, which is at its budget
// (scripts/check-budget.mjs). The catalog is merged into the language in use: nothing is
// replaced, and a word that both catalogs hold is the same word.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const templates: Catalogs = {
  en: () => import('./templates-locales/en/messages.po'),
};

let loaded: Promise<void> | undefined;

export function loadTemplatesWords(): Promise<void> {
  loaded ??= (async () => {
    const load = templates[i18n.locale] ?? templates['en'];
    if (load === undefined) return;
    const { messages } = await load();
    i18n.load(i18n.locale, messages);
  })();
  return loaded;
}

/** A page with the words beside it: for `lazy`, so neither is drawn without the other. */
export async function withTemplatesWords<Module>(module: Promise<Module>): Promise<Module> {
  const [loadedModule] = await Promise.all([module, loadTemplatesWords()]);
  return loadedModule;
}
