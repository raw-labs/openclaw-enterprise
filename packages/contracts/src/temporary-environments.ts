/** Operator-approved execution envelope; no caller-provided image, manifest or network policy. */
export interface TemporaryEnvironmentProfile {
  readonly id: string;
  readonly fingerprint: string;
  readonly namespaceIds: readonly string[];
  readonly cpuMillis: number;
  readonly memoryMiB: number;
  readonly lifetimeSeconds: number;
  readonly idleTimeoutSeconds: number;
}

export interface TemporaryEnvironmentPolicy {
  readonly profiles: readonly TemporaryEnvironmentProfile[];
  readonly quota: {
    readonly maxEnvironments: number;
    readonly maxCpuMillis: number;
    readonly maxMemoryMiB: number;
  };
}

/** Public connection metadata only. The SSH private key stays with the invoking Agent. */
export interface TemporaryEnvironmentSSH {
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

export interface TemporaryEnvironmentComputeRequest {
  readonly id: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly servicePrincipalId: string;
  readonly profileId: string;
  readonly profileFingerprint: string;
  readonly cpuMillis: number;
  readonly memoryMiB: number;
  readonly lifetimeSeconds: number;
  readonly hardExpiresAt: string;
  readonly sshPublicKey: string;
  /** Durable flag set before the first external create. Recovery observes; it never blindly recreates. */
  readonly allocationStarted: boolean;
  /** Opaque, nonsecret ownership receipt interpreted only by the selected Compute Driver. */
  readonly providerRef?: string;
}

export type TemporaryEnvironmentObservation =
  | { readonly state: "absent" }
  | { readonly state: "pending"; readonly providerRef?: string }
  | {
      readonly state: "ready";
      readonly providerRef: string;
      readonly ssh: TemporaryEnvironmentSSH;
    };

/** Absence must include every owned resource and exclude unresolved late allocation effects. */
export type TemporaryEnvironmentDeletion = { readonly state: "absent" | "pending" };

export type TemporaryEnvironmentState =
  "reserved" | "provisioning" | "ready" | "deleting" | "deleted";
