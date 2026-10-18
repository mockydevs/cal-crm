// The words of the contact list's bulk action dialogs: a catalog of their own
// (lingui.config.ts), fetched when a bulk action is first chosen, so they are not in the
// catalog every page downloads, which is at its budget (scripts/check-budget.mjs). The
// catalog is merged into the language in use: nothing is replaced, and a word that both
// catalogs hold is the same word.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const contactBulk: Catalogs = {
  en: () => import('./contact-bulk-locales/en/messages.po'),
};

let loaded: Promise<void> | undefined;

export function loadContactBulkWords(): Promise<void> {
  loaded ??= (async () => {
    const load = contactBulk[i18n.locale] ?? contactBulk['en'];
    if (load === undefined) return;
    const { messages } = await load();
    i18n.load(i18n.locale, messages);
  })();
  return loaded;
}
