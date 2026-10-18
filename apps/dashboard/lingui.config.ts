import { defineConfig } from '@lingui/cli';
import { formatter } from '@lingui/format-po';

// The Sites pages (the lists, a funnel's page, their dialogs) say their words nowhere
// else, so those are a catalog of their own, fetched with the pages (src/sites-words.ts).
const SITES = [
  'src/sites.tsx',
  'src/sites-create.tsx',
  'src/sites-dialogs.tsx',
  'src/site-page.tsx',
  'src/site-tabs.tsx',
  'src/site-publish.tsx',
  'src/site-publish-dialogs.tsx',
  'src/site-media-choice.tsx',
  'src/site-arrival-setting.tsx',
];

// The form builder, a form's submissions and numbers, and the tag chips its settings use
// say their words nowhere else either: a catalog of their own, fetched with the Forms page
// (src/forms-words.ts). A new place that shows the tag chips adds src/tag-picker.tsx to its
// own catalog's list as well: a file may be read into more than one catalog.
const FORMS = [
  'src/forms.tsx',
  'src/forms-editor.tsx',
  'src/forms-extras.tsx',
  'src/forms-source.tsx',
  'src/forms-link-check.tsx',
  'src/link-check-result.tsx',
  'src/forms-submissions.tsx',
  'src/tag-picker.tsx',
];

// The public booking page and the page that manages an appointment are what a visitor
// sees, never someone signed in: their words are fetched with them
// (src/public-booking-words.ts).
const BOOKING = ['src/public-booking.tsx'];

// What the workflow builder says about where a lead came from (its field lists, the lead
// source filters, the source of an opportunity) and the ready-made workflows: fetched with
// the builder and with the recipes dialog (src/automation-words.ts). The rest of the
// builder's words stay in the main catalog, where every page that shows a step's name
// already finds them.
const AUTOMATION = [
  'src/automation-source-fields.tsx',
  'src/automation-recipes.tsx',
  'src/automation-recipe-rules.ts',
  // A trigger's compact filters and the form it names, with the list they search.
  'src/automation-trigger-filters.ts',
  'src/automation-submission.ts',
  'src/automation-trigger-filters-panel.tsx',
  'src/search-picker.tsx',
  // Contacts → "Add to Workflow": the workflow picker, fetched with these words.
  'src/contact-add-to-workflow.tsx',
];

// The Send email action's panel, its template picker and statistics, and the popup email
// editor the Templates page opens too: fetched with whichever is opened first
// (src/email-words.ts). The searchable list is in this catalog as well, for a page that
// shows the editor without the builder.
const EMAIL = ['src/email-step', 'src/email-editor', 'src/search-picker.tsx'];

// Settings → Lead Sources: the business's own rules, the tracking link builder and "Check a
// link" (src/lead-sources-words.ts). The answer of a checked link, the tag chips and the
// searchable list are in this catalog as well: the page shows them without the form builder.
const LEAD_SOURCES = [
  'src/lead-sources',
  'src/link-check-result.tsx',
  'src/tag-picker.tsx',
  'src/search-picker.tsx',
];

// Marketing → Emails → Campaigns: the list, a campaign's editor and results, their dialogs,
// and the campaign ceiling in Settings → Email Services (src/campaigns-words.ts). The tag
// chips and the searchable list are in this catalog as well: the pages show them without
// the form builder or the email editor.
const CAMPAIGNS = [
  'src/campaigns',
  'src/email-library',
  'src/tag-picker.tsx',
  'src/search-picker.tsx',
];

// Marketing → Emails → Templates: the library, its menus and dialogs, and the plain-text
// template form (src/templates-words.ts). The Emails pages' shared library parts are in the
// Campaigns catalog as well: both pages show them.
const TEMPLATES = [
  'src/templates',
  'src/email-library',
  'src/template-editor.tsx',
  'src/template-folder-editor.tsx',
  'src/template-text.ts',
];
const PHONE = [
  'src/phone-system.tsx',
  'src/phone-system-calling.tsx',
  'src/phone-system-number.tsx',
  'src/phone-system-voice.tsx',
  'src/phone-system-parts.tsx',
  'src/sms-settings.tsx',
  'src/calls.tsx',
];

// The softphone's call bar and its problems: fetched with the bar, only for someone who may
// place calls while calling is available (src/softphone-words.ts).
const SOFTPHONE = ['src/softphone-active.tsx'];

// The App Marketplace, an app's page and the agency's Marketplace apps settings
// (src/marketplace-words.ts), and the page that connects an app. The search box
// and the tabs they show say nothing of their own.
const MARKETPLACE = [
  'src/marketplace.tsx',
  'src/marketplace-app.tsx',
  'src/marketplace-agency.tsx',
  'src/marketplace-parts.tsx',
  'src/marketplace-rules.ts',
  'src/oauth-consent.tsx',
];

// The contact list's bulk actions: the bar over the list, each action's dialog (tags,
// owner, export, email and text, do not disturb, opportunities, and when each runs) with
// the tag chips they show, and Contacts → Bulk Actions. Fetched with the bar when a contact
// is first ticked, and with the Bulk Actions page (src/contact-bulk-words.ts).
const CONTACT_BULK = [
  'src/contact-bulk',
  'src/contact-bulk-bar.tsx',
  'src/contact-bulk-actions.tsx',
  'src/tag-picker.tsx',
];

// Recurring tasks and task reminders: the task panel's Recurring Task section, the repeat
// mark and series deletion in the task lists, and Settings → My Notifications. Fetched with
// each of them (src/task-recurrence-words.ts).
const TASK_RECURRENCE = [
  'src/task-recurrence-fields.tsx',
  'src/task-recurrence-mark.tsx',
  'src/notification-settings.tsx',
];

// Settings → AI, for a business and for the agency: providers, models, the spending
// limit and keys say their words nowhere else (src/ai-settings-words.ts).
const AI_SETTINGS = [
  'src/ai-settings.tsx',
  'src/ai-settings-agency.tsx',
  'src/ai-settings-providers.tsx',
  'src/ai-settings-rules.ts',
];

// Settings → Manage Scoring and a contact's engagement score: fetched with the page and with
// the contact's score (src/scoring/words-loader.ts).
const SCORING = ['src/scoring'];

// Duplicate contacts: Contacts → Manage Duplicates, the review panel, a contact's "Possible
// duplicates" and Business Profile → Contact Deduplication Preferences, fetched with each of
// them (src/contact-duplicates/words.ts).
const CONTACT_DUPLICATES = ['src/contact-duplicates'];

// Email verification: an email row's status and menu on the contact page, and Settings →
// Email Services → Email Verification, fetched with each of them
// (src/email-verification/words.ts).
const EMAIL_VERIFICATION = ['src/email-verification'];

export default defineConfig({
  sourceLocale: 'en',
  // More languages are an open product decision.
  locales: ['en'],
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}/messages',
      include: ['src'],
      exclude: [
        'src/site-editor/**',
        'src/email-step/**',
        'src/email-editor/**',
        'src/lead-sources/**',
        'src/campaigns/**',
        ...SITES,
        ...FORMS,
        ...BOOKING,
        ...AUTOMATION,
        ...PHONE,
        ...SOFTPHONE,
        ...MARKETPLACE,
        ...CONTACT_BULK,
        ...TASK_RECURRENCE,
        ...AI_SETTINGS,
        ...SCORING,
        ...CONTACT_DUPLICATES,
        ...EMAIL_VERIFICATION,
        'src/templates/**',
        'src/email-library/**',
        ...TEMPLATES,
      ],
    },
    // The catalog every page downloads is at its budget (scripts/check-budget.mjs), so
    // what only one part of the dashboard says is kept apart from it: Sites, Forms, and the
    // page editor, whose words are fetched with the editor.
    { path: '<rootDir>/src/sites-locales/{locale}/messages', include: SITES },
    { path: '<rootDir>/src/forms-locales/{locale}/messages', include: FORMS },
    { path: '<rootDir>/src/booking-locales/{locale}/messages', include: BOOKING },
    { path: '<rootDir>/src/automation-locales/{locale}/messages', include: AUTOMATION },
    { path: '<rootDir>/src/email-locales/{locale}/messages', include: EMAIL },
    { path: '<rootDir>/src/lead-sources-locales/{locale}/messages', include: LEAD_SOURCES },
    { path: '<rootDir>/src/campaigns-locales/{locale}/messages', include: CAMPAIGNS },
    { path: '<rootDir>/src/phone-locales/{locale}/messages', include: PHONE },
    { path: '<rootDir>/src/softphone-locales/{locale}/messages', include: SOFTPHONE },
    { path: '<rootDir>/src/marketplace-locales/{locale}/messages', include: MARKETPLACE },
    { path: '<rootDir>/src/contact-bulk-locales/{locale}/messages', include: CONTACT_BULK },
    {
      path: '<rootDir>/src/task-recurrence-locales/{locale}/messages',
      include: TASK_RECURRENCE,
    },
    { path: '<rootDir>/src/ai-settings-locales/{locale}/messages', include: AI_SETTINGS },
    { path: '<rootDir>/src/scoring-locales/{locale}/messages', include: SCORING },
    {
      path: '<rootDir>/src/contact-duplicates-locales/{locale}/messages',
      include: CONTACT_DUPLICATES,
    },
    {
      path: '<rootDir>/src/email-verification-locales/{locale}/messages',
      include: EMAIL_VERIFICATION,
    },
    { path: '<rootDir>/src/templates-locales/{locale}/messages', include: TEMPLATES },
    {
      path: '<rootDir>/src/site-editor/locales/{locale}/messages',
      include: ['src/site-editor'],
    },
  ],
  // Files without line numbers, so moving code doesn't change the catalogs; CI checks
  // they're in sync with the source (lingui check sync).
  format: formatter({ lineNumbers: false }),
});
