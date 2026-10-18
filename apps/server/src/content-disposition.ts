/**
 * A download's Content-Disposition (RFC 6266): the name in ASCII for old clients, and in
 * full as RFC 8187 encodes it. encodeURIComponent leaves ' ( ) * alone, which RFC 8187
 * doesn't allow there.
 */
export function contentDisposition(inline: boolean, filename: string): string {
  const ascii = filename.replaceAll(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replaceAll(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
