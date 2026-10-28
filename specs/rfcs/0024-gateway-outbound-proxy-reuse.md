---
status: Proposed
implementation_status: Partially implemented
author: miguelbranco80
---

# Policy-controlled Gateway outbound connectivity

## Objective

Dedicated Gateways need outbound connections for native plugins, Channels and integrations. Give each Agent revision an explicit set of permitted destinations and enforce that set without changing where its Gateway or Harness runs. Reuse the selected proxy and policy engine instead of adding another HTTP forwarding implementation. Gateway workload containment is not a prerequisite for this connectivity option.

## Decision

Extend the selected Credential Proxy capability with destination-only admission. Its paired Sandbox implementation owns the network attachment; Compute retains Gateway and Harness placement and makes the proxy route mandatory. Channel Drivers contribute destinations required by the enabled revision configuration. The admitted policy and attachment belong to one Namespace, Agent and revision.

For the selected stock OpenShell implementation, run a separate proxy-only Pod for each revision. It contains the existing supervisor network proxy and a standard TCP relay. A Service exposes the relay only to that revision's Gateway; the relay carries bytes to the supervisor's loopback listener. OpenShell evaluates destination policy. Enforcing Kubernetes NetworkPolicy must prevent the Gateway from bypassing the attachment. Native credentials and end-to-end TLS remain with the Gateway.

This RFC defines the complete decision and its acceptance conditions. It is an experimental proposal, not an accepted architecture or production qualification.

## Upstream basis and attachment design

Upstream Credential Proxy operations bind credential/source routes to Sandbox executions. They do not provide a generic remote Gateway proxy. This PR adds optional destination admission to the existing [CredentialProxyDriver](../../packages/contracts/src/credential-proxy.ts); it does not treat the platform capability as another name for OpenShell. [SandboxDriver](../../docs/reference/drivers/sandbox.md) provisions Harnesses; [Kubernetes Compute](../../docs/reference/drivers/kubernetes-compute.md) owns Gateways and baseline networking. Destination permission does not require a fabricated credential source, protected execution or installation receipt.

The selected OpenShell 0.1.5 source is `bdb956f2cd65a635f1294fccf1d138d263bf650f`. Its [standalone role](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-supervisor/src/lib.rs#L536-L629) requires local Rego and policy-data files and rejects non-loopback listeners. It selects endpoint-only authorization, deliberately omitting caller binary identity. It does not enroll a workload, authenticate incoming proxy users or contain the Gateway. Reuse its unchanged [policy engine](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-supervisor-network/data/sandbox-policy.rego) and forwarding path, not a second allow evaluator.

The loopback-only listener is why this attachment needs a TCP relay. Keeping the proxy in a separate Pod gives it a different network boundary from the Gateway: only the proxy receives public TCP/443 egress. A proxy sidecar in the Gateway Pod would share that public-egress permission with the Gateway and would not make the route mandatory. The separate Deployment follows from these listener and Pod-network properties, not from a requirement to contain either workload.

These upstream boundaries were rechecked against `openclaw/openclaw-enterprise` main at `4837711993d6196c95f9264faf577fc93a2ae6af` on October 28, 2026. The PR comparison base remains the original upstream snapshot `33c47d4099ec27d7c73abe50137a95cdf6abdecd`; checking newer upstream source does not change that base.

## Proposed contracts and lifecycle

- Channel Drivers contribute nonsecret host/port requirements from the enabled revision configuration. A provider destination is not a Slack channel ID, tenant authorization, plugin identity or HTTP action permission.
- Credential Proxy exposes optional destination-only admission, separate from credential exchange. It admits the complete policy for the Namespace, Agent and revision through the selected registration.
- The paired Sandbox exposes preparation, readiness observation and retirement for the proxy-only attachment, without launching or moving a Gateway workload.
- Compute freezes the selected policy and registration identity in its existing private revision admission state. It installs the attachment before the Gateway, verifies its immutable policy and readiness, then projects the proxy endpoint and exact network grants. Missing support fails closed.

The initial experiment permits exact administrator-approved public DNS hosts on TCP/443 plus explicit Channel requirements. Administrator inputs cannot use wildcards. Trusted Channel contributions can include provider suffix wildcards needed for dynamic endpoints. No TLS interception, credential injection, provider-action authorization or response custody is added. Native integration credentials and certificate verification remain in the Gateway.

The proxy-only Pod runs the selected stock supervisor at `127.0.0.1:3128` and a standard TCP relay at port 3129. The relay transports bytes only. A revision-owned Service selects this attachment alone. Immutable local policy files bind its allowed destinations to the admitted revision. Readiness must check the stock proxy, not merely the relay listener. The proxy public-egress grant must exclude private, loopback, link-local, metadata and infrastructure networks.

## Dedicated implementation and embedded compatibility

The implemented experimental path is opt-in, dedicated, single-cluster Kubernetes execution. It requires the selected destination-admission capability and its paired Sandbox attachment. Unsupported combined execution admissions are refused. Neither Gateway nor Harness moves into the proxy Pod.

Embedded execution retains its existing placement, credentials and networking. This PR does not apply the dedicated destination-control path to embedded Gateways. That is a compatibility boundary, not evidence that embedded Gateway outbound control is implemented or verified.

## Mandatory routing and trust

The Gateway has no public egress grant. Its only external-integration route is to the proxy Pod for its exact revision. Proxy ingress selects the Namespace, Agent, revision and Gateway role; reciprocal Gateway egress selects the exact proxy revision. Preserve the required direct Harness and workspace-node transports. Remove the old channel-proxy grant for this selection: Kubernetes NetworkPolicy allows are additive, so a deny-all policy cannot cancel another allow.

This identity rests on enforcing CNI networking and trusted Kubernetes label and policy writers, not cryptographic workload authentication supplied by OpenShell. Do not share destination unions across Agents or revisions.

Proxy-aware clients can use HTTP CONNECT or the stock HTTP proxy. Clients that ignore proxy configuration fail; there is no direct fallback. An allowed hostname does not permit arbitrary private resolved addresses. Reuse OpenShell DNS and address checks and maintain an independent network-level public-egress fence. Uninspected CONNECT restricts host/port, not the encrypted payload.

Stop and replacement first fence the Gateway, then terminate the revision-owned proxy and wait for its connections and Pods to disappear. Delete only resources owned by that revision. Do not claim immediate withdrawal from changing a local file or removing one additive NetworkPolicy. A changed policy requires a new revision and attachment. Proxy or relay failure must not broaden access.

## Required evidence and current status

**Experimental source implementation is present; real-cluster enforcement is not qualified.** See the [implementation plan](../plans/0024-gateway-outbound-proxy-reuse.md), [source flow](../../docs/flows/gateway-outbound-destinations.md) and [verification procedure](../../docs/testing/gateway-outbound-destinations.md). The pinned supervisor/relay Docker test passes; it proves proxy behavior, not connectivity from the actual Gateway or CNI enforcement. Keep the experiment draft and unmerged.

Before qualification, run the regular Agent admission, worker preparation, activation, replacement and stop path. From the actual Gateway, prove allowed Channel and administrator destinations, denied hosts and ports, CONNECT/WebSocket traffic, TLS verification, wrong-policy refusal, proxy-down behavior and cross-Agent isolation. Prove revision-bound access and removal of established connections. The current dedicated lifecycle stops predecessors before candidate preparation; stale-endpoint withdrawal does not establish simultaneous cross-revision CNI isolation. Verify existing Harness/model/workspace behavior and placement before and after replacement.

Required real-cluster proof must also show direct TCP/443, raw-IP, HTTP, UDP/QUIC and alternate-proxy attempts denied from the actual Gateway, including with proxy environment variables removed. The actual-Gateway Kubernetes scenario remains unrun: the required cluster, runtime, credentials and public probe endpoints have not been prepared for that proof. These are explicit verification gaps, not passing tests. Forwarding through a proxy container alone cannot close them.
