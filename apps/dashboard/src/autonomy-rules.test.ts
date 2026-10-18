import { describe, expect, it } from 'vitest';
import { levelAlreadySet } from './autonomy-rules';

describe('levelAlreadySet', () => {
  it('saves nothing for a contact whose own level is already the one chosen', () => {
    expect(levelAlreadySet({ level: 'suggest', source: 'contact' }, 'suggest', 'contact')).toBe(
      true,
    );
    expect(levelAlreadySet({ level: 'suggest', source: 'contact' }, 'act', 'contact')).toBe(false);
  });

  it('still saves a contact their own level when the same one only comes from the business', () => {
    expect(levelAlreadySet({ level: 'ask', source: 'business' }, 'ask', 'contact')).toBe(false);
    expect(levelAlreadySet({ level: 'ask', source: 'default' }, 'ask', 'contact')).toBe(false);
  });

  it('gives up a contact’s own level only when they have one', () => {
    expect(levelAlreadySet({ level: 'act', source: 'contact' }, null, 'contact')).toBe(false);
    expect(levelAlreadySet({ level: 'ask', source: 'business' }, null, 'contact')).toBe(true);
    expect(levelAlreadySet({ level: 'ask', source: 'default' }, null, 'contact')).toBe(true);
  });

  it('saves nothing for the business when its level is already the one chosen', () => {
    expect(levelAlreadySet({ level: 'act', source: 'business' }, 'act', 'business')).toBe(true);
    expect(levelAlreadySet({ level: 'ask', source: 'default' }, 'suggest', 'business')).toBe(false);
    // Removing the business's own rule is always passed on: only the server knows the default.
    expect(levelAlreadySet({ level: 'ask', source: 'default' }, null, 'business')).toBe(false);
  });
});
