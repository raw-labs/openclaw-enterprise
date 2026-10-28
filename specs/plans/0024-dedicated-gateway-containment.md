---
rfc: ../rfcs/0024-dedicated-gateway-containment.md
---

# Implementation plan: Dedicated Gateway containment

- **ID:** RFC-0024
- **Delivery status:** In progress
- **Authority:** [Gateway containment RFC](../rfcs/0024-dedicated-gateway-containment.md)
- **Source baseline:** `33c47d4099ec27d7c73abe50137a95cdf6abdecd`

## Outcome and scope

The target outcome is normal OCE Agent deployment with its dedicated Gateway
inside the selected Sandbox and its dedicated Harness kept separate. OpenShell
is the first implementation. The experiment reuses existing containment and
outbound proxy primitives without credential rewriting or TLS interception.

The RFC owns requirements and alternatives. This plan owns implementation order
and verification evidence; incomplete runtime proof keeps delivery in progress.

## Contract and source touchpoints

- `packages/contracts/src/index.ts`: separate Gateway containment from
  `provisionHarness`; define workload and destination inputs.
- `apps/controller/src/drivers/compute/kubernetes/index.ts`: apply the selected
  containment capability to the ordinary Gateway workload, preserving routing,
  private state, readiness and lifecycle.
- `apps/controller/src/drivers/sandbox/`: implement OpenShell supervisor and
  network-policy translation behind the Sandbox contract.
- `apps/controller/src/drivers/channel/slack.ts`: contribute channel destinations
  through the channel interface, not an OpenShell-specific core branch.
- Installation composition: explicitly select Gateway containment without
  selecting a different Harness placement or credential path.
- Existing Agent integration boundaries: prove real admission, deployment,
  replacement and cleanup rather than direct calls to unused helpers.

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

Resolve the ingress decision above before changing Driver contracts.

1. Extend the generic Sandbox/Compute integration and opt-in configuration.
   Validate unsupported selections before any uncontained launch.
2. Provision the Gateway through OpenShell containment. Preserve its image,
   configuration, state, credential custody, startup behavior, readiness and
   resource limits, translating projections through supported provider inputs.
   Reuse the existing supervisor network proxy; do not add a forwarder.
3. Collect enabled channels' destination requirements. Keep compatibility
   network access explicit and distinct from credential operations.
4. Cover the normal provisioning and lifecycle path with meaningful integration
   assertions, including failure without an uncontained fallback.
5. Update the owning Sandbox, Compute and Channel references, architectural
   status, operator setup and source-backed runtime flow.
6. Register and execute the Linux QA scenario through normal Agent deployment.
   Inspect actual process containment, connectivity, credential custody,
   persistent state, replacement, stop and delete.

## Verification

| Required outcome | Check | Result or remaining proof |
| --- | --- | --- |
| Generic selected capability reaches normal Gateway deployment | Compute/controller integration | Pending implementation |
| Authenticated ingress rejects forged identity | Normal route and direct/provider-relayed negative controls | Blocked on ingress capability |
| Harness placement/auth/model custody unchanged | Normal Agent deployment and workload inspection | Not run |
| Real full containment rather than proxy attachment | Linux supervisor, process/filesystem and runtime inspection | Not run |
| Native outbound HTTPS and long-lived transport work | Real contained Gateway traffic | Not run |
| Enabled channels contribute destinations | Driver/Compute integration; live channel separately | Not run |
| Private state survives replacement | Real Agent redeploy/restart | Not run |
| Failure cannot activate an uncontained fallback | Failure integration and real runtime negative control | Not run |
| Stop/delete remove owned resources | Real Agent lifecycle | Not run |
| Source/doc checks | Workspace, formatting, types, lint, docs, spec/flow validation | Pending |

### Current Linux prerequisites

Read-only preflight on October 28, 2026 found Node 24, Docker and the pinned pnpm
available, but no project dependencies, Go, k3d, kubectl, Helm, built CLI,
OpenShell/runtime images or model credentials. There is no disposable cluster
or prepared database. No deployment or model/channel proof has run.

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

## Changelog

- 2026-10-28: Created the standalone delivery plan from upstream
  `33c47d4099ec27d7c73abe50137a95cdf6abdecd`.
