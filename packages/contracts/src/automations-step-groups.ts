// The groups a step type belongs to, on their own: the API's answers name them, and a page
// that only calls an automation endpoint must not carry the whole catalog to do so.

export const automationStepGroups = [
  'messages',
  'timing',
  'logic',
  'records',
  'ai',
  'connect',
] as const;
