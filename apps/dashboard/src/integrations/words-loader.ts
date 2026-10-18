// The words of Settings → Integrations: a catalog of their own (lingui.config.ts), fetched
// with the page, so they are not in the catalog every page downloads
// (scripts/check-budget.mjs). It is merged into the language in use: nothing is replaced,
// and a word both catalogs hold is the same word.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const integrations: Catalogs = {
  en: () => import('../integrations-locales/en/messages.po'),
};

let loaded: Promise<void> | undefined;

export function loadIntegrationsWords(): Promise<void> {
  loaded ??= (async () => {
    const load = integrations[i18n.locale] ?? integrations['en'];
    if (load === undefined) return;
    const { messages } = await load();
    i18n.load(i18n.locale, messages);
  })();
  return loaded;
}

/** A part with the words beside it: for `lazy`, so neither is drawn without the other. */
export async function withIntegrationsWords<Module>(module: Promise<Module>): Promise<Module> {
  const [loadedModule] = await Promise.all([module, loadIntegrationsWords()]);
  return loadedModule;
}
