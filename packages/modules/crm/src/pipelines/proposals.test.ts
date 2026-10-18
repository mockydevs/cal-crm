import { expect, it } from 'vitest';
import { createPipelineProposables } from './proposals.js';
import { ValidationError } from '@repo/kernel';

it('uses the native pipeline command and refuses malformed changes before storing a card', () => {
  const [proposal] = createPipelineProposables();
  expect(proposal?.commandName).toBe('pipelines.save');
  expect(proposal?.permission).toBe('pipelines.manage');
  expect(() => proposal?.check({ revision: 'invented', items: [] })).toThrow(ValidationError);
});
