---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Control Gateway outbound connections through the selected proxy

## Problem and decision

A dedicated OpenClaw Gateway runs trusted plugins, channel clients, and other
integrations. Its Kubernetes network policy permits specific internal peers and
a configured channel proxy. The bundled proxy admits Slack destinations, not
arbitrary administrator-approved services. For example, a Gateway cannot use
ClawHub merely because its administrator enabled the relevant software.

Add Gateway destination authorization to the selected Credential Proxy
capability. Reuse the selected implementation's network proxy and, where needed,
Sandbox networking. Do not add another OCE forwarding implementation or proxy
Deployment. OpenClaw Control Plane (OCC) owns the permission; the selected Driver
owns enforcement; Compute owns workload routing and lifecycle.

This is transport control, not credential mediation. Real integration credentials
remain in the Gateway, and dedicated Harness authentication remains unchanged.
TLS stays end to end. The proxy does not replace credentials, inspect HTTP
content, authorize provider actions, or filter responses.

## Operator behavior

The proposed OCE Agent setting `gatewayOutbound` selects access for a dedicated
Gateway, separately from native OpenClaw Configuration:

| Selection      | Gateway access                                                               |
| -------------- | ---------------------------------------------------------------------------- |
| `channelsOnly` | Enabled channels' declared destinations only.                                |
| `restricted`   | Channel destinations plus exact administrator-approved DNS hosts on TCP/443. |
| `publicHttps`  | Public TCP/443, subject to the Installation ceiling and forbidden addresses. |

Public mode is disabled unless the Installation permits it. TCP/443 access is
not proof that the client uses HTTPS. The setting is not a plugin identity or
permission to use another integration's credentials.

Changing this setting requires `update` and `administer` on the exact Agent.
Deployment retains its existing authorization checks. OCC records attributable
mutations and authorization denials and freezes the selection, channel
requirements, and Installation ceiling in the Agent revision. Configuration
changes cannot widen the selected access.

Ordinary embedded execution keeps its existing network behavior, credentials,
storage, and placement. This proposal adds no embedded policy selection or
automatic sandbox. A dedicated Agent without the new capability selected keeps
its existing supported routing; it does not gain general outbound access.

## Owners and contract changes

These additions are proposed contracts, not existing APIs:

- **Channel Driver:** contribute nonsecret destination requirements for its
  enabled configuration. Keep Gateway runtime requirements separate from
  control-plane credential validation and directory lookup.
- **Credential Proxy Driver:** advertise destination-only Gateway support;
  admit and install a revision-scoped destination policy, report its effective
  installation, and withdraw its connections. Keep this capability separate from
  credential-bound `ProxyPlan` routes and request-exchange callbacks.
- **Compute Driver:** advertise compatible routing, connect only the intended
  Gateway to its policy, and enforce that external traffic cannot bypass the
  selected proxy. Preserve exact Harness and platform transport peers.

OCC rejects an explicit selection when either selected Driver lacks support.
It must not create a dummy Secret, credential source, or protected credential
grant to represent a destination permission. Policies for two Agents must not
share authority merely because they use the same proxy service.

The current [Credential Proxy contract](../../../docs/reference/drivers/credential-proxy.md)
is credential/source-bound, and the current
[Sandbox contract](../../../docs/reference/drivers/sandbox.md) provisions
Harnesses. Neither already provides this Gateway-facing transport. The bundled
OpenShell integration therefore needs a supported transport capability before
runtime delivery. Its existing sandbox destination rules are a reusable
enforcement primitive, not evidence that an ordinary Gateway can join that path.

## Network and lifecycle requirements

Destination rules authorize host and port, not methods, paths, bodies, or
individual plugins. Channel Drivers may declare necessary DNS suffixes; manual
restricted grants name exact DNS hosts. The Installation excludes private,
loopback, link-local, metadata, reserved, and actual infrastructure addresses.
The selected proxy must validate resolved addresses and connect only to an
approved result. A permitted hostname cannot override an address exclusion.

The initial delivery requires IPv4 transport and TCP/443. Unsupported addresses,
protocols, and clients fail explicitly; there is no direct-network fallback.
Native certificate and hostname verification remain enabled. An external
redirect that requires a new connection receives another destination check.

Compute installs and observes the exact Gateway policy before activating its
route. A missing proxy, ambiguous workload identity, or unconfirmed policy keeps
the new revision unready. Changing desired state takes effect through deployment.
Disabling a channel removes only that channel's contribution; independently
approved access remains.

Withdrawal must deny new connections and close the affected established
connections before reporting completion. Replacement and cleanup must identify
the exact revision, fence its access, and preserve the successor. A shared proxy
is acceptable only if it can identify, isolate, and withdraw each Gateway's
connections. Proxy failure never enables a broader route.

## Placement and delivery boundary

This decision does not require moving the Gateway into a sandbox, adding a
sandbox per Gateway, changing runtime images, or changing dedicated Harness
sandboxing. Those are not consequences of reusing a Driver registration.
An implementation must establish a supported Gateway-facing route using the
existing primitives. If that requires a separate placement decision or supplier
change, bring that decision for review instead of adding it to this delivery.

This RFC and its [architecture report](report.md) are the complete change.
They add no runtime implementation or supported configuration. Implementation
requires the Gateway-facing transport first, then the normal Agent API/worker
workflow and real allowed/denied destination, direct-bypass, cross-Agent,
withdrawal, and replacement proof. Ordinary embedded execution and credential
delivery must remain unchanged. See [source evidence](sources.md).

<!-- report:omit:start -->

## Reading report

- [Architecture, interfaces, and verification](report.md).
- [Download the PDF](architecture-report.pdf).
- [Pinned source catalogue](sources.md).

Rebuild the PDF with `python3 build-report.py` from this directory. The builder
uses installed Pandoc and Typst. Add `--render-diagram` to regenerate the diagram
with an installed Mermaid CLI and browser. It installs no dependencies and
contacts no product runtime. `SHA256SUMS` records the source and PDF checksums.

<!-- report:omit:end -->
