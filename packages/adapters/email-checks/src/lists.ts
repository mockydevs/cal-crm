import { readFileSync } from 'node:fs';

// The snapshots ship beside dist/ and src/ in the package's data folder, read once on first
// use. No list is fetched at run time: an install works offline, and a bad change upstream
// can't flag every address at once.
function load(name: string): ReadonlySet<string> {
  return readList(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
}

/** A list file's entries: one per line, in lower case; # starts a comment line. */
export function readList(text: string): ReadonlySet<string> {
  return new Set(
    text
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line !== '' && !line.startsWith('#')),
  );
}

let disposable:
  { readonly block: ReadonlySet<string>; readonly allow: ReadonlySet<string> } | undefined;
let roles: ReadonlySet<string> | undefined;

/** The name and each parent of it: a.b.example.com, b.example.com, example.com, com. */
function selfAndParents(domain: string): string[] {
  const labels = domain.toLowerCase().replace(/\.$/, '').split('.');
  return labels.map((_, index) => labels.slice(index).join('.'));
}

/**
 * Whether a domain hosts disposable (temporary) mailboxes: it or a parent is on the
 * disposable list and neither is on the allow list. Such mail is delivered, so this is a
 * warning, never a reason to refuse.
 */
export function isDisposableDomain(domain: string): boolean {
  disposable ??= { block: load('disposable-domains.txt'), allow: load('disposable-allow.txt') };
  const names = selfAndParents(domain);
  const { block, allow } = disposable;
  return !names.some((name) => allow.has(name)) && names.some((name) => block.has(name));
}

/**
 * Whether a local part names a function or a team (info, support, postmaster) rather than
 * a person. A "+tag" is ignored. A hint only: role addresses receive mail.
 */
export function isRoleAddress(local: string): boolean {
  roles ??= load('role-addresses.txt');
  const plus = local.indexOf('+');
  return roles.has((plus === -1 ? local : local.slice(0, plus)).toLowerCase());
}
