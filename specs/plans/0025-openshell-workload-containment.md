---
rfc: ../rfcs/0025-openshell-workload-containment.md
---

# Implementation plan: experimental OpenShell workload containment

- **ID:** RFC-0025
- **Delivery status:** Planned
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
   separate Harness requirements in dedicated mode.
4. Deliver configuration and credentials privately, retain state ownership, and
   refuse unsupported identity requirements.
5. Compile admitted outbound intent into role-specific policy without widening
   Harness grants. Preserve runtime peers and Installation exclusions.
6. Update the current references, guide, source-backed flow, QA selection and CI.

## Verification

| Outcome                        | Real check                                                       | Status  |
| ------------------------------ | ---------------------------------------------------------------- | ------- |
| Private delivery and lifecycle | Agent API/worker against Kubernetes/OpenShell                    | Not run |
| Dedicated behavior             | Codex turn and Gateway ClawHub deny/grant/allow                  | Not run |
| Embedded boundary              | OpenClaw turn and agent HTTP deny/grant/allow                    | Not run |
| Filesystem/process enforcement | Native denied operations with permitted controls                 | Not run |
| Replacement and withdrawal     | Access closes; state and successor remain correct                | Not run |
| Source integration             | Typecheck, lint, integration, workspace and generated API checks | Not run |
| Documentation                  | Formatting, links, length, flow and specification checks         | Not run |

Missing credentials or provider support blocks the corresponding proof, not the
integration requirement. Do not substitute a fake runtime or self-enforcing fixture.

## Delivery record

The initial document commit submits the RFC before implementation. No runtime
qualification is claimed. Keep the RFC decision Proposed while work proceeds.
