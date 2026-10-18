// What is wrong or missing on a form, worked out with no model: what the in-app assistant's
// panel shows on a form's page, and what the assistant itself is told. A blocker is one of
// the form's own problems, which stop it being published. A suggestion is something a form
// usually has and this one lacks; it stops nothing.
//
// Pure: it reads a form as the API already answers it, and how many workflows listen to it.
import type { AssistantCheck, AssistantTarget, Form } from '@repo/contracts';

type CheckedForm = Pick<
  Form,
  'id' | 'status' | 'definition' | 'allowedOrigins' | 'problems' | 'hasUnpublishedChanges'
>;

/** The part of the form's page a problem at this path is fixed in. */
function sectionOf(path: string): string | null {
  if (path.startsWith('/fields')) return 'questions';
  if (path.startsWith('/consents')) return 'consent';
  if (path.startsWith('/notify')) return 'notify';
  if (path.startsWith('/contactActions')) return 'actions';
  if (path.startsWith('/allowedOrigins')) return 'websites';
  return null;
}

/**
 * A form's checks, blockers first. `listeners` is how many running workflows start when
 * the form is sent, or undefined when nobody could say (then that is not suggested).
 */
export function formChecks(form: CheckedForm, listeners: number | undefined): AssistantCheck[] {
  // An archived form serves nothing and is not being built: there is nothing to suggest.
  if (form.status === 'archived') return [];
  const at = (section: string | null, path: string | null): AssistantTarget => ({
    kind: 'form',
    id: form.id,
    section,
    path,
  });
  const blockers: AssistantCheck[] = form.problems.map((problem) => ({
    severity: 'blocker',
    code: problem.code,
    message: problem.message,
    target: at(sectionOf(problem.path), problem.path),
  }));
  const suggestions: AssistantCheck[] = [];
  const suggest = (code: string, message: string, target: AssistantTarget): void => {
    suggestions.push({ severity: 'suggestion', code, message, target });
  };
  const { definition } = form;
  if (definition.consents.length === 0)
    suggest(
      'no_consent_box',
      'This form has no consent box, so nobody who sends it agrees to marketing messages.',
      at('consent', '/consents'),
    );
  if (form.allowedOrigins.length === 0)
    suggest(
      'no_allowed_website',
      'No website may show this form yet. It has a page of its own to share; list a website to embed it there.',
      at('websites', '/allowedOrigins'),
    );
  if (listeners === 0)
    suggest(
      'no_workflow',
      'No workflow starts when this form is sent, so nothing follows a submission by itself.',
      { kind: 'automations', id: null, section: null, path: null },
    );
  if (!definition.fields.some((field) => field.type === 'hidden'))
    suggest(
      'no_campaign_field',
      'This form has no hidden field, so it cannot record which campaign a visitor came from.',
      at('questions', '/fields'),
    );
  if (definition.notify?.mode === 'nobody')
    suggest('nobody_notified', 'Nobody is told when this form is sent.', at('notify', '/notify'));
  if (form.hasUnpublishedChanges)
    suggest(
      'unpublished_changes',
      'This form has changes that are not published: websites still show the version before.',
      at('publish', null),
    );
  return [...blockers, ...suggestions];
}
