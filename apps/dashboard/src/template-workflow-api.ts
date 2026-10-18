// The endpoint that lists the workflows using a template, in a module of its own so the
// Templates page asks for it when someone looks (templates/rows.tsx): its contract brings
// the automation schemas, which the page starts without.
export { listTemplateWorkflowActions } from '@repo/contracts';
