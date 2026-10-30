import { randomUUID } from "node:crypto";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { Agent, AgentRevision, Namespace } from "@openclaw-enterprise/contracts";
import { ResourceConflictError, ScopeViolationError } from "../errors.ts";
import type {
  TemporaryEnvironmentQuota,
  TemporaryEnvironmentRepository,
  TemporaryEnvironmentReservation,
} from "../ports/temporary-environments.ts";

interface TemporaryEnvironmentMemory {
  readonly quotas: Map<string, Readonly<TemporaryEnvironmentQuota>>;
  readonly reservations: Map<string, Readonly<TemporaryEnvironmentReservation>>;
  enqueue(record: Readonly<TemporaryEnvironmentReservation>): void;
  namespace(id: string): Readonly<Namespace> | undefined;
  agent(namespaceId: string, agentId: string): Readonly<Agent> | undefined;
  revision(
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Readonly<AgentRevision> | undefined;
}

const positiveInteger = (value: number, maximum = 2147483647): boolean =>
  Number.isInteger(value) && value > 0 && value <= maximum;
const token = (value: string): boolean =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 128 &&
  /^[A-Za-z0-9]/u.test(value) &&
  !/[^A-Za-z0-9._:-]/u.test(value);

/** Mirrors SQL constraints within the memory store's existing single-writer transaction. */
export function memoryTemporaryEnvironments(
  state: TemporaryEnvironmentMemory,
): TemporaryEnvironmentRepository {
  const find = (namespaceId: string, agentId: string, requestId: string) =>
    [...state.reservations.values()].find(
      (row) =>
        row.namespaceId === namespaceId && row.agentId === agentId && row.requestId === requestId,
    );
  return {
    // Memory state has no durable worker/claims: never emulate a fenced provider confirmation.
    reconcile: async () => {
      throw new ScopeViolationError(
        "Temporary environment reconciliation requires PostgreSQL claims.",
      );
    },
    touch: async (namespaceId, agentId, requestId) => {
      const row = find(namespaceId, agentId, requestId);
      if (
        row === undefined ||
        row.state === "deleting" ||
        row.state === "deleted" ||
        Date.parse(row.idleExpiresAt) <= Date.now() ||
        Date.parse(row.hardExpiresAt) <= Date.now()
      ) {
        return undefined;
      }
      const saved = immutableCopy({
        ...row,
        idleExpiresAt: new Date(
          Math.min(Date.parse(row.hardExpiresAt), Date.now() + row.idleTimeoutSeconds * 1000),
        ).toISOString(),
      });
      state.reservations.set(saved.id, saved);
      return saved;
    },
    requestDeletion: async (namespaceId, agentId, requestId) => {
      const row = find(namespaceId, agentId, requestId);
      if (row === undefined || row.state === "deleted") {
        return row;
      }
      const saved = immutableCopy({ ...row, state: "deleting" as const });
      state.reservations.set(saved.id, saved);
      return saved;
    },
    getQuota: async (namespaceId) => {
      const saved = state.quotas.get(namespaceId);
      return saved === undefined ? undefined : immutableCopy(saved);
    },
    setQuota: async (namespaceId, limits) => {
      const current = state.quotas.get(namespaceId);
      const usage = {
        reservedEnvironments: current?.reservedEnvironments ?? 0,
        reservedCpuMillis: current?.reservedCpuMillis ?? 0,
        reservedMemoryMiB: current?.reservedMemoryMiB ?? 0,
      };
      if (
        !state.namespace(namespaceId) ||
        !positiveInteger(limits.maxEnvironments, 1000) ||
        !positiveInteger(limits.maxCpuMillis) ||
        !positiveInteger(limits.maxMemoryMiB) ||
        usage.reservedEnvironments > limits.maxEnvironments ||
        usage.reservedCpuMillis > limits.maxCpuMillis ||
        usage.reservedMemoryMiB > limits.maxMemoryMiB
      ) {
        throw new ScopeViolationError(
          "Temporary environment quota violates ownership or reserved usage.",
        );
      }
      const saved = immutableCopy({
        namespaceId,
        maxEnvironments: limits.maxEnvironments,
        maxCpuMillis: limits.maxCpuMillis,
        maxMemoryMiB: limits.maxMemoryMiB,
        ...usage,
      });
      state.quotas.set(namespaceId, saved);
      return immutableCopy(saved);
    },
    findByRequest: async (namespaceId, agentId, requestId) => {
      const saved = find(namespaceId, agentId, requestId);
      return saved === undefined ? undefined : immutableCopy(saved);
    },
    listForAgent: async (namespaceId, agentId) =>
      immutableCopy(
        [...state.reservations.values()]
          .filter((row) => row.namespaceId === namespaceId && row.agentId === agentId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      ),
    reserve: async (input) => {
      const existing = find(input.namespaceId, input.agentId, input.requestId);
      if (existing !== undefined) {
        if (
          existing.name !== input.name ||
          existing.slug !== input.slug ||
          existing.revisionId !== input.revisionId ||
          existing.profileId !== input.profileId ||
          existing.profileFingerprint !== input.profileFingerprint ||
          existing.cpuMillis !== input.cpuMillis ||
          existing.memoryMiB !== input.memoryMiB ||
          existing.lifetimeSeconds !== input.lifetimeSeconds ||
          existing.idleTimeoutSeconds !== input.idleTimeoutSeconds ||
          existing.sshPublicKey !== input.sshPublicKey
        ) {
          throw new ResourceConflictError("Temporary environment request identity conflicts.");
        }
        return immutableCopy(existing);
      }
      const owner = state.agent(input.namespaceId, input.agentId);
      if (
        state.namespace(input.namespaceId)?.status !== "ready" ||
        owner?.status !== "active" ||
        owner.desiredRuntimeState !== "running" ||
        owner.activeRevisionId !== input.revisionId ||
        !state.revision(input.namespaceId, input.agentId, input.revisionId)
      ) {
        throw new ScopeViolationError("Temporary environment Agent revision is unavailable.");
      }
      if (
        !token(input.name) ||
        !token(input.slug) ||
        !token(input.requestId) ||
        !token(input.profileId) ||
        typeof input.profileFingerprint !== "string" ||
        input.profileFingerprint.length !== 64 ||
        /[^a-f0-9]/u.test(input.profileFingerprint) ||
        !positiveInteger(input.cpuMillis) ||
        !positiveInteger(input.memoryMiB) ||
        !positiveInteger(input.lifetimeSeconds, 86400) ||
        !positiveInteger(input.idleTimeoutSeconds, 86400) ||
        typeof input.sshPublicKey !== "string" ||
        input.sshPublicKey.length < 20 ||
        input.sshPublicKey.length > 16384 ||
        /[\r\n]/u.test(input.sshPublicKey)
      ) {
        throw new ScopeViolationError("Temporary environment reservation input is invalid.");
      }
      const quota = state.quotas.get(input.namespaceId);
      if (
        !quota ||
        quota.reservedEnvironments >= quota.maxEnvironments ||
        input.cpuMillis > quota.maxCpuMillis - quota.reservedCpuMillis ||
        input.memoryMiB > quota.maxMemoryMiB - quota.reservedMemoryMiB
      ) {
        throw new ScopeViolationError("Temporary environment quota is unavailable or exhausted.");
      }
      const now = Date.now();
      const saved = immutableCopy({
        namespaceId: input.namespaceId,
        agentId: input.agentId,
        revisionId: input.revisionId,
        requestId: input.requestId,
        name: input.name,
        slug: input.slug,
        profileId: input.profileId,
        profileFingerprint: input.profileFingerprint,
        cpuMillis: input.cpuMillis,
        memoryMiB: input.memoryMiB,
        lifetimeSeconds: input.lifetimeSeconds,
        idleTimeoutSeconds: input.idleTimeoutSeconds,
        sshPublicKey: input.sshPublicKey,
        allocationStarted: false,
        idleExpiresAt: new Date(
          now + Math.min(input.idleTimeoutSeconds, input.lifetimeSeconds) * 1000,
        ).toISOString(),
        id: "tenv_" + randomUUID(),
        servicePrincipalId: owner.servicePrincipalId,
        state: "reserved" as const,
        createdAt: new Date(now).toISOString(),
        hardExpiresAt: new Date(now + input.lifetimeSeconds * 1000).toISOString(),
      });
      state.quotas.set(
        input.namespaceId,
        immutableCopy({
          ...quota,
          reservedEnvironments: quota.reservedEnvironments + 1,
          reservedCpuMillis: quota.reservedCpuMillis + input.cpuMillis,
          reservedMemoryMiB: quota.reservedMemoryMiB + input.memoryMiB,
        }),
      );
      state.reservations.set(saved.id, saved);
      state.enqueue(saved);
      return immutableCopy(saved);
    },
  };
}
