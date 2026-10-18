import { t as words } from '@lingui/core/macro';
import type { MissingSetup } from './automation-availability';

/** What a step that can't be used here yet needs, as its line in the picker says it. */
export function needsWords(missing: MissingSetup): string {
  switch (missing) {
    case 'email':
      return words`Connect a mailbox in Settings to use this action.`;
    case 'sms':
      return words`Connect a text message provider in Settings to use this action.`;
    case 'whatsapp':
      return words`Connect WhatsApp in Settings to use this action.`;
    case 'ai':
      return words`Add an AI key in Settings to use this action.`;
    case 'webhooks':
      return words`Create a webhook signing secret in Settings to use this action.`;
    case 'verification':
      return words`Turn on email verification in Settings → Email Services → Email Verification to use this action.`;
    case 'only_one':
      return words`This workflow already has one, and one is the most. Add what else meets the goal to it.`;
    case 'unavailable':
      return words`This action isn't available yet.`;
  }
}
