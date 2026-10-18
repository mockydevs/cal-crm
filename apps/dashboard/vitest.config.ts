import { availableParallelism } from 'node:os';

import { lingui } from '@lingui/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const inCi = process.env['CI'] === 'true';

export default defineConfig({
  plugins: [react(), lingui({ macroTransform: { parser: { syntax: 'typescript', tsx: true } } })],
  test: {
    // DOM suites contend at the CPU-derived default on machines with many logical cores, and
    // four workers on a two- or four-core CI machine starved each other into timeouts (42
    // on 2026-10-14's first run on our own CI server). One core is left for the rest.
    maxWorkers: Math.max(1, Math.min(4, availableParallelism() - 1)),
    // The long builder tests click through several panels; on a CI machine they take longer
    // than Vitest's five seconds without anything being wrong (vitest.setup.ts).
    testTimeout: inCi ? 20_000 : 5_000,
    setupFiles: ['vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit.xml' },
    coverage: {
      provider: 'v8',
      // The dashboard's unit-tested features: the automation builder, the form builder, and
      // what Settings → AI models works out before it draws, and the rules of the assistant in
      // the Inbox and of its autonomy control, and the in-app assistant (its rules, its
      // panel and its full-screen view). Existing pages retain their browser gates.
      include: [
        'src/phone-system-rules.ts',
        'src/voice-browser.ts',
        'src/calls-rules.ts',
        'src/automation*.{ts,tsx}',
        'src/forms*.{ts,tsx}',
        'src/ai-settings-rules.ts',
        'src/inbox-assistant-rules.ts',
        'src/autonomy-rules.ts',
        'src/assistant/**/*.{ts,tsx}',
        'src/snippet-picker*.{ts,tsx}',
        // Media Storage and the media picker: rules, uploads and every state.
        'src/media/**/*.{ts,tsx}',
        // The page editor's own rules (src/site-editor): our document as the canvas holds
        // it and back, a node's look on each device, the page document's limits while
        // editing, the stylesheet the canvas shares with the published page, saving by
        // itself, the draft kept in the browser, and what stands in the way of a save or a
        // publish. Its screens (the canvas, the panels, the fields, the dialogs) are
        // checked in a browser (e2e/site-editor.spec.ts) and are not counted here.
        'src/site-editor/document-map.ts',
        'src/site-editor/device.ts',
        'src/site-editor/tree.ts',
        'src/site-editor/node-css.ts',
        'src/site-editor/node-defaults.ts',
        'src/site-editor/autosave.ts',
        'src/site-editor/local-draft.ts',
        'src/site-editor/problems.ts',
        // What the panel works out about a popup, a calendar and a page's versions, and
        // what a page may name as a picture (an address anyone can open, its own size).
        'src/site-editor/element-rules.ts',
        'src/site-editor/version-rules.ts',
        'src/site-editor/pending-pictures.ts',
        'src/site-media-rules.ts',
        // The public booking page when the server says it is busy: how long it waits, and
        // that it asks again by itself a few times and no more.
        'src/public-booking-busy.ts',
        // How the visitor arrived, as the booking page sends it with a booking.
        'src/public-booking-visit.ts',
        // The tag chips a setting shows (a form's tags today): its rules and every state;
        // whose click ids are held, by platform; and what the contact page's Attribution
        // group lists of a touch.
        'src/tag-picker*.{ts,tsx}',
        'src/click-id-platforms.ts',
        'src/reporting/contact-attribution-rules.ts',
        'src/site-publish-rules.ts',
        // Reporting's rules: chart geometry, how numbers, money and dates are
        // written, a query's answer as a chart or a table, what the catalogue lets a
        // widget ask, the builder's steps, and what the pages keep in their addresses.
        // Its screens are checked by component tests (widget states) and in a browser.
        'src/reporting/chart-geometry.ts',
        'src/reporting/format.ts',
        'src/reporting/result-model.ts',
        'src/reporting/query-rules.ts',
        'src/reporting/builder-state.ts',
        'src/reporting-search.ts',
        // The Send email action and the email editor: the searchable list's
        // rules, a step's settings in each of its four forms and back, the template
        // picker's rows, the statistics' wording, and the editor's HTML on its way in and
        // out (chips and {{path}} text, pasted text, the plain-text part). Their screens
        // are checked by component tests and in a browser (e2e/automation-email.spec.ts).
        'src/search-picker-rules.ts',
        'src/email-step/config.ts',
        'src/email-step/rules.ts',
        'src/email-step/template-picker-rules.ts',
        'src/email-editor/email-html.ts',
        'src/email-editor/rules.ts',
        // Settings → Lead Sources: a rule as its editor holds it and as the API takes it,
        // a rule as a sentence, the limits, the order after a move, whether a rule being
        // written would match a checked link, and the tracking link builder's reading of
        // the catalogue. Its screens are checked by component tests and in a browser
        // (e2e/lead-sources.spec.ts).
        'src/lead-sources/rules.ts',
        'src/lead-sources/links.ts',
        // Marketing → Emails → Campaigns: a status and why a campaign waits, an
        // audience as a sentence, every skip reason and check in words, what a person may
        // do, the draft as the API takes it, and the schedule arithmetic as it is said.
        // Its screens are checked by component tests and in a browser
        // (e2e/campaigns.spec.ts).
        'src/campaigns/rules.ts',
        'src/campaigns/draft.ts',
        // The App Marketplace: the list and its Installed tab, an app's page with its install
        // and uninstall, the agency's Marketplace apps settings with an app's connection, the
        // page that connects an app, and their rules and address. Every state is checked by
        // component tests, and in a browser (e2e/marketplace.spec.ts).
        'src/marketplace*.{ts,tsx}',
        'src/oauth-consent*.{ts,tsx}',
      ],
      exclude: ['src/**/*.test.{ts,tsx}'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
