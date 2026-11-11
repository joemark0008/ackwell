export interface PortRange {
  from: number;
  to: number;
}

/** Parses "6000-6050" (or a single port "6000") into an inclusive range. Throws on bad input. */
export function parsePortRange(value: string): PortRange {
  const m = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5}))?\s*$/.exec(value);
  if (!m) throw new Error(`Invalid port range "${value}" (expected e.g. 6000-6050)`);
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (from < 1 || to > 65535 || from > to) throw new Error(`Invalid port range "${value}"`);
  return { from, to };
}

export function isPortInRange(port: number, range: PortRange): boolean {
  return port >= range.from && port <= range.to;
}
