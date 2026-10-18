// Every word the form embed shows a visitor that is not the form's own (its title, its
// questions and its consent wording come from the business). Plain, short English, in one
// place, so it can be translated or overridden later without touching the embed's code.

export const strings = {
  region: 'Form',
  loading: 'Loading…',
  unavailable: 'This form is not available right now. Please try again later.',
  required: '(required)',
  choose: 'Choose…',
  sending: 'Sending…',
  answerNeeded: 'Answer this question.',
  tickNeeded: 'Tick this box to continue.',
  checkAnswers: 'Check the answers marked below and send again.',
  refused: 'Check your details and try again.',
  slowDown: 'Please wait a moment, then send again.',
  updated: 'This form was updated. Check your answers and send again.',
  offline: 'Could not send the form. Check your connection and try again.',
  // The link of a terms box whose form gave it no words of its own.
  termsLink: 'Read the terms',
  // Shown above a draft that someone on the team is previewing.
  preview: 'This is a preview. Nothing you send here is saved.',
  // In a preview, in place of sending the visitor on to another page.
  previewRedirect: 'When this form is published, people are sent on to:',
  // For anyone who reaches the field people are not meant to see.
  trap: 'Leave this field empty',
  // The bot check of a form that asks for one: the browser works, the visitor does nothing.
  botChecking: 'Checking that you’re a person…',
  botChecked: 'Check complete.',
  botFailed: 'We couldn’t finish checking that you’re a person. Send the form again to retry.',
} as const;

export type Strings = { readonly [Key in keyof typeof strings]: string };
