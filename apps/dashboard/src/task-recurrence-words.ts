// The words of recurring tasks and task reminders: the task panel's Recurring Task section,
// the repeat mark in the task lists, and Settings → My Notifications. A catalog of their own
// (lingui.config.ts), fetched with those parts, so they are not in the catalog every page
// downloads (scripts/check-budget.mjs). It is merged into the language in use.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const taskRecurrence: Catalogs = {
  en: () => import('./task-recurrence-locales/en/messages.po'),
};

let loaded: Promise<void> | undefined;

export function loadTaskRecurrenceWords(): Promise<void> {
  loaded ??= (async () => {
    const load = taskRecurrence[i18n.locale] ?? taskRecurrence['en'];
    if (load === undefined) return;
    const { messages } = await load();
    i18n.load(i18n.locale, messages);
  })();
  return loaded;
}
