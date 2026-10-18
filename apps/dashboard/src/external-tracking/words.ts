// The words of Settings → External Tracking: a catalog of their own (lingui.config.ts),
// fetched with its tabs, so they are not in the catalog every page downloads
// (scripts/check-budget.mjs). Merged into the language in use: nothing is replaced.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const catalogs: Catalogs = {
  en: () => import('../external-tracking-locales/en/messages.po'),
};

let loaded: Promise<void> | undefined;

export function loadExternalTrackingWords(): Promise<void> {
  loaded ??= (async () => {
    const load = catalogs[i18n.locale] ?? catalogs['en'];
    if (load === undefined) return;
    const { messages } = await load();
    i18n.load(i18n.locale, messages);
  })();
  return loaded;
}

/** A tab with the words beside it: for `lazy`, so neither is drawn without the other. */
export async function withExternalTrackingWords<Module>(module: Promise<Module>): Promise<Module> {
  const [loadedModule] = await Promise.all([module, loadExternalTrackingWords()]);
  return loadedModule;
}
