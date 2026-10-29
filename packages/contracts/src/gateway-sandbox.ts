import type {
  AgentRevision,
  OpenClawConfigurationDocument,
  SandboxNamespaceContext,
  SandboxResourceRef,
} from "./index.ts";
import type { GatewayOutboundPolicy, GatewayOutboundAdmission } from "./gateway-outbound.ts";

/** Only exact Agent-owned non-model material may be read from this same-Namespace key. */
export interface GatewaySandboxSecretRef {
  readonly name: string;
  readonly key: string;
}
export interface GatewaySandboxRuntimePeer {
  readonly host: string;
  readonly addresses: readonly string[];
  readonly ports: readonly number[];
}
export interface GatewaySandboxNodeBinding {
  readonly generation: string;
  readonly nodeId: string;
  /** Workspace-node identity only; transport credentials remain in startup Secret refs. */
  readonly token?: string;
  readonly endpoint?: string;
}
/** A Gateway description, not an arbitrary Pod template or Harness executor. */
export interface GatewaySandboxRequirements {
  readonly image: string;
  readonly command: readonly string[];
  readonly configuration: OpenClawConfigurationDocument;
  readonly environment: readonly {
    readonly name: string;
    readonly value?: string;
    readonly secretKeyRef?: GatewaySandboxSecretRef;
  }[];
  readonly files: readonly {
    readonly path: string;
    readonly secretKeyRef: GatewaySandboxSecretRef;
  }[];
  readonly state: {
    readonly claimName: string;
    readonly stateSubPath: string;
    readonly workspaceSubPath: string;
    /** Exact retained native Gateway categories; no arbitrary mounts. */
    readonly mounts?: readonly { readonly subPath: string; readonly mountPath: string }[];
  };
  readonly resources: Readonly<Record<string, unknown>>;
  readonly nodeSelector?: Readonly<Record<string, string>>;
  readonly outboundPolicy: GatewayOutboundPolicy;
  readonly outboundAdmission: GatewayOutboundAdmission;
  readonly runtimePeers: readonly GatewaySandboxRuntimePeer[];
  /** Exact control-plane/cluster ranges excluded from external destinations. */
  readonly infrastructureCidrs: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
}
export interface GatewaySandboxContext extends SandboxNamespaceContext {
  readonly revision: Readonly<AgentRevision>;
  /** Fresh launch generation, never an old PVC release marker. */
  readonly generation: string;
  readonly requirements: GatewaySandboxRequirements;
}
export interface GatewaySandboxEndpoint {
  /** Controller HTTPS/WSS endpoint, authenticated by the native Gateway token. */
  readonly url: string;
  /** Provider relay Host authority (may differ from the control endpoint URL). */
  readonly authority: string;
  readonly tls?: { readonly caBundle: string };
}
export type GatewaySandboxStatus =
  | { readonly state: "starting" }
  | { readonly state: "ready" }
  | { readonly state: "failed"; readonly reason: string };
export interface GatewaySandboxObservation {
  readonly state: "present" | "absent";
  readonly resource?: SandboxResourceRef;
  readonly instanceId?: string;
  readonly mainProcessInstanceId?: string;
  /** Exact source of provider-opened connections; absent observations grant no peer. */
  readonly networkPeer?: {
    readonly namespace: string;
    readonly podLabels: Readonly<Record<string, string>>;
  };
}
export interface GatewaySandboxCapability {
  /** Stable non-secret owner fingerprint; persisted with launch state and fenced on every operation. */
  readonly identity: string;
  /** Nonpersistent private HOME for native startup rendering. */
  readonly home?: string;
  validate(requirements: GatewaySandboxRequirements): void;
  ensureNamespace(context: SandboxNamespaceContext): Promise<void>;
  provision(context: GatewaySandboxContext): Promise<SandboxResourceRef>;
  status(context: GatewaySandboxContext): Promise<GatewaySandboxStatus>;
  endpoint(context: GatewaySandboxContext): Promise<GatewaySandboxEndpoint>;
  /** Bounded private HTTP through authenticated provider transport, never a public service. */
  readStatus(
    context: GatewaySandboxContext,
    path: string,
  ): Promise<Readonly<Record<string, unknown>>>;
  updateNodeBinding(
    context: GatewaySandboxContext,
    binding: GatewaySandboxNodeBinding,
  ): Promise<void>;
  observe(context: GatewaySandboxContext): Promise<GatewaySandboxObservation>;
  stop(context: GatewaySandboxContext): Promise<void>;
  /** Delete exact Sandbox, confirm absence twice, retain Agent PVC. */
  cleanup(context: GatewaySandboxContext): Promise<void>;
}
