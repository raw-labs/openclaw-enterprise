---
status: Proposed
implementation_status: Partially implemented
author: miguelbranco80
---

# Proposal: control Gateway egress in embedded OpenClaw

- **ID:** RFC-0024
- **Created:** 2026-10-28
- **RFC PR:** [Gateway egress draft](https://github.com/raw-labs/openclaw-enterprise/pull/23)
- **Implementation plan:** [Gateway egress delivery](../plans/0024-embedded-runtime-containment.md)
- **Source base:** `openclaw/openclaw-enterprise` at `4837711993d6196c95f9264faf577fc93a2ae6af`.

## Application problem

Native channels, plugins and integrations execute in the OpenClaw Gateway. Their HTTPS requests originate there, not in a separate Harness. Giving a Harness network access or placing only that Harness in a Sandbox does not provide Gateway connectivity or apply the Sandbox's destination policy to Gateway requests.

OpenClaw Enterprise (OCE) already has Kubernetes tenant networking, channel HTTPS-proxy support and OpenShell networking for selected Harnesses. These mechanisms have different scopes: Kubernetes peer/port rules do not place a Gateway process under OpenShell policy; the configured channel proxy is not a general native-plugin policy; a Harness Sandbox contains its Harness, not the separate Gateway. Embedded channel admission and embedded OpenShell placement currently refuse deployment.

The proposed outcome is working Gateway outbound connectivity under configurable OpenShell policy **in embedded mode**. Run the Gateway and its built-in Harness together inside one OpenShell Sandbox. Containment serves that application outcome; this is not an arbitrary workload-provisioning interface. Keep the PR draft and unmerged until the normal Agent workflow proves it.

## One request before and after

Consider a native Slack channel checking its token with [`POST https://slack.com/api/auth.test`](https://docs.slack.dev/reference/methods/auth.test/). The Gateway's Node process issues HTTPS with the actual channel token in the Authorization header. This is an illustrative read-only authentication check, not a claim that this draft has executed Slack or passed channel acceptance.

**Before:** the embedded Agent's channel settings are refused. Giving a separate Harness access to `slack.com:443` does not fix that admission or move the Gateway's Slack code into the Harness. An existing dedicated channel-proxy deployment follows its own supported path and remains unchanged.

**After, proposed:** normal Agent deployment starts the combined embedded runtime under OpenShell. The Gateway's Slack module attempts the same HTTPS request with the same token. OpenShell checks the initiating executable and destination. An allowed connection reaches Slack through its existing supervisor/proxy path; TLS remains between the Gateway client and Slack. A denied connection fails with OpenShell policy evidence. A permissive initial compatibility policy is acceptable, but must still put the actual request through this enforcement path. It is not a claim of destination restriction or exfiltration prevention.

A successful model turn or a shell command that fetches Slack does not prove this Gateway-owned request. Slack delivery, Socket Mode and other integrations need their own approved inputs and destination coverage.

## Processes, Pods and connections

The following is the proposed embedded topology, using pinned OpenShell v0.1.5:

| Component                             | Placement and responsibility                                                                                                                                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OCC API and worker                    | Existing control-plane processes authorize the Agent, configuration and Secret references, save a revision and reconcile deployment. They do not become the application egress proxy.                                                                                |
| Combined application                  | One OpenShell-managed workload Pod runs its boundary launcher, the OCE Gateway supervisor, native Gateway Node process and embedded execution children. Channel/plugin code runs here. There is no separate dedicated Harness or additional application Gateway Pod. |
| OpenShell supervisor                  | A separate provider-owned Pod per Sandbox handles supervised connections and existing network/proxy enforcement. It is not the application Gateway and does not receive the application's native model credential as an inference-provider binding.                  |
| OpenShell management/service listener | Existing provider infrastructure handles provisioning and HTTP/WebSocket service exposure. Creating or managing this listener or another proxy Pod alone would not contain the application Gateway.                                                                  |
| OCE ingress                           | Existing authenticated ingress reaches the provider service exposure, which relays to the native Gateway's loopback listener. It must retain authorization, TLS/Host handling and native WebSocket behavior.                                                         |

Outbound traffic goes from the Gateway process, through the OpenShell boundary and its separate supervisor, to the allowed external destination. Kubernetes NetworkPolicies retain outer tenant isolation; they must not add a direct-egress bypass for the contained Pod.

OpenShell confines application sockets to loopback. Selecting its workload Pod with a Kubernetes Service cannot supply application ingress. Use the existing HTTP/WebSocket exposure; keep it private to trusted ingress/observation callers or enforce equivalent application authentication. An arbitrary caller must not gain trusted-proxy identity by supplying `x-occ-identity` to that relay. Provider Ready status alone does not establish that native OpenClaw has started or authenticated.

### Execution modes and unchanged behavior

- **Embedded, selected OpenShell placement:** Gateway and Harness remain one application runtime. Model execution, channels and plugins stay native; only their placement and network-enforcement path change. Preserve configuration, workspace/private state, authenticated access and lifecycle behavior.
- **Embedded without this placement:** existing Compute behavior remains unchanged. Do not enable unsupported channels by silently skipping admission or networking requirements.
- **Dedicated:** retain the Compute-owned Gateway and separate Harness, including existing Sandbox selection, model authentication, channel proxy and routing. This proposal does not contain the dedicated Gateway or change dedicated execution.

## Credentials and destination enforcement

Authorized Agent-owned Secrets remain the source of native model, Gateway, channel and integration credentials. Private delivery puts only the required material into the combined runtime using its existing native environment/auth-file formats. Do not put secret bytes in Sandbox specifications, command arguments, public provider configuration, status, logs or evidence. A reference to another Namespace does not grant authority to read it.

Native model and channel credentials remain in the embedded runtime's shared trust domain; code authorized to read those credentials can still do so. Network containment is not credential isolation between the embedded Harness and Gateway. Do not substitute OpenShell inference providers, credential aliases, different model URLs or a dedicated Harness to make deployment succeed.

Use existing OpenShell executable/destination policy, configured by the operator and the Agent's admitted policy additions. Reuse its supervisor/proxy rather than add an egress service. Use TLS passthrough for these routes, retain certificate/hostname verification and restore admitted trust settings instead of inheriting OpenShell-injected interception trust. Credential rewriting and TLS interception are not consequences of selecting this placement.

## Why these platform interfaces

After the topology is established, its owners determine the interfaces:

- **Sandbox:** start and observe the combined OpenClaw application, deliver private startup material and provide its owned service exposure. Extend the existing primitive because it already owns provider execution and network policy. A Driver that merely creates a proxy Pod does not satisfy this containment responsibility.
- **Compute:** retain approved storage, authenticated ingress, readiness/activation, replacement exclusivity, stop and deletion. Use provider exposure instead of assuming direct Pod reachability.
- **OCC:** retain Agent admission, Secret authorization, immutable revisions, queued work and attributable failures. Core depends on these generic responsibilities; OpenShell transport details stay in its Driver/Backend.

Use the existing OCE Gateway supervisor and OpenShell canonical command, not a permanent Gateway detached from an exec session. Private ExecSandbox stdin is a candidate delivery mechanism, with the existing 400,000-byte cap; it still needs revision/generation checks, safe installation and acknowledgment before application code runs. Preserve protected Gateway-owner initialization, immutable inputs, resource bounds, requested identity and persistent state. Describe those application/security requirements rather than export a full Kubernetes PodSpec or arbitrary initializer contract. Unsupported requested identity must fail explicitly.

## Implementation state and acceptance

The experimental Sandbox/Compute coordination and selected model/tool/lifecycle scenario are drafted. The current OpenShell adapter still refuses embedded placement; native startup/private delivery, service-exposure ingress/readiness and native channel integration remain unfinished. Missing arbitrary init-container or emptyDir pass-through prevents verbatim Pod conversion, but does not by itself establish an unavoidable Gateway-egress limitation or a mandatory provider upgrade.

Acceptance requires normal Linux Agent API/worker deployment, a Gateway-owned plugin/channel/integration request with destination receipt and matching OpenShell allow/deny evidence, unchanged native model execution and authenticated Gateway operation. Verify retained workspace/private state, replacement exclusivity, startup failure, stop and deletion. No manually started Sandbox, fake model or refusal-only test substitutes for that workflow.

The task has no selected authorized native-model credential/model or prepared runtime stack. These block live acceptance, not the assessment of provider capability. The [plan](../plans/0024-embedded-runtime-containment.md) records implementation and verification separately.

## Source references

- OCE [Sandbox contract](../../docs/reference/drivers/sandbox.md), [Compute lifecycle](../../docs/reference/drivers/compute.md) and [OpenShell implementation](../../docs/reference/drivers/openshell-sandbox.md).
- OpenShell `bdb956f2cd65a635f1294fccf1d138d263bf650f`: [launch/exec protocol](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/proto/openshell.proto), [Kubernetes driver](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-driver-kubernetes/src/driver.rs), [socket confinement](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-sandbox/src/linux/socket_confinement.rs) and [service routing](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-server/src/service_routing.rs).
