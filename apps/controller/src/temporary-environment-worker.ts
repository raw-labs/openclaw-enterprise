import type {
  ComputeDriver,
  IAMDriver,
  TemporaryEnvironmentObservation,
} from "@openclaw-enterprise/contracts";
import { WorkClaimLostError } from "@openclaw-enterprise/occ";
import type { ClaimedWork, PostgresPlatformState } from "@openclaw-enterprise/occ";

interface Dependencies {
  readonly state: PostgresPlatformState;
  readonly compute: ComputeDriver;
  readonly iam: IAMDriver;
  effect<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

/** One ordinary queue claim; ready records retain their scheduled expiry obligation. */
export async function reconcileTemporaryEnvironment(
  claim: ClaimedWork,
  deps: Dependencies,
): Promise<"success" | "pending" | "retry"> {
  const id = claim.idempotencyKey.slice("temporary_environment:".length);
  const transition = (
    action: "inspect" | "beginAllocation" | "delete" | "confirmAbsent",
    observation?: TemporaryEnvironmentObservation,
    auditAction?: "allocation_started" | "ready" | "deleted",
  ) =>
    deps.state.transact(async (unit) => {
      const saved = await unit.temporaryEnvironments.reconcile(claim, id, action, observation);
      if (
        saved &&
        auditAction &&
        (auditAction === "allocation_started" || saved.state === auditAction)
      ) {
        const installation = await unit.installations.getInstallation();
        if (!installation) {
          throw new Error("Installation unavailable for lifecycle audit");
        }
        await unit.audit.append({
          id: "aud_" + crypto.randomUUID(),
          installationId: installation.id,
          namespaceId: saved.namespaceId,
          occurredAt: new Date().toISOString(),
          kind: "mutation",
          actorId: claim.actorId,
          source: "occ",
          action: "openclaw.agents.temporary_environments." + auditAction,
          resource: { kind: "agent", id: saved.agentId, namespaceId: saved.namespaceId },
          iamDriverId: deps.iam.id,
          outcome: "success",
          details: {
            environmentId: saved.id,
            state: saved.state,
            computeDriverId: deps.compute.id,
          },
        });
      }
      return saved;
    });
  let delayMs = 1000;
  let code = "TEMPORARY_ENVIRONMENT_PENDING";
  try {
    let record = await transition("inspect");
    if (record === undefined) {
      throw new WorkClaimLostError();
    }
    const compute = deps.compute;
    const revision = await deps.state.read((view) =>
      view.revisions.findRevision(record!.namespaceId, record!.agentId, record!.revisionId),
    );
    if (
      record.state !== "deleted" &&
      (revision?.compute.id !== compute.id ||
        revision.compute.implementation !== compute.implementation)
    ) {
      // A different Driver cannot attest absence in the provider that accepted the allocation.
      await transition("delete");
      throw new Error("Compute ownership unavailable");
    }
    if (record.state !== "deleted" && record.state !== "deleting") {
      const policy = compute.getTemporaryEnvironmentPolicy?.();
      const profile = policy?.profiles.find((candidate) => candidate.id === record!.profileId);
      const decision = await deps.effect(() =>
        deps.iam.authorize({
          principalId: record!.servicePrincipalId,
          action: "operate",
          resource: { kind: "agent", id: record!.agentId, namespaceId: record!.namespaceId },
        }),
      );
      const identity = await deps.effect(() =>
        deps.iam.lookupIdentity({
          servicePrincipalId: record!.servicePrincipalId,
          namespaceId: record!.namespaceId,
        }),
      );
      const identityPresent =
        identity?.kind === "service_principal" &&
        identity.id === record.servicePrincipalId &&
        identity.namespaceId === record.namespaceId;
      if (
        !identityPresent ||
        revision?.compute.id !== compute.id ||
        revision.compute.implementation !== compute.implementation ||
        revision.servicePrincipalId !== record.servicePrincipalId ||
        decision?.allowed !== true ||
        decision.driverId !== deps.iam.id ||
        profile?.fingerprint !== record.profileFingerprint ||
        !profile.namespaceIds.includes(record.namespaceId) ||
        profile.cpuMillis !== record.cpuMillis ||
        profile.memoryMiB !== record.memoryMiB ||
        profile.lifetimeSeconds !== record.lifetimeSeconds ||
        profile.idleTimeoutSeconds !== record.idleTimeoutSeconds
      ) {
        record = await transition("delete");
        if (record === undefined) {
          throw new WorkClaimLostError();
        }
      }
    }
    if (record.state === "deleting") {
      // No IAM check gates disposal of resources whose authority has been withdrawn.
      if (compute.deleteTemporaryEnvironment === undefined) {
        throw new Error("Compute cleanup unavailable");
      }
      const deletion = await deps.effect((signal) =>
        compute.deleteTemporaryEnvironment!(record!, signal),
      );
      if (deletion.state === "absent") {
        record = await transition("confirmAbsent", undefined, "deleted");
        if (record === undefined) {
          throw new WorkClaimLostError();
        }
      }
    } else if (record.state !== "deleted") {
      if (
        compute.observeTemporaryEnvironment === undefined ||
        compute.createTemporaryEnvironment === undefined
      ) {
        throw new Error("Compute allocation unavailable");
      }
      let observation: TemporaryEnvironmentObservation;
      if (!record.allocationStarted) {
        const started = await transition("beginAllocation", undefined, "allocation_started");
        if (started === undefined) {
          throw new WorkClaimLostError();
        }
        record = started;
        // The durable single-winner marker commits before the external effect. Any uncertainty
        // thereafter is observation-only, even if a process dies before recording its receipt.
        observation = await deps.effect(async (signal) => {
          // Re-read after heartbeat: stop, teardown or expiry may have won since effect-start.
          const current = await transition("inspect");
          if (current === undefined) {
            throw new WorkClaimLostError();
          }
          if (current.state !== "provisioning") {
            return { state: "pending" };
          }
          const decision = await deps.iam.authorize({
            principalId: current.servicePrincipalId,
            action: "operate",
            resource: { kind: "agent", id: current.agentId, namespaceId: current.namespaceId },
          });
          if (decision?.allowed !== true || decision.driverId !== deps.iam.id) {
            await transition("delete");
            return { state: "pending" };
          }
          return compute.createTemporaryEnvironment!(current, signal);
        });
      } else {
        observation = await deps.effect((signal) =>
          compute.observeTemporaryEnvironment!(record!, signal),
        );
      }
      record = await transition(
        "inspect",
        observation,
        record.state !== "ready" && observation.state === "ready" ? "ready" : undefined,
      );
      if (record === undefined) {
        throw new WorkClaimLostError();
      }
      if (observation.state === "absent") {
        // Absence after an allocation attempt is never permission to allocate again.
        record = await transition("delete");
        if (record === undefined) {
          throw new WorkClaimLostError();
        }
      }
      if (record.state === "ready") {
        delayMs = Math.max(
          1,
          Math.min(
            30_000,
            Date.parse(record.idleExpiresAt) - Date.now(),
            Date.parse(record.hardExpiresAt) - Date.now(),
          ),
        );
        code = "TEMPORARY_ENVIRONMENT_READY";
      }
    }
  } catch (error) {
    if (error instanceof WorkClaimLostError) {
      throw error;
    }
    // Driver errors cannot establish absence. Keep quota, receipt, and the cleanup obligation.
    code = "TEMPORARY_ENVIRONMENT_DEPENDENCY_UNAVAILABLE";
  }
  return deps.state.transactWithQueue(async (unit, queue) => {
    // Lock the owner before the queue claim, matching reservation and lifecycle transitions.
    const record = await unit.temporaryEnvironments.reconcile(claim, id, "inspect");
    if (record === undefined) {
      throw new WorkClaimLostError();
    }
    if (record.state === "deleted") {
      await queue.complete(claim, { code: "TEMPORARY_ENVIRONMENT_DELETED" });
      return "success";
    }
    await queue.defer(claim, { code }, { delayMs: record.state === "deleting" ? 1000 : delayMs });
    return code === "TEMPORARY_ENVIRONMENT_DEPENDENCY_UNAVAILABLE" ? "retry" : "pending";
  });
}
