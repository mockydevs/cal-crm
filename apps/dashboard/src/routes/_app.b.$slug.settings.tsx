import { createFileRoute } from '@tanstack/react-router';

// Settings' pages. In them the sidebar lists the settings pages in place of the modules
// (shell/app-shell.tsx), so each page has the whole width beside it.
export const Route = createFileRoute('/_app/b/$slug/settings')({});
