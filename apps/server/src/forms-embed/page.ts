// A form as a page of its own, served by the CRM: `/f/{formKey}`, a link to share where
// there is no website to put the form on, and `/f/preview/{token}`, the same page showing
// a draft to whoever holds a link someone signed in asked for.
//
// The page is a shell and nothing else: a title, a few lines of style, and the one script
// tag a website would paste. The embed does the rest, exactly as it does on a website, so
// what is shared and what is embedded are the same form. The shell is the same bytes for
// every form but for the key or the token, and each is checked against the alphabet it is
// made of before it is written, so nothing a caller sends can end the attribute or the
// tag. Serving it looks nothing up: a key that names no published form gets the page, and
// the embed says the form is not available.
//
// This page is on the address the team signs in at. It runs one script, the embed, from
// that same address; the policy below allows no other, no inline script, no frame around
// it and nothing loaded from anywhere else. The embed sends no cookie with its requests.
import { createHash } from 'node:crypto';

import { formPreviewToken, formPublicKey } from '@repo/contracts';

/** The whole of the page's own style. The form's look is the embed's (styles.ts). */
export const PAGE_STYLE =
  'html{background:#f3f5f2}' +
  'body{margin:0;padding:32px 16px;display:flex;justify-content:center;' +
  'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1d2a24}' +
  'main{width:100%;max-width:560px}';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('base64');

/**
 * What the page may do: run scripts of this address, talk to this address, and use the
 * one style block above, named by its digest. Nothing else is loaded, nothing may frame
 * the page (a form in someone else's frame would be a form on a website nobody listed),
 * and no form on it posts anywhere: the embed sends with fetch.
 */
export const PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'self'",
  `style-src 'sha256-${sha256(PAGE_STYLE)}'`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Marks the page as the CRM's own, for the embed (entry.ts) to name the tab after the form. */
export const PAGE_MARK = 'data-crm-form-page';

function shell(scriptPath: string, attribute: string, value: string): string {
  return [
    '<!doctype html>',
    `<html lang="en" ${PAGE_MARK}>`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    '<title>Form</title>',
    `<style>${PAGE_STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<script async src="${scriptPath}" ${attribute}="${value}"></script>`,
    '<noscript>This form needs JavaScript to be shown.</noscript>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** The page of a form, or undefined for anything that is not the shape of a form key. */
export function formPage(scriptPath: string, formKey: unknown): string | undefined {
  const key = formPublicKey.safeParse(formKey);
  return key.success ? shell(scriptPath, 'data-form-key', key.data) : undefined;
}

/** The page of a preview, or undefined for anything that is not the shape of a preview link. */
export function previewPage(scriptPath: string, previewToken: unknown): string | undefined {
  const token = formPreviewToken.safeParse(previewToken);
  return token.success ? shell(scriptPath, 'data-form-preview', token.data) : undefined;
}
