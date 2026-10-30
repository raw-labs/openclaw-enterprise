---
rfc: ../rfcs/0024-gateway-outbound-proxy-reuse.md
---

# Implementation plan: Gateway outbound destination control via a standalone OpenShell proxy

- **ID:** RFC-0024
- **Delivery status:** In progress
- **Authority:** [Submitted RFC-0024](../rfcs/0024-gateway-outbound-proxy-reuse.md)
- **PR:** [24](https://github.com/raw-labs/openclaw-enterprise/pull/24), retained as a draft until required verification is complete
- **RFC clarification:** `72fa7ce820fe53ad3cd5aee248a8aaea9d4da72b`; SHA-256 `f803e741835ae7b1af4ade63678e04f1d36646171ba4f2d6200fafb6d00300ac`. The author authorized the ownership clarification on 2026-10-29; requirements and acceptance criteria are unchanged.

- **Follow-up amendment:** `c671cb4ed363130342d98db6b28fe3671213092a`, submitted to the fork on 2026-10-30: dependencies follow Gateway-only versus management-dependent use; cleanup remains possible after admission changes; unsupported destination settings fail explicitly. The Backend-free normal dedicated workflow and changed-configuration lifecycle passed fresh verification; independent review and final-head CI remain pending.

## Outcome and scope

Implement the RFC through the regular Agent authoring, deployment, activation,
replacement and stop workflow. Preserve the RFC requirements and the authorized
ownership clarification. Each dedicated Kubernetes Gateway uses its revision's
OpenShell proxy for external HTTPS, including Slack, with either a local or remote
Harness. Embedded networking is unchanged. Milestone 6 records two-cluster delivery.

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
- [ ] Publish only task-owned changes to the existing fork PR branch. Keep the
      RFC consistent with the authorized narrow amendment. Leave upstream untouched
      and keep the PR unmerged unless separately authorized.

### 6. Separate execution cluster

RFC amendment `171ff6ffb` was pushed before implementation on 2026-10-30.

- [x] Require immutable admission in both topologies.
- [x] Keep proxy resources and DNS in the Gateway cluster; exclude both clusters' infrastructure.
- [x] Preserve authenticated Harness transport without alternate external grants.
- [x] Verify the existing Gateway-only profile with the execution-cluster overlay.
- [x] Extend and run the real two-cluster API/worker integration.

On `171ff6ffb` plus this extension, 453 conformance cases, 48 startup cases,
one rendered-profile case and five final regressions passed without skips.
Remote regressions failed against previous source. Typecheck, lint and workspace passed.

Real Helm-installed two-cluster verification: **1 passed, no failures/skips**,
374 seconds. It proved two-Agent destination/proxy isolation, direct IPv4 TCP
denial with positive controls, remote model shell execution, workspace retention,
replacement, stop/resume, execution-node outage and recovered deletion. Gateway
permissions held during the outage; overall stop/delete still waits for execution
API recovery. No PAT, IPv6 or immediate outage-time withdrawal claim. Source-matched
local images were used. Owned resources were removed; no images were published.

## Verification evidence

Required proof follows the [RFC acceptance criteria](../rfcs/0024-gateway-outbound-proxy-reuse.md#acceptance-criteria).
A source change, unit test, fixture or skipped integration is not live enforcement
proof. Keep each result tied to the tested revision and environment.

| Requirement                                                  | Supported verification path                                                                     | Current result                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent permissions and immutable revisions                    | Production API, native IAM and real PostgreSQL through the Agent workflow                       | API: 1 passed; PostgreSQL: 1 passed, no skips, on the working implementation based on `fae0c334f`                                                                                                                                                                                   |
| Console and CLI authoring                                    | Browser interaction, rebuilt Storybook, CLI requests and uploaded screenshots/video             | Browser: 3 passed, no skips; complete Go CLI package passed. Rebuilt preview captures reviewed and [uploaded](https://gist.github.com/miguelbranco80/dcd6de78c1d0d226d7961a71009cb97a). Full Storybook build subsequently passed on 2026-10-30; no new UI change in this follow-up. |
| Distinct Agent policies and Channel grants                   | Real Agent admission and worker deployment with two destination lists                           | Maintained normal dedicated two-Agent isolation passed after the fixes; authenticated Channel cases remain pending.                                                                                                                                                                 |
| Gateway and protected Harness coexistence                    | Selected paired OpenShell Drivers and actual protected requests                                 | Pending                                                                                                                                                                                                                                                                             |
| HTTPS, Slack API and Socket Mode                             | Actual Gateway clients and authorized upstream credentials                                      | Earlier native-client and normal dedicated HTTPS/WebSocket checks passed; authenticated Slack remains unrun.                                                                                                                                                                        |
| Network bypass, address exclusions and cross-Agent isolation | Disposable Kubernetes cluster with enforcing NetworkPolicies and positive connectivity controls | Earlier real attachment and normal dedicated isolation/direct TCP checks passed with positive controls; complete bypass matrix remains pending.                                                                                                                                     |
| Outages, tamper, replacement and connection closure          | Regular stop/replacement workflow and measured established tunnels                              | Fresh maintained replacement/stop after changed installation exclusions passed, including established-tunnel closure and peer preservation. Foreign-owner and retry cases passed with simulated Kubernetes API.                                                                     |
| Control-plane networking                                     | Slack validation/directory before and alongside Agent deployment                                | Pending                                                                                                                                                                                                                                                                             |
| Static and documentation checks                              | Typecheck, lint, formatting, workspace, OpenAPI, local links and flow validation                | Combined follow-up lint, typecheck, formatting, workspace, OpenAPI, docs and flow checks passed; 623 focused regressions passed with no skips, plus the complete Go launcher package.                                                                                               |

The [source flow](../../docs/flows/gateway-outbound-destinations.md) owns the runtime
trace. The [QA procedure](../../docs/testing/gateway-outbound-destinations.md) owns
infrastructure, credentials, commands and cleanup. Record results here as each
required proof completes; missing infrastructure or credentials keeps that item
incomplete.

### Fresh follow-up verification

On 2026-10-30, the maintained `gateway-destinations-dedicated` scenario passed
with **3 reported tests, no failures or skips** on `c671cb4ed` plus the accompanying
implementation. Both images were rebuilt from that source. Two API/worker-created
Agents used Gateway-only registration without a management Backend. Installation
blocked CIDRs changed before replacement and again before stop. Established
TLS/WebSocket tunnels closed after 2,949 ms and 2,296 ms; the peer retained its
Pod and connection with 58 upstream echoes. Three nonce model turns used
`gpt-6.1-sol` with low reasoning and Harness-only model credentials. Owned cluster,
database, state and image references were removed; inventories matched the
pre-run state. Deletion conflicts and foreign ownership are simulated-API proof,
not injected live failures. See the [QA guide](../../docs/testing/gateway-outbound-destinations.md)
for the maintained command and remaining acceptance limits.

### Normal dedicated verification before the follow-up fixes

On 2026-10-30, the normal launcher and API/worker workflow tested the runtime
changes recorded in `2e74eb5aed5c7a4aac1553187eae37f7b8c3e097`. Two Agents reached
their own hosts and could not reach the other host or proxy frontend. Real model
turns used Harness-only credentials. Replacement closed an established verified
TLS/WebSocket tunnel after 2,086 ms; stop closed it after 2,157 ms. The peer
continued exchanging messages. These results do not cover the new Backend-free
configuration or changed-admission cleanup. The fresh follow-up result above supersedes this run for the corrected paths;
protected Harness and authenticated Slack acceptance remain pending.

Full Storybook, documentation build, lint, types, formatting, workspace, OpenAPI
and flow checks passed for that earlier source. Historical prerequisite failures
below describe their original runs, not current blockers.

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

### Real Kubernetes attachment repair

2026-10-29, source based on `e69e52e99` plus the accompanying repair:

- The new real-API regression failed before the repair because SDK serialization
  dropped `ingress.from`. It now passes with **1 passed, no skips**, including
  read-back, repeated preparation and refusal of a valid broadened peer rule.
- The same case with the cached native Gateway image selected passes with
  **1 passed, no skips** on fresh k3s 1.35.5. It verifies actual stock proxy and
  relay readiness, native ClawHub HTTPS, denied-host refusal, foreign-Pod refusal,
  private TCP/443 egress denial with a reachable control, and attachment removal.
- Live execution also exposed omitted false Pod defaults, the Deployment
  controller revision annotation, and kubelet ownership of the TLS volume root.
  The repair accepts only those known API defaults and uses a private child TLS
  directory created by the non-root stock process. Pod image specifications and
  observed immutable image identities remain checked. The attachment fingerprint
  version changes with the layout.
- These are direct attachment component tests with real Kubernetes and native
  clients, not the regular Agent API/worker deployment journey. They do not prove
  Compute-generated Gateway direct-egress restrictions, authenticated integrations,
  model execution or full revision connection fencing. Those acceptance items
  remain open. The run-owned cluster, imported layers and temporary tags were
  removed; existing resources were preserved.

## Installation inputs and live-proof blockers

`drivers.credential_proxy.usage: gateway` selects the existing paired capabilities
for Gateway networking without selecting Harness or repository credential delivery.
Execution selection remains the default and keeps its existing custody checks.
Gateway-only selection refuses credential authority, provider custody, Credential
Gateway/Refresh selection and protected repository transport configuration.

The dedicated profile requires an explicit `gatewayProxy` input with Sandbox
and Credential Proxy configurations and infrastructure CIDRs. Gateway-only
registration omits the management Backend and refuses unused management settings.
Management-dependent execution still requires its authenticated Backend. API and
worker register the Gateway pair independently of Harness execution. The renderer
keeps native Git delivery and control-plane Slack unchanged.

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
