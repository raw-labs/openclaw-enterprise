import type { TemporaryEnvironmentPolicy } from "@openclaw-enterprise/contracts";
import { isIP } from "node:net";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { TemporaryEnvironmentReservation } from "./ports/temporary-environments.ts";
import { DependencyUnavailableError, ScopeViolationError } from "./errors.ts";

export interface AcquireTemporaryEnvironmentInput {
  readonly requestId: string;
  readonly name: string;
  readonly slug: string;
  readonly profileId: string;
  readonly sshPublicKey: string;
}

export function validateTemporaryEnvironmentInput(input: AcquireTemporaryEnvironmentInput): void {
  for (const value of [input.requestId, input.profileId, input.name, input.slug]) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 128 ||
      !/^[A-Za-z0-9]/u.test(value) ||
      /[^A-Za-z0-9._:-]/u.test(value)
    ) {
      throw new ScopeViolationError(
        "A bounded request identity and approved profile are required.",
      );
    }
  }
  // Only a canonical Ed25519 public key is accepted, never authorized_keys options or commands.
  if (
    typeof input.sshPublicKey !== "string" ||
    !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/u.test(input.sshPublicKey) ||
    input.sshPublicKey.length !== 80
  ) {
    throw new ScopeViolationError("A canonical Ed25519 SSH public key is required.");
  }
  const key = Buffer.from(input.sshPublicKey.slice(12), "base64");
  if (
    key.length !== 51 ||
    key.readUInt32BE(0) !== 11 ||
    key.subarray(4, 15).toString("ascii") !== "ssh-ed25519" ||
    key.readUInt32BE(15) !== 32 ||
    key.toString("base64") !== input.sshPublicKey.slice(12)
  ) {
    throw new ScopeViolationError("A canonical Ed25519 SSH public key is required.");
  }
}

/** Validate the selected Driver contract before any quota write, not caller-provided policy. */
export function validateTemporaryEnvironmentPolicy(policy: TemporaryEnvironmentPolicy): void {
  const positive = (value: number, max: number) =>
    Number.isInteger(value) && value > 0 && value <= max;
  const ids = new Set<string>();
  if (
    !policy ||
    !policy.quota ||
    !Array.isArray(policy.profiles) ||
    policy.profiles.length > 100 ||
    !positive(policy.quota.maxEnvironments, 1000) ||
    !positive(policy.quota.maxCpuMillis, 2147483647) ||
    !positive(policy.quota.maxMemoryMiB, 2147483647)
  ) {
    throw new DependencyUnavailableError(
      "The selected Compute Driver returned invalid temporary environment policy.",
    );
  }
  for (const profile of policy.profiles) {
    if (
      !profile ||
      typeof profile.id !== "string" ||
      profile.id.length < 1 ||
      profile.id.length > 128 ||
      /[^A-Za-z0-9._:-]/u.test(profile.id) ||
      !/^[A-Za-z0-9]/u.test(profile.id) ||
      ids.has(profile.id) ||
      typeof profile.fingerprint !== "string" ||
      profile.fingerprint.length !== 64 ||
      /[^a-f0-9]/u.test(profile.fingerprint) ||
      !Array.isArray(profile.namespaceIds) ||
      profile.namespaceIds.length < 1 ||
      profile.namespaceIds.length > 1000 ||
      !profile.namespaceIds.every(
        (id: unknown) => typeof id === "string" && /^ns_[0-9a-f-]{36}$/u.test(id),
      ) ||
      !positive(profile.cpuMillis, policy.quota.maxCpuMillis) ||
      !positive(profile.memoryMiB, policy.quota.maxMemoryMiB) ||
      !positive(profile.lifetimeSeconds, 86400) ||
      !positive(profile.idleTimeoutSeconds, profile.lifetimeSeconds)
    ) {
      throw new DependencyUnavailableError(
        "The selected Compute Driver returned invalid temporary environment policy.",
      );
    }
    ids.add(profile.id);
  }
}

/** Never disclose internal ownership receipts or an endpoint after its admitted deadline. */
export function temporaryEnvironmentView(
  record: Readonly<TemporaryEnvironmentReservation>,
  allowConnection = true,
) {
  const usable =
    allowConnection &&
    record.state === "ready" &&
    Date.parse(record.hardExpiresAt) > Date.now() &&
    Date.parse(record.idleExpiresAt) > Date.now();
  const ssh = record.ssh;
  if (
    usable &&
    (!ssh ||
      typeof ssh.host !== "string" ||
      ssh.host.length > 253 ||
      !(isIP(ssh.host) > 0 || /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/u.test(ssh.host)) ||
      !Number.isInteger(ssh.port) ||
      ssh.port < 1 ||
      ssh.port > 65535 ||
      typeof ssh.user !== "string" ||
      !/^[a-z_][a-z0-9_-]{0,31}$/u.test(ssh.user))
  ) {
    throw new DependencyUnavailableError("The temporary environment SSH endpoint is invalid.");
  }
  return immutableCopy({
    id: record.id,
    namespaceId: record.namespaceId,
    agentId: record.agentId,
    revisionId: record.revisionId,
    requestId: record.requestId,
    name: record.name,
    slug: record.slug,
    profileId: record.profileId,
    state: record.state,
    createdAt: record.createdAt,
    hardExpiresAt: record.hardExpiresAt,
    idleExpiresAt: record.idleExpiresAt,
    cpuMillis: record.cpuMillis,
    memoryMiB: record.memoryMiB,
    usable,
    ...(usable && record.ssh
      ? { ssh: { host: record.ssh.host, port: record.ssh.port, user: record.ssh.user } }
      : {}),
  });
}
