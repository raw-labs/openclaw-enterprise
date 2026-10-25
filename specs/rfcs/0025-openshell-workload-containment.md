---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: contain Gateway and embedded workloads with OpenShell

- **ID:** RFC-0025
- **Created:** 2026-10-25
- **Implementation plan:** [Experimental delivery](../plans/0025-openshell-workload-containment.md)
- **Related:** [Gateway outbound policy](0024-gateway-outbound.md), [Sandbox contract](../../docs/reference/drivers/sandbox.md)

## Decision and experiment boundary

Extend the existing Sandbox/Compute composition so an explicitly selected Sandbox
can contain a dedicated Agent Gateway or the combined embedded OpenClaw workload.
OpenClaw Control Plane (OCC) retains admission, identities, immutable revisions,
policy authority, routing, and lifecycle. OpenShell supplies the execution
boundary. This is a fork-only experiment, not production qualification.

The comparison base includes RFC-0024's outbound selection and authorization.
Retain its transport when the experiment is not selected. Reuse its admitted
destination intent rather than adding another per-Agent permission system.
Existing PR branches and upstream repositories remain unchanged.

## Problem and workload roles

Dedicated execution separates the Harness but leaves executable Gateway
integrations outside its OpenShell boundary. A proxy can permit HTTPS without
containing local filesystem or process effects. Embedded OpenClaw combines those
roles and currently has broader external connectivity.

| Mode              | Contained payload                          | Policy consequence                                                                |
| ----------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| Dedicated Codex   | Gateway Sandbox; separate Harness retained | Gateway destination grants do not grant Harness access.                           |
| Embedded OpenClaw | Combined Gateway/Harness Sandbox           | Model-directed subprocesses and integrations share the effective workload policy. |

## Contract and lifecycle

Add an optional application-workload capability to the generic Sandbox contract.
Its inputs describe role, image, command, approved environment references,
configuration, private storage, resource limits, and application ports. Do not
pretend a Gateway is a Harness or introduce OpenShell-specific branches in OCC.

Kubernetes Compute calls this capability from normal Agent deployment. It
prepares exact-owner storage and configuration, waits for application readiness,
activates routing, and stops the exact previous workload before releasing its
resources. Provider identities include role and revision to avoid Harness
collisions. Adoption must verify both. Supervisor readiness alone is insufficient.

An application frontend may be required because OpenShell exposes services
through its supervisor. Its target is fixed by admitted provider output. It has
no integration or model credentials and cannot turn caller URLs or Host headers
into management requests. It preserves existing authenticated routing.

## Configurable restrictions

The operator selects the experimental placement and supported baseline filesystem,
process, and resource settings. Per-Agent outbound admission grants additional
destinations within the Installation ceiling. The first qualification targets
restricted named hosts, not arbitrary-public-host parity. Infrastructure
exclusions remain mandatory; the payload cannot widen its own policy.

Network access requires a generated runtime requirement or an admitted rule.
Native clients retain end-to-end TLS. Embedded agent HTTP requests to unapproved
hosts must fail. Runtime files and managed configuration are read-only. Only
private state, the approved workspace, and bounded temporary storage are writable.
Dedicated Gateway and Harness storage stay separate. Retain nonroot execution,
no privilege escalation, kernel enforcement, and resource limits. Ordinary
subprocesses remain allowed inside the boundary; per-command authorization is
outside this experiment.

## Private projection and recovery

The selected OpenShell release accepts PVC projections but not ordinary Secret
environment references or ConfigMap mounts. Its managed provider files are
nonsecret. Never put credential bytes in Sandbox specs, provider configuration,
image layers, logs, or command arguments.

The adapter needs private, exact-revision delivery. A staging Job can materialize
admitted Secret references and configuration on a private revision volume mounted
read-only into the payload. It has no network or Kubernetes API credentials and
cannot access unrelated bindings. Do not share a writable bootstrap directory
with serving payloads. Delete delivery material only after payload termination;
persistent application state retains its Agent-owned lifetime.

Preserve required identity and secure routing or refuse admission. Shared
ServiceAccounts and development service listeners do not establish production
support. Missing projections, unavailable enforcement, and conflicting ownership
fail closed. Retry must not rewrite active material. Stop, replacement,
withdrawal, and deletion must close established access without removing a
successor's resources. Preserve existing IAM and attributable audit checks.

## Required verification

Use the real Agent API/worker, selected images, and an owned disposable Kubernetes
cluster with enforcing NetworkPolicies and the selected OpenShell release.

1. Dedicated Codex and embedded OpenClaw complete real model turns and preserve
   state across replacement.
2. Gateway ClawHub requests return actual remote results after a destination
   grant and fail without it. Bundled fallback results are not a pass. Installation
   and remote-workspace compatibility are separate outcomes.
3. Direct sockets and unapproved destinations fail. Dedicated Harness grants do
   not grow with Gateway grants. Embedded subprocesses obey the combined policy.
4. Forbidden filesystem operations fail while permitted writes succeed. Include
   native process-boundary evidence.
5. Restart, replacement, withdrawal, and cleanup preserve exact ownership.

Record missing infrastructure or runtime support as a gap, not mock proof. The
plan owns execution details and results.

## Alternatives and limits

RFC-0024's proxy is sufficient for destination control with less integration cost.
A standalone OpenShell proxy reuses forwarding code but adds no workload boundary.
Individual integration isolation is a different project. Code inside this Gateway
still shares readable state and permitted authority; a compromised Gateway can
misuse its own Agent's allowed operations.
