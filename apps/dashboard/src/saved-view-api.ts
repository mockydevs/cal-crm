// The endpoint that lists saved views, in a module of its own so the row of views can ask
// for it when it reads them (saved-views.tsx): the saved-view contract brings the contact
// and opportunity schemas a view's state is made of, which a list's page starts without.
export { listViews } from '@repo/contracts';
