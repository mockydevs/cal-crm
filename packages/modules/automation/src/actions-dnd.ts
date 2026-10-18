// dnd.set: do not disturb on or off through the CRM's own command, so the same revision
// check, events and audit apply as on the contact page. Outbound is every channel (the
// contact's do not contact) or one channel; inbound is the one switch for what the contact
// sends in. What the step leaves alone stays as the contact has it.
import type { CommandContext } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { readContactDetails, setContactDndCommand, type TaskOptions } from '@repo/module-crm';

import { runActionCommand } from './actions-command.js';

export async function setStepDnd(
  trx: DatabaseTransaction,
  command: CommandContext,
  options: TaskOptions,
  id: string,
  config: {
    readonly direction?: 'outbound' | 'inbound' | undefined;
    /** Left out only for inbound, which has no channels. */
    readonly channel?: 'all' | 'call' | 'email' | 'sms' | 'webchat' | undefined;
    readonly action: 'enable' | 'disable';
    readonly reason: string;
  },
): Promise<void> {
  const current = await readContactDetails(trx, command, id, options);
  const enabled = config.action === 'enable';
  const inbound = config.direction === 'inbound';
  const { channel } = config;
  const channels =
    inbound || channel === undefined || channel === 'all'
      ? current.dnd.channels
      : enabled
        ? [...new Set([...current.dnd.channels, channel])]
        : current.dnd.channels.filter((each) => each !== channel);
  await runActionCommand(command, setContactDndCommand(options), {
    id,
    all: !inbound && channel === 'all' ? enabled : current.dnd.all,
    channels,
    inbound: inbound ? enabled : current.dnd.inbound,
    reason: config.reason,
    revision: current.dnd.revision,
  });
}
