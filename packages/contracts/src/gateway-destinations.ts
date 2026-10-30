import type { AgentRevision, SandboxNamespaceContext } from "./index.ts";

/** Destination permission, not a credential grant or permission to invoke an integration. */
export interface GatewayDestination {
  readonly host: string;
  readonly port: 443;
}

/** Additional exact destinations approved by this Agent's administrator. */
export interface GatewayOutbound {
  readonly destinations: readonly GatewayDestination[];
}

/** Canonical DNS names only. Wildcards are reserved for trusted Channel contributions. */
export function isGatewayDestinationHost(host: unknown, trustedChannel = false): host is string {
  if (typeof host !== "string" || host.length > 253) {
    return false;
  }
  const dns = trustedChannel && host.startsWith("*.") ? host.slice(2) : host;
  return (
    dns.includes(".") &&
    !/^[0-9.]+$/.test(dns) &&
    dns.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}

/** Validate without repairing a spelling that could change the approved authority. */
export function normalizeGatewayOutbound(value: unknown): GatewayOutbound {
  if (value === undefined) {
    return Object.freeze({ destinations: Object.freeze([]) });
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("destinations" in value) ||
    !Array.isArray(value.destinations)
  ) {
    throw new Error("Gateway outbound must contain a destinations list.");
  }
  const destinations = value.destinations.map((entry: unknown) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      !("host" in entry) ||
      !("port" in entry) ||
      !isGatewayDestinationHost(entry.host) ||
      entry.port !== 443
    ) {
      throw new Error(
        "Gateway outbound destinations require exact canonical DNS hosts on TCP/443.",
      );
    }
    return Object.freeze({ host: entry.host, port: 443 as const });
  });
  const hosts = new Set(destinations.map(({ host }) => host));
  if (hosts.size !== destinations.length) {
    throw new Error("Gateway outbound destinations must be unique.");
  }
  return Object.freeze({ destinations: Object.freeze(destinations) });
}

/** Nonsecret admission, frozen by Compute into the exact Agent revision. */
export interface GatewayDestinationPlan {
  readonly version: 1;
  readonly driverId: string;
  readonly sandboxDriverId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly destinations: readonly GatewayDestination[];
  /** Opaque selected-implementation policy; Compute must not interpret or broaden it. */
  readonly policy: string;
  readonly policyHash: string;
  /** Binds policy-engine assets, runtime images and attachment configuration. */
  readonly attachmentDigest: string;
  /** Enforced by the attachment network boundary, including DNS-resolved destinations. */
  readonly egress: {
    readonly addressFamily: "ipv4";
    readonly excludedCidrs: readonly string[];
  };
  readonly endpoint: {
    readonly serviceName: string;
    readonly port: number;
    readonly podLabels: Readonly<Record<string, string>>;
  };
}

export interface GatewayDestinationControl {
  /** Pure admission. No credential reads, protected-execution receipts or network effects. */
  admit(
    revision: Readonly<AgentRevision>,
    destinations: readonly GatewayDestination[],
  ): GatewayDestinationPlan;
}

export interface GatewayProxyAttachmentContext extends SandboxNamespaceContext {
  readonly revision: Readonly<AgentRevision>;
  /** Existing physical Gateway placement, not a new placement selected by the proxy. */
  readonly namespaceName: string;
  readonly dnsPeer: {
    readonly namespace: string;
    readonly podLabels: Readonly<Record<string, string>>;
  };
}

export interface GatewayProxyAttachment {
  readonly prepare: (
    context: GatewayProxyAttachmentContext,
    plan: GatewayDestinationPlan,
  ) => Promise<boolean>;
  /** Resolve true only after the exact revision proxy and its open connections are gone. */
  readonly remove: (
    context: GatewayProxyAttachmentContext,
    plan: GatewayDestinationPlan,
  ) => Promise<boolean>;
}
