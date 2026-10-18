// Do not disturb as the contact page's DND tab has it: every channel at once, or one
// channel at a time. "Every channel" is the contact's do-not-contact flag
// (crm.contacts.do_not_contact), unchanged: the contact command still sets it, and this
// command sets the same column. The channels are crm.contacts.dnd_channels. Sending reads
// both in its own check (messaging's outbound policy), so a message queued before a change
// is still stopped by it.
//
// Inbound do not disturb (crm.contacts.dnd_inbound) is the other direction: what the
// contact sends in is blocked when it arrives (text messages; calls once the phone system
// checks it). It is one switch, as GoHighLevel has it, and stops nothing sent to the contact.
//
// As for do not contact: a change names the revision it was based on and
// says why, and the reason is kept in the command's audit row and in no event. It takes no
// lock beyond the contact's row.
import { defineCommand, requireBusiness, type Command } from '@repo/commands';
import { dndChannelsOf, setContactDndCommandInput, type ContactDetails } from '@repo/contracts';

import {
  dndRevisionOf,
  lockLiveContact,
  readContactDetails,
  requireRevision,
  storedDndChannels,
  type ContactDetailOptions,
} from './details.js';

export function setContactDndCommand(
  options: ContactDetailOptions,
): Command<typeof setContactDndCommandInput, ContactDetails> {
  return defineCommand({
    name: 'contact.set_dnd',
    permission: 'contacts.manage',
    input: setContactDndCommandInput,
    async handle(trx, input, command): Promise<ContactDetails> {
      const businessId = requireBusiness(command.context);
      const contact = await lockLiveContact(trx, businessId, input.id);
      const stored = storedDndChannels(contact.dnd_channels);
      requireRevision(
        "This contact's do not disturb settings",
        dndRevisionOf(contact.do_not_contact, stored, contact.dnd_inbound),
        input.revision,
      );
      const channels = dndChannelsOf(input.channels);
      const inbound = input.inbound ?? contact.dnd_inbound;
      const allChanged = input.all !== contact.do_not_contact;
      const inboundChanged = inbound !== contact.dnd_inbound;
      const enabled = channels.filter((channel) => !stored.includes(channel));
      const disabled = stored.filter((channel) => !channels.includes(channel));
      if (!allChanged && !inboundChanged && enabled.length === 0 && disabled.length === 0)
        return readContactDetails(trx, command, input.id, options);
      await trx
        .updateTable('crm.contacts')
        .set({ do_not_contact: input.all, dnd_channels: channels, dnd_inbound: inbound })
        .where('business_id', '=', businessId)
        .where('id', '=', contact.id)
        .execute();
      // The same two events the contact command writes, so a timeline and an automation
      // see one kind of change however it was made.
      if (allChanged)
        await command.emit({
          type: input.all ? 'contact.do_not_contact_set' : 'contact.do_not_contact_cleared',
          subject: { kind: 'contact', id: contact.id },
          records: [contact.id],
        });
      if (inboundChanged)
        await command.emit({
          type: inbound ? 'contact.inbound_dnd_set' : 'contact.inbound_dnd_cleared',
          subject: { kind: 'contact', id: contact.id },
          records: [contact.id],
        });
      // The channels now stopped, and which this change turned on and off, which are
      // settings and not personal data; never the reason. When the same save turned do not
      // contact on or off, it says so: one save is then one change to whoever counts saves
      // (the Contact DND trigger), not two.
      if (enabled.length > 0 || disabled.length > 0)
        await command.emit({
          type: 'contact.dnd_changed',
          subject: { kind: 'contact', id: contact.id },
          records: [contact.id],
          payload: {
            channels,
            enabled,
            disabled,
            ...(allChanged ? { doNotContact: input.all ? 'set' : 'cleared' } : {}),
          },
        });
      return readContactDetails(trx, command, input.id, options);
    },
  });
}
