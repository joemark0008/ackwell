import { BlockList, isIPv4, isIPv6 } from 'node:net';

/**
 * Per-channel source IP allowlist for MLLP. Entries are IPv4/IPv6 addresses or CIDR ranges
 * (validated by `allowlistEntrySchema`). An empty list allows every address.
 */
export class Allowlist {
  private readonly list: BlockList | null;

  constructor(entries: readonly string[]) {
    if (!entries.length) {
      this.list = null;
      return;
    }
    const list = new BlockList();
    for (const entry of entries) {
      const [addr, prefix] = entry.split('/');
      const family = isIPv4(addr!) ? 'ipv4' : isIPv6(addr!) ? 'ipv6' : null;
      if (!family) throw new Error(`Invalid allowlist entry "${entry}"`);
      if (prefix === undefined) list.addAddress(addr!, family);
      else list.addSubnet(addr!, Number(prefix), family);
    }
    this.list = list;
  }

  get isOpen(): boolean {
    return this.list === null;
  }

  allows(remoteAddress: string | undefined | null): boolean {
    if (!this.list) return true;
    if (!remoteAddress) return false;
    const ip = normalizeIp(remoteAddress);
    if (isIPv4(ip)) return this.list.check(ip, 'ipv4');
    if (isIPv6(ip)) return this.list.check(ip, 'ipv6');
    return false;
  }
}

/** `::ffff:10.0.0.1` (IPv4-mapped IPv6, what a dual-stack socket reports) → `10.0.0.1`. */
export function normalizeIp(address: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return m ? m[1]! : address;
}
