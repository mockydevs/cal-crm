// The words the workflow builder says about where a lead came from, and those of the
// ready-made workflows: a catalog of their own (lingui.config.ts), fetched with the builder
// and with the recipes dialog, so they are not in the catalog every page downloads, which
// is at its budget (scripts/check-budget.mjs). The catalog is merged into the language in
// use: nothing is replaced, and a word that both catalogs hold is the same word.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const automation: Catalogs = {
  en: () => import('./automation-locales/en/messages.po'),
};

export async function loadAutomationWords(): Promise<void> {
  const load = automation[i18n.locale] ?? automation['en'];
  if (load === undefined) return;
  const { messages } = await load();
  i18n.load(i18n.locale, messages);
}
