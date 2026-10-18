import { i18n, type Messages } from '@lingui/core';

// Each language's catalog is its own chunk, loaded only when that language is used.
const catalogs = {
  en: () => import('./locales/en/messages.po'),
} satisfies Record<string, () => Promise<{ messages: Messages }>>;

export type Locale = keyof typeof catalogs;

export async function activateLocale(locale: Locale): Promise<void> {
  const { messages } = await catalogs[locale]();
  i18n.loadAndActivate({ locale, messages });
}

export { i18n };
