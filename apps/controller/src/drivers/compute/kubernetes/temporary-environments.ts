import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { TemporaryEnvironmentPolicy } from "@openclaw-enterprise/contracts";

/** Operator-supplied images must implement the nonroot SSH entrypoint contract. */
export interface KubernetesTemporaryEnvironmentOptions {
  /** Explicit adapter selection; omission keeps HTTP profile discovery available. */
  readonly defaultProfileId?: string;
  readonly profiles: readonly {
    readonly id: string;
    readonly namespaceIds: readonly string[];
    readonly image: string;
    readonly cpuMillis: number;
    readonly memoryMiB: number;
    readonly lifetimeSeconds: number;
    readonly idleTimeoutSeconds: number;
    readonly egress: readonly { readonly cidr: string; readonly port: number }[];
  }[];
  readonly quota: TemporaryEnvironmentPolicy["quota"];
}

const boundedInteger = (value: unknown, maximum: number): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;

export function validateTemporaryEnvironmentOptions(
  value: KubernetesTemporaryEnvironmentOptions | undefined,
): void {
  if (value === undefined) {
    return;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).some((key) => !["profiles", "quota", "defaultProfileId"].includes(key)) ||
    !Array.isArray(value.profiles) ||
    value.profiles.length === 0 ||
    value.profiles.length > 32
  ) {
    throw new Error("Temporary environments require explicit operator profiles and quota.");
  }
  const quota = value.quota;
  if (
    !quota ||
    Object.keys(quota).some(
      (key) => !["maxEnvironments", "maxCpuMillis", "maxMemoryMiB"].includes(key),
    ) ||
    !boundedInteger(quota.maxEnvironments, 1000) ||
    !boundedInteger(quota.maxCpuMillis, 1_000_000) ||
    !boundedInteger(quota.maxMemoryMiB, 1_048_576)
  ) {
    throw new Error("Temporary environment quota must be bounded.");
  }
  const ids = new Set<string>();
  for (const profile of value.profiles) {
    if (
      !profile ||
      Object.keys(profile).some(
        (key) =>
          ![
            "id",
            "namespaceIds",
            "image",
            "cpuMillis",
            "memoryMiB",
            "lifetimeSeconds",
            "idleTimeoutSeconds",
            "egress",
          ].includes(key),
      ) ||
      typeof profile.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,62}$/.test(profile.id) ||
      ids.has(profile.id) ||
      typeof profile.image !== "string" ||
      !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(profile.image) ||
      !Array.isArray(profile.namespaceIds) ||
      profile.namespaceIds.length === 0 ||
      profile.namespaceIds.some(
        (id: unknown) => typeof id !== "string" || !/^ns_[a-zA-Z0-9-]+$/.test(id),
      ) ||
      !boundedInteger(profile.cpuMillis, Math.min(16000, quota.maxCpuMillis)) ||
      !boundedInteger(profile.memoryMiB, Math.min(65536, quota.maxMemoryMiB)) ||
      !boundedInteger(profile.lifetimeSeconds, 86400) ||
      !boundedInteger(profile.idleTimeoutSeconds, profile.lifetimeSeconds) ||
      !Array.isArray(profile.egress) ||
      profile.egress.length > 32
    ) {
      throw new Error(
        "Temporary environment profile must be an immutable, bounded SSH profile with a Namespace allowlist.",
      );
    }
    ids.add(profile.id);
    for (const rule of profile.egress) {
      const parts = typeof rule?.cidr === "string" ? rule.cidr.split("/") : [];
      // Exact IPv4 destinations only: no broad internet, link-local or loopback grant.
      const address = parts[0] ?? "";
      if (
        Object.keys(rule).some((key) => !["cidr", "port"].includes(key)) ||
        isIP(address) !== 4 ||
        parts.length !== 2 ||
        parts[1] !== "32" ||
        /^(0|127|169\.254)\./.test(address) ||
        Number(address.split(".")[0]) >= 224 ||
        !boundedInteger(rule.port, 65535)
      ) {
        throw new Error(
          "Temporary environment egress requires exact approved IPv4 /32 destinations and TCP ports.",
        );
      }
    }
  }
  if (value.defaultProfileId !== undefined && !ids.has(value.defaultProfileId)) {
    throw new Error("Temporary environment defaultProfileId must select an approved profile.");
  }
}

export function temporaryEnvironmentPolicy(
  options: KubernetesTemporaryEnvironmentOptions | undefined,
): TemporaryEnvironmentPolicy | undefined {
  if (options === undefined) {
    return undefined;
  }
  return {
    quota: { ...options.quota },
    profiles: options.profiles.map((profile) => ({
      id: profile.id,
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify({
            version: 1,
            id: profile.id,
            namespaceIds: [...profile.namespaceIds].sort(),
            image: profile.image,
            cpuMillis: profile.cpuMillis,
            memoryMiB: profile.memoryMiB,
            lifetimeSeconds: profile.lifetimeSeconds,
            idleTimeoutSeconds: profile.idleTimeoutSeconds,
            egress: profile.egress
              .map((rule) => ({ cidr: rule.cidr, port: rule.port }))
              .sort((a, b) => a.cidr.localeCompare(b.cidr) || a.port - b.port),
          }),
        )
        .digest("hex"),
      namespaceIds: [...profile.namespaceIds],
      cpuMillis: profile.cpuMillis,
      memoryMiB: profile.memoryMiB,
      lifetimeSeconds: profile.lifetimeSeconds,
      idleTimeoutSeconds: profile.idleTimeoutSeconds,
    })),
  };
}
