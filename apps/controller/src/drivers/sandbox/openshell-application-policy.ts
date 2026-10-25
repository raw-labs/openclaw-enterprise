import { isIP } from "node:net";
import { validGatewayOutboundSnapshot } from "@openclaw-enterprise/contracts";
import type { AgentRevision, GatewayOutboundDestination } from "@openclaw-enterprise/contracts";

export interface OpenShellApplicationRuntimePeer {
  readonly host: string;
  readonly port: number;
  /** Exact IPv4 addresses of a platform-generated runtime endpoint, not a network grant. */
  readonly allowedIps: readonly string[];
}

interface IpRange {
  readonly family: 4 | 6;
  readonly first: bigint;
  readonly last: bigint;
}

interface Endpoint {
  readonly host: string;
  readonly ports: readonly number[];
  readonly protocol: "tcp";
  readonly tls: "NETWORK_TLS_MODE_SKIP";
  readonly allowed_ips: readonly string[];
}

const DNS_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function invalid(message: string): never {
  throw new Error(`OpenShell application network policy: ${message}`);
}

function ipv4Number(value: string): number {
  if (isIP(value) !== 4) {
    return invalid("an IPv4 address is required.");
  }
  return value.split(".").reduce((result, octet) => result * 256 + Number(octet), 0);
}

function ipv4Text(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

function ipv6Number(value: string): bigint {
  const normalized = value.replace(/(?:\d+\.){3}\d+$/, (address) => {
    const number = ipv4Number(address);
    return `${Math.floor(number / 65536).toString(16)}:${(number % 65536).toString(16)}`;
  });
  const [leading, trailing] = normalized.split("::");
  const left = leading === "" ? [] : leading!.split(":");
  const right = trailing === undefined || trailing === "" ? [] : trailing.split(":");
  const parts = [
    ...left,
    ...Array.from({ length: 8 - left.length - right.length }, () => "0"),
    ...right,
  ];
  return parts.reduce((result, part) => (result << 16n) | BigInt(Number.parseInt(part, 16)), 0n);
}

function ipv6Text(value: bigint): string {
  return Array.from({ length: 8 }, (_, index) =>
    ((value >> BigInt((7 - index) * 16)) & 0xffffn).toString(16),
  ).join(":");
}

function exclusion(value: string): IpRange {
  if (typeof value !== "string" || value.length > 128 || value.includes("%")) {
    return invalid("an exclusion CIDR is invalid.");
  }
  const match = /^([^/]+)\/(0|[1-9][0-9]*)$/.exec(value);
  if (match === null) {
    return invalid("an exclusion CIDR is invalid.");
  }
  const address = match[1]!;
  const family = isIP(address);
  const prefix = Number(match[2]);
  if ((family !== 4 && family !== 6) || prefix > (family === 4 ? 32 : 128)) {
    return invalid("an exclusion CIDR is invalid.");
  }
  const bits = family === 4 ? 32 : 128;
  const number = family === 4 ? BigInt(ipv4Number(address)) : ipv6Number(address);
  const size = 1n << BigInt(bits - prefix);
  const first = (number / size) * size;
  return { family, first, last: first + size - 1n };
}

function rangeCidrs(first: bigint, last: bigint, family: 4 | 6): string[] {
  const cidrs: string[] = [];
  let cursor = first;
  const addressBits = family === 4 ? 32 : 128;
  while (cursor <= last) {
    let alignedBits = addressBits;
    while (cursor % (1n << BigInt(alignedBits)) !== 0n) {
      alignedBits -= 1;
    }
    let remaining = last - cursor + 1n;
    let remainingBits = 0;
    while (remaining > 1n) {
      remaining >>= 1n;
      remainingBits += 1;
    }
    const bits = Math.min(alignedBits, remainingBits);
    const address = family === 4 ? ipv4Text(Number(cursor)) : ipv6Text(cursor);
    cidrs.push(`${address}/${addressBits - bits}`);
    cursor += 1n << BigInt(bits);
  }
  return cidrs;
}

function publicFamilyAddresses(exclusions: readonly IpRange[], family: 4 | 6): string[] {
  const ranges = exclusions
    .filter((range) => range.family === family)
    .sort((left, right) => {
      if (left.first < right.first) {
        return -1;
      }
      if (left.first > right.first) {
        return 1;
      }
      return left.last < right.last ? -1 : Number(left.last > right.last);
    });
  const allowed: string[] = [];
  // The existing proxy permits IPv6 only inside global unicast 2000::/3.
  // Keep every other IPv6 range outside the positive grant, even if an operator
  // omits it from exclusions. Both DNS families are validated by OpenShell.
  let cursor = family === 4 ? 0n : 1n << 125n;
  const last = family === 4 ? (1n << 32n) - 1n : (1n << 126n) - 1n;
  for (const range of ranges) {
    if (range.first > last) {
      break;
    }
    if (range.first > cursor) {
      allowed.push(...rangeCidrs(cursor, range.first - 1n, family));
    }
    if (range.last >= cursor) {
      cursor = range.last + 1n;
    }
    if (cursor > last) {
      break;
    }
  }
  if (cursor <= last) {
    allowed.push(...rangeCidrs(cursor, last, family));
  }
  return allowed;
}

function host(value: string): string {
  if (typeof value !== "string" || value.length > 253 || !DNS_HOST.test(value)) {
    return invalid("a destination must be a canonical DNS hostname, without wildcards.");
  }
  return value;
}

function runtimeAddresses(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 64) {
    return invalid("a generated runtime peer requires bounded exact IPv4 addresses.");
  }
  const addresses = values.map((value) => {
    if (typeof value !== "string") {
      return invalid("a generated runtime peer requires exact IPv4 addresses.");
    }
    const address = value.endsWith("/32") ? value.slice(0, -3) : value;
    const number = ipv4Number(address);
    // Never turn generated peers into broad private-network grants. OpenShell
    // itself always refuses loopback and link-local, including explicit peers.
    if (
      number < 2 ** 24 ||
      Math.floor(number / 2 ** 24) === 127 ||
      Math.floor(number / 2 ** 16) === 169 * 256 + 254 ||
      number >= 224 * 2 ** 24
    ) {
      return invalid("a generated runtime peer uses a non-routable IPv4 address.");
    }
    return `${address}/32`;
  });
  return [...new Set(addresses)].sort();
}

function endpoint(hostname: string, port: number, addresses: readonly string[]): Endpoint {
  return {
    host: hostname,
    ports: [port],
    protocol: "tcp",
    tls: "NETWORK_TLS_MODE_SKIP",
    allowed_ips: addresses,
  };
}

/**
 * Compile the admitted whole-application authority, not a plugin or command
 * boundary. The caller must also install the independent Kubernetes egress fence.
 * TLS remains end to end; this policy makes no HTTP method or path decision.
 */
export function compileOpenShellApplicationNetworkPolicy(input: {
  readonly revision: Pick<AgentRevision, "gatewayOutbound">;
  readonly denyCidrs: readonly string[];
  /** Supply both existing outbound proxy mandatory IPv4 and IPv6 exclusion lists. */
  readonly mandatoryDenyCidrs: readonly string[];
  readonly runtimePeers: readonly OpenShellApplicationRuntimePeer[];
  /** Exact HTTPS hosts derived from the admitted embedded model configuration. */
  readonly generatedPublicHosts?: readonly string[];
}): Record<string, unknown> {
  const snapshot = input.revision.gatewayOutbound;
  if (snapshot !== undefined && !validGatewayOutboundSnapshot(snapshot)) {
    return invalid("the admitted Gateway outbound snapshot is invalid.");
  }
  if (snapshot?.selection.mode === "publicHttps") {
    return invalid("publicHttps is not supported by this contained application experiment.");
  }
  if (
    !Array.isArray(input.mandatoryDenyCidrs) ||
    input.mandatoryDenyCidrs.length === 0 ||
    input.mandatoryDenyCidrs.length > 64 ||
    !Array.isArray(input.denyCidrs) ||
    input.denyCidrs.length > 64 ||
    !Array.isArray(input.runtimePeers) ||
    input.runtimePeers.length > 64 ||
    (input.generatedPublicHosts !== undefined &&
      (!Array.isArray(input.generatedPublicHosts) || input.generatedPublicHosts.length > 64))
  ) {
    return invalid("the Installation exclusions or generated runtime peers are invalid.");
  }
  const mandatory = input.mandatoryDenyCidrs.map(exclusion);
  if (
    !mandatory.some((range) => range.family === 4) ||
    !mandatory.some((range) => range.family === 6)
  ) {
    return invalid("mandatory public-address exclusions must cover both IP families.");
  }
  const exclusions = [
    ...mandatory,
    ...(snapshot?.denyCidrs ?? []).map(exclusion),
    ...input.denyCidrs.map(exclusion),
  ];
  const addresses = [
    ...publicFamilyAddresses(exclusions, 4),
    ...publicFamilyAddresses(exclusions, 6),
  ];
  const destinations = new Map<string, GatewayOutboundDestination>();
  for (const requirement of snapshot?.requirements ?? []) {
    for (const destination of requirement.destinations) {
      const hostname = host(destination.host);
      destinations.set(hostname, {
        host: hostname,
        includeSubdomains:
          destination.includeSubdomains || destinations.get(hostname)?.includeSubdomains === true,
      });
    }
  }
  if (snapshot?.selection.mode === "restricted") {
    for (const selected of snapshot.selection.hosts) {
      const hostname = host(selected);
      if (!destinations.has(hostname)) {
        destinations.set(hostname, { host: hostname, includeSubdomains: false });
      }
    }
  }
  for (const generated of input.generatedPublicHosts ?? []) {
    const hostname = host(generated);
    if (!destinations.has(hostname)) {
      destinations.set(hostname, { host: hostname, includeSubdomains: false });
    }
  }
  const publicEndpoints: Endpoint[] = [];
  if (addresses.length > 0) {
    for (const destination of [...destinations.values()].sort((a, b) =>
      a.host.localeCompare(b.host),
    )) {
      publicEndpoints.push(endpoint(destination.host, 443, addresses));
      if (destination.includeSubdomains) {
        // OpenShell '*' covers one DNS label. '**' covers one or more labels;
        // include the apex separately to preserve OCE's suffix-match contract.
        publicEndpoints.push(endpoint(`**.${destination.host}`, 443, addresses));
      }
    }
  }
  const peers = new Map<string, Endpoint>();
  for (const peer of input.runtimePeers) {
    const hostname = host(peer.host);
    if (!Number.isInteger(peer.port) || peer.port < 1 || peer.port > 65535) {
      return invalid("a generated runtime peer port is invalid.");
    }
    if (
      peer.port === 443 &&
      [...destinations.values()].some(
        (destination) =>
          hostname === destination.host ||
          (destination.includeSubdomains && hostname.endsWith(`.${destination.host}`)),
      )
    ) {
      return invalid("a generated runtime peer overlaps a public destination grant.");
    }
    const compiled = endpoint(hostname, peer.port, runtimeAddresses(peer.allowedIps));
    const key = `${hostname}:${peer.port}`;
    const previous = peers.get(key);
    if (
      previous !== undefined &&
      JSON.stringify(previous.allowed_ips) !== JSON.stringify(compiled.allowed_ips)
    ) {
      return invalid("a generated runtime peer has conflicting address sets.");
    }
    peers.set(key, compiled);
  }
  const endpoints = [
    ...publicEndpoints,
    ...[...peers.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, peer]) => peer),
  ];
  return endpoints.length === 0
    ? {}
    : {
        "oce-application": {
          name: "oce-application",
          binaries: [{ path: "/**" }],
          endpoints,
        },
      };
}
