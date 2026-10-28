---
rfc: ../rfcs/0024-gateway-outbound-proxy-reuse.md
---

# Implementation plan: Gateway destination proxy experiment

- **ID:** RFC-0024
- **Delivery status:** Partially implemented; real-cluster acceptance pending
- **Owner:** RFC author and assigned implementation contributors
- **Authority:** [Submitted RFC-0024](../rfcs/0024-gateway-outbound-proxy-reuse.md)
- **Source baseline:** `45224b0b8ea6927e16d95c2e525ca182c28f365f` plus accompanying draft changes

## Outcome and scope

Deliver a standalone experimental draft in
[PR 24](https://github.com/raw-labs/openclaw-enterprise/pull/24), without merging.
The ordinary Agent workflow must preserve Gateway and Harness placement while
routing admitted Gateway destinations through a separate revision-owned proxy.
This plan does not record RFC acceptance or production support.

The [source flow](../../docs/flows/gateway-outbound-destinations.md) describes the
current draft callers. The [QA procedure](../../docs/testing/gateway-outbound-destinations.md)
owns required inputs, commands, cleanup, and the detailed deferred acceptance list.
Stock proxy/relay Docker proof is available; no live Kubernetes enforcement proof is available. Required integration outcomes keep
delivery incomplete even when helpers or selection checks pass.

## Contract and source touchpoints

- [Shared destination contracts](../../packages/contracts/src/gateway-destinations.ts):
  nonsecret destination admission and paired Sandbox attachment, separate from
  credential exchange and Harness provisioning.
- [Channel contribution](../../apps/controller/src/drivers/channel/slack.ts):
  trusted provider requirements. Administrator inputs remain exact DNS TCP/443;
  trusted Channel suffix wildcards are not administrator wildcard support.
- [Credential Proxy registration](../../apps/controller/src/drivers/egress-proxy/openshell-registration.ts)
  and [destination admission](../../apps/controller/src/drivers/egress-proxy/gateway-destinations.ts):
  selected capability identity, stock image/policy pins, and immutable plan.
- [Sandbox attachment](../../apps/controller/src/drivers/sandbox/gateway-proxy-attachment.ts):
  proxy-only Pod with stock loopback OpenShell network proxy and stock socat relay;
  no Gateway, Harness, workspace, credential material, or workload enrollment.
- [Kubernetes Compute](../../apps/controller/src/drivers/compute/kubernetes/index.ts):
  regular revision admission, preparation, routing, activation, stop, and retirement.
  NetworkPolicy/CNI enforcement and trusted label writers remain prerequisites.
- [Real integration scenario](../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs),
  [QA selection](../../tests/helpers/qa-selection.mjs), and
  [QA manifest](../../scripts/ci/test-suites/qa-matrix.json): explicit
  `gateway-destinations` scenario, not default advisory coverage.

## Implementation

1. Confirm the submitted contract amendment and retain draft-only scope. Refuse
   combined protected execution or repository authority for this destination-only
   selection. Preserve the regular Harness credential path and embedded behavior.
2. Connect generic admission and paired Sandbox provisioning through the selected
   registration. Freeze the complete plan in Compute revision admission, compare it
   on retries, and refuse changed identity, policy, images, or attachment settings.
3. Prepare and observe the exact proxy-only Pod before Gateway release. Verify
   immutable files, actual stock policy-engine readiness, observed image identity,
   and fail-closed behavior on tampering or missing dependencies.
4. Keep Gateway/Harness placement and transports unchanged. Prove reciprocal
   revision selectors and mandatory CNI routing; prevent ordinary channel/model
   policies or alternate proxies from adding a bypass. Fence the Gateway before
   terminating the old proxy and its established connections.
5. Run the explicit QA journey using authorized disposable infrastructure and real
   credentials. Extend proof to every deferred RFC condition. Do not replace
   missing prerequisites with a fake proxy, fake cluster, or invented receipt.
6. Keep architecture status, current contract caveats, flow, QA procedure, and
   navigation accurate. Retain the experiment as **UNVERIFIED** until evidence
   supports a narrower claim. No merge is authorized by this plan.

These steps describe remaining delivery and validation work; source files already
present do not mark a step complete. Real runtime dependencies and credentials
block acceptance, not further source review or documentation work.

## Verification

| Required outcome                     | Real check and prerequisites                                                                                    | Result or remaining proof                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Revision-owned policy and attachment | Ordinary API admission, PostgreSQL revision, worker preparation; exact selected pair and stock assets           | Scenario assertions exist; not run.                                                            |
| Allowed and refused traffic          | Real Gateway CONNECT with TLS and independent marker; host/port denials; real Channel/WebSocket traffic         | Basic HTTPS assertions exist; not run. Channel/WebSocket proof deferred.                       |
| No bypass or foreign attachment      | Enforcing CNI, positive controls, all matching policies, proxy variables removed, cross-Agent/revision attempts | TCP/443/isolation assertions exist; not run. Other protocols/address cases deferred.           |
| Failure and cleanup                  | Tamper, proxy/relay outage, replacement, stop, measured established-connection closure                          | Outage/resource-removal assertions exist; not run. Tamper and connection-close proof deferred. |
| Existing execution remains intact    | Actual Harness/model/workspace access and unchanged placement before/after replacement                          | Assertions exist; not run.                                                                     |
| Document consistency                 | Flow validator, local/source links, navigation and length checks; no runtime tests for prose                    | Record actual results in the task handoff; no enforcement claim.                               |

## Delivery record

2026-10-28: Added source-backed flow, current-reference caveats, experimental QA
procedure, and navigation for the accompanying draft implementation. The source
baseline predates the uncommitted implementation; it is provenance, not a tested
implementation SHA. No dependencies, cluster tooling, cluster, or authorized model
credentials were available. Stock runtime, CNI, full integration, lint, typecheck,
and formatting remain unrun. No production support, completed acceptance, or
merge readiness is claimed.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-28 19:04: Record draft delivery and deferred acceptance conditions. (authoring-run/e4a4150b-1969-47ea-a5ab-88dc8b4a2061 - 45224b0b8ea6927e16d95c2e525ca182c28f365f)
