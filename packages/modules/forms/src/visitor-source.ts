// Who a submission comes from, as far as the server can tell without asking: the address it
// saw, widened to what one visitor holds. One IPv4 address is one source. An IPv6 visitor is
// handed a whole /64 by their provider (RFC 6177 recommends at least a /64 per site, and
// RFC 4291 makes /64 the subnet size), and can pick a new address in it for every request,
// so the /64 is the source. A form counts what each source sends (policy.ts), and the token
// that says when the form was shown is bound to the source that loaded it (render-token.ts).
import { isIP } from 'node:net';

export interface VisitorSource {
  /** The same text for every address of one source; part of the render token's digest. */
  readonly key: string;
  /** The source as a network Postgres reads as `inet`, to count what it sent. */
  readonly network: string;
}

/** The eight groups of an IPv6 address, as numbers. The address is a valid one. */
function groupsOf(address: string): number[] {
  let text = address.toLowerCase();
  // An IPv4 address at the end is the last two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const part = (side: string): number[] =>
    side === '' ? [] : side.split(':').map((group) => Number.parseInt(group, 16));
  const front = part(head);
  if (tail === undefined) return front;
  const back = part(tail);
  return [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
}

export function visitorSource(address: string): VisitorSource {
  const family = isIP(address);
  if (family === 4) return { key: address, network: `${address}/32` };
  if (family !== 6) throw new Error('Not an IP address.');
  const groups = groupsOf(address);
  // An IPv4 address written as IPv6 (::ffff:a.b.c.d) is that IPv4 address.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [high = 0, low = 0] = groups.slice(6);
    return visitorSource(
      `${String(high >> 8)}.${String(high & 255)}.${String(low >> 8)}.${String(low & 255)}`,
    );
  }
  const prefix = groups.slice(0, 4);
  while (prefix.length > 0 && prefix[prefix.length - 1] === 0) prefix.pop();
  const network = `${prefix.map((group) => group.toString(16)).join(':')}::/64`;
  return { key: network, network };
}
