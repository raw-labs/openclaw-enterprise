# Dedicated Gateway containment

The experimental implementation of [RFC-0024](../../specs/rfcs/0024-dedicated-gateway-containment.md)
is in progress. The dedicated lifecycle requires provider startup, private
readback and verified routing; none can fall back to an ordinary Gateway.
This is not production-qualified. The [delivery record](../../specs/plans/0024-dedicated-gateway-containment.md)
and [verification procedure](../testing/gateway-containment.md) distinguish source
checks from real Gateway, networking and model evidence.

Embedded execution and the separate dedicated Harness keep their existing
placement, workspace and model credentials. Gateway containment does not require
a model Credential Gateway or Credential Proxy selection.

## Select the Gateway provider

The Installation administrator configures the same trusted startup YAML for the
API and worker:

```yaml
gatewaySandbox:
  driverId: openshell-sandbox
  ingress:
    keyId: current
    privateKeyPath: /etc/openclaw/gateway-ingress/private-key.pem
gatewayOutboundPolicyCeiling:
  allowPublicHttps: false
  hosts: [api.github.com]
```

The provider ID must select an installed Sandbox Driver with a `gateway`
capability and bundled Kubernetes Compute. The existing `drivers.sandbox`
entry and its Backend configure that instance. Set
`drivers.sandbox.useForHarness: false` for Gateway-only containment: this
keeps the ordinary dedicated Harness, workspace and model Secret unchanged.
Omitting this flag retains the existing Harness Sandbox selection. An Agent's `sandboxDriverId`
continues to select its Harness Sandbox; it does not select the Gateway provider.
A missing capability rejects dedicated deployment. There is no ordinary Gateway
or channel-proxy fallback.

The OpenShell capability requires authenticated HTTPS control transport,
`userNamespaces: false`, and a public CA bundle for the HTTPS relay. Plain HTTP,
anonymous control and the development `insecureTransport` declaration are not
supported for Gateway containment. Configure the pinned provider to verify
client certificates, enable application mTLS authentication, and reject
unauthenticated control callers. The native service relay uses server-authenticated
TLS without a provider control credential; its bearer token and signed operator
evidence still authorize native requests. This does not change the existing
Harness development transport options.

Provider-owned Harness bootstrap is not qualified with this implementation.
It needs the Gateway to issue node setup before its final Harness endpoint
exists, while a contained launch freezes that endpoint. An explicit
bootstrap-to-final launch transition remains a design and implementation gap.
Do not treat provider-Harness fixture failures as successful Gateway-only proof.

The ingress file contains an Ed25519 private key in a protected regular file.
Startup rejects symbolic links, unsafe ownership, writable group permissions,
access by other users, files larger than 16 KiB and invalid keys. Owner-only 0600 and
root-owned group-readable 0440 mounts are supported. Only controller processes
read the signing key. The Gateway receives its public verification key and an
audience bound to its Agent and revision.

With Helm, set `gatewayIngress.secretName` to a dedicated Secret containing
`private.pem`. The chart mounts that key at the path above only in the API,
worker and upgrade preflight. It does not mount it in migration, bootstrap,
Gateway, Harness or OpenShell supervisor workloads. The subPath mount requires
controller restart after key replacement; deploy a new Gateway revision with
the matching public key. Do not reuse the ingress API-key or model Secret.

## Choose Agent outbound access

The Agent API field `gatewayOutbound` is separate from native OpenClaw
Configuration:

| Selection                                     | Access                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Omitted, or `{mode: restricted, hosts: []}`   | Enabled supported-channel destinations, necessary DNS and exact runtime peers.                                      |
| `{mode: restricted, hosts: [api.github.com]}` | The same destinations plus those exact DNS hosts on TCP/443, within the Installation ceiling.                       |
| `{mode: publicHttps}`                         | Reserved; currently rejected by bundled Kubernetes Compute. Proposed access also requires `allowPublicHttps: true`. |

The ceiling defaults to no additional hosts and no public HTTPS permission.
The current bundled Kubernetes Compute still rejects `publicHttps`, even when
the ceiling permits it: complete public cluster/node address exclusions are not
available. Restricted hosts and enabled-channel rules use positive public-address
allowlists with the known infrastructure exclusions. Public HTTPS remains an
unimplemented part of the proposal, not a qualified deployment option.
Restricted hosts must be canonical lowercase public DNS names, with at most
64 unique entries. URLs, IP addresses, wildcards and reserved aliases are
rejected. Plugins and package registries receive no implicit grant.

Changing policy requires `update` and `administer` on the exact Agent.
Creating an Agent with additional hosts or public HTTPS also requires
Namespace-scoped Agent `administer`. Mutations and authorization denials use
the existing audit path. Deployment freezes the requested policy, channel
contributions and Installation ceiling in the Agent revision. A later tighter
ceiling remains a deployment constraint; native Configuration cannot widen it.
Explicit outbound-policy requests for embedded execution are rejected.

## Networking and authentication boundaries

The Channel Driver contributes destinations without credentials. Slack keeps
its existing API and Socket Mode domain coverage on TCP/443. Disabling Slack
removes that contribution on replacement unless an independent explicit grant
still permits it. Control-plane Slack validation and directory calls retain
their existing proxy and network restrictions.

OpenShell policy must constrain DNS results and direct IP-literal connections,
not just hostname patterns. External grants exclude private, loopback,
link-local, metadata and infrastructure ranges. Separate private runtime grants
pin exact addresses and ports. The pinned provider cannot represent a universal
public TCP/443 rule together with a differently constrained private runtime
rule on that port; unsupported combinations are rejected, not combined into a
broader address allowlist. Native TLS remains end to end with `tls: skip`.

Signed operator evidence is request-bound, replay-checked and valid for 30 seconds. It cannot authorize
a native node or worker. Unsigned node and transfer traffic retains native
credentials, pairing and scope checks without loopback identity trust. Port
18791 stays behind authenticated private provider transport; provider Ready
alone does not prove native Gateway readiness.

## Related

- [Sandbox Driver](drivers/sandbox.md)
- [Compute Driver](drivers/compute.md)
- [Channel Driver](drivers/channel.md)
- [Installation configuration](configuration.md#installation-startup-configuration)
