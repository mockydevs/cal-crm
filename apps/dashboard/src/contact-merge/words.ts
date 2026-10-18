// The words of merging contacts: the Merge Contacts dialog, wherever it opens. A catalog of
// their own (lingui.config.ts), fetched with the dialog, so they are not in the catalog every
// page downloads (scripts/check-budget.mjs). It is merged into the language in use.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const contactMerge: Catalogs = {
  en: () => import('../contact-merge-locales/en/messages.po'),
};

let loaded: Promise<void> | undefined;

export function loadContactMergeWords(): Promise<void> {
  loaded ??= (async () => {
    const load = contactMerge[i18n.locale] ?? contactMerge['en'];
    if (load === undefined) return;
    const { messages } = await load();
    i18n.load(i18n.locale, messages);
  })();
  return loaded;
}
