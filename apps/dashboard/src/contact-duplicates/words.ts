// The words of duplicate contacts: Contacts → Manage Duplicates, the review panel, a
// contact's "Possible duplicates" and Business Profile → Contact Deduplication
// Preferences. A catalog of their own (lingui.config.ts), fetched with those parts, so they
// are not in the catalog every page downloads (scripts/check-budget.mjs). It is merged into
// the language in use.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const contactDuplicates: Catalogs = {
  en: () => import('../contact-duplicates-locales/en/messages.po'),
};

let loaded: Promise<void> | undefined;

export function loadContactDuplicateWords(): Promise<void> {
  loaded ??= (async () => {
    const load = contactDuplicates[i18n.locale] ?? contactDuplicates['en'];
    if (load === undefined) return;
    const { messages } = await load();
    i18n.load(i18n.locale, messages);
  })();
  return loaded;
}
