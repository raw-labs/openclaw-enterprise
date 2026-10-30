import { isIPv4 } from "node:net";

/** Public IPv4 proxy egress excludes these special-use ranges and operator infrastructure. */
export const GATEWAY_PROXY_NONPUBLIC_CIDRS: readonly string[] = Object.freeze([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "192.88.99.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
]);

function range(cidr: string): { start: bigint; end: bigint } {
  const [address = "", prefix = "", extra] = cidr.split("/");
  if (!isIPv4(address) || extra !== undefined || !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(prefix)) {
    throw new Error("Gateway proxy exclusions require IPv4 CIDRs.");
  }
  const value = address.split(".").reduce((value, octet) => (value << 8n) + BigInt(octet), 0n);
  const size = 1n << BigInt(32 - Number(prefix));
  const start = (value / size) * size;
  return { start, end: start + size - 1n };
}

/** A supernet can exclude a required range; an overlapping subset cannot. */
export function gatewayProxyExclusionsCover(
  excluded: readonly string[],
  required: readonly string[],
): boolean {
  try {
    const exclusions = excluded.map(range);
    return required
      .map(range)
      .every(({ start, end }) =>
        exclusions.some((blocked) => blocked.start <= start && blocked.end >= end),
      );
  } catch {
    return false;
  }
}
