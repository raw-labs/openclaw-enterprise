---
rfc: ../rfcs/0024-gateway-outbound-proxy-reuse.md
---

# Implementation plan: Gateway outbound destination control via a standalone OpenShell proxy

- **ID:** RFC-0024
- **Delivery status:** In progress
- **Authority:** [Submitted RFC-0024](../rfcs/0024-gateway-outbound-proxy-reuse.md)
- **PR:** [24](https://github.com/raw-labs/openclaw-enterprise/pull/24), retained as a draft until required verification is complete
- **RFC clarification:** `72fa7ce820fe53ad3cd5aee248a8aaea9d4da72b`; SHA-256 `f803e741835ae7b1af4ade63678e04f1d36646171ba4f2d6200fafb6d00300ac`. The author authorized the ownership clarification on 2026-10-29; requirements and acceptance criteria are unchanged.

## Outcome and scope

Implement the RFC through the regular Agent authoring, deployment, activation,
replacement and stop workflow. Preserve the RFC requirements and the authorized
ownership clarification. Each dedicated Gateway in
a single-cluster Kubernetes deployment uses its revision's OpenShell proxy for
external HTTPS, including Slack. Embedded networking and separate execution
clusters keep their existing behavior.

Agent settings hold additional destinations. Enabled Channels contribute their
own requirements. OCC saves these inputs and the effective policy in each Agent
revision. Installation configuration supplies the selected implementation and
network restrictions. Gateway and Harness placement and protected Harness
operations remain intact.

## Implementation sequence

### 1. Agent settings, authorization and persistence

- [x] Add `gatewayOutbound.destinations` to Agent create, provision,
      preflight and update contracts, using an empty default list and exact DNS
      hosts on TCP/443.
- [x] Authorize destination writes with `update` and `administer` on the
      exact Agent. Preserve attributable mutations and denials.
- [x] Persist the desired list through the Agent repository and PostgreSQL.
      Snapshot it into the immutable revision at deployment.
- [x] Permit an outbound-only update. Keep native OpenClaw Configuration and
      plugin installation separate from the additional-host setting.

Owners: [Agent contracts](../../packages/contracts/src/index.ts),
[API schemas](../../packages/contracts/src/api/common.ts),
[OCC](../../packages/occ/src/index.ts),
[PostgreSQL state](../../packages/occ/src/state/postgres-state.ts) and
[Agent routes](../../apps/controller/src/http/agents.ts).

### 2. Console and CLI authoring

- [x] Expose the dedicated Agent's additional destinations in existing authoring
      workflows, including empty, saving, error and permission-denied states.
- [x] Support the same setting through CLI create/update input and document the
      required Agent permissions.
- [ ] Update Storybook stories and browser coverage. Capture final screenshots
      and an interaction video outside the checkout and upload reviewer-accessible
      evidence to the PR.

Owners: [Console](../../apps/controller/src/console/agents),
[CLI](../../internal/occcli) and
[Storybook](../../scripts/console-storybook).

### 3. Policy admission and protected-operation coexistence

- [ ] Replace the shared administrator-host input with the destination list saved
      in the Agent revision. Add only that Agent's enabled Channel requirements.
- [ ] Save the effective destinations, policy, implementation identities and
      attachment settings in immutable revision admission. Reconcile from the
      saved policy rather than current desired settings.
- [ ] Compose Gateway destination control with existing protected Harness and
      repository operations in the selected paired Drivers. Use separate proxy
      instances and permissions for the Gateway and Harness paths.
- [ ] Preserve other required Compute admission facts when destination admission
      is present. Refuse unsupported or changed capability identities.

Owners: [destination contracts](../../packages/contracts/src/gateway-destinations.ts),
[OpenShell registration](../../apps/controller/src/drivers/egress-proxy/openshell-registration.ts),
[destination admission](../../apps/controller/src/drivers/egress-proxy/gateway-destinations.ts),
[Slack Channel](../../apps/controller/src/drivers/channel/slack.ts) and
[Kubernetes Compute](../../apps/controller/src/drivers/compute/kubernetes/index.ts).

### 4. Mandatory routing and connection lifecycle

- [ ] Require the selected capability for every dedicated single-cluster Gateway.
      Remove its old Slack-proxy route and prevent alternate external grants.
- [ ] Prepare the revision's proxy before starting the Gateway. Verify ownership,
      immutable policy, pinned images and actual OpenShell readiness.
- [ ] Enforce reciprocal revision-specific Gateway/proxy peers, DNS access and
      proxy TCP/443 egress with private and infrastructure address exclusions.
- [ ] Preserve native TLS verification and support the Gateway's HTTP and
      WebSocket clients through the explicit proxy.
- [ ] Stop the old Gateway, remove its proxy and wait for its Pods and established
      connections to disappear before reporting cleanup. Preserve other Agents
      and the successor revision.
- [ ] Retain the control-plane Slack proxy for token validation and directory
      lookups, including before any Agent is deployed.

Owner: [Sandbox proxy attachment](../../apps/controller/src/drivers/sandbox/gateway-proxy-attachment.ts)
and the existing Compute and installation composition paths.

### 5. Verification and publication

- [x] Extend the regular API/PostgreSQL Agent workflow for destination writes,
      permission denials, audit evidence, persistence and immutable revisions.
- [ ] Extend the existing real OpenShell Kubernetes journey for different
      destinations on two Agents, Channel requirements, allowed/denied traffic,
      bypass prevention, outages, tampering, replacement and connection closure.
- [ ] Prove protected Harness operations alongside Gateway destination control
      and unchanged control-plane Slack operations.
- [ ] Run focused tests, typecheck, lint, formatting, workspace, OpenAPI and
      documentation checks with the installed toolchain. Record missing
      prerequisites and skipped checks explicitly.
- [ ] Update current references, the source-backed flow and QA instructions from
      the final implementation. Complete independent review and final-head CI.
- [ ] Publish only task-owned changes to the existing PR branch. Verify that the
      RFC's bytes are unchanged. Keep the PR unmerged unless separately authorized.

## Verification evidence

Required proof follows the [RFC acceptance criteria](../rfcs/0024-gateway-outbound-proxy-reuse.md#acceptance-criteria).
A source change, unit test, fixture or skipped integration is not live enforcement
proof. Keep each result tied to the tested revision and environment.

| Requirement                                                  | Supported verification path                                                                     | Current result                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent permissions and immutable revisions                    | Production API, native IAM and real PostgreSQL through the Agent workflow                       | API: 1 passed; PostgreSQL: 1 passed, no skips, on the working implementation based on `fae0c334f`                                                                                                                                                     |
| Console and CLI authoring                                    | Browser interaction, rebuilt Storybook, CLI requests and uploaded screenshots/video             | Browser: 3 passed, no skips; complete Go CLI package passed. Rebuilt preview captures reviewed and [uploaded](https://gist.github.com/miguelbranco80/dcd6de78c1d0d226d7961a71009cb97a). Full Storybook manager build blocked by missing dependencies. |
| Distinct Agent policies and Channel grants                   | Real Agent admission and worker deployment with two destination lists                           | Pending                                                                                                                                                                                                                                               |
| Gateway and protected Harness coexistence                    | Selected paired OpenShell Drivers and actual protected requests                                 | Pending                                                                                                                                                                                                                                               |
| HTTPS, Slack API and Socket Mode                             | Actual Gateway clients and authorized upstream credentials                                      | Docker native-client transport passed; authenticated Slack events and Kubernetes routing remain unrun                                                                                                                                                 |
| Network bypass, address exclusions and cross-Agent isolation | Disposable Kubernetes cluster with enforcing NetworkPolicies and positive connectivity controls | Pending                                                                                                                                                                                                                                               |
| Outages, tamper, replacement and connection closure          | Regular stop/replacement workflow and measured established tunnels                              | Pending                                                                                                                                                                                                                                               |
| Control-plane networking                                     | Slack validation/directory before and alongside Agent deployment                                | Pending                                                                                                                                                                                                                                               |
| Static and documentation checks                              | Typecheck, lint, formatting, workspace, OpenAPI, local links and flow validation                | Pending                                                                                                                                                                                                                                               |

The [source flow](../../docs/flows/gateway-outbound-destinations.md) owns the runtime
trace. The [QA procedure](../../docs/testing/gateway-outbound-destinations.md) owns
infrastructure, credentials, commands and cleanup. Record results here as each
required proof completes; missing infrastructure or credentials keeps that item
incomplete.

### Local checks on the working implementation

2026-10-29, source based on `72fa7ce82` plus the task-owned working tree:

- Kubernetes Compute, configuration startup, Sandbox startup and Agent API batch:
  **570 passed, no failures, 1 skipped** across 571 tests. The skip required the
  native runtime image. Repeating Sandbox startup with the verified cached image
  produced **126 passed, no skips**, including that initializer case. The batch
  includes all 396 Kubernetes Compute cases. Kubernetes observations are simulated;
  these results do not establish live CNI enforcement.
- Full installation-profile suite with Helm: **84 passed, no skips**. This includes
  dependency-free checkout rendering, explicit Gateway pair inputs, native repository
  selection, control-plane Slack and refusal of a dedicated shared-proxy input.
- Native-client Docker integration: **1 passed, no skips** with pinned stock proxy
  images and local runtime image `ab8155103b74` (OpenClaw source `762a2fe60`). Built-in
  fetch/HTTPS, unauthenticated Slack `api.test` and Socket Mode WebSocket transport
  against a public echo endpoint passed; denied hosts and relay/proxy outages
  refused those clients. This is not authenticated Slack or live Kubernetes proof.
- Agent API authoring integration: **1 passed**, included in the batch. It exercises
  exact-Agent update/administer checks, audit and saved settings with in-memory state.
- Earlier fresh PostgreSQL authoring integration: **1 passed, no skips**, after an
  administrator created the database and a migrator applied the schema. The limited
  application role ran the test. This does not establish real Agent deployment.
- Earlier Console browser workflow: **3 passed, no skips** with in-memory state.
  Rebuilt simulated preview fingerprint `5ad391ab1cefce3d` remains unchanged.
  Screenshots and a 21-second interaction video are uploaded in the PR. The full
  Storybook manager build is blocked by absent Storybook dependencies.
- Go CLI package: passed with cached Go 1.27.3 and dependency downloads disabled.
  The cases establish JSON transport and output, not live-controller persistence.
- Final lint, formatting, application/test typecheck, workspace isolation, OpenAPI
  generation check, CI selection audit, flow validation and diff checks passed.
- Independent P0–P2 autoreview remains **unavailable**. The frozen-candidate attempt
  returned HTTP 401 with no validated report; the current reviewer CLI reports no
  login. No review approval is claimed.
- Canonical documentation build/length checks remain blocked by the missing
  `@sindresorhus/slugify` dependency. No dependencies were installed. The profile
  guide and networking reference remain coherent single-topic pages; redundant
  experiment detail links to the flow instead of expanding those references.

## Installation inputs and live-proof blockers

`drivers.credential_proxy.usage: gateway` selects the existing paired capabilities
for Gateway networking without selecting Harness or repository credential delivery.
Execution selection remains the default and keeps its existing custody checks.
Gateway-only selection refuses credential authority, provider custody, Credential
Gateway/Refresh selection and protected repository transport configuration.

The dedicated profile requires an explicit `gatewayProxy` input with Backend,
Sandbox and Credential Proxy configurations and infrastructure CIDRs. It does not
invent endpoints, RuntimeClasses or workspace settings. The Backend can own the
Gateway pair without a Credential Gateway. API and worker register that owner
without selecting its execution capabilities. The renderer keeps native Git
delivery and control-plane Slack unchanged.

These source paths still require complete final regression and deployment proof.
Existing OpenShell Harness production qualification retains its documented
listener and identity limits; Gateway-only proxy management does not call the
OpenShell management service or qualify that separate Harness path.

The live acceptance run additionally needs a fresh enforcing Kubernetes lane,
approved image provenance, authorized model and Slack credentials, independently
controlled public probes and complete infrastructure address exclusions. The
existing unrelated local cluster is not a prepared or qualified substitute.

## Delivery record

The initial authoring observation below predates the implementation checks.

2026-10-28: Added source-backed flow, current-reference caveats, experimental QA
procedure, and navigation for the accompanying draft implementation. The source
baseline predates the uncommitted implementation; it is provenance, not a tested
implementation SHA. No dependencies, cluster tooling, cluster, or authorized model
credentials were available. Stock runtime, CNI, full integration, lint, typecheck,
and formatting remain unrun. No production support, completed acceptance, or
merge readiness is claimed.

2026-10-28: Implementation source `85018ba5b` includes destination admission,
paired attachment, Compute lifecycle wiring and the real-Agent scenario. The
stock-proxy Docker test passes; it does not prove actual-Gateway traffic or CNI
enforcement. The real Kubernetes scenario remains unrun. The RFC and plan now
state a standalone connectivity design, with dedicated support and embedded
compatibility stated separately. Keep draft and unmerged.

2026-10-28: Rewrote the active RFC around the connectivity problem, a Slack
request, the actual Pods and processes, and dedicated versus embedded behavior.
Aligned the PR description and flow overview. Source implementation and recorded
runtime results are unchanged; actual-Gateway client compatibility and enforced
Kubernetes networking remain unproved.

2026-10-28: Made the proposed Credential Proxy extension explicit and separated
it from the bundled OpenShell topology. Replaced the Slack success example with
a non-Slack request that the existing proxy refuses. Recorded which Gateway route
changes and which API/ordinary Slack consumers remain. Marked combined credential
and general HTTPS proxying as unresolved and unimplemented, not merely unverified.
No runtime behavior changed.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-28 19:04: Record draft delivery and deferred acceptance conditions. (authoring-run/e4a4150b-1969-47ea-a5ab-88dc8b4a2061 - 45224b0b8ea6927e16d95c2e525ca182c28f365f)
