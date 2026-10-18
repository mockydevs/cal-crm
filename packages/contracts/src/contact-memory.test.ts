import { expect, it } from 'vitest';
import { contactMemory } from './contact-memory.js';

it('distinguishes missing contact memory from a saved summary and validates its timestamp', () => {
  expect(contactMemory.parse({ summary: null })).toEqual({ summary: null });
  const summary = {
    text: 'Planning an outdoor wedding in October.',
    updatedAt: '2026-10-08T10:00:00.000Z',
    throughEventId: null,
  };
  expect(contactMemory.parse({ summary })).toEqual({ summary });
  expect(contactMemory.safeParse({ summary: { ...summary, updatedAt: 'yesterday' } }).success).toBe(
    false,
  );
  expect(
    contactMemory.safeParse({ summary: { ...summary, throughEventId: 'ctc_wrong' } }).success,
  ).toBe(false);
});
