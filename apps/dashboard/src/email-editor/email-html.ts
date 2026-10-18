// An email's formatted part between the editor and the server. The server keeps an
// allowlist of tags, attributes and styles (packages/modules/messaging/src/email-html.ts)
// and stores merge fields as plain {{path}} text; the editor shows each merge field as a
// chip. So on the way in, the {{path}} text of the stored HTML becomes chip elements the
// editor reads, and on the way out the chips become text again and nothing the editor adds
// for itself (classes, data attributes) is left. Also here: what is pasted from Word or
// Google Docs with its wrapping taken off, the plain-text part written from the formatted
// one as the server writes it, and plain text as paragraphs.
//
// Everything works on a parsed document that is never put on the page, so no script in the
// HTML runs and no image in it is fetched.
/* eslint-disable lingui/no-unlocalized-strings -- HTML, selectors and addresses, not words */

/** A merge field as text holds it: a dotted path in double braces. */
export const MERGE_TOKEN = /\{\{\s*([a-z][a-z_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)\s*\}\}/g;

/** The attribute a chip carries its path in, inside the editor only. */
export const CHIP_ATTRIBUTE = 'data-merge';

export const tokenOf = (path: string): string => `{{${path}}}`;

/** The merge fields text uses, each once, in the order they first appear. */
export function mergePathsIn(text: string): string[] {
  return [
    ...new Set([...text.matchAll(MERGE_TOKEN)].flatMap((match) => (match[1] ? [match[1]] : []))),
  ];
}

const parse = (html: string): HTMLElement =>
  new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html').body;

const textNodesOf = (root: Node): Text[] => {
  const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: Text[] = [];
  if (walker === undefined) return found;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
    found.push(node as Text);
  return found;
};

/**
 * Stored HTML as the editor reads it: every {{path}} in the text becomes a chip element.
 * A merge field that is a link's whole address is an attribute, not text, and stays as it is.
 */
export function chipsFromTokens(html: string): string {
  const body = parse(html);
  for (const node of textNodesOf(body)) {
    const text = node.data;
    const matches = [...text.matchAll(MERGE_TOKEN)];
    if (matches.length === 0 || node.parentElement?.hasAttribute(CHIP_ATTRIBUTE) === true) continue;
    const parts = body.ownerDocument.createDocumentFragment();
    let at = 0;
    for (const match of matches) {
      const [whole, path] = match;
      if (path === undefined) continue;
      parts.append(text.slice(at, match.index));
      const chip = body.ownerDocument.createElement('span');
      chip.setAttribute(CHIP_ATTRIBUTE, path);
      chip.textContent = tokenOf(path);
      parts.append(chip);
      at = match.index + whole.length;
    }
    parts.append(text.slice(at));
    node.replaceWith(parts);
  }
  return body.innerHTML;
}

// What the server writes on every link it keeps: the editor writes the same, so that
// cleaning what the editor made changes nothing.
const LINK_TARGET = '_blank';
const LINK_REL = 'noopener noreferrer';

/**
 * The editor's HTML as it is saved: chips as {{path}} text, a link as the server writes
 * one, an empty paragraph holding a line break (mail apps give an empty one no height),
 * and none of the editor's own classes or data attributes.
 */
export function tokensFromChips(html: string): string {
  const body = parse(html);
  for (const chip of body.querySelectorAll(`[${CHIP_ATTRIBUTE}]`)) {
    const path = chip.getAttribute(CHIP_ATTRIBUTE) ?? '';
    chip.replaceWith(body.ownerDocument.createTextNode(path === '' ? '' : tokenOf(path)));
  }
  for (const element of body.querySelectorAll('*')) {
    for (const name of element.getAttributeNames())
      if (
        name === 'class' ||
        name === 'contenteditable' ||
        name === 'draggable' ||
        name.startsWith('data-')
      )
        element.removeAttribute(name);
    // A style as the server writes it back: each declaration as property:value, no spaces
    // around them, so the saved HTML is letter for letter what the server keeps.
    const style = element.getAttribute('style');
    if (style !== null) {
      const declarations = style
        .split(';')
        .map((each) => {
          const colon = each.indexOf(':');
          return colon === -1
            ? ''
            : `${each.slice(0, colon).trim().toLowerCase()}:${each.slice(colon + 1).trim()}`;
        })
        .filter((each) => each !== '' && !each.endsWith(':'));
      if (declarations.length === 0) element.removeAttribute('style');
      else element.setAttribute('style', declarations.join(';'));
    }
    if (element.tagName === 'A' && element.hasAttribute('href')) {
      element.setAttribute('target', LINK_TARGET);
      element.setAttribute('rel', LINK_REL);
    }
    if (element.tagName === 'P' && element.childNodes.length === 0)
      element.append(body.ownerDocument.createElement('br'));
  }
  // The editor keeps a list item's words in a paragraph. An email does not: a paragraph
  // there adds space in mail apps, and breaks the line after the dash of the text part.
  for (const item of body.querySelectorAll('li')) {
    const [first] = item.children;
    if (first?.tagName === 'P' && first.attributes.length === 0 && item.firstChild === first)
      first.replaceWith(...first.childNodes);
  }
  body.normalize();
  return body.innerHTML;
}

/** Whether formatted content shows anything: some text, or a picture. */
export function isEmptyHtml(html: string): boolean {
  const body = parse(html);
  return body.textContent.trim() === '' && body.querySelector('img') === null;
}

const PASTE_DROPPED =
  'script,style,meta,link,title,head,xml,iframe,object,embed,form,input,button,select,textarea,svg,math';

/**
 * What was pasted, with the wrapping an office program adds taken off before the editor
 * reads it: its style sheets and notes to itself, Word's list markers and empty "o:p"
 * elements, and every class. The editor then keeps only what it can write (its own
 * allowlist), so what is left is headings, paragraphs, lists, links and plain emphasis.
 */
export function cleanPastedHtml(html: string): string {
  const body = parse(html);
  const comments: Node[] = [];
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) comments.push(node);
  for (const comment of comments) comment.parentNode?.removeChild(comment);
  for (const element of body.querySelectorAll(PASTE_DROPPED)) element.remove();
  for (const element of body.querySelectorAll('*')) {
    // Word's namespaced elements (o:p, v:shape, w:sdt) hold nothing an email keeps.
    if (element.tagName.includes(':')) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    // Word writes a list item's bullet as text in a span of its own.
    if ((element.getAttribute('style') ?? '').replace(/\s/g, '').includes('mso-list:Ignore')) {
      element.remove();
      continue;
    }
    for (const name of element.getAttributeNames())
      if (
        name === 'class' ||
        name === 'id' ||
        name === 'lang' ||
        // A chip copied from the editor is known by its path: that one is kept.
        (name.startsWith('data-') && name !== CHIP_ATTRIBUTE)
      )
        element.removeAttribute(name);
    const style = element.getAttribute('style');
    if (style !== null) {
      const kept = style
        .split(';')
        .map((each) => each.trim())
        .filter((each) => each !== '' && !/^(?:mso-|tab-stops|page-break|-webkit-)/i.test(each));
      if (kept.length === 0) element.removeAttribute('style');
      else element.setAttribute('style', kept.join(';'));
    }
  }
  return body.innerHTML;
}

const TEXT_BLOCKS = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'PRE',
  'UL',
  'OL',
  'LI',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'TD',
  'TH',
  'CAPTION',
  'CENTER',
  'HR',
]);

/**
 * The plain-text part of a formatted email, written from its HTML as the server writes it
 * (emailTextOf): a block is a paragraph, a list item a line with a dash, a link its words
 * and its address, a picture its description. Merge fields are text and stay as they are.
 */
export function textOfHtml(html: string): string {
  const out: string[] = [];
  const walk = (nodes: NodeListOf<ChildNode>, preformatted: boolean): void => {
    for (const node of nodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.nodeValue ?? '';
        out.push(preformatted ? value : value.replace(/\s+/g, ' '));
        continue;
      }
      if (!(node instanceof Element)) continue;
      const tag = node.tagName;
      if (tag === 'BR') out.push('\n');
      else if (tag === 'HR') out.push('\n\n----------\n\n');
      else if (tag === 'IMG') {
        const alt = (node.getAttribute('alt') ?? '').trim();
        if (alt !== '') out.push(`[${alt}]`);
      } else if (tag === 'A') {
        const start = out.length;
        walk(node.childNodes, preformatted);
        const words = out.slice(start).join('').trim();
        const address = (node.getAttribute('href') ?? '').replace(/^mailto:|^tel:/i, '');
        if (address !== '' && address !== words) out.push(words === '' ? address : ` (${address})`);
      } else {
        const block = TEXT_BLOCKS.has(tag);
        const cell = tag === 'TD' || tag === 'TH';
        const line = tag === 'LI' || tag === 'TR';
        if (block && !cell) out.push(line ? '\n' : '\n\n');
        if (tag === 'LI') out.push('- ');
        walk(node.childNodes, preformatted || tag === 'PRE');
        if (cell) out.push(' ');
        else if (block) out.push(line ? '\n' : '\n\n');
      }
    }
  };
  walk(parse(html).childNodes, false);
  return out
    .join('')
    .replaceAll(String.fromCharCode(160), ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+(?=\S)/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Plain text as formatted content, for a plain-text email its author chooses to format: a
 * blank line starts a new paragraph, and a line break inside one stays a line break.
 */
export function htmlOfText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/^\n+|\n+$/g, ''))
    .filter((paragraph) => paragraph.trim() !== '')
    .map((paragraph) => `<p>${paragraph.split('\n').map(escapeText).join('<br>')}</p>`)
    .join('');
}

/**
 * A file's address as an email may name it as a picture: a file of this install's media
 * library by its path (/m/…), which the server gives the install's address when the email
 * leaves, or any other https address. Nothing for an address a mail app would not load.
 */
export function emailImageAddress(address: string | null | undefined): string | undefined {
  if (address === null || address === undefined) return undefined;
  try {
    const url = new URL(address, 'https://relative.invalid');
    if (/^\/m\/[A-Za-z0-9._~%/-]+$/.test(url.pathname) && !url.pathname.includes('..'))
      return url.pathname;
    return url.protocol === 'https:' && url.hostname !== 'relative.invalid' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A link's address as an email may hold it: a web, mail or phone address, or one merge
 * field. A bare "example.com" is read as a web address, as a person means it.
 */
export function emailLinkAddress(typed: string): string | undefined {
  const address = typed.trim();
  if (address === '') return undefined;
  if (/^\{\{\s*[a-z][a-z_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\s*\}\}$/.test(address)) return address;
  if (/^(?:https?:\/\/|mailto:|tel:)/i.test(address)) return address;
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(address)) return `mailto:${address}`;
  return /^[^\s:/]+\.[^\s:/]+/.test(address) ? `https://${address}` : undefined;
}
