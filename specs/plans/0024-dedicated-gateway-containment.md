---
rfc: ../rfcs/0024-dedicated-gateway-containment.md
---

# Implementation plan: Policy-controlled Gateway outbound connectivity

- **ID:** RFC-0024
- **Delivery status:** In progress
- **Implementation hold:** Await the RFC owner's review; no implementation is authorized.
- **Authority:** [Gateway containment RFC](../rfcs/0024-dedicated-gateway-containment.md)
- **Source baseline:** `33c47d4099ec27d7c73abe50137a95cdf6abdecd`

## Outcome and scope

Deliver usable native Gateway HTTPS and WebSocket traffic through the selected
Sandbox's existing policy enforcement. Run the dedicated Gateway in OpenShell
as the mechanism. Keep the separate Harness's placement, workspace,
authentication and model-credential path unchanged. Use the RFC's
[`gatewayOutbound` policy](../rfcs/0024-dedicated-gateway-containment.md#gateway-outbound-policy):
`restricted` by default, with an empty additional host list; `publicHttps`
requires explicit Installation permission.

Only the normal dedicated-Gateway caller is in scope. Do not build a generic
workload executor, scheduler, Pod-template adoption layer, new public resource,
credential broker or data-plane proxy. Gateway startup, state, ingress and
cleanup are required only to make this connectivity path usable through normal
Agent deployment. An ingress dependency is not a separate completed experiment.

Source review uses the branch baseline above and upstream
`1156880e23375c2cfcfc706e646693db7c1b4c01` (October 28, 2026). The required
Gateway containment and channel destination integration are absent. The RFC
owns the decision; this plan tracks code and actual proof.

## Runtime and request scope

Before containment, the Gateway Node process runs in an ordinary Compute-owned
Pod. Enabled channels receive `HTTPS_PROXY` and an approved channel-proxy
network grant. The separate Harness's egress policy does not affect a Slack SDK
request made by that Gateway. See the RFC's
[concrete request](../rfcs/0024-dedicated-gateway-containment.md#one-outbound-request-before-and-after).

In the proposed dedicated path, OpenShell owns the Gateway workload Pod and its
existing separate supervisor Pod, using its [Kubernetes runtime layout](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-driver-kubernetes/src/driver.rs). The workload's boundary process mediates native Gateway sockets;
the supervisor authorizes and opens upstream TCP connections. A Slack token
stays in the Gateway and crosses this path inside native end-to-end TLS. The
separate Harness Pod retains its workspace, model credential and authenticated
Gateway link. This is Gateway containment, not merely a Driver managing a
proxy Pod beside an ordinary Gateway.

Compute must replace the ordinary Gateway realization, not start both. Translate
only Gateway startup/state/resources and integrate provider readiness and cleanup.
Use provider fencing without unioning ordinary Gateway egress grants into it.
For the contained path, replace `HTTPS_PROXY` injection and the requirement for
the cooperative channel-proxy route with native socket mediation. Detect explicit
application/upstream proxies; either support their actual destination semantics
or reject the conflicting configuration. Do not claim Slack-host enforcement
when only a second proxy's address was authorized.

Embedded execution keeps its existing combined Gateway/Harness Pod, credentials,
workspace and networking. It does not invoke this dedicated-only capability;
an explicit embedded containment request fails admission without changing mode.
The dedicated path requires the selected Gateway containment capability;
missing support or setup failure rejects deployment, with no ordinary Gateway
or channel-proxy fallback. Only egress permissions are configurable. Exact
runtime/DNS grants remain separate from external application access. Embedded
behavior needs regression proof, not new containment features.

## Implementation scope review

| Owner                                           | Required change                                                                                                                            | Excluded expansion                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Contracts                                       | Gateway-specific Sandbox lifecycle/endpoint inputs and non-secret Channel destination contributions                                        | Generic arbitrary-workload or Kubernetes-template API                           |
| Installation composition and Kubernetes Compute | Required dedicated Gateway containment, replacing its ordinary realization and channel-proxy route; preserve embedded behavior and cleanup | Reusing Harness `sandboxDriverId` or enabling its credential delivery           |
| OpenShell Sandbox Driver                        | Translate Gateway startup/state and egress into supported provider calls; reuse socket mediation and supervisor authorization              | New forwarder, uncontained fallback, or copying provider behavior into OCC core |
| Channel Driver and admission                    | Collect enabled-channel destinations into the Agent revision; Slack first                                                                  | Provider host lists hardcoded in Compute or credentials stored in policy        |
| Existing ingress owners                         | Minimum compatible authenticated final hop for operator and node traffic                                                                   | General-purpose ingress product or ordinary loopback trust                      |
| Existing Agent QA                               | Genuine Gateway HTTPS/WSS, model turn, state and cleanup with unchanged Harness                                                            | Harness-only qualification presented as Gateway proof                           |

Source owners are `packages/contracts/src/index.ts`,
`apps/controller/src/composition/installation-config.ts`, Kubernetes Compute,
`apps/controller/src/drivers/sandbox/openshell*.ts`, the bundled Slack Channel
Driver and the existing Agent QA boundary. Keep provider translation in its
Driver. Do not add an otherwise unused helper while ingress is unresolved.

## Outbound policy implementation details

Define the proposed `gatewaySandbox` provider setting in Installation
configuration, independently of Harness Sandbox selection. The Installation
administrator selects this provider; Agents have no provider override. Use the
selected Driver's optional `SandboxDriver.gateway` capability. Existing
`sandboxDriver`, `revision.sandboxDriverId`, `configureAgent` and
`provisionHarness` retain their Harness meaning. Composition passes only the Gateway capability to Compute;
Compute retains routes, state ownership, activation and lifecycle.

The existing socket broker sends connection metadata through `AcceptNetwork`
to the supervisor's [transparent authorization path](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-supervisor-network/src/proxy.rs).
Select explicit `tls: skip`: it skips interception, not native TLS validation.
Omitting this mode can select interception. Sandbox translation owns the actual
image's executable identities, initially verifying `/usr/local/bin/node`.
Channels contribute hosts, ports and HTTPS/WSS requirements, not binaries or
provider enums. Reuse the same selected Channel adapter and Slack's enabled
account derivation; perform no secret reads or network calls to derive policy.

Derive exact Harness transport/status destinations from rendered configuration:
in-cluster Codex uses ports 18790/18791; routed variants use authenticated TLS
on 443. Add only required platform callbacks. Package/plugin downloads need
explicit outbound permission; startup must not silently widen the default.

Do not install a broad compatibility rule. Additional restricted hosts use
TCP/443; public TCP/443 requires explicit `publicHttps` selection and Installation
permission. There is no implicit port-80 grant. OpenShell [host patterns](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-core/src/host_pattern.rs)
use `*` for one DNS label and `**` across labels. TCP grants do not authorize
UDP/QUIC; DNS uses the broker path. [Destination validation](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-supervisor-network/src/proxy/destination.rs)
rejects private answers under wildcard DNS policy, but handles IP-literal dials
separately: a broad grant must not be claimed to exclude direct private-IP
access. Declare exact internal endpoints and verify allowed and denied private
connections. Loopback, link-local and control-plane restrictions still apply.
The existing Agent-addition translator caps each grant at 1024 expanded ports;
that is not a limit on separately configured baseline policy.

For Slack, preserve the [RFC's existing-proxy destination coverage](../rfcs/0024-dedicated-gateway-containment.md#one-outbound-request-before-and-after):
`slack.com`, `slack-edge.com`, `slack-msgs.com` and their subdomains on TCP/443.
Emit each apex separately from its `**` subdomain pattern. [Socket Mode returns a temporary URL](https://docs.slack.dev/reference/methods/apps.connections.open/);
retain native connection/reconnect ownership and never log its ticket. Native
SDK source does not establish a Slack-only host validator. These contributions
are not complete Slack media/response-URL coverage. Unsupported destinations
fail closed or require explicit additional access; never add a broad default.

## Minimum ingress dependency

The RFC is submitted in [draft PR #25](https://github.com/raw-labs/openclaw-enterprise/pull/25).
Implementation remains blocked on native authentication support, not RFC
submission or complete Pod-template support. The recommendation below is a
source-backed candidate, not an approved protocol or runtime result.

### Reuse the service relay; extend native verification

Pinned OpenShell v0.1.5 is
`bdb956f2cd65a635f1294fccf1d138d263bf650f`. Its
[socket confinement](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-sandbox/src/linux/socket_confinement.rs)
binds workload INET sockets to loopback; Service or NetworkPolicy changes cannot
restore Pod-IP ingress. Its existing
[service relay](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-server/src/service_routing.rs)
can carry HTTP, WebSocket upgrades and a dedicated proof header to the listener.
It replaces Host and strips `cf-access-jwt-assertion`; do not use that header.
No provider change or new forwarding process is intrinsically required for
this transport. The relay does not authenticate OCE identity.

Recommend verifying OCE-signed ingress evidence in the native Gateway, with
signing in existing authenticated OCE callers. Keep ordinary
`allowLoopback: false`. At native pin
`762a2fe60cc37cf6b8c9d05e61c329866e0d3f6f`, this requires:

- [Ingress attribution](https://github.com/openclaw/openclaw/blob/762a2fe60cc37cf6b8c9d05e61c329866e0d3f6f/src/gateway/ingress-attribution.ts):
  verify the selected transport's evidence before ordinary forwarded-header
  rejection, and retain verified request facts. Invalid proof fails closed.
- [Authentication](https://github.com/openclaw/openclaw/blob/762a2fe60cc37cf6b8c9d05e61c329866e0d3f6f/src/gateway/auth.ts):
  consume verified operator identity, not raw `x-occ-identity`. Preserve
  trusted-proxy scope semantics where possible; retain native role, device,
  bootstrap and token checks for nodes. Operator evidence must not turn a node
  connection into an operator.
- Native configuration types/schema and auth-policy revalidation: select the
  verification keys and policy explicitly; key or audience changes invalidate
  previously accepted authority. These semantics do not exist at the pin.

Review must settle issuer/key selection, Gateway/Agent revision audience,
operator-versus-node transport access, identity, short validity, replay defense
and request binding. Bind the original Origin and presentation/request facts
without ignoring Envoy path rewrites or the relay's Host replacement. Keep
signing authority outside the Sandbox; deliver verification material only to
the Gateway. This plan does not finalize a wire format. Carry any required
OpenClaw change through the existing OCE runtime patch build and obtain review
of its authentication design; a separate upstream PR is not a prerequisite.

### OCE callers, nodes and private status

The [native-admin proxy](../../apps/controller/src/gateway/native-admin-proxy.ts)
can sign after existing admission, stripping caller-supplied proof for HTTP and
WS upgrades. The device-less operator callers in
[workspace files](../../apps/controller/src/gateway/workspace-files-client.ts)
and [node enrollment](../../apps/controller/src/gateway/node-enrollment-client.ts)
also need fresh evidence through their existing transport-header path. Compute
must select the relay backend, preserve route separation and validate/project
the selected native auth configuration.

The [Envoy configuration](../../deploy/helm/openclaw-enterprise/templates/gateway-routing.yaml)
uses API-key authentication, not an external-authorization signing service.
Do not describe a new signer service as existing infrastructure. For node
traffic, investigate loopback transport attribution without loopback identity
authentication, retaining native credentials. That is unproved. Requiring a
signed transport assertion for every public node request would need an
additional signing integration; the current static API-key filter cannot issue
one. Neither route may gain operator authority.

Compute's `privateStatusReadback` reads port 18791 through Kubernetes Pod proxy.
That route cannot reach a loopback-confined status listener either. Add private
selected-Sandbox readback/readiness mapping; do not expose status through the
public operator relay. State/startup translation also needs provider files,
Gateway-only PVC subpaths and authenticated material delivery, not full-template
copying.

### Why existing authentication is insufficient

Native token/password auth exists, but switching OCE to it changes device,
pairing, scope and secret-delivery behavior. An HTTP Authorization header does
not set WS `connect.auth`; current backend callers send no device or scopes.
The trusted-proxy password fallback is local-direct, not forwarded traffic.
Do not strip provenance or reuse the Harness token to reach that fallback.
Native [remote ingress](https://github.com/openclaw/openclaw/blob/762a2fe60cc37cf6b8c9d05e61c329866e0d3f6f/src/gateway/remote-control-ui-transport.ts)
uses in-process request provenance for an admitted plugin, not a trusted HTTP
header, and does not replace node and private-status routes. Authenticating
only OpenShell's external relay still leaves final-hop verification unresolved.

## Implementation

1. Design and review native verified ingress, carrying required changes through
   the OCE runtime patch build. Provide an approved runtime image and resolve
   node attribution and private-status mapping above.
2. Add the dedicated-only Gateway capability and independent composition. Replace
   its ordinary deployment/channel-proxy path, preserve provider fencing, and
   leave the Harness and embedded paths unchanged. Translate Gateway startup,
   credentials, private state and resources through supported provider calls.
3. Connect native Gateway sockets to existing OpenShell enforcement. Add
   runtime, channel and explicit `gatewayOutbound` policy inputs. Name executables,
   host patterns, ports and private endpoints; retain native TLS validation.
4. Add meaningful integration at normal Agent deployment, including forged
   ingress identity, denied egress and failed setup without an uncontained
   fallback. Register a distinct Gateway QA scenario; leave Harness-only tests
   unchanged. Update current references and the owning runtime flow with code.
5. Execute the Linux scenario with the separate dedicated Harness: native
   HTTPS/WSS, enabled-channel policy and live channel separately, a model/tool
   turn, state across replacement, stop/start and delete. Check unchanged embedded
   behavior and reject dedicated deployment without containment. Preserve
   unrelated infrastructure and remove only run-owned effects.

Steps 2–5 are not implemented or qualified. Do not mark the experiment complete
when step 1 is documented or when a fixture passes.

## Verification

| Required outcome                                            | Check                                                       | Result or remaining proof                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| Gateway-specific capability reaches normal Agent deployment | Compute/controller integration                              | Pending implementation                                               |
| Authenticated ingress rejects forged identity               | Normal route and direct/provider-relayed negative controls  | Blocked on ingress capability                                        |
| Harness and embedded placement/auth/model custody unchanged | Normal Agent deployment and workload inspection             | Not run                                                              |
| Real full containment rather than proxy attachment          | Linux supervisor, process/filesystem and runtime inspection | Not run                                                              |
| Native outbound HTTPS and long-lived transport work         | Real contained Gateway traffic                              | Not run                                                              |
| Default-deny and explicit widening work                     | Policy cases in the verification procedure                  | Not run                                                              |
| Enabled channels contribute destinations                    | Driver/Compute integration; live channel separately         | Not run                                                              |
| Private state survives replacement                          | Real Agent redeploy/restart                                 | Not run                                                              |
| Failure cannot activate an uncontained fallback             | Failure integration and real runtime negative control       | Not run                                                              |
| Stop/delete remove owned resources                          | Real Agent lifecycle                                        | Not run                                                              |
| Source/doc checks                                           | Scoped formatting, workspace, local links and diff checks   | Passed; canonical docs/spec/length blocked on docs-site dependencies |

### Current Linux prerequisites

Read-only preflight on October 28, 2026 found Node 24, Docker and the pinned pnpm
available, but no project dependencies, Go, k3d, kubectl, Helm, built CLI,
OpenShell/runtime images or model credentials. There is no disposable cluster
or prepared database. No deployment or model/channel proof has run. A later
read-only recheck found k3d and base k3s images available, but still no Go,
kubectl, Helm, built CLI or genuine Gateway/Harness/OpenShell runtime images.
The formatting invocation then prepared the locked root dependencies and the
repository-managed pre-push hook automatically. No tracked manifest or lockfile
changed; the hook matches its tracked source. The separate docs-site graph
remains absent. Do not alter another task's cluster or images.

Prepare an isolated environment with the repository's documented tooling and
approved immutable runtime images. Supply existing authorized model credentials
through protected files, never command arguments or logs. Live Slack requires
separately authorized Slack credentials and a test channel. Preserve default
kubeconfig and unrelated infrastructure; remove only run-owned resources.

The existing OpenShell Harness suite is not proof of this feature: it changes
Harness placement and model delivery. The new scenario must retain the ordinary
dedicated Harness while containing the Gateway independently.

## Delivery record

- 2026-10-28: Allocated RFC-0024 from current upstream and began independent
  Gateway containment investigation. Linux preflight identified the missing
  prerequisites above. No runtime success is claimed.
- 2026-10-28: Submitted draft PR #25. Native translation assessment identified
  the ingress gap above and excluded a direct Pod-IP route. Driver code and
  Linux verification remain outstanding; keep the PR draft and unmerged.
- 2026-10-28: Refocused the RFC, implementation scope and verification on
  usable native Gateway outbound connectivity. Compared current upstream
  `4837711993d6196c95f9264faf577fc93a2ae6af`; no runtime delivery is claimed.
- 2026-10-28: Completed ingress/outbound source investigation. Recommended
  native verified ingress over the existing relay; identified separate node
  attribution and private-status work. Rechecked upstream at `1156880e` without
  changing the branch/base. Runtime implementation is still absent.
- 2026-10-28: Rewrote application/request and Pod explanations before interfaces;
  corrected existing channel-proxy handling and explicit embedded non-change.
  No runtime implementation or qualification is claimed.
- 2026-10-29: Removed the uncontained dedicated variant. Gateway containment is
  required in this proposal; egress policy remains configurable and embedded
  behavior remains unchanged. Corrected native patch ownership to the OCE build.

- 2026-10-29: Set `gatewayOutbound` to `channelsOnly` by default; wider
  selections are explicit. Added default-deny proof cases. Implementation is on
  hold for the RFC owner's review.

- 2026-10-29: Simplified the proposal to `restricted` and `publicHttps`.
  `restricted` defaults to an empty additional host list, preserving the
  enabled-channel-only default without a separate mode.

## Changelog

- 2026-10-28: Created the standalone delivery plan from upstream
  `33c47d4099ec27d7c73abe50137a95cdf6abdecd`.
