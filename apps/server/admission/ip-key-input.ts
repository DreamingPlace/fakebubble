import { createHmac } from 'node:crypto';

/**
 * Part 17c: what the per-IP keys (HMAC ip_hash) are computed over.
 *
 * An IPv6 client controls a whole /64, so keying on the full address would let it mint endless "different" IPs. So:
 *   - IPv4 (no ':'): the text unchanged, so every existing IPv4 hash and row still matches;
 *   - IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:hhhh:hhhh): that IPv4 address in dotted form;
 *   - any other IPv6: its /64 prefix in one canonical text form, e.g. "2001:db8:1:2::/64";
 *   - anything unparsable: null (the caller refuses it with REGION_UNAVAILABLE, as before).
 */
const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function v4Groups(text: string): number[] | null {
  const m = V4.exec(text);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return null;
  return [octets[0]! * 256 + octets[1]!, octets[2]! * 256 + octets[3]!];
}

function groupsOf(part: string, last: boolean): number[] | null {
  if (part === '') return [];
  const out: number[] = [];
  const pieces = part.split(':');
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    if (last && i === pieces.length - 1 && piece.includes('.')) {
      const tail = v4Groups(piece);
      if (!tail) return null;
      out.push(...tail);
    } else if (/^[0-9a-fA-F]{1,4}$/.test(piece)) out.push(parseInt(piece, 16));
    else return null;
  }
  return out;
}

/** The eight 16-bit groups of an IPv6 address, or null. */
function parseIPv6(address: string): number[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = groupsOf(halves[0]!, halves.length === 1);
  const tail = halves.length === 2 ? groupsOf(halves[1]!, true) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  // '::' stands for at least one group of zeros.
  const fill = 8 - head.length - tail.length;
  return fill < 1 ? null : [...head, ...new Array<number>(fill).fill(0), ...tail];
}

export function ipKeyInput(peer: string): string | null {
  if (!peer.includes(':')) return peer;
  const groups = parseIPv6(peer);
  if (!groups) return null;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi, lo] = [groups[6]!, groups[7]!];
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/** The per-IP key: HMAC over the label and ipKeyInput(peer); null for an unparsable peer. Label 'web-cloud-ip-v1' or 'web-local-ip-v1'. */
export function peerIpHash(ipKeyBase64url: string, label: string, peer: string): string | null {
  const input = ipKeyInput(peer);
  return input === null
    ? null
    : createHmac('sha256', Buffer.from(ipKeyBase64url, 'base64url')).update(`${label}\0`).update(input).digest('hex');
}
