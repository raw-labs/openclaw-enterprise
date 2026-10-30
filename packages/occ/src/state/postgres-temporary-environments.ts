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
    profileId: row.profile_id as string,
    profileFingerprint: row.profile_fingerprint as string,
    cpuMillis: row.cpu_millis as number,
    memoryMiB: row.memory_mib as number,
    lifetimeSeconds: row.lifetime_seconds as number,
    state: "reserved",
    createdAt: new Date(row.created_at as string).toISOString(),
    hardExpiresAt: new Date(row.hard_expires_at as string).toISOString(),
  });
}

export function postgresTemporaryEnvironments(
  client: PostgresQueryClient,
): TemporaryEnvironmentRepository {
  return {
    getQuota: async (namespaceId) => {
      const { rows } = await client.query(
        "SELECT * FROM occ.temporary_environment_quotas WHERE namespace_id = $1",
        [namespaceId],
      );
      return rows[0] === undefined ? undefined : quota(rows[0]);
    },
    setQuota: async (namespaceId, limits) => {
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
        "SELECT * FROM occ.reserve_temporary_environment($1,$2,$3,$4,$5,$6,$7,$8,$9)",
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
        ],
      );
      return reservation(rows[0]!);
    },
  };
}
