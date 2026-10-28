---
rfc: ../rfcs/0024-dedicated-gateway-containment.md
---

# Implementation plan: Dedicated Gateway containment

- **ID:** RFC-0024
- **Delivery status:** In progress
- **Authority:** [Gateway containment RFC](../rfcs/0024-dedicated-gateway-containment.md)
- **Source baseline:** `33c47d4099ec27d7c73abe50137a95cdf6abdecd`

## Outcome and scope

Normal OCE Agent deployment can run its dedicated Gateway inside the selected
Sandbox while keeping the dedicated Harness separate. OpenShell is the first
implementation. The experiment reuses existing containment and outbound proxy
primitives without introducing credential rewriting or TLS interception.

The RFC owns requirements and alternatives. This plan owns implementation order
and verification evidence; incomplete runtime proof keeps delivery in progress.

## Contract and source touchpoints

- `packages/contracts/src/index.ts`: separate Gateway containment from
  `provisionHarness`; define workload and destination inputs.
- `apps/controller/src/drivers/compute/kubernetes/index.ts`: apply the selected
  containment capability to the ordinary Gateway workload, preserving routing,
  private state, readiness and lifecycle.
- `apps/controller/src/drivers/sandbox/`: implement OpenShell supervisor and
  network-policy translation behind the Sandbox contract.
- `apps/controller/src/drivers/channel/slack.ts`: contribute channel destinations
  through the channel interface, not an OpenShell-specific core branch.
- Installation composition: explicitly select Gateway containment without
  selecting a different Harness placement or credential path.
- Existing Agent integration boundaries: prove real admission, deployment,
  replacement and cleanup rather than direct calls to unused helpers.

## Implementation

1. Extend the generic Sandbox/Compute integration and opt-in configuration.
   Validate unsupported selections before any uncontained launch.
2. Wrap the ordinary Gateway workload in OpenShell containment. Preserve the
   image, configuration, mounts, init steps, Secrets, probes and resource limits.
   Reuse the existing supervisor network proxy; do not add a forwarder.
3. Collect enabled channels' destination requirements. Keep compatibility
   network access explicit and distinct from credential operations.
4. Cover the normal provisioning and lifecycle path with meaningful integration
   assertions, including failure without an uncontained fallback.
5. Update the owning Sandbox, Compute and Channel references, architectural
   status, operator setup and source-backed runtime flow.
6. Register and execute the Linux QA scenario through normal Agent deployment.
   Inspect actual process containment, connectivity, credential custody,
   persistent state, replacement, stop and delete.

## Verification

| Required outcome | Check | Result or remaining proof |
| --- | --- | --- |
| Generic selected capability reaches normal Gateway deployment | Compute/controller integration | Pending implementation |
| Harness placement/auth/model custody unchanged | Normal Agent deployment and workload inspection | Not run |
| Real full containment rather than proxy attachment | Linux supervisor, process/filesystem and runtime inspection | Not run |
| Native outbound HTTPS and long-lived transport work | Real contained Gateway traffic | Not run |
| Enabled channels contribute destinations | Driver/Compute integration; live channel separately | Not run |
| Private state survives replacement | Real Agent redeploy/restart | Not run |
| Failure cannot activate an uncontained fallback | Failure integration and real runtime negative control | Not run |
| Stop/delete remove owned resources | Real Agent lifecycle | Not run |
| Source/doc checks | Workspace, formatting, types, lint, docs, spec/flow validation | Pending |

### Current Linux prerequisites

Read-only preflight on October 28, 2026 found Node 24, Docker and the pinned pnpm
available, but no project dependencies, Go, k3d, kubectl, Helm, built CLI,
OpenShell/runtime images or model credentials. There is no disposable cluster
or prepared database. No deployment or model/channel proof has run.

Prepare an isolated environment with the repository's documented tooling and
approved immutable runtime images. Supply existing authorized model credentials
through protected files, never command arguments or logs. Live Slack requires
separately authorized Slack credentials and a test channel. Preserve default
kubeconfig and unrelated infrastructure; remove only run-owned resources.

The existing OpenShell Harness suite is not proof of this feature: it changes
Harness placement and model delivery. The new scenario must retain the ordinary
dedicated Harness while containing the Gateway independently.

## Delivery record

- 2026-10-28: Allocated RFC-0024 from current upstream and began independent
  Gateway containment implementation. Linux preflight identified the missing
  prerequisites above. No runtime success is claimed.

## Changelog

- 2026-10-28: Created the standalone delivery plan from upstream
  `33c47d4099ec27d7c73abe50137a95cdf6abdecd`.
