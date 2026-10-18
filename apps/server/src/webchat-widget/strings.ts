// Every word the web chat widget shows a visitor, in one place, so it can be translated or
// overridden later without touching the widget's code. Plain, short English.

export const strings = {
  region: 'Chat',
  launcher: 'Chat with us',
  launcherUnread: 'Chat with us, new reply',
  close: 'Close chat',
  loading: 'Loading…',
  unavailable: 'Chat is not available right now. Please try again later.',
  nameLabel: 'Name',
  emailLabel: 'Email',
  optional: '(optional)',
  messageLabel: 'Message',
  messagePlaceholder: 'Write a message',
  start: 'Start chat',
  send: 'Send',
  endChat: 'End chat',
  you: 'You',
  team: 'Team',
  sending: 'Sending…',
  failed: 'Not sent.',
  retry: 'Try again',
  emailNeeded: 'Enter your email address.',
  emailInvalid: 'Enter a valid email address.',
  messageNeeded: 'Write a message first.',
  messageTooLong: 'This message is too long.',
  detailsRefused: 'Check your details and try again.',
  slowDown: 'You are sending messages quickly. Wait a moment and try again.',
  sessionEnded: 'This chat has ended. Start a new one to continue.',
  offline: 'Could not reach the chat. Check your connection and try again.',
  privacy:
    'Your messages go to our team. This chat is saved in this browser so you can come back to it.',
} as const;

export type Strings = { readonly [Key in keyof typeof strings]: string };
export type StringKey = keyof Strings;
