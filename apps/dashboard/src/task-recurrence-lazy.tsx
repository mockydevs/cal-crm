// The recurring task parts the task lists and forms show, each fetched with its words the
// first time it is drawn (task-recurrence-words.ts), so neither the lists nor the catalog
// every page downloads carry them.
import { lazy } from 'react';
import { loadTaskRecurrenceWords } from './task-recurrence-words';

export const RecurrenceSection = lazy(async () => {
  const [module] = await Promise.all([
    import('./task-recurrence-fields'),
    loadTaskRecurrenceWords(),
  ]);
  return { default: module.RecurrenceSection };
});

export const RecurrenceMark = lazy(async () => {
  const [module] = await Promise.all([import('./task-recurrence-mark'), loadTaskRecurrenceWords()]);
  return { default: module.RecurrenceMark };
});

export const SeriesDeleteChoice = lazy(async () => {
  const [module] = await Promise.all([import('./task-recurrence-mark'), loadTaskRecurrenceWords()]);
  return { default: module.SeriesDeleteChoice };
});
