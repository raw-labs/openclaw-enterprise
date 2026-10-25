import type {
  AgentRevision,
  SandboxEnvironmentVariable,
  SandboxNamespaceContext,
} from "./index.ts";

/** Application placement is separate from a dedicated Harness's requirements. */
export type SandboxApplicationRole = "gateway" | "embedded";

export interface SandboxApplicationMount {
  readonly name: string;
  readonly mountPath: string;
  readonly subPath?: string;
  readonly readOnly?: boolean;
}

export type SandboxApplicationVolume = { readonly name: string } & (
  | { readonly persistentVolumeClaim: { readonly claimName: string; readonly readOnly?: boolean } }
  | {
      readonly configMap: {
        readonly name: string;
        readonly defaultMode?: number;
        readonly optional?: boolean;
        readonly items?: readonly {
          readonly key: string;
          readonly path: string;
          readonly mode?: number;
        }[];
      };
    }
  | {
      readonly secret: {
        readonly secretName: string;
        readonly defaultMode?: number;
        readonly optional?: boolean;
        readonly items?: readonly {
          readonly key: string;
          readonly path: string;
          readonly mode?: number;
        }[];
      };
    }
  | { readonly emptyDir: { readonly medium?: string; readonly sizeLimit?: string } }
);

export interface SandboxApplicationProcess {
  readonly name: string;
  readonly image: string;
  readonly command: readonly string[];
  readonly args: readonly string[];
  readonly environment: readonly (
    | SandboxEnvironmentVariable
    | {
        readonly name: string;
        readonly valueFrom: { readonly fieldRef: { readonly fieldPath: "metadata.uid" } };
      }
  )[];
  readonly mounts: readonly SandboxApplicationMount[];
  readonly resources?: Readonly<Record<string, unknown>>;
}

/** Prepared references, never resolved credential values or arbitrary provider policy. */
export interface SandboxApplicationRequirements extends SandboxApplicationProcess {
  readonly role: SandboxApplicationRole;
  readonly volumes: readonly SandboxApplicationVolume[];
  readonly initializers: readonly SandboxApplicationProcess[];
  readonly port: number;
  readonly namespaceName: string;
  readonly serviceAccountName: string;
  readonly nodeSelector?: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  /** Compute-generated peers, not arbitrary URLs discovered in payload configuration. */
  readonly runtimePeers: readonly {
    readonly host: string;
    readonly port: number;
    readonly allowedIps: readonly string[];
  }[];
  readonly denyCidrs: readonly string[];
  readonly generatedPublicHosts: readonly string[];
}

export interface SandboxApplicationContext extends SandboxNamespaceContext {
  readonly revision: Readonly<AgentRevision>;
  readonly requirements: SandboxApplicationRequirements;
}

/** A fixed application origin; connectOrigin must never select a caller-controlled route. */
export interface SandboxApplicationEndpoint {
  readonly origin: string;
  readonly connectOrigin: string;
  readonly caBundle?: string;
  readonly statusOrigin: string;
  readonly transportSecretRef: { readonly name: string; readonly key: string };
}

export interface SandboxApplicationProvider {
  readonly ingress: "authenticated-loopback";
  readonly embedded: boolean;
  provision(
    context: SandboxApplicationContext,
  ): Promise<
    | { readonly state: "pending" }
    | { readonly state: "ready"; readonly endpoint: SandboxApplicationEndpoint }
  >;
  cleanup(
    context: SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> },
  ): Promise<void>;
  /** Exact payload identity, not the transport frontend's identity. */
  readStatus(
    context: SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> },
    path: string,
  ): Promise<
    { readonly status: unknown; readonly podUid: string; readonly containerId?: string } | undefined
  >;
}
