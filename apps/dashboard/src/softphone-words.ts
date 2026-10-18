// The softphone's words: a catalog of their own (lingui.config.ts), fetched with the call bar
// when the person may place calls and calling is available, so they are not in the catalog
// every page downloads (scripts/check-budget.mjs). The catalog is merged into the language
// in use: nothing is replaced, and a word that both catalogs hold is the same word.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const softphone: Catalogs = {
  en: () => import('./softphone-locales/en/messages.po'),
};

let loaded: Promise<void> | undefined;

export function loadSoftphoneWords(): Promise<void> {
  loaded ??= (async () => {
    const load = softphone[i18n.locale] ?? softphone['en'];
    if (load === undefined) return;
    const { messages } = await load();
    i18n.load(i18n.locale, messages);
  })();
  return loaded;
}
