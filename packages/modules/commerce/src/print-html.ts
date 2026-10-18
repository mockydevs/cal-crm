// A quote or an invoice as a page of its own: what /d/<token> answers with. It draws the
// same description the PDF is drawn from (print.ts), so the two say the same.
//
// The page is the whole answer: no script runs on it, nothing is loaded from anywhere but
// its own address (the logo), and the one style block is named in the policy by its
// digest. Every word a business or a customer typed is escaped before it is written. The
// only things a visitor can do are download the PDF and, on a quote still open, press
// Accept or Decline, which are plain forms that post back to this address.
import { createHash } from 'node:crypto';

import type { Printed } from './print.js';

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text as it may be written between tags or inside a quoted attribute. */
export const escapeHtml = (text: string): string =>
  text.replaceAll(/[&<>"']/g, (character) => ESCAPES[character] ?? character);

/** The whole of the page's style. */
export const DOCUMENT_PAGE_STYLE = [
  'html{background:#f3f5f2}',
  'body{margin:0;padding:24px 12px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1d2a24}',
  'main{max-width:820px;margin:0 auto}',
  '.sheet{background:#fff;border:1px solid #d5dbd7;border-radius:8px;padding:32px;position:relative;overflow:hidden}',
  '.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin:0 0 16px}',
  '.bar form{display:inline}',
  '.button{display:inline-block;font:inherit;font-weight:600;padding:8px 16px;border-radius:6px;border:1px solid #1d2a24;background:#fff;color:#1d2a24;text-decoration:none;cursor:pointer}',
  '.primary{background:#1d2a24;color:#fff}',
  '.notice{margin:0 0 16px;padding:10px 14px;border-radius:6px;background:#e8eeea;border:1px solid #d5dbd7}',
  '.top{display:flex;flex-wrap:wrap;gap:24px;justify-content:space-between}',
  '.logo{max-width:150px;max-height:64px;display:block;margin:0 0 10px}',
  'h1{font-size:24px;letter-spacing:.04em;margin:0;text-align:right;text-transform:uppercase}',
  'h2{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#5f6b66;margin:24px 0 4px}',
  '.number{text-align:right;font-size:15px;margin:2px 0 8px}',
  '.name{font-weight:600;font-size:15px}',
  '.muted{color:#5f6b66}',
  'p{margin:0}',
  '.text{white-space:pre-wrap;overflow-wrap:anywhere}',
  'table{border-collapse:collapse}',
  '.facts{margin-left:auto}',
  '.facts td{padding:1px 0 1px 16px}',
  '.facts td+td,.lines td+td,.lines th+th,.totals td+td{text-align:right}',
  '.wide{overflow-x:auto;margin-top:20px}',
  '.lines{width:100%}',
  '.lines th{font-size:11px;color:#5f6b66;text-align:left;padding:6px 0 6px 12px;white-space:nowrap}',
  '.lines td{border-top:1px solid #d5dbd7;padding:8px 0 8px 12px;vertical-align:top;white-space:nowrap}',
  '.lines th:first-child,.lines td:first-child{padding-left:0;white-space:normal;overflow-wrap:anywhere}',
  '.totals{margin:16px 0 0 auto}',
  '.totals td{padding:3px 0 3px 24px}',
  '.totals td:first-child{padding-left:0;color:#5f6b66}',
  '.strong td{font-weight:600;font-size:16px;color:#1d2a24!important}',
  '.mark{position:absolute;top:38%;left:0;right:0;text-align:center;font-size:96px;font-weight:700;color:#9aa5a0;opacity:.16;transform:rotate(-30deg);pointer-events:none}',
  '.foot{margin:16px 0 0;font-size:12px;color:#5f6b66;text-align:center}',
  '@media print{html{background:#fff}body{padding:0}.bar,.notice{display:none}.sheet{border:0;padding:0}}',
].join('');

const sha256 = (text: string): string => createHash('sha256').update(text).digest('base64');

/**
 * What the page may do: use the one style block above, show images of its own address (the
 * logo), and post its forms back to its own address. No script, no frame around it, nothing
 * loaded from anywhere else.
 */
export const DOCUMENT_PAGE_POLICY = [
  "default-src 'none'",
  `style-src 'sha256-${sha256(DOCUMENT_PAGE_STYLE)}'`,
  "img-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export interface DocumentPage {
  readonly printed: Printed;
  /** The page's own path, /d/<token>, already checked to be a token's shape. */
  readonly path: string;
  /** Whether /d/<token>/logo answers with an image. */
  readonly logo: boolean;
  /** Whether the customer can accept or decline here, now. */
  readonly answerable: boolean;
  /** One line above the document: what happened, or why something cannot be done. */
  readonly notice?: string | undefined;
}

const shell = (title: string, body: string): string =>
  [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${DOCUMENT_PAGE_STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    body,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');

const paragraphs = (lines: readonly string[], style: string): string =>
  lines.map((line) => `<p class="${style}">${escapeHtml(line)}</p>`).join('');

/** The page of a document: the same words as its PDF, with what a visitor can do above. */
export function documentPage(page: DocumentPage): string {
  const { printed, path } = page;
  const named = [printed.title, printed.number].filter((part) => part !== null).join(' ');
  const [description, ...numbers] = printed.columns;
  const form = (action: string, label: string, primary: boolean): string =>
    `<form method="post" action="${path}/${action}"><button class="button${primary ? ' primary' : ''}" type="submit">${label}</button></form>`;
  const body = [
    page.notice === undefined
      ? ''
      : `<p class="notice" role="status">${escapeHtml(page.notice)}</p>`,
    '<div class="bar">',
    `<span>${page.answerable ? form('accept', 'Accept quote', true) + ' ' + form('decline', 'Decline', false) : ''}</span>`,
    `<a class="button" href="${path}/pdf">Download PDF</a>`,
    '</div>',
    '<article class="sheet">',
    printed.mark === null ? '' : `<div class="mark" aria-hidden="true">${printed.mark}</div>`,
    '<div class="top">',
    '<div>',
    page.logo ? `<img class="logo" src="${path}/logo" alt="">` : '',
    `<p class="name">${escapeHtml(printed.seller.name)}</p>`,
    paragraphs(printed.seller.lines, 'muted'),
    '</div>',
    '<div>',
    `<h1>${escapeHtml(printed.title)}</h1>`,
    `<p class="number">${escapeHtml(printed.number ?? 'Draft')}</p>`,
    '<table class="facts">',
    ...printed.facts.map(
      (fact) =>
        `<tr><td class="muted">${escapeHtml(fact.label)}</td><td>${escapeHtml(fact.value)}</td></tr>`,
    ),
    '</table>',
    '</div>',
    '</div>',
    `<h2>${escapeHtml(printed.customer.heading)}</h2>`,
    `<p class="name">${escapeHtml(printed.customer.name)}</p>`,
    paragraphs(printed.customer.lines, 'muted'),
    printed.lines.length === 0
      ? ''
      : [
          '<div class="wide"><table class="lines">',
          `<thead><tr><th scope="col">${escapeHtml(description)}</th>${numbers
            .map((heading) => `<th scope="col">${escapeHtml(heading)}</th>`)
            .join('')}</tr></thead>`,
          '<tbody>',
          ...printed.lines.map(
            (line) =>
              `<tr><td><strong>${escapeHtml(line.name)}</strong>${
                line.description === ''
                  ? ''
                  : `<p class="muted text">${escapeHtml(line.description)}</p>`
              }</td>${[line.quantity, line.rate, line.discount, line.tax, line.amount]
                .map((cell) => `<td>${escapeHtml(cell)}</td>`)
                .join('')}</tr>`,
          ),
          '</tbody></table></div>',
        ].join(''),
    '<table class="totals">',
    ...printed.totals.map(
      (row) =>
        `<tr${row.strong ? ' class="strong"' : ''}><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.value)}</td></tr>`,
    ),
    '</table>',
    ...printed.sections.map(
      (section) =>
        `<h2>${escapeHtml(section.heading)}</h2><p class="text">${escapeHtml(section.text)}</p>`,
    ),
    '</article>',
    `<p class="foot">${escapeHtml(named)}</p>`,
  ]
    .filter((part) => part !== '')
    .join('\n');
  return shell(named, body);
}

/** What an address answers with once its document is void, withdrawn or gone. */
export function unavailablePage(): string {
  return shell(
    'No longer available',
    '<article class="sheet"><p class="name">This document is no longer available.</p><p class="muted">Ask whoever sent it to you for a new link.</p></article>',
  );
}
