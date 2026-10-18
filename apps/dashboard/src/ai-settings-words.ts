// The words of Settings → AI, for a business and for the agency: the providers, the
// models, the spending limit and the keys. A catalog of their own (lingui.config.ts),
// fetched with those pages, so they are not in the catalog every page downloads
// (scripts/check-budget.mjs). It is merged into the language in use.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const aiSettings: Catalogs = {
  en: () => import('./ai-settings-locales/en/messages.po'),
};

let loaded: Promise<void> | undefined;

export function loadAiSettingsWords(): Promise<void> {
  loaded ??= (async () => {
    const load = aiSettings[i18n.locale] ?? aiSettings['en'];
    if (load === undefined) return;
    const { messages } = await load();
    i18n.load(i18n.locale, messages);
  })();
  return loaded;
}
