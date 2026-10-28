---
rfc: ../rfcs/0024-embedded-runtime-containment.md
---

# Embedded runtime containment implementation

- **ID:** RFC-0024 implementation plan
- **Status:** In progress
- **Created:** 2026-10-28
- **Source base:** upstream `33c47d4099ec27d7c73abe50137a95cdf6abdecd`

## Outcome

Implement the [embedded placement proposal](../rfcs/0024-embedded-runtime-containment.md) through the normal Agent lifecycle. Keep the independent PR a draft and unmerged. This plan does not record acceptance of the Driver contract.

## Delivery

- [ ] Submit the contract proposal for human review before implementation.
- [ ] Extend Sandbox contract and generic admission for embedded runtime placement.
- [ ] Connect Kubernetes Compute preparation, readiness, ingress activation, replacement, stop, retirement and Namespace cleanup to that contract.
- [ ] Implement OpenShell placement using existing provider and Sandbox owners. Preserve actual credentials, passthrough TLS, approved volumes and startup.
- [ ] Update current contract, implementation reference and source-backed flow.
- [ ] Extend normal real-Agent integration coverage and register a selected QA case.
- [ ] Run source checks and required Linux real-runtime integration without skips.
- [ ] Publish implementation and explicit proof limits in the draft PR.

## Verification and prerequisites

Use disposable Linux Kubernetes/OpenShell infrastructure, real PostgreSQL and worker, approved immutable images, and an authorized native model credential. Normal provisioning and authenticated Gateway calls must prove embedded execution, model/tool behavior, workspace/private-state continuity, replacement, failure handling and owned-resource cleanup.

Channel/plugin/integration compatibility needs actual workflow inputs; a permissive policy is not proof. Do not substitute a manually launched Sandbox process or fake provider/model.

Host preflight found no JavaScript dependencies, CLI build, k3d, kubectl, Helm, Go, prepared database/cluster, OCE/OpenShell images or model credential. Rootless Docker works, but required OpenShell isolation is unproven. These prerequisites block live verification. Dependency installation or reconciliation is not an implicit verification step. Keep the live milestone open.

## Change record

- 2026-10-28: Initial independent proposal against upstream commit `33c47d4099ec27d7c73abe50137a95cdf6abdecd`.
