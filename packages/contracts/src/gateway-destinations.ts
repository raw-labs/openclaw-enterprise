import type { AgentRevision, SandboxNamespaceContext } from "./index.ts";

/** Destination permission, not a credential grant or permission to invoke an integration. */
export interface GatewayDestination {
  readonly host: string;
  readonly port: 443;
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
