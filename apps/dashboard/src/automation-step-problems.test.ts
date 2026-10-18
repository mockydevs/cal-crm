import { describe, expect, it } from 'vitest';
import { inFlow, placeInDocument, problemsAt } from './automation-step-problems';

describe('problemsAt', () => {
  const issues = [
    { level: 'warning', path: '/steps/go/config/automation', message: 'A warning.' },
    { level: 'error', path: '/steps/go/config/automation', message: 'It would loop.' },
    { level: 'error', path: '/steps/go/config/automation', message: 'A second thing.' },
    { level: 'error', path: '/steps/clear/config/except/1', message: 'No automation is "Gone".' },
    { level: 'error', path: '/steps/go', message: 'About the step as a whole.' },
    { level: 'error', path: '/steps/a~1b/config/tag', message: 'Escaped.' },
  ] as const;

  it("sorts a step's errors under the settings they name, the first for each", () => {
    expect(problemsAt(issues, 'go')).toEqual({ automation: 'It would loop.' });
    expect(problemsAt(issues, 'clear')).toEqual({ except: 'No automation is "Gone".' });
    expect(problemsAt(issues, 'a/b')).toEqual({ tag: 'Escaped.' });
    expect(problemsAt(issues, 'other')).toEqual({});
  });

  it("sorts a trigger's the same way, by its place among the triggers", () => {
    const found = [
      { level: 'error', path: '/triggers/1/config/automations/0', message: 'It would loop.' },
      { level: 'error', path: '/triggers/10/config/form', message: 'Another trigger.' },
      { level: 'error', path: '/triggers', message: 'About them all.' },
    ];
    expect(problemsAt(found, 1)).toEqual({ automations: 'It would loop.' });
    expect(problemsAt(found, 0)).toEqual({});
  });
});

describe('a refusal about a step as a whole', () => {
  const found = [
    { level: 'error', path: '/steps/back/next', message: 'A Go To ends its path.' },
    { level: 'error', path: '/steps/back', message: 'The steps back, wait loop without a wait.' },
    { level: 'error', path: '/steps/back/config/target', message: "There's no step gone." },
    { level: 'warning', path: '/steps/other', message: 'A warning.' },
  ];

  it('is said under the one setting it is about, when the step has one, after its own', () => {
    expect(problemsAt(found, 'back', 'target')).toEqual({ target: 'A Go To ends its path.' });
    expect(problemsAt(found.slice(1), 'back', 'target')).toEqual({
      target: 'The steps back, wait loop without a wait.',
    });
    expect(problemsAt(found, 'back')).toEqual({ target: "There's no step gone." });
    expect(problemsAt(found, 'other', 'target')).toEqual({});
  });
});

describe('the place a refusal names', () => {
  it('is a place in the document, whether a save or a publish was refused', () => {
    expect(placeInDocument('/document/steps/go/config/automation')).toBe(
      '/steps/go/config/automation',
    );
    expect(placeInDocument('/steps/go/config/automation')).toBe('/steps/go/config/automation');
    expect(placeInDocument('/document/name')).toBe('/name');
    expect(placeInDocument('/documents')).toBe('/documents');
  });

  it('is in the flow when it is in a step or a trigger', () => {
    expect(inFlow('/steps/go/config/automation')).toBe(true);
    expect(inFlow('/triggers/0')).toBe(true);
    expect(inFlow('/name')).toBe(false);
    expect(inFlow('/start')).toBe(false);
  });
});
