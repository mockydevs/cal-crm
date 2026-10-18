import { createHash } from 'node:crypto';

import { expect, it } from 'vitest';

import { formPage, PAGE_MARK, PAGE_POLICY, PAGE_STYLE, previewPage } from './page.js';

const KEY = 'k'.repeat(32);
const PREVIEW = `${'P'.repeat(70)}.${'S'.repeat(22)}`;
const SCRIPT = '/forms/embed.js';

it('is a shell around the one script tag a website would paste', () => {
  const page = formPage(SCRIPT, KEY) ?? '';
  expect(page.startsWith('<!doctype html>\n<html lang="en"')).toBe(true);
  expect(page).toContain(`<html lang="en" ${PAGE_MARK}>`);
  expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  expect(page).toContain('<meta name="robots" content="noindex">');
  // One script, loaded from the CRM's own address, and none written into the page.
  expect(page.match(/<script\b/g)).toHaveLength(1);
  expect(page).toContain(`<script async src="${SCRIPT}" data-form-key="${KEY}"></script>`);
  // In the body and not in the head: the embed puts the form where its tag is.
  expect(page.indexOf('<script')).toBeGreaterThan(page.indexOf('<main>'));
  expect(page).not.toMatch(/\son[a-z]+=|javascript:|<iframe|<link|<img|https?:\/\//i);
});

it('allows its one style block by digest, scripts of its own address, and nothing else', () => {
  const page = formPage(SCRIPT, KEY) ?? '';
  const [, style = ''] = /<style>([^<]*)<\/style>/.exec(page) ?? [];
  expect(style).toBe(PAGE_STYLE);
  const digest = createHash('sha256').update(style).digest('base64');
  expect(PAGE_POLICY.split('; ')).toEqual([
    "default-src 'none'",
    "script-src 'self'",
    "connect-src 'self'",
    `style-src 'sha256-${digest}'`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ]);
  expect(PAGE_POLICY).not.toMatch(/unsafe-inline|unsafe-eval|\*|data:|https?:/);
  // Nothing in the style reaches out.
  expect(PAGE_STYLE).not.toMatch(/url\(|@import|expression\(/i);
});

it('names a draft by its preview link instead of a key, in the same shell', () => {
  const page = previewPage(SCRIPT, PREVIEW) ?? '';
  expect(page).toContain(`<script async src="${SCRIPT}" data-form-preview="${PREVIEW}"></script>`);
  expect(page).not.toContain('data-form-key');
  expect(page.replace(`data-form-preview="${PREVIEW}"`, '')).toBe(
    (formPage(SCRIPT, KEY) ?? '').replace(`data-form-key="${KEY}"`, ''),
  );
});

it('is made for nothing but the shape of a key or of a link', () => {
  for (const given of [
    undefined,
    null,
    7,
    '',
    'short',
    'k'.repeat(65),
    `${'k'.repeat(20)}"><script>alert(1)</script>`,
    `${'k'.repeat(20)} onload=alert(1)`,
    `${'k'.repeat(20)}&quot;`,
    [KEY],
  ]) {
    expect(formPage(SCRIPT, given)).toBeUndefined();
    expect(previewPage(SCRIPT, given)).toBeUndefined();
  }
  // Each is its own shape: a key opens no draft and a link is no key.
  expect(previewPage(SCRIPT, KEY)).toBeUndefined();
  expect(formPage(SCRIPT, PREVIEW)).toBeUndefined();
});
