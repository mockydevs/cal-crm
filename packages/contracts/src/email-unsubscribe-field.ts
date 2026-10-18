// Apart from the campaigns' contract, so the workflow builder, which checks a step's merge
// fields, does not load the whole of it for one name.
/**
 * The merge field that becomes the recipient's own unsubscribe address. A body that does
 * not use it gets a standard unsubscribe line at its end, so every campaign email shows
 * one (Google's and Yahoo's sender rules ask for a visible link in the body).
 */
export const EMAIL_UNSUBSCRIBE_MERGE_FIELD = 'email.unsubscribe_link';
