---
rfc: ../rfcs/0024-dedicated-gateway-containment.md
---

# Implementation plan: Policy-controlled Gateway outbound connectivity

- **ID:** RFC-0024
- **Delivery status:** In progress
- **Authority:** [Gateway containment RFC](../rfcs/0024-dedicated-gateway-containment.md)
- **Source baseline:** `33c47d4099ec27d7c73abe50137a95cdf6abdecd`

## Outcome and scope

Deliver usable native Gateway HTTPS and WebSocket traffic through the selected
Sandbox's existing policy enforcement. Run the dedicated Gateway in OpenShell
as the mechanism. Keep the separate Harness's placement, workspace,
authentication and model-credential path unchanged. Explicit initial
compatibility access is acceptable; it does not prove restrictive isolation.

Only the normal dedicated-Gateway caller is in scope. Do not build a generic
workload executor, scheduler, Pod-template adoption layer, new public resource,
credential broker or data-plane proxy. Gateway startup, state, ingress and
cleanup are required only to make this connectivity path usable through normal
Agent deployment. An ingress dependency is not a separate completed experiment.

The branch starts at upstream `33c47d409`. A read-only comparison with upstream
`4837711993d6196c95f9264faf577fc93a2ae6af` on October 28, 2026 checked the ten
subsequent commits. Compute changes add native-worker plugin delivery, not
Gateway containment or authenticated relay ingress; Channel and Sandbox still
lack the required Gateway integration. This plan does not depend on another
experimental PR.

The RFC owns the decision; this plan tracks code and actual proof. Neither is
complete while the contained normal Gateway remains unavailable.

## Implementation scope review

| Owner                                           | Required change                                                                                                               | Excluded expansion                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Contracts                                       | Gateway-specific Sandbox lifecycle/endpoint inputs and non-secret Channel destination contributions                           | Generic arbitrary-workload or Kubernetes-template API                           |
| Installation composition and Kubernetes Compute | Separate Gateway Sandbox opt-in, used by normal Gateway deployment and cleanup                                                | Reusing Harness `sandboxDriverId` or enabling its credential delivery           |
| OpenShell Sandbox Driver                        | Translate Gateway startup/state and egress into supported provider calls; reuse socket mediation and supervisor authorization | New forwarder, uncontained fallback, or copying provider behavior into OCC core |
| Channel Driver and admission                    | Collect enabled-channel destinations into the Agent revision; Slack first                                                     | Provider host lists hardcoded in Compute or credentials stored in policy        |
| Existing ingress owners                         | Minimum compatible authenticated final hop for operator and node traffic                                                      | General-purpose ingress product or ordinary loopback trust                      |
| Existing Agent QA                               | Genuine Gateway HTTPS/WSS, model turn, state and cleanup with unchanged Harness                                               | Harness-only qualification presented as Gateway proof                           |

Source owners are `packages/contracts/src/index.ts`,
`apps/controller/src/composition/installation-config.ts`, Kubernetes Compute,
`apps/controller/src/drivers/sandbox/openshell*.ts`, the bundled Slack Channel
Driver and the existing Agent QA boundary. Keep provider translation in its
Driver. Do not add an otherwise unused helper while ingress is unresolved.

## Open decision: authenticated ingress

Implementation is blocked on an ingress capability, not on RFC submission or
complete Pod-template support. [Draft PR #25](https://github.com/raw-labs/openclaw-enterprise/pull/25)
submitted the RFC for human review on October 28, 2026. No runtime implementation
has been added.

The inspected OpenShell v0.1.5 source is
`bdb956f2cd65a635f1294fccf1d138d263bf650f`. Its
[socket confinement](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-sandbox/src/linux/socket_confinement.rs)
binds workload INET sockets to the loopback device. The
[network broker](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-sandbox/src/network_broker.rs)
installs that restriction before passing sockets to the workload. A wildcard
listener does not permit direct Pod-IP ingress. An ordinary Service or a broader
NetworkPolicy cannot restore the existing Envoy-to-Gateway connection.

OpenShell
[service routing](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-server/src/service_routing.rs)
relays to loopback. Its authorization modes strip or pass application bearer
headers; they do not verify OCE operator identity. The relay also preserves
`x-occ-identity`. The pinned
[native Gateway authentication](https://github.com/openclaw/openclaw/blob/762a2fe60cc37cf6b8c9d05e61c329866e0d3f6f/src/gateway/auth.ts)
rejects loopback trusted-proxy requests unless explicitly enabled. Kubernetes
Compute requires that setting to remain false; its `gatewayRouteHeaderFilter`
sets operator identity only on the authenticated route and removes it on node
routes. Enabling ordinary loopback trust would not preserve that boundary.

The RFC owner must select the scope of the required ingress change:

1. Prefer a supported provider-native capability that authenticates ingress,
   removes caller-supplied identity and supplies an identity the Gateway can
   verify over the final hop. It must work with the Gateway trust checks;
   authenticating only the external listener is insufficient.
2. Alternatively, review a native Gateway authentication adaptation for the
   provider-relayed transport. It must reject forged identity and local-workload
   impersonation without enabling ordinary loopback trusted-proxy access.

Neither capability exists in the inspected OCE integration. Both go beyond
translating provider inputs. The RFC owner must approve the authentication
design; this plan does not authorize changes to the provider or native Gateway
repository. Do not add an ad-hoc relay or disable socket confinement.
State/startup translation remains a candidate: provider files, Gateway-only PVC
subpaths and authenticated startup delivery still need implementation and
real-runtime proof, not full-template copying.

## Implementation

1. Resolve the smallest compatible ingress path above. Identify exact native
   or provider changes if existing support cannot preserve operator and node
   authentication. The RFC is submitted; investigation needs no new approval
   gate. Unavailable external support remains an implementation dependency.
2. Add the Gateway-only Sandbox capability and independent composition. Keep
   the normal Harness path unchanged. Translate native Gateway configuration,
   credentials, private state and resources; use its real startup/readiness
   path rather than require full Pod-template support.
3. Connect native Gateway sockets to existing OpenShell enforcement. Add
   runtime, channel and explicit compatibility policy inputs. Name executables,
   host patterns, ports and private endpoints; retain native TLS validation.
4. Add meaningful integration at normal Agent deployment, including forged
   ingress identity, denied egress and failed setup without an uncontained
   fallback. Register a distinct Gateway QA scenario; leave Harness-only tests
   unchanged. Update current references and the owning runtime flow with code.
5. Execute the Linux scenario with the separate dedicated Harness: native
   HTTPS/WSS, enabled-channel policy and live channel separately, a model/tool
   turn, state across replacement, stop/start and delete. Preserve unrelated
   infrastructure and remove only run-owned effects.

Steps 2–5 are not implemented or qualified. Do not mark the experiment complete
when step 1 is documented or when a fixture passes.

## Verification

| Required outcome                                              | Check                                                       | Result or remaining proof                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| Generic selected capability reaches normal Gateway deployment | Compute/controller integration                              | Pending implementation                                               |
| Authenticated ingress rejects forged identity                 | Normal route and direct/provider-relayed negative controls  | Blocked on ingress capability                                        |
| Harness placement/auth/model custody unchanged                | Normal Agent deployment and workload inspection             | Not run                                                              |
| Real full containment rather than proxy attachment            | Linux supervisor, process/filesystem and runtime inspection | Not run                                                              |
| Native outbound HTTPS and long-lived transport work           | Real contained Gateway traffic                              | Not run                                                              |
| Enabled channels contribute destinations                      | Driver/Compute integration; live channel separately         | Not run                                                              |
| Private state survives replacement                            | Real Agent redeploy/restart                                 | Not run                                                              |
| Failure cannot activate an uncontained fallback               | Failure integration and real runtime negative control       | Not run                                                              |
| Stop/delete remove owned resources                            | Real Agent lifecycle                                        | Not run                                                              |
| Source/doc checks                                             | Scoped formatting, workspace, local links and diff checks   | Passed; canonical docs/spec/length blocked on docs-site dependencies |

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

## Changelog

- 2026-10-28: Created the standalone delivery plan from upstream
  `33c47d4099ec27d7c73abe50137a95cdf6abdecd`.
