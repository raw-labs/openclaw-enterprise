import { immutableCopy } from "@openclaw-enterprise/utils";
import type {
  TemporaryEnvironmentQuota,
  TemporaryEnvironmentRepository,
  TemporaryEnvironmentReservation,
} from "../ports/temporary-environments.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

function quota(value: unknown): Readonly<TemporaryEnvironmentQuota> {
  const row = value as Record<string, unknown>;
  return immutableCopy({
    namespaceId: row.namespace_id as string,
    maxEnvironments: row.max_environments as number,
    maxCpuMillis: row.max_cpu_millis as number,
    maxMemoryMiB: row.max_memory_mib as number,
    reservedEnvironments: row.reserved_environments as number,
    reservedCpuMillis: row.reserved_cpu_millis as number,
    reservedMemoryMiB: row.reserved_memory_mib as number,
  });
}

function reservation(value: unknown): Readonly<TemporaryEnvironmentReservation> {
  const row = value as Record<string, unknown>;
  return immutableCopy({
    id: row.id as string,
    namespaceId: row.namespace_id as string,
    agentId: row.agent_id as string,
    revisionId: row.revision_id as string,
    servicePrincipalId: row.service_principal_id as string,
    requestId: row.request_id as string,
    name: row.name as string,
    slug: row.slug as string,
    profileId: row.profile_id as string,
    profileFingerprint: row.profile_fingerprint as string,
    cpuMillis: row.cpu_millis as number,
    memoryMiB: row.memory_mib as number,
    lifetimeSeconds: row.lifetime_seconds as number,
    state: row.state as TemporaryEnvironmentReservation["state"],
    allocationStarted: row.allocation_started as boolean,
    idleTimeoutSeconds: row.idle_timeout_seconds as number,
    sshPublicKey: row.ssh_public_key as string,
    idleExpiresAt: new Date(row.idle_expires_at as string).toISOString(),
    ...(row.provider_ref === null ? {} : { providerRef: row.provider_ref as string }),
    ...(row.ssh === null
      ? {}
      : { ssh: row.ssh as NonNullable<TemporaryEnvironmentReservation["ssh"]> }),
    createdAt: new Date(row.created_at as string).toISOString(),
    hardExpiresAt: new Date(row.hard_expires_at as string).toISOString(),
  });
}

export function postgresTemporaryEnvironments(
  client: PostgresQueryClient,
): TemporaryEnvironmentRepository {
  const mutate = async (
    namespaceId: string,
    agentId: string,
    requestId: string,
    action: string,
  ) => {
    const { rows } = await client.query(
      "SELECT * FROM occ.request_temporary_environment($1,$2,$3,$4)",
      [namespaceId, agentId, requestId, action],
    );
    return rows[0] === undefined || (rows[0] as { id?: string }).id == null
      ? undefined
      : reservation(rows[0]);
  };
  return {
    touch: (namespaceId, agentId, requestId) => mutate(namespaceId, agentId, requestId, "touch"),
    requestDeletion: (namespaceId, agentId, requestId) =>
      mutate(namespaceId, agentId, requestId, "delete"),
    reconcile: async (claim, id, action, observation) => {
      const { rows } = await client.query(
        "SELECT * FROM occ.reconcile_temporary_environment($1,$2,$3,$4,$5)",
        [
          claim.idempotencyKey,
          claim.claimToken,
          id,
          action,
          observation === undefined ? null : JSON.stringify(observation),
        ],
      );
      return rows[0] === undefined || (rows[0] as { id?: string }).id == null
        ? undefined
        : reservation(rows[0]);
    },
    getQuota: async (namespaceId) => {
      const { rows } = await client.query(
        "SELECT * FROM occ.temporary_environment_quotas WHERE namespace_id = $1",
        [namespaceId],
      );
      return rows[0] === undefined ? undefined : quota(rows[0]);
    },
    setQuota: async (namespaceId, limits) => {
      // Admission often sets policy and reserves in one UOW: lock Namespace before quota.
      await client.query("SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE", [namespaceId]);
      const { rows } = await client.query(
        `INSERT INTO occ.temporary_environment_quotas (namespace_id, max_environments, max_cpu_millis, max_memory_mib)
         VALUES ($1,$2,$3,$4) ON CONFLICT (namespace_id) DO UPDATE SET
         max_environments = EXCLUDED.max_environments, max_cpu_millis = EXCLUDED.max_cpu_millis,
         max_memory_mib = EXCLUDED.max_memory_mib RETURNING *`,
        [namespaceId, limits.maxEnvironments, limits.maxCpuMillis, limits.maxMemoryMiB],
      );
      return quota(rows[0]!);
    },
    findByRequest: async (namespaceId, agentId, requestId) => {
      const { rows } = await client.query(
        "SELECT * FROM occ.temporary_environments WHERE namespace_id = $1 AND agent_id = $2 AND request_id = $3",
        [namespaceId, agentId, requestId],
      );
      return rows[0] === undefined ? undefined : reservation(rows[0]);
    },
    listForAgent: async (namespaceId, agentId) => {
      const { rows } = await client.query(
        "SELECT * FROM occ.temporary_environments WHERE namespace_id = $1 AND agent_id = $2 ORDER BY created_at, id",
        [namespaceId, agentId],
      );
      return rows.map(reservation);
    },
    reserve: async (input) => {
      const { rows } = await client.query(
        "SELECT * FROM occ.reserve_temporary_environment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [
          input.namespaceId,
          input.agentId,
          input.revisionId,
          input.requestId,
          input.profileId,
          input.profileFingerprint,
          input.cpuMillis,
          input.memoryMiB,
          input.lifetimeSeconds,
          input.sshPublicKey,
          input.idleTimeoutSeconds,
          input.name,
          input.slug,
        ],
      );
      return reservation(rows[0]!);
    },
  };
}
