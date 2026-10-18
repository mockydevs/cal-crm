// How long the reason given with a do-not-contact change may be. On its own so that the
// automation catalog, whose Set do not disturb step takes such a reason, can use the limits
// without loading the contact's preference endpoints with it.

/** The shortest reason that can say why do not contact was turned on or off. */
export const DO_NOT_CONTACT_REASON_MIN = 10;
export const DO_NOT_CONTACT_REASON_MAX = 1000;
