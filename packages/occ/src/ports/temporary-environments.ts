/** Trusted admission inputs, after workload identity, IAM and profile policy resolution. */
export interface TemporaryEnvironmentRequest {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly requestId: string;
  readonly profileId: string;
  /** Digest of the operator-approved immutable profile; never credentials or a caller manifest. */
  readonly profileFingerprint: string;
  readonly cpuMillis: number;
  readonly memoryMiB: number;
  readonly lifetimeSeconds: number;
}

export interface TemporaryEnvironmentReservation extends TemporaryEnvironmentRequest {
  readonly id: string;
  readonly servicePrincipalId: string;
  readonly state: "reserved";
  readonly createdAt: string;
  readonly hardExpiresAt: string;
}

export interface TemporaryEnvironmentQuotaLimits {
  readonly maxEnvironments: number;
  readonly maxCpuMillis: number;
  readonly maxMemoryMiB: number;
}

export interface TemporaryEnvironmentQuota extends TemporaryEnvironmentQuotaLimits {
  readonly namespaceId: string;
  readonly reservedEnvironments: number;
  readonly reservedCpuMillis: number;
  readonly reservedMemoryMiB: number;
}

export interface TemporaryEnvironmentReadRepository {
  getQuota(namespaceId: string): Promise<Readonly<TemporaryEnvironmentQuota> | undefined>;
  findByRequest(
    namespaceId: string,
    agentId: string,
    requestId: string,
  ): Promise<Readonly<TemporaryEnvironmentReservation> | undefined>;
  listForAgent(
    namespaceId: string,
    agentId: string,
  ): Promise<readonly Readonly<TemporaryEnvironmentReservation>[]>;
}

export interface TemporaryEnvironmentRepository extends TemporaryEnvironmentReadRepository {
  /** Operator policy only: reducing a ceiling below reserved usage is refused. */
  setQuota(
    namespaceId: string,
    limits: TemporaryEnvironmentQuotaLimits,
  ): Promise<Readonly<TemporaryEnvironmentQuota>>;
  /**
   * Locks current ownership, reserves aggregate capacity and persists one immutable request.
   * Identical retries return that reservation without spending capacity or renewing its deadline.
   * These persistence checks do not replace workload authentication or IAM authorization.
   */
  reserve(input: TemporaryEnvironmentRequest): Promise<Readonly<TemporaryEnvironmentReservation>>;
  // TODO(RFC-0019): Release capacity only through confirmed provider cleanup in durable worker
  // reconciliation. No expiry, caller release, or row-delete operation frees capacity yet.
}
