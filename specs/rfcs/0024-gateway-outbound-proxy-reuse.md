---
status: Proposed
implementation_status: Partially implemented
author: miguelbranco80
---

# Gateway outbound destination control via a standalone OpenShell proxy

## Problem and proposed solution

Gateway-hosted plugins, Channels and integrations need external connections. A separate Harness's network access does not carry Gateway requests. Kubernetes already uses default-deny networking, but the [bundled Slack proxy](../../apps/controller/src/slack-proxy.mjs) permits only Slack destinations on TCP/443.

**Extend the platform's Credential Proxy capability with Gateway destination authorization.** For supported dedicated Gateways, the selected proxy becomes the sole route to external HTTPS services. It replaces the Gateway's Slack-proxy route; it is not an optional second route. Kubernetes blocks direct Internet access and access through the old proxy.

The OpenShell implementation uses one proxy-only Pod per Agent revision. It reuses OpenShell's proxy software and policy engine, not an already running proxy instance. Gateway and Harness placement stays unchanged. Existing Harness containment and protected credential handling must continue alongside Gateway destination control.

## Gateway and control-plane scope

The Gateway and the OpenClaw Control Plane (OCC) API have different callers, policies and lifetimes:

| Workload                | External requests                                                                                                | Route under this proposal                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Dedicated Agent Gateway | Enabled Channels, plugins and integrations; destinations vary with the Agent                                     | Its revision's OpenShell proxy, including Slack traffic |
| OCC API                 | Platform operations selected by installation configuration, including Slack setup, sign-in and provider services | Existing installation-level routes, unchanged           |

The OCC API does not run the Agent's OpenClaw plugins. Its destination requirements change with configured platform features and endpoints, not with each Agent's plugin list. They are installation-scoped, rather than permanently fixed.

**The bundled Slack proxy remains only for OCC API Slack requests:** bot-token validation and user/channel directory lookups. The API implements those operations by calling Slack; the proxy only provides their network route. These calls can occur before any Agent is deployed. The proxy remains an installation resource, independent of Agent revisions. It is not retained for embedded mode or as a fallback for dedicated Gateways.

Keeping this route avoids expanding a Gateway connectivity change into a redesign of control-plane networking. The tradeoff is retaining the small Slack-only proxy alongside OpenShell. Replacing it with a general control-plane proxy is separate work: it would need installation-owned policy and HTTP-client wiring for the affected platform features, not an Agent's destination list.

This proposal covers dedicated execution on single-cluster Kubernetes deployments. Embedded networking and separate execution clusters are outside its scope. It does not introduce an installation-level OpenShell proxy for the OCC API.

## Destination policy and configuration

Each Gateway proxy enforces a policy saved for one Namespace, Agent and revision. The controller combines two inputs:

- **Installation-wide administrator destinations.** The Kubernetes Compute Driver's `runtime.gatewayOutbound.destinations` list supplies a common baseline for every dedicated Gateway managed by that Driver.
- **Agent-specific Channel destinations.** Each enabled Channel contributes its required hosts from that Agent's configuration. Slack includes suffix wildcards for rotating WebSocket endpoints. A Channel must not contribute permissions to another Agent's policy.

Configuration fragment within the Compute Driver's installation configuration:

```yaml
runtime:
  gatewayOutbound:
    destinations:
      - host: api.example.com
        port: 443
```

`gatewayOutbound` configures destination rules; it does not enable or disable proxy routing. If the section or list is absent or empty, the administrator baseline is empty and enabled Channels still contribute their requirements. A missing proxy capability refuses deployment; it does not restore the Slack-only route or direct Internet access.

The common baseline makes administrator configuration simple, but grants each listed destination to every dedicated Gateway using that Compute Driver. Separate per-revision policies do not make those common grants Agent-specific. This RFC does not add a per-Agent custom-destination field or automatic discovery of arbitrary plugin endpoints. Additional plugin services must be explicitly approved in the administrator list; Channel contributions alone do not cover them.

The destination list uses exact administrator DNS hosts on TCP/443 and trusted Channel suffix wildcards. An initially permissive compatibility policy is acceptable, but it must preserve the private-address restrictions below. Permissions apply to hosts and ports, not encrypted API actions.

Compute saves the combined policy in the immutable Agent revision. Editing installation configuration does not change an existing revision's policy; deploying with changed destinations requires a new revision.

## One request before and after

Consider a trusted integration sending HTTPS to `api.example.com:443`.

**Before:** the bundled Slack proxy refuses this non-Slack destination.

**With this proposal:**

1. The administrator approves the destination in the common list.
2. At deployment, the controller saves the combined policy and prepares that revision's proxy before starting its Gateway.
3. The Gateway client requests an HTTP CONNECT tunnel through its proxy Service. The Service and TCP forwarder carry the connection to OpenShell.
4. OpenShell permits or refuses the destination. For a permitted tunnel, HTTPS remains end-to-end between the Gateway and the external service.
5. Kubernetes blocks connections that bypass the proxy, including attempts to use the bundled Slack proxy.

This is an explicit proxy, not transparent interception. Gateway HTTP and WebSocket clients must support the route. A client that ignores proxy settings cannot use a direct fallback. Enabled Slack contributes the destinations required to preserve API and Socket Mode behavior; the two proxies are not chained.

## Processes, Pods and connections

Dashed arrows show the proposed Gateway route. The control-plane Slack route and internal Gateway–Harness transport remain unchanged.

```mermaid
---
config:
  theme: base
  htmlLabels: true
  themeVariables:
    fontSize: 14px
  flowchart:
    nodeSpacing: 28
    rankSpacing: 32
    padding: 14
    subGraphTitleMargin:
      top: 10
      bottom: 14
---
flowchart TB
  subgraph GatewayPod["Existing Gateway Pod"]
    G["<b>OpenClaw Gateway</b><br/>Channels and plugins"]
  end
  S["<b>Revision proxy Service</b><br/>TCP/3129"]
  subgraph ProxyPod["Pod hosting OpenShell"]
    R["<b>TCP port forwarder</b><br/>socat on port 3129"]
    P["<b>OpenShell proxy</b><br/>127.0.0.1:3128"]
    R -.->|forward TCP connection| P
  end
  E["<b>Approved destinations</b><br/>Slack and integrations"]
  H["<b>Existing Harness</b><br/>Separate workload"]
  A["<b>OCC API</b><br/>Slack setup and directory"]
  L["<b>Bundled Slack proxy</b><br/>Installation resource"]
  Slack["<b>Slack API</b><br/>Existing platform calls"]
  G -.->|HTTP proxy connection| S
  S -.->|forward TCP| R
  P -.->|permitted destination| E
  G <-->|internal transport| H
  A -->|HTTPS through CONNECT| L
  L -->|Slack destination| Slack
  classDef workload fill:#EBF3F0,stroke:#7F9D93,color:#2B4038,stroke-width:1px
  classDef endpoint fill:#EDF2F7,stroke:#879AB0,color:#25364A,stroke-width:1px
  classDef external fill:#F1EEF5,stroke:#A091AD,color:#3A3243,stroke-width:1px
  class G,R,P,H,L workload
  class S,A endpoint
  class E,Slack external
  style GatewayPod fill:#FAFBFC,stroke:#D8DEE6,stroke-width:1px
  style ProxyPod fill:#FAFBFC,stroke:#D8DEE6,stroke-width:1px
```

OpenShell is the proxy; the Pod hosts it. In the pinned OpenShell 0.1.5 standalone `network-proxy` mode, the listener must use loopback. [OpenShell v0.1.6 enforces the same restriction](https://github.com/NVIDIA/OpenShell/blob/v0.1.6/crates/openshell-supervisor/src/lib.rs#L651-L675), so that upgrade alone does not remove the need for the forwarder. `socat` exposes the listener to the Service; it makes no policy decisions and does not terminate TLS. Remove the forwarder when the selected OpenShell version supports a suitable listener directly.

The proxy runs separately from the Gateway because Kubernetes network permissions apply to the Pod. A sidecar would share the Gateway's Pod-level permissions and would not provide this separation. The standalone proxy does not require a second OpenShell management-server installation.

## Instance and lifecycle tradeoffs

One proxy per Agent revision keeps policy and cleanup independent. Stopping one revision must close its connections without disrupting another Agent. A policy change creates a new revision and proxy rather than changing shared policy in place.

The cost grows with deployed revisions: 100 running dedicated revisions require 100 additional proxy Pods, each with a Deployment, Service, policy files and network rules. Existing Harness-side proxying and the control-plane Slack proxy remain separate. Scheduling, resource use, readiness and cleanup add operational work.

A shared Gateway proxy would reduce instance count, but would need to identify the originating Agent and revision, select the correct policy, and close one revision's connections without disrupting others. Keeping a proxy across revisions of one Agent would also require policy updates and connection draining. This proposal chooses per-revision instances to avoid those shared lifecycle requirements. Reusing the Credential Proxy interface or OpenShell engine does not require sharing one running process.

## Platform responsibilities and enforcement

The controller extends existing interfaces:

- **Compute** owns Gateway deployment and Kubernetes networking. It saves the policy and selected Driver identities in the Agent revision, configures the proxy address, preserves required internal routes and blocks bypass.
- **Credential Proxy** adds destination-policy admission alongside its existing protected-credential operations. Gateway destination control must not require disabling Harness protection.
- **OpenShell Sandbox Driver** manages the revision's proxy Pod, Service, policy files and network rules. This is resource management, not placement of the Gateway inside a sandbox.
- **Channel Drivers** contribute the destinations required by the Agent's enabled Channels.

The proposed extensions are [Credential Proxy `gatewayDestinations.admit`](../../packages/contracts/src/credential-proxy.ts) and [Sandbox `gatewayProxy.prepare/remove`](../../packages/contracts/src/gateway-destinations.ts). Compute calls those interfaces, not an OpenShell-specific forwarding engine. Sandbox and Credential Proxy retain the existing [paired Driver registration](../../docs/reference/drivers/selection.md#select-a-protected-sender). The selected Driver must support both Gateway destination control and protected Harness operations; these can use separate proxy instances.

OpenShell authorizes destinations; Kubernetes prevents bypass. Gateway egress must reach only its own proxy and required internal services. Proxy ingress must select that revision's Gateway. External proxy rules must exclude private, loopback, link-local, metadata and infrastructure ranges, alongside OpenShell's DNS/address checks. Allowed DNS names must not create a route to private addresses.

This requires an enforcing Kubernetes network plugin and trusted writers of Pod labels and network rules. Standalone OpenShell supplies no cryptographic Gateway identity. Remove the Gateway's old Channel egress grant, remove its access from the bundled Slack proxy's ingress rules, and prevent broader rules from granting it an alternate route. Kubernetes allow rules are additive; a deny-all policy cannot cancel another allow rule. Removing proxy environment variables must not restore Internet access.

Before starting a Gateway, verify resource ownership, immutable policy, pinned images and readiness of OpenShell itself, not just the forwarder. Refuse changed or missing dependencies. Proxy failure must not open another route. Stop or replacement first stops the old Gateway, then removes its proxy and waits for its Pods and established connections to disappear. Delete only that revision's resources; Service removal alone does not close established tunnels.

## Acceptance criteria

Exercise the regular Agent deploy, activation, replacement and stop path to establish:

- Approved non-Slack HTTPS and preserved Slack API/Socket Mode connections through the revision proxy.
- Existing Harness containment and protected credential requests alongside Gateway destination control, without sharing permissions between the two traffic paths.
- Unchanged control-plane Slack validation, directory lookups and other installation-level network routes, including with no Agent deployed.
- Refusal of denied hosts and ports, wrong policies, changed proxy resources and proxy/forwarder outages.
- Denial of direct TCP, raw-IP, HTTP, UDP/QUIC, bundled Slack-proxy and alternate-proxy bypass attempts, including without proxy variables; private-address protection and cross-Agent isolation.
- Revision-specific access, complete cleanup and closure of established connections after stop or replacement.

The [implementation plan](../plans/0024-gateway-outbound-proxy-reuse.md), [source flow](../../docs/flows/gateway-outbound-destinations.md) and [QA procedure](../../docs/testing/gateway-outbound-destinations.md) hold delivery and verification details. See the pinned OpenShell [standalone role](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-supervisor/src/lib.rs#L536-L629) and [policy rules](../../deploy/runtime/gateway-proxy/sandbox-policy.rego).
