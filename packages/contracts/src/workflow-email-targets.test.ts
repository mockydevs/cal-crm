import { expect, it } from 'vitest';
import { workflowEmailTarget } from './workflow-email-targets.js';

const automation = 'aut_01k8e2wzr0e008000000000010';
const version = 'aver_01k8e2wzr0e008000000000011';

it('requires an explicit draft revision for a draft content target', () => {
  expect(
    workflowEmailTarget.parse({ scope: 'draft', automation, step: 'welcome', baseDraftVersion: 3 }),
  ).toEqual({
    scope: 'draft',
    automation,
    step: 'welcome',
    baseDraftVersion: 3,
  });
  expect(
    workflowEmailTarget.safeParse({ scope: 'draft', automation, step: 'welcome' }).success,
  ).toBe(false);
});

it('requires the exact published version and independent content revision', () => {
  expect(
    workflowEmailTarget.parse({
      scope: 'published',
      automation,
      step: 'welcome',
      version,
      contentRevision: 2,
    }),
  ).toEqual({
    scope: 'published',
    automation,
    step: 'welcome',
    version,
    contentRevision: 2,
  });
  expect(
    workflowEmailTarget.safeParse({
      scope: 'published',
      automation,
      step: 'welcome',
      contentRevision: 2,
    }).success,
  ).toBe(false);
  expect(
    workflowEmailTarget.safeParse({ scope: 'published', automation, step: 'welcome', version })
      .success,
  ).toBe(false);
});

it.each([0, -1, 1.5, '2', null])('rejects invalid revision %j for either scope', (revision) => {
  expect(
    workflowEmailTarget.safeParse({
      scope: 'draft',
      automation,
      step: 'welcome',
      baseDraftVersion: revision,
    }).success,
  ).toBe(false);
  expect(
    workflowEmailTarget.safeParse({
      scope: 'published',
      automation,
      step: 'welcome',
      version,
      contentRevision: revision,
    }).success,
  ).toBe(false);
});

it('rejects cross-scope fields and tenant or content mass assignment', () => {
  const draft = { scope: 'draft', automation, step: 'welcome', baseDraftVersion: 3 };
  expect(workflowEmailTarget.safeParse({ ...draft, version }).success).toBe(false);
  expect(workflowEmailTarget.safeParse({ ...draft, businessId: 'other' }).success).toBe(false);
  expect(
    workflowEmailTarget.safeParse({ ...draft, subject: 'Replace without preview' }).success,
  ).toBe(false);
  expect(
    workflowEmailTarget.safeParse({
      scope: 'all',
      automation,
      step: 'welcome',
      baseDraftVersion: 3,
    }).success,
  ).toBe(false);
});

it('rejects identifiers from another resource kind and empty step keys', () => {
  expect(
    workflowEmailTarget.safeParse({
      scope: 'draft',
      automation: version,
      step: 'welcome',
      baseDraftVersion: 3,
    }).success,
  ).toBe(false);
  expect(
    workflowEmailTarget.safeParse({ scope: 'draft', automation, step: '', baseDraftVersion: 3 })
      .success,
  ).toBe(false);
  expect(
    workflowEmailTarget.safeParse({
      scope: 'published',
      automation,
      step: 'welcome',
      version: automation,
      contentRevision: 1,
    }).success,
  ).toBe(false);
});
