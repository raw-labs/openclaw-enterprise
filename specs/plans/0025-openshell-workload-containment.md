---
rfc: ../rfcs/0025-openshell-workload-containment.md
---

# Implementation plan: experimental OpenShell workload containment

- **ID:** RFC-0025
- **Delivery status:** Experimental implementation; qualification incomplete
- **Source baseline:** `17340527e83e97f5bfa77220cb7f04ee6124bb65`

## Outcome and scope

Implement the [proposed workload boundary](../rfcs/0025-openshell-workload-containment.md)
in one fork-only draft PR. Its comparison base includes the outbound policy/API
proposal. Leave fork main, existing PR heads, and upstream unchanged. Support
dedicated Codex and embedded OpenClaw experimentally; preserve ordinary placement.

## Implementation

1. Submit the RFC in the draft PR before changing Driver contracts.
2. Extend Sandbox with role-specific application requirements, readiness,
   transport, and cleanup. Keep provider details in its adapter.
3. Integrate delegation into normal Compute deployment and activation. Preserve
   ordinary Kubernetes Codex Harness requirements in dedicated mode. Do not
   stack the application profile with OpenShell-owned Harness execution.
4. Deliver configuration and credentials privately, retain state ownership, and
   refuse unsupported identity requirements.
5. Compile admitted outbound intent into role-specific policy without widening
   Harness grants. Preserve runtime peers and Installation exclusions.
6. Update the current references, guide, source-backed flow, QA selection and CI.

## Verification

| Outcome                        | Real check                                                               | Status                              |
| ------------------------------ | ------------------------------------------------------------------------ | ----------------------------------- |
| Private delivery and lifecycle | Agent API/worker against Kubernetes/OpenShell                            | Not run                             |
| Dedicated behavior             | Codex turn and Gateway ClawHub deny/grant/allow                          | Not run                             |
| Embedded boundary              | OpenClaw turn and agent HTTP deny/grant/allow                            | Not run                             |
| Filesystem/process enforcement | Native fixture denial, permitted writes and subprocess control           | Fixture passed; real workflow unrun |
| Replacement and withdrawal     | Access closes; state and successor remain correct                        | Not run                             |
| Source integration             | Typecheck, lint, focused conformance, workspace and generated API checks | Passed within the scope below       |
| Documentation                  | Formatting, links, length, flow and specification checks                 | Passed                              |

Missing credentials or provider support blocks the corresponding proof, not the
integration requirement. Do not substitute a fake runtime or self-enforcing fixture.

## Delivery record

The initial document commit submits the RFC before implementation in fork draft
PR #21. Keep the RFC decision Proposed. Application placement uses the generic
Sandbox capability and a durable Compute admission fact; ordinary revisions are
not silently moved by an Installation change.

Local checks currently establish:

- Full source TypeScript build passes. Focused Compute, repository lifecycle,
  registration, frontend and policy checks report 548 passes and one existing
  optional skip. The new placement test includes unavailable-provider shutdown.
- OpenShell transport, TLS, OAuth and provider Harness checks report 88 passes
  without skips. Module policy and QA fixtures report 38 passes without skips.
  CI manifest audit, generated OpenAPI, lint, formatting, workspace isolation,
  documentation links/length/specification checks and the flow validator pass.
- The startup suite reports 112 passes, four failures and one optional skip.
  The two failing setup-wrapper cases and their parent failures reproduce on
  the unchanged comparison baseline; expected exit 2 is exit 1 on this host.
- PostgreSQL outbound persistence, migration upgrade/rollback, logical restore
  and provider continuation checks passed against disposable PostgreSQL 18.6.
  These prove persistence compatibility, not the new native Agent workflow.
- A disposable k3d cluster runs stock digest-pinned OpenShell v0.1.5. Its real
  NetworkPolicy check proves baseline connectivity, denial and exact-peer allow.
  Native application creation exposed reserved `/run` paths, omitted protobuf
  defaults and SDK deletion metadata requirements; the adapter now handles them.
  Native TCP admission also rejected an L7-only enforcement field; the compiler
  now emits connection-level rules without it.

The supplemental native fixture observes tokenless/forged-token refusal,
authenticated access, private environment delivery, actual nonroot identity,
prepared configuration, writable temporary storage and a forbidden filesystem
read. A same-image unconfined control permits that read. Unapproved HTTPS fails;
an admitted `clawhub.ai` request succeeds while an unrelated host remains denied.
The default filesystem baseline also permits a Node subprocess with ignored
standard input and reads both runtime-provenance files. The fixed frontend
crosses the authenticated hop and removes forged OCE identity headers. Both
fixture revisions complete native payload and private-projection cleanup.

These probes use OpenShell v0.1.5 and the OCE runtime image with OpenClaw source
`f8386bc7df0a6c9eda7a28ae81943c5c06a414ff`, pinned in the owned cluster as
`sha256:4498e0bb07efd82d22653c303158f1874b679c41115251dd263ff9caeec39a0e`.
The image is not rebuilt by this PR. NetworkPolicy allow/deny is qualified only
for this disposable cluster, not shared-cluster admission or production routing.

The supplemental native probe uses a Node HTTP fixture in the pinned OCE image,
not an actual Gateway or model. It cannot qualify ClawHub, embedded tools, state
replacement or authenticated OCE routing. The new opt-in real API/worker scenario
requires fresh migrated PostgreSQL, selected runtime images and genuine model
credentials; it remains unrun because those credentials are unavailable. Selected
missing prerequisites fail instead of skipping. No integration override is claimed.

The broad conformance attempt was not clean on this host. Changed-owner cleanup
regressions were repaired and rerun; TLS-related cases pass with the selected
OpenSSL toolchain. The remaining unrelated seccomp, repository-fixture and SSH
failures were not treated as a full-suite pass.

Canonical autoreview could not authenticate and produced no verdict. Supplemental
independent static reviews found native-cleanup, policy-withdrawal and default
filesystem defects. Those are repaired; targeted cleanup re-review found no
remaining P1 in its reviewed paths. This does not replace the missing canonical
or real-workflow qualification. Keep the PR draft.
