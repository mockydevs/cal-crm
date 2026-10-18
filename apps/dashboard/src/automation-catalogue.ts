// Where each action and trigger sits in the pickers: under GoHighLevel's category names,
// holding only what this product's catalog has. A type no category lists yet is kept, under
// Other, so nothing the catalog offers goes missing here.
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

export interface Category {
  readonly key: string;
  readonly label: MessageDescriptor;
  readonly types: readonly string[];
}

/** The action categories, in GoHighLevel's order, each with this product's own steps. */
export const actionCategories: readonly Category[] = [
  {
    key: 'contact',
    label: msg`Contact`,
    types: [
      'contact.update',
      'tag.add',
      'tag.remove',
      'owner.assign',
      'owner.remove',
      'dnd.set',
      'followers.add',
      'followers.remove',
      'task.create',
      'note.create',
      'score.modify',
      // GoHighLevel lists Email Verification last in Contact.
      'email.verify',
    ],
  },
  {
    key: 'communication',
    label: msg`Communication`,
    types: ['email.send', 'sms.send', 'whatsapp.send', 'manual.call', 'manual.sms', 'team.notify'],
  },
  { key: 'send_data', label: msg`Send data`, types: ['webhook.call'] },
  {
    key: 'internal',
    label: msg`Internal`,
    types: [
      'condition',
      'wait',
      'wait.until',
      'wait.event',
      'wait.condition',
      'wait.appointment',
      'split',
      'goto',
      'goal',
      'automation.run',
      'automation.remove',
    ],
  },
  {
    key: 'workflow_ai',
    label: msg`Workflow AI`,
    types: ['ai.ask', 'ai.classify', 'ai.draft_reply'],
  },
  {
    key: 'opportunity',
    label: msg`Opportunity`,
    types: ['deal.create', 'deal.find', 'deal.update', 'deal.move', 'deal.close'],
  },
];

/** The trigger categories, in GoHighLevel's order, each with this product's own triggers. */
export const triggerCategories: readonly Category[] = [
  {
    key: 'contact',
    label: msg`Contact`,
    types: [
      'contact.created',
      'field.changed',
      'contact.dnd_changed',
      'contact.score_changed',
      'tag.added',
      'tag.removed',
      'task.created',
      'task.completed',
      'task.reminder',
      'note.created',
      'note.updated',
      'date.reached',
    ],
  },
  {
    key: 'events',
    label: msg`Events`,
    types: [
      'form.submitted',
      'message.received',
      'trigger_link.clicked',
      'external_tracking.event',
      'webhook.received',
      'schedule',
      'automation.run_ended',
    ],
  },
  {
    key: 'appointments',
    label: msg`Appointments`,
    types: ['appointment.booked', 'appointment.status_changed'],
  },
  { key: 'opportunities', label: msg`Opportunities`, types: ['deal.stage_changed', 'deal.closed'] },
  {
    key: 'payments',
    label: msg`Payments`,
    types: [
      'quote.sent',
      'quote.accepted',
      'quote.declined',
      'invoice.issued',
      'invoice.sent',
      'invoice.paid',
      'payment.recorded',
    ],
  },
];

const other: Omit<Category, 'types'> = { key: 'other', label: msg`Other` };

export interface Section<Item> {
  readonly key: string;
  readonly label: MessageDescriptor;
  readonly items: readonly Item[];
}

/**
 * The items in their categories, each category in its own order; a category with nothing in
 * it is left out, and an item of a type no category names goes last, under Other.
 */
export function categorised<Item extends { readonly type: string }>(
  items: readonly Item[],
  categories: readonly Category[],
): Section<Item>[] {
  const placed = new Set(categories.flatMap((category) => category.types));
  const sections = categories.map((category) => ({
    key: category.key,
    label: category.label,
    items: category.types.flatMap((type) => items.filter((item) => item.type === type)),
  }));
  const rest = items.filter((item) => !placed.has(item.type));
  return [...sections, { ...other, items: rest }].filter((section) => section.items.length > 0);
}

/** The category an action or trigger is in, for the colour of its tile. */
export function categoryOf(type: string, categories: readonly Category[]): string {
  return categories.find((category) => category.types.includes(type))?.key ?? other.key;
}

/** Which of the items a search for these words finds: by what each is called. */
export function matching<Item>(
  items: readonly Item[],
  words: string,
  nameOf: (item: Item) => string,
): Item[] {
  const wanted = words.trim().toLowerCase();
  return wanted === ''
    ? [...items]
    : items.filter((item) => nameOf(item).toLowerCase().includes(wanted));
}
