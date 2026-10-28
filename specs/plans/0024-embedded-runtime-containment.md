---
rfc: ../rfcs/0024-embedded-runtime-containment.md
---

# Gateway egress in embedded OpenClaw

- **ID:** RFC-0024 implementation plan
- **Status:** In progress — native launch and Gateway egress unverified
- **Created:** 2026-10-28
- **Source base:** `openclaw/openclaw-enterprise` at `4837711993d6196c95f9264faf577fc93a2ae6af`.

## Outcome and scope

Make a Gateway-owned channel/plugin/integration request cross configurable OpenShell network policy through normal embedded Agent deployment. The [RFC](../rfcs/0024-embedded-runtime-containment.md) explains the concrete Slack `auth.test` example, process/Pod placement, credential locations and unchanged dedicated topology. The example is not an executed test.

Contain the combined Gateway/Harness application; keep embedded execution and native model authentication. Reuse existing OpenShell supervision, proxying and service exposure. An initially permissive compatibility policy is acceptable. Do not create a general workload provisioner, add another proxy, select credential rewriting/TLS interception, relocate a dedicated Gateway, or change dedicated Harness behavior. Keep the PR draft and unmerged.

## Owners and implementation order

### 1. Describe the OpenClaw application launch

**Owners:** Sandbox contract, Kubernetes Compute, OpenShell Sandbox Driver.

Replace the Pod-template-shaped draft with the inputs needed by the existing OCE Gateway supervisor: selected image/command, admitted native configuration/plugin inputs, private Secret references, approved persistent workspace/private state, process identity, resource bounds, service exposure and application readiness. The caller is Compute's normal Agent revision preparation, not an arbitrary-workload API.

Use OpenShell's canonical command for the long-lived runtime. Preserve startup ordering, protected Gateway-owner initialization, immutable inputs and requested identity. Do not disable owner checks or claim that same-UID chmod makes a file immutable. Reject genuinely unsupported requested identity before acquiring provider authority. Map supported initialization/storage to the application requirement; an unbounded PVC directory does not replace a storage bound.

**Proof:** review the connected caller and focused contract/startup checks; real API/worker deployment must start embedded OpenClaw without a separate application Gateway or dedicated Harness. No uncalled launcher or provider refusal counts as delivery.

### 2. Deliver actual native credentials and configuration

**Owners:** existing Agent Secret authorization/delivery and the OpenShell adapter.

Authorize only the selected Agent's model, Gateway, channel and integration material. Keep native environment/auth-file formats and the selected model endpoint. Separate private material from public configuration and plugin inputs. Use supported private delivery, such as fixed ExecSandbox stdin with the existing 400,000-byte cap, revision/generation checks and acknowledged installation before application code starts. Handle a lost acknowledgment without conflicting writes or secret output.

Model credentials belong in the combined runtime, not an inference-provider binding, proxy Pod or published Sandbox spec. Preserve embedded code's existing shared credential trust domain; do not claim Gateway/Harness credential separation.

**Proof:** native authentication succeeds with the actual authorized model credential; withdrawn/mismatched/oversized material fails safely. Inspect specs, arguments, status and redacted evidence for disclosure. Channel/integration credential admission must not silently select the dedicated channel proxy.

### 3. Connect Gateway ingress and outbound enforcement

**Owners:** Compute ingress/activation and OpenShell service/network operations.

Keep existing authenticated OCE ingress, but send it through OpenShell's HTTP/WebSocket service exposure to the Gateway's loopback listener. Direct workload-Pod Service selection is not valid. Preserve TLS identity, HTTP Host/origin behavior, native WebSocket authentication and real application readiness. Keep the exposure private to trusted ingress/observation callers or enforce equivalent native authentication; a caller-supplied trusted-proxy identity header is not authority.

Reuse OpenShell executable/destination policy and its separate supervisor/proxy Pod for Gateway outbound connections. Kubernetes NetworkPolicies retain outer isolation without direct-egress bypass. TLS passthrough must preserve application verification and admitted trust settings, not inherit injected interception trust. Do not grant a separate Harness access and label that Gateway coverage.

**Proof:** a Gateway-owned request reaches its approved destination and appears in OpenShell network evidence; policy denial prevents that request. Provider Ready metadata, model traffic or a tool-process fetch alone is insufficient. Test the public/native access path as well as internal observation.

### 4. Preserve the normal Agent lifecycle

**Owners:** OCC worker and Compute/Sandbox cleanup coordination.

Stop the previous combined runtime before a successor writes shared state or starts channel consumers. Activate only after ownership, native authentication and application readiness. On failure, retain attributable evidence without exposing secrets. Stop removes ingress and the canonical runtime; deletion removes owned provider resources and Agent storage in the existing order. Preserve dedicated execution and embedded Agents that do not select this placement.

**Proof:** normal API/worker checks cover workspace/private-state continuity, replacement exclusivity, failed startup, stop and deletion. Retries adopt only matching owned resources; they must not create competing writers or mutate provider Pods outside their owner.

### 5. Extend and run selected acceptance

**Owners:** existing `embedded-containment` QA helper and real OpenShell/Kubernetes fixture.

The selected scenario is opt-in, excluded from default QA/OpenShell execution. Extend its model/tool/lifecycle assertions with a Gateway-owned plugin/channel/integration request, matching destination receipt and OpenShell allow/deny evidence. Use supported admission and runtime loading, not a manually started Sandbox, fake model, copied fixture logic or tool-only probe. External channel checks require an approved account/destination; the illustrative Slack request does not authorize posting messages.

Required acceptance must pass without skips. Keep missing infrastructure/credentials, implementation failures and successful source checks distinct. Update the owning flow/reference/testing pages and PR with actual commands, revision, images and outcomes after implementation settles.

## Current evidence and substantive blockers

- RFC submitted for review; decision remains Proposed. Sandbox/Compute coordination and a selected real-Agent scenario are drafted. The published adapter still refuses embedded placement.
- Native private startup, protected owner initialization, authenticated provider-service ingress and native channel admission are unfinished. Compute also requests separate 1 GiB runtime-state and 64 MiB temporary volumes. The reviewed provider configuration supports PVC mounts and aggregate container resources, not separate mount capacities; confined application code cannot add mounts. A qualified capacity-enforced storage mapping or constrained provider mount capability needs a design decision. PVC requested size alone does not prove its maximum capacity. This unresolved mapping is not evidence that Gateway egress is impossible or a provider upgrade mandatory.
- The selected scenario now asserts a native Gateway cron webhook, destination receipts and OpenShell allow/deny evidence before and after Agent grant revocation. Its command child only prints a nonce; native Gateway delivery performs HTTP. Correlation uses the native job ID/start time, revision and applied-policy operation. These assertions have not run against OpenShell. Receiver smoke checks and prerequisite regression checks are not Gateway-egress proof. Historical source evidence at `231cb7125328014c8672ae68ca1f53629016c071` recorded 570 regression passes, zero failures/skips; it is not current-head deployment proof.
- The task has Docker/k3d but no selected prepared OpenShell stack, PostgreSQL connection, approved runtime images or authorized native model/model credential. Prepare only disposable owned infrastructure; the credential/model must come from its authorized owner. Do not reuse unrelated provider credentials or substitute a fake model.
- Documentation checks are blocked by missing docs-site `@sindresorhus/slugify`. Do not install dependencies as a verification side effect. Record available formatting/link/structure checks separately.

## Change record

- 2026-10-28: Scope the delivery to Gateway-owned outbound requests in embedded mode; name native launch, ingress, credential and acceptance owners. Source `525310dbc6823e16fb5d8b9c16fcca3706acffe7`; authoring run `f7158b2f-3ad7-49d8-8c00-f5b5806013d0`.
