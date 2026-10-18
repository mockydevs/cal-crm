// The words of email verification: an email row's status and menu on the contact page, and
// Settings → Email Services → Email Verification. A catalog of their own (lingui.config.ts),
// fetched with those parts, so they are not in the catalog every page downloads
// (scripts/check-budget.mjs). It is merged into the language in use.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const emailVerification: Catalogs = {
  en: () => import('../email-verification-locales/en/messages.po'),
};

let loaded: Promise<void> | undefined;

export function loadEmailVerificationWords(): Promise<void> {
  loaded ??= (async () => {
    const load = emailVerification[i18n.locale] ?? emailVerification['en'];
    if (load === undefined) return;
    const { messages } = await load();
    i18n.load(i18n.locale, messages);
  })();
  return loaded;
}

/** A part with the words beside it: for `lazy`, so neither is drawn without the other. */
export async function withEmailVerificationWords<Module>(module: Promise<Module>): Promise<Module> {
  const [loadedModule] = await Promise.all([module, loadEmailVerificationWords()]);
  return loadedModule;
}
