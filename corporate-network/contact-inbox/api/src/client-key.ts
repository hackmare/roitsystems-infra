// The key rate limits count by: the visitor's address, not a proxy's.
//
// Requests reach this service through Cloudflare and then Caddy, so the connecting
// peer (and the X-Forwarded-For entry Caddy adds) is a Cloudflare edge, shared by
// many visitors. Cloudflare sets CF-Connecting-IP to the visitor's address and
// overwrites any value the visitor sends. That header is only trustworthy while the
// host accepts web traffic from Cloudflare alone; if that ever changes, this key
// must come from a proxy that strips the header instead.
import { isIP } from 'net';

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  ip: string;
}

export function clientKey(request: RequestLike): string {
  const header = request.headers['cf-connecting-ip'];
  const value = typeof header === 'string' ? header.trim() : '';
  const address = isIP(value) ? value : request.ip;
  return isIP(address) === 6 ? ipv6Key(address) : address;
}

// IPv6 visitors are counted per /64, the usual size of one site's allocation, so
// one client can't step through addresses to dodge a limit. IPv4-mapped addresses
// count as the IPv4 address.
export function ipv6Key(address: string): string {
  const a = address.toLowerCase().split('%')[0];
  const mapped = a.match(/^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  let parts = a.split('::');
  const head = parts[0] ? parts[0].split(':') : [];
  let tail = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
  // An embedded IPv4 tail (e.g. 64:ff9b::1.2.3.4) is two groups.
  const last = tail.length ? tail[tail.length - 1] : head[head.length - 1];
  if (last && last.includes('.')) {
    const [b1, b2, b3, b4] = last.split('.').map(Number);
    const groups = [((b1 << 8) | b2).toString(16), ((b3 << 8) | b4).toString(16)];
    if (tail.length) tail = [...tail.slice(0, -1), ...groups];
    else head.splice(head.length - 1, 1, ...groups);
  }
  const fill = parts.length > 1 ? Array(8 - head.length - tail.length).fill('0') : [];
  const groups = [...head, ...fill, ...tail];
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/64';
}
