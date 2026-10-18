// The words of the email step's panel, its template picker, its statistics and the popup
// email editor: a catalog of their own (lingui.config.ts), fetched with whichever of them
// is opened first, so they are not in the catalog every page downloads, which is at its
// budget (scripts/check-budget.mjs). The catalog is merged into the language in use:
// nothing is replaced, and a word that both catalogs hold is the same word.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const email: Catalogs = {
  en: () => import('./email-locales/en/messages.po'),
};

let loaded: Promise<void> | undefined;

export function loadEmailWords(): Promise<void> {
  loaded ??= (async () => {
    const load = email[i18n.locale] ?? email['en'];
    if (load === undefined) return;
    const { messages } = await load();
    i18n.load(i18n.locale, messages);
  })();
  return loaded;
}

/** A component with the email words beside it: for `lazy`, so neither is drawn without the other. */
export async function withEmailWords<Module>(module: Promise<Module>): Promise<Module> {
  const [loadedModule] = await Promise.all([module, loadEmailWords()]);
  return loadedModule;
}
