// What the sign-in emails say: plain words and one link. The HTML is the same text, with
// the link as a link; anything from outside (the agency's name, the link) is escaped.

export interface Email {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** An invitation proves access to its email; it works once for seven days. */
export function invitationEmail(to: string, agency: string, url: string): Email {
  return email(
    to,
    `Join ${agency}`,
    `You've been invited to join ${agency}.`,
    url,
    'Accept invitation',
    'This invitation works once, within seven days, for this email address. If you were not expecting it, ignore this email.',
  );
}

function email(
  to: string,
  subject: string,
  lead: string,
  url: string,
  linkText: string,
  after: string,
): Email {
  return {
    to,
    subject,
    text: `${lead}\n\n${url}\n\n${after}\n`,
    html: [
      `<p>${escapeHtml(lead)}</p>`,
      `<p><a href="${escapeHtml(url)}">${escapeHtml(linkText)}</a></p>`,
      `<p>${escapeHtml(after)}</p>`,
    ].join('\n'),
  };
}

/** A magic link: it signs the person in once, within the given minutes. */
export function signInLinkEmail(to: string, agency: string, url: string, minutes: number): Email {
  return email(
    to,
    `Sign in to ${agency}`,
    `Open this link to sign in to ${agency}:`,
    url,
    `Sign in to ${agency}`,
    `It works once, within ${String(minutes)} minutes. If you didn't ask to sign in, ignore this email; nothing happens without the link.`,
  );
}

/** A password reset: the link works once, within the given minutes. */
export function passwordResetEmail(
  to: string,
  agency: string,
  url: string,
  minutes: number,
): Email {
  return email(
    to,
    `Reset your password for ${agency}`,
    `Open this link to choose a new password for ${agency}:`,
    url,
    'Choose a new password',
    `It works once, within ${String(minutes)} minutes, and signs you out everywhere else. If you didn't ask for this, ignore this email; your password stays as it is.`,
  );
}
