import type { SandboxEmbeddedRuntimeRequirements } from "@openclaw-enterprise/contracts";

/**
 * OpenShell v0.1.5 driver_config admits only PVC-backed volumes, scheduling and
 * Agent resources. It rejects emptyDir, Secret projection and init containers.
 * Private ExecSandbox stdin can carry bytes, but cannot supply those boundaries.
 * TODO(openshell-embedded-runtime): qualify a provider path that preserves the complete
 * rendered workload before replacing these refusals with provisioning and Pod selection.
 */
export function openShellEmbeddedRuntimeRefusal(
  requirements?: SandboxEmbeddedRuntimeRequirements,
): string {
  if (requirements?.workloadIdentity !== undefined) {
    return "OpenShell v0.1.5 cannot preserve the embedded runtime ServiceAccount and projected identity token.";
  }
  if ((requirements?.ephemeralVolumes.length ?? 0) > 0) {
    return "OpenShell v0.1.5 cannot preserve the embedded runtime's bounded Pod-local volumes: driver_config supports PVC-backed volumes only. Aggregate ephemeral-storage limits are not per-volume bounds.";
  }
  if ((requirements?.initializers.length ?? 0) > 0) {
    return "OpenShell v0.1.5 cannot preserve the embedded runtime's initializer container image, mount and security boundaries through driver_config. ExecSandbox startup commands are not equivalent init containers.";
  }
  if ((requirements?.secretVolumes.length ?? 0) > 0) {
    return "OpenShell v0.1.5 cannot preserve the embedded runtime's projected Secret volumes through driver_config. Private stdin delivery does not establish read-only Secret mount semantics.";
  }
  if ((requirements?.mountedFiles.length ?? 0) > 0) {
    return "OpenShell v0.1.5 has no qualified exact read-only mounted-file delivery for the combined embedded runtime.";
  }
  // Omitting unsupported fields must not accidentally qualify a reduced or malformed
  // workload. There is no supported embedded provisioning path in the pinned provider.
  return "OpenShell v0.1.5 embedded runtime placement is not qualified: complete bounded Pod-local storage, initializer and private material delivery must be preserved before provisioning.";
}
