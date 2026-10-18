// The ids of the elements that stand for a step or a trigger, in whichever view is shown.
// A check that says "show where" brings the keyboard to the element with this id, and a
// dialog that changed a step returns it there. On their own, so a view needs nothing more
// than these to be found.
export const stepElementId = (id: string): string => `automation-step-${id}`;
export const triggerElementId = (index: number): string => `automation-trigger-${String(index)}`;
/** The heading the keyboard goes to when what it was on has been removed. */
export const STEPS_HEADING_ID = 'automation-steps-heading';
/** The JSON view's text box, which a form's "Edit in JSON" hands the keyboard to. */
export const JSON_EDITOR_ID = 'automation-json-editor';
