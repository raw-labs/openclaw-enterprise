---
rfc: ../rfcs/0024-embedded-runtime-containment.md
---

# Gateway egress in embedded OpenClaw

- **ID:** RFC-0024 implementation plan
- **Status:** In progress — native launch and Gateway egress not implemented
- **Created:** 2026-10-28
- **Source base:** upstream `openclaw/openclaw-enterprise` at `4837711993d6196c95f9264faf577fc93a2ae6af`.

## Outcome

Deliver the [Gateway egress proposal](../rfcs/0024-embedded-runtime-containment.md) through normal Agent deployment. Keep embedded execution and existing model authentication. Gateway plugin, channel and integration traffic must use OpenShell's existing network enforcement. Keep the PR draft and unmerged.

## Delivery gates

- [x] Submit RFC-0024 for human review. The active proposal is not an accepted decision.
- [x] Draft generic Sandbox/Compute coordination and register a selected real-Agent scenario. Neither establishes a native launch or Gateway integration request.
- [x] Reassess pinned OpenShell's canonical command, private exec stdin, PVC mounts, loopback confinement and HTTP/WebSocket exposure against application requirements.
- [ ] Replace the Pod-template-shaped launch contract with application inputs and explicit behavioral/security requirements.
- [ ] Implement native startup and private credential delivery in the OpenShell adapter, using the existing Gateway supervisor and native authentication. Preserve authorized Secret custody, protected Gateway-owner initialization, admitted trust settings, state persistence and enforced resource bounds.
- [ ] Connect existing authenticated Gateway ingress to the provider service exposure. The current Pod selector cannot reach a loopback-confined application. Preserve TLS/Host handling and prevent direct exposure from bypassing trusted-proxy identity authorization.
- [ ] Implement native channel/integration credentials and egress without selecting the dedicated channel proxy.
- [ ] Extend selected real-Agent acceptance with a Gateway-owned plugin/integration outbound request and OpenShell network evidence. A tool command or model turn is not this proof.
- [ ] Verify model authentication, native Gateway operation, state continuity, replacement, failure, stop and deletion through the real API and worker.

## Provider findings and implementation gaps

The pinned provider is OpenShell v0.1.5 at `bdb956f2cd65a635f1294fccf1d138d263bf650f`. It accepts a canonical workload command, private exec stdin and approved PVC mounts. Lack of arbitrary init-container and `emptyDir` pass-through prevents a verbatim Pod conversion, not necessarily the requested Gateway egress.

Map each existing startup/volume requirement to its purpose before changing its representation: private file ownership, protected signing material, exact admitted application inputs, bounded writable scratch, persistent state and startup ordering. A sequential trusted bootstrap can replace an initializer only if it preserves those properties. Private stdin is a delivery mechanism, not an implemented native-auth path. Aggregate ephemeral-storage limits do not automatically bound a PVC directory. Unsupported requested ServicePrincipal identity still requires explicit refusal.

The current adapter always refuses embedded placement. Its generic Compute branch also assumes direct Pod-Service ingress and the original Kubernetes readiness probe. These are unfinished integration choices, not unavoidable provider limitations. No reviewed source establishes that an OpenShell extension or version upgrade is mandatory for Gateway egress.

Use the provider's HTTP/WebSocket service exposure, not a new proxy or detached exec. The exposure is not proof of application authentication; preserve the trusted ingress boundary. Keep permissive outbound policy separate from ingress authorization. Do not change model endpoints, credential semantics or application TLS trust to make a test pass.

## Verification prerequisites

The rechecked host has Docker and k3d but no running Docker workloads or k3d cluster. The task environment has no selected prepared OpenShell environment, database URL, approved Gateway image, native model selection or native model key. These are missing acceptance inputs, not evidence of provider incompatibility. Do not reuse unrelated runtime or model-provider credentials.

Use disposable Linux Kubernetes/OpenShell infrastructure, real PostgreSQL and worker, approved immutable images and an authorized native model credential. Infrastructure can be prepared within that disposable scope; a real native credential/model selection must be supplied or explicitly selected by its owner. Do not substitute a fake model, compatibility bridge or manually launched Sandbox for ordinary Agent acceptance.

## Evidence

Source at `231cb7125328014c8672ae68ca1f53629016c071` passed TypeScript, ESLint, workspace boundaries, CI registration and a focused six-file run with 570 passes, zero failures/skips. This is historical contract/regression evidence, not current-head validation, Gateway egress or a successful deployment. The selected `embedded-containment` scenario remains unexecuted and does not yet include the required Gateway integration request.

This revision refreshes against upstream `4837711993d6196c95f9264faf577fc93a2ae6af` by merge, preserving published history. Record current-head checks in the PR. Documentation-site checks require missing `@sindresorhus/slugify`; do not install dependencies as a verification side effect.
