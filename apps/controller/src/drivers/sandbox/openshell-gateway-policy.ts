import { isIP } from "node:net";
import {
  assertGatewayOutboundWithinCeiling,
  normalizeGatewayOutboundAdmission,
  normalizeGatewayOutboundPolicy,
} from "@openclaw-enterprise/contracts";
import type { GatewaySandboxRequirements } from "@openclaw-enterprise/contracts";

// Positive public ranges are required even for exact DNS names and IP literals: the
// pinned provider does not apply its generic SSRF exclusion to every exact rule.
const FORBIDDEN = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/3",
  "::/3",
  "4000::/2",
  "8000::/1",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
];

function addressNumber(address: string): { value: bigint; bits: number } {
  const family = isIP(address);
  if (family === 4) {
    return { value: address.split(".").reduce((n, x) => (n << 8n) | BigInt(x), 0n), bits: 32 };
  }
  if (family !== 6 || address.includes(".")) {
    throw new Error("Gateway policy requires canonical IPv4 or IPv6 CIDRs.");
  }
  const halves = address.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words =
    halves.length === 1
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return { value: words.reduce((n, x) => (n << 16n) | BigInt("0x" + x), 0n), bits: 128 };
}
function cidrRange(cidr: string) {
  const [address, rawPrefix] = cidr.split("/");
  const { value, bits } = addressNumber(address!);
  const prefix = Number(rawPrefix);
  if (!/^\d+$/u.test(rawPrefix ?? "") || !Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
    throw new Error("Invalid Gateway infrastructure CIDR.");
  }
  const size = 1n << BigInt(bits - prefix);
  const start = (value / size) * size;
  return { start, end: start + size - 1n, bits };
}
function cidrs(start: bigint, end: bigint, bits: number): string[] {
  const result: string[] = [];
  while (start <= end) {
    let shift = 0;
    while (
      shift < bits &&
      start % (1n << BigInt(shift + 1)) === 0n &&
      start + (1n << BigInt(shift + 1)) - 1n <= end
    ) {
      shift++;
    }
    const address =
      bits === 32
        ? [24, 16, 8, 0].map((n) => Number((start >> BigInt(n)) & 255n)).join(".")
        : [112, 96, 80, 64, 48, 32, 16, 0]
            .map((n) => ((start >> BigInt(n)) & 65535n).toString(16))
            .join(":");
    result.push(address + "/" + (bits - shift));
    start += 1n << BigInt(shift);
  }
  return result;
}
function publicCidrs(infrastructure: readonly string[]): string[] {
  const excluded = [...FORBIDDEN, ...infrastructure].map(cidrRange);
  const result: string[] = [];
  for (const bits of [32, 128]) {
    let cursor = 0n;
    for (const range of excluded
      .filter((r) => r.bits === bits)
      .sort((a, b) => (a.start < b.start ? -1 : 1))) {
      if (range.start > cursor) {
        result.push(...cidrs(cursor, range.start - 1n, bits));
      }
      if (range.end >= cursor) {
        cursor = range.end + 1n;
      }
    }
    const end = (1n << BigInt(bits)) - 1n;
    if (cursor <= end) {
      result.push(...cidrs(cursor, end, bits));
    }
  }
  return result;
}

export function openShellGatewayNetworkPolicy(
  requirements: GatewaySandboxRequirements,
): Readonly<Record<string, unknown>> {
  const policy = normalizeGatewayOutboundPolicy(requirements.outboundPolicy);
  const admission = normalizeGatewayOutboundAdmission(requirements.outboundAdmission);
  assertGatewayOutboundWithinCeiling(policy, admission.ceiling);
  const allowed = publicCidrs(requirements.infrastructureCidrs);
  const endpoints: Record<string, unknown>[] = [];
  const endpoint = (host: string, ports: readonly number[], ips: readonly string[]) => ({
    host,
    ports: [...ports],
    allowed_ips: [...ips],
    tls: "NETWORK_TLS_MODE_SKIP",
    enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
  });
  if (policy.mode === "publicHttps") {
    endpoints.push(endpoint("", [443], allowed));
  } else {
    for (const host of policy.hosts) {
      endpoints.push(endpoint(host, [443], allowed));
    }
  }
  for (const destination of admission.channelDestinations) {
    const host = destination.host.startsWith("*.")
      ? "**." + destination.host.slice(2)
      : destination.host;
    endpoints.push(endpoint(host, destination.ports, allowed));
  }
  for (const peer of requirements.runtimePeers) {
    if (
      !peer.host ||
      peer.host.includes("*") ||
      peer.addresses.length === 0 ||
      peer.addresses.length > 16 ||
      peer.ports.length === 0 ||
      peer.ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)
    ) {
      throw new Error("Gateway runtime peers require exact hosts, addresses and ports.");
    }
    if (policy.mode === "publicHttps" && peer.ports.includes(443)) {
      // Upstream rejects overlapping universal/private port rules with distinct
      // allowed_ips. Unioning their lists would expose all public hosts to private IPs.
      throw new Error(
        "OpenShell cannot combine public HTTPS with a private runtime peer on port 443.",
      );
    }
    const ips = peer.addresses.map((address) => {
      const { value, bits } = addressNumber(address);
      const privateRanges = new Set([
        "10.0.0.0/8",
        "100.64.0.0/10",
        "172.16.0.0/12",
        "192.168.0.0/16",
      ]);
      const reserved = FORBIDDEN.filter(
        (cidr) => !privateRanges.has(cidr) && !(bits === 128 && cidr === "8000::/1"),
      ).map(cidrRange);
      const unicastIpv6 = value >> 125n === 1n || value >> 121n === 0x7en;
      const blocked =
        (bits === 128 && !unicastIpv6) ||
        reserved.some((range) => range.bits === bits && value >= range.start && value <= range.end);
      if (blocked) {
        throw new Error("Unsupported Gateway runtime peer address.");
      }
      return address + "/" + bits;
    });
    if (isIP(peer.host) && !peer.addresses.includes(peer.host)) {
      throw new Error("Gateway runtime literal must match its address pin.");
    }
    endpoints.push(endpoint(peer.host, peer.ports, ips));
  }
  const unique = [...new Map(endpoints.map((value) => [JSON.stringify(value), value])).values()];
  return {
    "gateway-native": {
      name: "gateway-native",
      binaries: [{ path: "/usr/local/bin/node" }],
      endpoints: unique,
    },
  };
}
