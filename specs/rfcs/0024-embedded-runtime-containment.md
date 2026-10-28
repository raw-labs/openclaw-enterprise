---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: contain embedded OpenClaw through Sandbox and Compute

- **ID:** RFC-0024
- **Created:** 2026-10-28
- **Implementation plan:** [Embedded runtime containment](../plans/0024-embedded-runtime-containment.md)

## Summary

Run the combined embedded OpenClaw Gateway and Harness in one OpenShell-managed Sandbox. OpenClaw Enterprise (OCE) selects this placement through its existing Sandbox and Compute capabilities. The Agent remains in embedded execution mode; there is no additional Gateway or dedicated Harness deployment.

This is an independent experimental proposal against upstream commit `33c47d4099ec27d7c73abe50137a95cdf6abdecd`. It is not production qualification. Extend the [Sandbox contract](../../docs/reference/drivers/sandbox.md) to accept a complete embedded runtime and reuse the [Compute lifecycle](../../docs/reference/drivers/compute.md), rather than duplicate a sandbox or network proxy in the control plane.

## Motivation

Kubernetes Compute currently owns embedded Gateway Pods. Its optional Sandbox Driver provisions only dedicated Harnesses, leaving the Gateway outside that containment boundary. Channels, plugins, model clients and tools in an embedded process tree therefore cannot share the Sandbox outbound controls.

Containing that whole process tree reuses existing infrastructure owners. The placement must preserve the normal Agent workflow, not merely demonstrate a manually started process in a Sandbox.

## Goals

- Provision embedded OpenClaw through the normal Agent API and worker.
- Preserve model execution, native channels, plugins, integrations, workspace, private state, startup, replacement, stop and deletion.
- Apply OpenShell network controls to both Gateway and embedded execution traffic.
- Start with a compatibility-oriented policy that operators can restrict later.
- Preserve existing model and channel credential semantics. Do not introduce credential substitution or TLS interception as a consequence of containment.

## Non-goals

Do not split Gateway and Harness credentials, add another execution resource, replace the Credential Proxy, or change the Agent to dedicated execution. Permissive outbound access does not protect against exfiltration. This proposal does not promote the experimental OpenShell deployment into a production profile.

## Proposal

### Placement and ownership

The Sandbox Driver exposes an optional embedded-runtime capability with actual provisioning, ownership observation and Pod-selection operations. Admission refuses embedded placement if the selected Driver cannot supply that capability. The platform core depends on this contract, not OpenShell implementation names.

Kubernetes Compute renders the ordinary embedded Gateway workload, including its existing entrypoint, native configuration, plugin material, environment, workspace and private-state mounts. It passes those requirements to Sandbox. The Sandbox must preserve every requirement or refuse before provisioning. Unsupported identity projections must not silently disappear.

OpenShell implements the capability through its existing Gateway, Workspace, Sandbox API, supervisor, filesystem/process policy, private runtime-material delivery and Kubernetes volume configuration. Reuse revision-scoped resource naming and adoption checks. Do not introduce a second proxy or sandbox implementation.

Compute still owns the Agent ingress Service and route, activation decision, persistent claims and lifecycle hooks. Its Service selects only provider Pods whose Sandbox ownership has been independently validated for that Agent revision. Neither a dedicated Gateway Deployment nor a dedicated Harness is created. OpenShell owns the combined process tree and outbound enforcement.

### Policy

Model/tool and Gateway traffic cross the same OpenShell supervisor network boundary. The initial experimental Installation can grant broad outbound destinations and the binaries needed by its runtime. This establishes process and filesystem containment without claiming destination restriction. Operator-selected rules remain the restriction surface.

Use passthrough TLS for this placement: authorize connections without terminating application TLS. Preserve certificate and hostname verification in OpenClaw. Do not generate certificate authorities, alter provider base URLs, rewrite model credentials or install TLS interception because Sandbox was selected. Existing explicitly selected credential integrations retain their own contracts; this proposal does not implicitly select them.

A restrictive policy must include destinations used by model clients, channels, plugins, integrations and tool subprocesses. Configuration is not proof that every dynamic destination is known. Initially favor compatibility, report denials through existing Sandbox logs, and restrict only with workflow coverage. An allow rule for one executable is not general tool compatibility.

Kubernetes NetworkPolicies remain outer tenant isolation. Compute must not accidentally restore ordinary direct-egress grants to provider-fenced Pods. Ingress permits the existing authenticated Gateway path; it does not expose OpenShell management authority to Agent code.

### Credentials and trust

Embedded execution already places Gateway, channel and model credentials in one runtime trust domain. A plugin or tool that can read that runtime material remains in that domain. Containment limits effects outside the Sandbox; it does not separate credentials from code inside it.

Keep Agent-owned Secret authorization and delivery. The normal Gateway password, model authentication, channel Secrets and integration bindings remain unchanged from the application perspective. Private material delivery must distinguish secret bytes from nonsecret configuration and avoid values in Sandbox specifications, logs, status or published evidence. Secret references are not authority to read another Namespace.

OpenShell v0.1.5 cannot preserve an arbitrary projected workload identity. Refuse that request explicitly rather than run with a weaker identity or attach controller credentials. Unsupported credential-source/protected-egress profiles must likewise fail at admission, not silently select another model path.

### State and lifecycle

Compute retains Agent-owned persistent workspace and Gateway-private state. OpenShell mounts the approved claims and subpaths; it must not replace them with revision-local ephemeral storage. Native configuration and plugin files are immutable revision inputs. Application state remains writable only in approved private paths.

1. The normal API authorizes the Agent and referenced configuration and Secrets, freezes the revision and queues worker deployment.
2. Compute prepares tenant isolation, claims and private startup material, then asks Sandbox to provision the entire rendered embedded workload.
3. Sandbox validates placement, materials and ownership, then creates or verifies the revision OpenShell resource. Reconciliation adopts only an identical resource with matching Agent and revision identity.
4. Compute waits for provider and authenticated runtime readiness. It must not activate merely because a Sandbox exists. Startup failure evidence remains attributable to the deployment; unknown provider state remains pending.
5. Compute selects verified provider Pods on the existing Gateway Service. Normal Agent requests, workspace operations and native execution continue through that path.
6. Replacement stops the previous combined runtime before a successor writes shared state or starts channel consumers. Retain private state and workspace. Retirement of a predecessor must not remove successor ingress or provider resources.
7. Stop removes the serving path and contained process tree. Cleanup confirms termination before removing revision material. Agent deletion removes owned persistent state through Compute cleanup. Namespace cleanup cannot finish while owned Sandboxes remain.

Cancellation, partial creation and provider outages remain retryable under existing work claims. Cleanup uses the stored revision Driver and resource identity, never a caller-supplied Sandbox name. A missing or ambiguous resource cannot be adopted or declared absent without provider ownership checks.

## Delivery and verification

See the [implementation plan](../plans/0024-embedded-runtime-containment.md). Keep this PR a draft and do not merge it. Source and unit/contract checks are not evidence of a working Linux deployment.

Acceptance requires real Linux Kubernetes and OpenShell through normal OCE Agent provisioning/deployment and the worker. Demonstrate an actual model/tool turn, channel/plugin/integration compatibility, workspace and private-state continuity after replacement, failure handling, stop and deletion. Inspect provider resources and Kubernetes workloads to establish that the combined runtime is contained and dedicated execution was not substituted.

Use authorized model credentials and immutable runtime/controller images. Do not replace missing prerequisites with fake model or Sandbox results. Record commands, revision, environment, passed/failed/skipped cases and gaps. Live channel posting also requires an approved test destination and credentials.

At proposal submission, this Linux host lacks a prepared Kubernetes/OpenShell stack, model credential, built images and installed JavaScript dependencies. Rootless Docker is available but its required isolation behavior is unverified. Live verification remains blocked; the plan tracks that requirement.

## Rationale and alternatives

**Contain the whole embedded runtime (recommended).** Reuse existing primitives and apply one outbound boundary to Gateway and model/tool traffic. Preserve embedded compatibility at the cost of sharing its credential domain.

**Wrap only the Gateway with the Credential Proxy.** Express outbound authorization where the proxy protocol covers traffic, but this alone does not supply filesystem/process containment or govern arbitrary embedded tool traffic. Reuse it when its credential contract is selected; do not add interception just to make it a placement prerequisite.

**Separate Gateway and Harness.** Permit a different credential boundary, but change execution topology and miss the embedded-runtime goal.

**Add a Gateway-specific sandbox/proxy.** Duplicate capability owners and lifecycle. Reject this alternative for the experiment.

## References

- [Platform architecture](../../docs/design.md)
- [OpenShell implementation](../../docs/reference/drivers/openshell-sandbox.md)
- [Reviewer guidance on primitive reuse](https://github.com/openclaw/openclaw-enterprise/pull/3520#issuecomment-6425774660)
- [Reviewer guidance on proxy authorization](https://github.com/openclaw/openclaw-enterprise/pull/3520#issuecomment-6431170986)
