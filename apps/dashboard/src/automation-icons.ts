// The icon of each kind of step, the same in the Steps view and on the canvas: its own for
// the steps people use most, and its group's for the rest.
import { automationStepTypes } from '@repo/contracts';
import {
  Clock,
  CalendarClock,
  CalendarCheck,
  ListChecks,
  CalendarSync,
  CalendarDays,
  ContactRound,
  CornerDownRight,
  CircleDollarSign,
  ArrowRightLeft,
  BadgeCheck,
  BellRing,
  BellOff,
  FileInput,
  FilePenLine,
  FileText,
  FileX,
  Globe,
  Flag,
  GitBranch,
  Link2,
  Mail,
  MailCheck,
  MessageSquare,
  MessageCircle,
  MessageSquareDashed,
  MessageSquareText,
  MousePointerClick,
  ListTodo,
  ListFilter,
  LogOut,
  Phone,
  Pencil,
  Sparkles,
  Shuffle,
  Radar,
  Receipt,
  Send,
  Tag,
  TagX,
  Tags,
  Target,
  Timer,
  UserPlus,
  UserRoundCheck,
  UserRoundMinus,
  Webhook,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';

const groupIcons: Readonly<Record<string, LucideIcon>> = {
  messages: Mail,
  timing: Clock,
  logic: GitBranch,
  records: Pencil,
  ai: Sparkles,
  connect: Link2,
};

const ownIcons: Readonly<Record<string, LucideIcon>> = {
  'sms.send': MessageSquare,
  'whatsapp.send': MessageCircle,
  'manual.sms': MessageSquareDashed,
  'manual.call': Phone,
  'team.notify': BellRing,
  'wait.until': CalendarClock,
  'wait.event': Radar,
  'wait.condition': ListChecks,
  'wait.appointment': CalendarCheck,
  split: Shuffle,
  goto: CornerDownRight,
  goal: Target,
  'contact.update': ContactRound,
  'deal.create': CircleDollarSign,
  'deal.find': ListFilter,
  'deal.update': Pencil,
  'deal.move': ArrowRightLeft,
  'deal.close': BadgeCheck,
  'task.create': ListTodo,
  'owner.assign': UserRoundCheck,
  'owner.remove': UserRoundMinus,
  'note.create': FilePenLine,
  'dnd.set': BellOff,
  // The icons the owner's steps and a new contact have, so no more are loaded.
  'followers.add': UserPlus,
  'followers.remove': UserRoundMinus,
  'tag.add': Tag,
  'tag.remove': TagX,
  'ai.classify': ListFilter,
  'ai.draft_reply': MessageSquareText,
  'webhook.call': Webhook,
  'automation.run': Workflow,
  'automation.remove': LogOut,
  'score.modify': Target,
  'email.verify': MailCheck,
};

const triggerIcons: Readonly<Record<string, LucideIcon>> = {
  'contact.created': UserPlus,
  'contact.dnd_changed': BellOff,
  'contact.score_changed': Target,
  'field.changed': FilePenLine,
  'tag.added': Tags,
  'tag.removed': TagX,
  'task.created': ListTodo,
  'task.completed': BadgeCheck,
  'task.reminder': BellRing,
  'note.created': FileInput,
  'note.updated': FilePenLine,
  'form.submitted': FileInput,
  'message.received': MessageSquare,
  'trigger_link.clicked': MousePointerClick,
  'external_tracking.event': Globe,
  'appointment.booked': CalendarCheck,
  'appointment.status_changed': CalendarSync,
  'deal.stage_changed': ArrowRightLeft,
  'deal.closed': Flag,
  'quote.sent': Send,
  'quote.accepted': BadgeCheck,
  'quote.declined': FileX,
  'invoice.issued': FileText,
  'invoice.sent': Mail,
  'invoice.paid': CircleDollarSign,
  'payment.recorded': Receipt,
  'date.reached': CalendarDays,
  'webhook.received': Webhook,
  'automation.run_ended': Workflow,
  schedule: Timer,
};

/** Recognisable event icons; unknown events retain the generic trigger symbol. */
export function triggerIcon(type: string): LucideIcon {
  return Object.hasOwn(triggerIcons, type) ? (triggerIcons[type] ?? Zap) : Zap;
}

/** The icon for a step type; a type this version doesn't know gets the branch. */
export function stepIcon(type: string): LucideIcon {
  if (Object.hasOwn(ownIcons, type)) return ownIcons[type] ?? GitBranch;
  const group = Object.hasOwn(automationStepTypes, type)
    ? automationStepTypes[type as keyof typeof automationStepTypes].group
    : undefined;
  return (group === undefined ? undefined : groupIcons[group]) ?? GitBranch;
}

// The colour of an icon's tile, by where the step sits in the pickers
// (automation-catalogue.ts). A trigger's tile is green, as GoHighLevel's is.
const accentTileClassName = 'bg-accent text-link';
const neutralTileClassName = 'bg-secondary text-secondary-foreground';
export const triggerTileClassName = 'bg-success-subtle text-success';
const attentionTileClassName = 'bg-attention text-attention-foreground';
const assistantTileClassName = 'bg-assistant text-assistant-foreground';

/** The classes of a step's icon tile, from the category it is in. */
export function stepTileClassName(category: string): string {
  switch (category) {
    case 'contact':
    case 'opportunity':
      return accentTileClassName;
    case 'communication':
      return triggerTileClassName;
    case 'send_data':
      return attentionTileClassName;
    case 'workflow_ai':
      return assistantTileClassName;
    default:
      return neutralTileClassName;
  }
}
