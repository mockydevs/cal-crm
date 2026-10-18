import { automationStepTypes } from '@repo/contracts';
import {
  CalendarCheck,
  CalendarSync,
  GitBranch,
  ListTodo,
  LogOut,
  Mail,
  MailCheck,
  MessageSquare,
  MessageSquareDashed,
  Phone,
  Tag,
  TagX,
  UserPlus,
  UserRoundCheck,
  Workflow,
} from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { actionCategories, categoryOf } from './automation-catalogue';
import { stepIcon, stepTileClassName, triggerIcon, triggerTileClassName } from './automation-icons';

describe('the icon of a step', () => {
  it('is its own for the steps people use most, and its group’s for the rest', () => {
    expect(stepIcon('sms.send')).toBe(MessageSquare);
    expect(stepIcon('manual.sms')).toBe(MessageSquareDashed);
    expect(stepIcon('manual.call')).toBe(Phone);
    expect(stepIcon('email.send')).toBe(Mail);
    expect(stepIcon('condition')).toBe(GitBranch);
  });

  it('distinguishes adding and removing tags, tasks and owner assignment', () => {
    expect(stepIcon('tag.add')).toBe(Tag);
    expect(stepIcon('tag.remove')).toBe(TagX);
    expect(stepIcon('task.create')).toBe(ListTodo);
    expect(stepIcon('owner.assign')).toBe(UserRoundCheck);
    expect(stepIcon('deal.create')).not.toBe(stepIcon('deal.move'));
    expect(stepIcon('deal.move')).not.toBe(stepIcon('deal.close'));
  });

  it('distinguishes starting another automation from removing a contact from some', () => {
    expect(stepIcon('automation.run')).toBe(Workflow);
    expect(stepIcon('automation.remove')).toBe(LogOut);
    expect(categoryOf('automation.remove', actionCategories)).toBe(
      categoryOf('automation.run', actionCategories),
    );
  });

  it('distinguishes contact creation, booking and appointment changes', () => {
    expect(triggerIcon('contact.created')).toBe(UserPlus);
    expect(triggerIcon('appointment.booked')).toBe(CalendarCheck);
    expect(triggerIcon('appointment.status_changed')).toBe(CalendarSync);
  });

  it('marks an Email verification step with a checked envelope', () => {
    expect(stepIcon('email.verify')).toBe(MailCheck);
  });

  it('is the branch for a type this version does not know', () => {
    expect(stepIcon('brand.new')).toBe(GitBranch);
  });

  it('has a tile of its category’s colour for every step the catalog has', () => {
    for (const type of Object.keys(automationStepTypes))
      expect(stepTileClassName(categoryOf(type, actionCategories))).toMatch(/^bg-\S+ text-\S+$/);
    expect(stepTileClassName('communication')).toBe(triggerTileClassName);
    expect(stepTileClassName('contact')).toBe(stepTileClassName('opportunity'));
    expect(stepTileClassName('send_data')).not.toBe(stepTileClassName('workflow_ai'));
    expect(stepTileClassName('other')).toBe(stepTileClassName('internal'));
  });
});
