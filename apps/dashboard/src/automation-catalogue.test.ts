import { automationStepTypes, automationTriggerTypes } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  actionCategories,
  categorised,
  categoryOf,
  matching,
  triggerCategories,
} from './automation-catalogue';

const typed = (types: readonly string[]): { type: string }[] => types.map((type) => ({ type }));

describe('the categories of the pickers', () => {
  it('place every step the catalog has, each once', () => {
    const placed = actionCategories.flatMap((category) => category.types);
    expect([...placed].sort()).toEqual(Object.keys(automationStepTypes).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('place every trigger the catalog has, each once', () => {
    const placed = triggerCategories.flatMap((category) => category.types);
    expect([...placed].sort()).toEqual(Object.keys(automationTriggerTypes).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it("group what is offered under GoHighLevel's names, in their order, leaving empty ones out", () => {
    const sections = categorised(
      typed(['sms.send', 'wait', 'condition', 'tag.add', 'email.send']),
      actionCategories,
    );
    expect(
      sections.map((section) => [section.key, section.items.map((item) => item.type)]),
    ).toEqual([
      ['contact', ['tag.add']],
      ['communication', ['email.send', 'sms.send']],
      ['internal', ['condition', 'wait']],
    ]);
  });

  it('keep a type no category names, last, under Other', () => {
    const sections = categorised(typed(['brand.new', 'deal.closed']), triggerCategories);
    expect(sections.map((section) => section.key)).toEqual(['opportunities', 'other']);
    expect(sections[1]?.items).toEqual([{ type: 'brand.new' }]);
  });

  it('say which category a type is in', () => {
    expect(categoryOf('email.send', actionCategories)).toBe('communication');
    expect(categoryOf('deal.closed', triggerCategories)).toBe('opportunities');
    expect(categoryOf('brand.new', actionCategories)).toBe('other');
  });
});

describe('searching a picker', () => {
  const items = [{ name: 'Send email' }, { name: 'Send text' }, { name: 'Wait' }];
  const nameOf = (item: { name: string }): string => item.name;

  it('finds by any part of the name, whatever its capitals', () => {
    expect(matching(items, ' SEND ', nameOf)).toEqual([
      { name: 'Send email' },
      { name: 'Send text' },
    ]);
    expect(matching(items, 'ai', nameOf)).toEqual([{ name: 'Send email' }, { name: 'Wait' }]);
  });

  it('finds everything for no words, and nothing for words in no name', () => {
    expect(matching(items, '  ', nameOf)).toEqual(items);
    expect(matching(items, 'call', nameOf)).toEqual([]);
  });
});
