// The words of Marketing → Emails → Campaigns (the list, a campaign's editor and results,
// the dialogs, and the campaign ceiling in Settings → Email Services): a catalog of their
// own (lingui.config.ts), fetched with whichever of them is opened first, so they are not
// in the catalog every page downloads, which is at its budget (scripts/check-budget.mjs).
// The catalog is merged into the language in use: nothing is replaced, and a word that both
// catalogs hold is the same word.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const campaigns: Catalogs = {
  en: () => import('./campaigns-locales/en/messages.po'),
};

let loaded: Promise<void> | undefined;

export function loadCampaignsWords(): Promise<void> {
  loaded ??= (async () => {
    const load = campaigns[i18n.locale] ?? campaigns['en'];
    if (load === undefined) return;
    const { messages } = await load();
    i18n.load(i18n.locale, messages);
  })();
  return loaded;
}

/** A page with the words beside it: for `lazy`, so neither is drawn without the other. */
export async function withCampaignsWords<Module>(module: Promise<Module>): Promise<Module> {
  const [loadedModule] = await Promise.all([module, loadCampaignsWords()]);
  return loadedModule;
}
