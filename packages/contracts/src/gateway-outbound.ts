import type { ChannelGatewayDestination } from "./channel-gateway.ts";

export interface GatewayOutboundPolicyCeiling {
  readonly allowPublicHttps: boolean;
  readonly hosts: readonly string[];
}

export interface GatewayOutboundAdmission {
  readonly ceiling: GatewayOutboundPolicyCeiling;
  readonly channelDestinations: readonly ChannelGatewayDestination[];
}

/** External Gateway application access. Exact restricted hosts grant only TCP/443. */
export type GatewayOutboundPolicy =
  | { readonly mode: "restricted"; readonly hosts: readonly string[] }
  | { readonly mode: "publicHttps" };

const reservedSuffixes = [
  "localhost",
  "local",
  "internal",
  "home",
  "lan",
  "localdomain",
  "test",
  "invalid",
  "example",
  "onion",
  "arpa",
  "svc",
  "cluster.local",
  "example.com",
  "example.net",
  "example.org",
  "nip.io",
  "sslip.io",
];

/** Validate DNS names only; runtime enforcement must also reject forbidden DNS answers. */
export function normalizeGatewayOutboundPolicy(input: unknown): GatewayOutboundPolicy {
  if (input === undefined) {
    return Object.freeze({ mode: "restricted", hosts: Object.freeze([]) });
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(
      "Gateway outbound policy must be restricted with exact DNS hosts or publicHttps.",
    );
  }
  const policy = input as Record<string, unknown>;
  if (policy.mode === "publicHttps" && Object.keys(policy).length === 1) {
    return Object.freeze({ mode: "publicHttps" });
  }
  if (
    policy.mode !== "restricted" ||
    Object.keys(policy).length !== 2 ||
    !Array.isArray(policy.hosts) ||
    policy.hosts.length > 64
  ) {
    throw new Error(
      "Gateway outbound policy must be restricted with exact DNS hosts or publicHttps.",
    );
  }
  const hosts: string[] = [];
  for (const value of policy.hosts) {
    if (
      typeof value !== "string" ||
      value.length > 253 ||
      value !== value.toLowerCase() ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z][a-z0-9-]*[a-z0-9]$/u.test(value) ||
      value.split(".").some((label) => label.length > 63) ||
      reservedSuffixes.some((suffix) => value === suffix || value.endsWith("." + suffix)) ||
      hosts.includes(value)
    ) {
      throw new Error(
        "Gateway outbound hosts must be unique exact public DNS names, not URLs, patterns, IP addresses or reserved aliases.",
      );
    }
    hosts.push(value);
  }
  return Object.freeze({ mode: "restricted", hosts: Object.freeze(hosts.sort()) });
}

/** Installation settings never default to public access or extra hosts. */
export function normalizeGatewayOutboundPolicyCeiling(
  input: unknown,
): GatewayOutboundPolicyCeiling {
  if (input === undefined) {
    return Object.freeze({ allowPublicHttps: false, hosts: Object.freeze([]) });
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Gateway outbound ceiling requires allowPublicHttps and exact DNS hosts.");
  }
  const ceiling = input as Record<string, unknown>;
  if (
    Object.keys(ceiling).length !== 2 ||
    typeof ceiling.allowPublicHttps !== "boolean" ||
    !Array.isArray(ceiling.hosts)
  ) {
    throw new Error("Gateway outbound ceiling requires allowPublicHttps and exact DNS hosts.");
  }
  const policy = normalizeGatewayOutboundPolicy({ mode: "restricted", hosts: ceiling.hosts });
  if (policy.mode !== "restricted") {
    throw new Error("Invalid Gateway outbound ceiling.");
  }
  return Object.freeze({ allowPublicHttps: ceiling.allowPublicHttps, hosts: policy.hosts });
}

/** A policy can consume only explicit Installation authority. Channel grants remain separate. */
export function assertGatewayOutboundWithinCeiling(
  policy: GatewayOutboundPolicy,
  ceiling: GatewayOutboundPolicyCeiling,
): void {
  if (
    policy.mode === "publicHttps"
      ? !ceiling.allowPublicHttps
      : policy.hosts.some((host) => !ceiling.hosts.includes(host))
  ) {
    throw new Error("Gateway outbound policy exceeds the Installation ceiling.");
  }
}

export function normalizeGatewayOutboundAdmission(input: unknown): GatewayOutboundAdmission {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Dedicated Gateway outbound admission snapshot is required.");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 2 ||
    value.ceiling === undefined ||
    !Array.isArray(value.channelDestinations) ||
    value.channelDestinations.length > 256
  ) {
    throw new Error("Dedicated Gateway outbound admission snapshot is invalid.");
  }
  const ceiling = normalizeGatewayOutboundPolicyCeiling(value.ceiling);
  const channelDestinations = value.channelDestinations.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Invalid channel destination.");
    }
    const destination = entry as Record<string, unknown>;
    const host = destination.host;
    if (
      Object.keys(destination).length !== 3 ||
      typeof host !== "string" ||
      !Array.isArray(destination.ports) ||
      destination.ports.length !== 1 ||
      destination.ports[0] !== 443 ||
      (destination.protocol !== "https" && destination.protocol !== "wss")
    ) {
      throw new Error("Invalid channel destination.");
    }
    normalizeGatewayOutboundPolicy({
      mode: "restricted",
      hosts: [host.startsWith("*.") ? host.slice(2) : host],
    });
    return Object.freeze({ host, ports: Object.freeze([443]), protocol: destination.protocol });
  });
  return Object.freeze({ ceiling, channelDestinations: Object.freeze(channelDestinations) });
}
