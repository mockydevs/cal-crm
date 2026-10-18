// The Automations page's search parameters, on their own so the route can validate an
// address without loading the page: the route file is in the first bundle, and anything it
// imports is too.
import { publicId } from '@repo/contracts';
import type { AutomationsSearch } from './automation-navigation';

const automationIdSchema = publicId('automation');
const runIdSchema = publicId('automation_enrolment');
const folderIdSchema = publicId('automation_folder');
const calendarIdSchema = publicId('calendar');
// The canvas is the view an address without one opens, so it is never written.
const views = ['steps', 'json', 'settings', 'runs', 'logs'] as const;

/** The page's search parameters, for the route to validate: anything else is dropped. */
export function automationsSearch(search: Record<string, unknown>): AutomationsSearch {
  const automation = automationIdSchema.safeParse(search['automation']);
  const view = views.find((each) => each === search['view']);
  const run = runIdSchema.safeParse(search['run']);
  const folder = folderIdSchema.safeParse(search['folder']);
  // The list's own place: only while no workflow is open, and a folder never in Deleted,
  // where nothing is in one.
  if (!automation.success && view === undefined) {
    if (search['list'] === 'deleted') return { list: 'deleted' };
    // A recipe opened from elsewhere, such as a calendar's settings, with its calendar.
    if (search['recipe'] === 'appointment_reminders') {
      const calendar = calendarIdSchema.safeParse(search['calendar']);
      return {
        recipe: 'appointment_reminders',
        ...(calendar.success ? { calendar: calendar.data } : {}),
      };
    }
    if (folder.success) return { folder: folder.data };
  }
  return {
    ...(automation.success ? { automation: automation.data } : {}),
    ...(view === undefined ? {} : { view }),
    // A run is only ever open inside its automation's runs.
    ...(automation.success && view === 'runs' && run.success ? { run: run.data } : {}),
  };
}
