---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Gateway destination control with a revision-owned proxy attachment

## Decision

Extend the selected Credential Proxy registration with destination-only Gateway
control. Its paired Sandbox implementation owns the proxy-only attachment;
Compute retains the existing Gateway and Harness placement and owns mandatory
network routing. This is an experimental amendment to the attachment boundary in
[the submitted destination-control proposal](https://github.com/raw-labs/openclaw-enterprise/pull/22),
not a dependency on that branch or the workload-containment experiment.

The earlier proposal excluded an additional proxy Deployment. Inspection of the
selected OpenShell implementation establishes that its standalone network proxy
binds only to loopback. This amendment proposes a separate revision-owned
proxy-only Pod and a standard TCP relay to that loopback listener. It does not
move the Gateway into OpenShell or add another HTTP forwarding implementation.
Submit this changed attachment decision for human review before implementation.
Implementation and review can then proceed in parallel; acceptance is not implied.

## Existing implementation and gap

[CredentialProxyDriver](../../packages/contracts/src/credential-proxy.ts) currently
binds credential/source routes to Sandbox executions. Its configure, observe,
verify and remove operations do not provide a generic remote Gateway proxy.
[SandboxDriver](../../docs/reference/drivers/sandbox.md) provisions Harnesses;
[Kubernetes Compute](../../docs/reference/drivers/kubernetes-compute.md) owns
Gateways and baseline networking. Do not fabricate a credential source,
protected execution, or installation receipt for destination permission.

The selected OpenShell 0.1.5 source is
`bdb956f2cd65a635f1294fccf1d138d263bf650f`. Its
[standalone role](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-supervisor/src/lib.rs#L536-L629)
requires local Rego and policy-data files and rejects non-loopback listeners.
It selects endpoint-only authorization, deliberately omitting caller binary
identity. It does not enroll a workload, authenticate incoming proxy users, or
contain the Gateway. Reuse its unchanged
[policy engine](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-supervisor-network/data/sandbox-policy.rego)
and forwarding path, not a second allow evaluator.

## Proposed contracts and lifecycle

- Channel Drivers contribute bounded, nonsecret host/port requirements from the
  enabled revision configuration. A provider destination is not a Slack channel
  ID, tenant authorization, plugin identity, or HTTP action permission.
- Credential Proxy exposes an optional destination-only capability, separate
  from credential exchange. It admits the complete policy for the Agent,
  Namespace and revision through the selected registration.
- The paired Sandbox exposes provisioning, observation and retirement for the
  proxy-only attachment, without launching or moving a Gateway workload.
- Compute freezes the selected policy and registration identity in its existing
  private revision admission state. It installs the attachment before the
  Gateway, verifies its exact immutable policy and readiness, then projects the
  proxy endpoint and exact network grants. Missing support fails closed.

The initial experiment permits exact administrator-approved public DNS hosts on
TCP/443 plus explicit Channel requirements. No public wildcard mode, TLS
interception, credential injection, provider-action authorization or response
custody is added. Native integration credentials and certificate verification
remain in the Gateway. Ordinary embedded execution is unchanged.

The proxy-only Pod runs the selected stock supervisor at `127.0.0.1:3128` and a
standard TCP relay at port 3129. The relay transports bytes only. A revision-owned
Service selects this attachment alone. Immutable local policy files bind its
allowed destinations to the admitted revision. Readiness must check the stock
proxy, not merely the relay listener. The proxy public-egress grant must exclude
private, loopback, link-local, metadata and infrastructure networks.

## Mandatory routing and trust

The Gateway has no public egress grant. Its only external-integration route is to
the proxy Pod for its exact revision. Proxy ingress selects the Namespace, Agent,
revision and Gateway role; reciprocal Gateway egress selects the exact proxy
revision. Preserve the required direct Harness and workspace-node transports.
Remove the old channel-proxy grant for this selection: Kubernetes NetworkPolicy
allows are additive, so a deny-all policy cannot cancel another allow.

This identity rests on enforcing CNI networking and trusted Kubernetes label and
policy writers, not cryptographic workload authentication supplied by OpenShell.
Do not share destination unions across Agents or revisions. A sidecar is rejected:
public egress granted to a shared Pod would also permit the Gateway to bypass it.

Proxy-aware clients can use HTTP CONNECT or the stock HTTP proxy. Clients that
ignore proxy configuration fail; there is no direct fallback. An allowed hostname
does not permit arbitrary private resolved addresses. Reuse OpenShell DNS and
address checks and maintain an independent network-level public-egress fence.
Uninspected CONNECT restricts host/port, not the encrypted payload.

Stop and replacement first fence the Gateway, then terminate the revision-owned
proxy and wait for its connections and Pods to disappear. Delete only resources
owned by that revision. Do not claim immediate withdrawal from changing a local file or
removing one additive NetworkPolicy. A changed policy requires a new revision
and attachment. Proxy or relay failure must not broaden access.

## Required evidence and current status

**No runtime implementation or enforcement proof is claimed by this proposal.**
The experiment must remain a draft and must not be merged.

Before qualifying the implementation, exercise the regular Agent admission,
worker preparation, activation, replacement and stop path. Prove allowed channel
and administrator destinations, denied hosts and ports, real CONNECT/WebSocket
traffic, TLS verification, wrong policy, proxy-down behavior, cross-Agent and
cross-revision isolation, and removal of established connections. Verify that
existing Harness/model/workspace behavior and placement remain unchanged.

Docker can validate the pinned binary, local policy and TCP attachment. It cannot
prove Kubernetes bypass prevention. Required real-cluster proof must show direct
TCP/443, raw-IP, HTTP, UDP/QUIC and alternate-proxy attempts denied from the actual
Gateway, including with proxy environment variables removed. Missing cluster,
dependencies or credentials remain explicit verification gaps, not passing tests.
