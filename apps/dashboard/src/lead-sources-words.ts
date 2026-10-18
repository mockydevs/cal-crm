// The words of Settings → Lead Sources (its rules, the tracking link builder and "Check a
// link"): a catalog of their own (lingui.config.ts), fetched with whichever tab is opened
// first, so they are not in the catalog every page downloads, which is at its budget
// (scripts/check-budget.mjs). The catalog is merged into the language in use: nothing is
// replaced, and a word that both catalogs hold is the same word.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const leadSources: Catalogs = {
  en: () => import('./lead-sources-locales/en/messages.po'),
};

let loaded: Promise<void> | undefined;

export function loadLeadSourcesWords(): Promise<void> {
  loaded ??= (async () => {
    const load = leadSources[i18n.locale] ?? leadSources['en'];
    if (load === undefined) return;
    const { messages } = await load();
    i18n.load(i18n.locale, messages);
  })();
  return loaded;
}

/** A tab with the words beside it: for `lazy`, so neither is drawn without the other. */
export async function withLeadSourcesWords<Module>(module: Promise<Module>): Promise<Module> {
  const [loadedModule] = await Promise.all([module, loadLeadSourcesWords()]);
  return loadedModule;
}
