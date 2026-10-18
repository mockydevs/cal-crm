// The words of engagement scoring: Settings → Manage Scoring and the contact's score. A
// catalog of their own (lingui.config.ts), fetched with those parts, so they are not in the
// catalog every page downloads (scripts/check-budget.mjs). It is merged into the language
// in use: nothing is replaced, and a word both catalogs hold is the same word.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const scoring: Catalogs = {
  en: () => import('../scoring-locales/en/messages.po'),
};

let loaded: Promise<void> | undefined;

export function loadScoringWords(): Promise<void> {
  loaded ??= (async () => {
    const load = scoring[i18n.locale] ?? scoring['en'];
    if (load === undefined) return;
    const { messages } = await load();
    i18n.load(i18n.locale, messages);
  })();
  return loaded;
}

/** A part with the words beside it: for `lazy`, so neither is drawn without the other. */
export async function withScoringWords<Module>(module: Promise<Module>): Promise<Module> {
  const [loadedModule] = await Promise.all([module, loadScoringWords()]);
  return loadedModule;
}
