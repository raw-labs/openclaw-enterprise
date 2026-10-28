---
status: Proposed
implementation_status: Partially implemented
author: miguelbranco80
---

# Proposal: control Gateway egress in embedded OpenClaw

- **ID:** RFC-0024
- **Created:** 2026-10-28
- **RFC PR:** [Gateway egress draft #23](https://github.com/raw-labs/openclaw-enterprise/pull/23)
- **Implementation plan:** [Gateway egress delivery](../plans/0024-embedded-runtime-containment.md)
- **Source base:** upstream `openclaw/openclaw-enterprise` at `4837711993d6196c95f9264faf577fc93a2ae6af`.

## Decision

Run the ordinary embedded OpenClaw Gateway and Harness as one native OpenShell workload so that Gateway plugin, channel and integration requests cross OpenShell's existing network enforcement. Keep embedded execution and its existing model authentication. Whole-runtime placement is the mechanism, not a separate containment product or a requirement to reproduce an identical Kubernetes Pod template.

The experimental contract and Compute wiring are drafted, but the OpenShell adapter still refuses embedded placement. This RFC does not claim a working deployment. Keep the PR draft and unmerged.

## Problem and outcome

The current OpenShell integration provisions dedicated Harnesses, while Kubernetes Compute runs their Gateways separately. In embedded mode, Gateway and Harness share a runtime. Applying OpenShell networking to Gateway traffic therefore requires launching the combined runtime through OpenShell.

Success is an ordinary Agent deployment through the API and worker, followed by an outbound request made by a Gateway plugin, channel or integration. Correlate the request with OpenShell's network evidence and the destination's receipt. A model turn or a tool subprocess request alone does not prove Gateway integration egress. Preserve a genuine native model turn as a compatibility check, not as a substitute for the requested outcome.

## Minimum native launch

Extend the existing Sandbox primitive and keep provider-specific behavior in its OpenShell implementation. Compute owns Agent storage, ingress, activation, replacement and cleanup coordination. The Sandbox owns the combined workload and network enforcement.

The application launch contract needs:

- The selected runtime image and the existing OCE Gateway supervisor command, including managed-mode selection, plugin setup, native model probe and status reporting.
- Admitted configuration and plugin material, separate from references to private native model, Gateway, channel and integration credentials.
- Approved persistent workspace and Gateway-private-state mounts, process identity, resource limits, startup ordering and cleanup behavior.
- A provider-owned HTTP/WebSocket exposure and an application-readiness operation. Provider Ready status alone is not application readiness.
- Requested workload identity, when configured. Unsupported identity must be rejected explicitly, not replaced with the controller's identity.

Do not make `renderedPodSpec`, arbitrary init-container images or the exact `emptyDir` layout the public launch contract. Preserve the application behavior and security reason for each setting. Any replacement must name its owner and enforcement mechanism; renaming an unbounded writable directory does not preserve a storage bound.

### Startup and private material

Use OpenShell's canonical workload command for the long-lived Gateway. A fixed trusted wrapper prepares private state, waits for revision-bound material, then starts the existing OCE supervisor. Do not background the permanent Gateway from an exec session.

OpenShell's ExecSandbox stdin can carry a private document to a fixed receiver. The receiver must enforce the existing 400,000-byte transport cap, reject stale revision/generation material, avoid secret arguments, environment overrides, output and raw errors, and acknowledge installation before application code starts. A lost response must not permit conflicting writes. Secret custody, native auth-file formats, file permissions and the protected Gateway-owner bootstrap remain required work; stdin's existence is not proof that delivery is implemented.

Preserve the existing native model credential and selected auth method. Do not select OpenShell inference providers, credential aliases, a different model URL or a dedicated Harness merely to make the launch pass. Embedded code retains its existing shared credential trust domain.

### Networking and ingress

Gateway Node processes and their integration subprocesses use OpenShell's existing executable/destination policy. The experimental policy may allow broad destinations for compatibility. This proves mediation only when actual requests are observed; it does not establish destination restriction or prevent exfiltration.

Use TLS passthrough for the relevant rules and preserve application certificate verification. OpenShell can inject CA/trust environment even when a route uses `tls: skip`; the trusted launch must restore the admitted application's trust settings rather than inadvertently enable interception. Do not add credential rewriting, a TLS intermediary or another egress proxy.

Stock OpenShell confines workload sockets to loopback. A Kubernetes Service selecting the workload Pod cannot replace its HTTP/WebSocket service exposure. Compute must route its existing authenticated Gateway ingress through that exposure, preserving the expected Host, TLS verification and native WebSocket protocol. Keep the exposure private to the trusted ingress and observation callers, or enforce equivalent application authentication. An externally reachable relay must not make caller-supplied `x-occ-identity` a trusted identity.

Keep Kubernetes tenant isolation outside OpenShell. Do not restore ordinary direct-egress grants to provider-fenced workloads. Native channel credential delivery and Gateway egress must not inherit the dedicated channel proxy as a substitute.

## What the provider limitations establish

The reviewed provider is OpenShell v0.1.5 at `bdb956f2cd65a635f1294fccf1d138d263bf650f`.

| Finding                                                                                                | Consequence for this workflow                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kubernetes `driver_config` has PVC mounts but no arbitrary init containers or `emptyDir` pass-through. | Prevents copying the current Pod template verbatim. It does not alone prevent native Gateway launch or outbound requests. Evaluate trusted sequential setup and supported storage against actual bounds and persistence requirements. |
| ExecSandbox has private stdin; SandboxSpec has a canonical command.                                    | Supplies mechanisms for bootstrap and workload launch. The OCE adapter still needs to implement private native auth and startup; this is not a model-authentication limitation proved against OpenShell.                              |
| Workload sockets are loopback-confined; HTTP/WebSocket service routing exists.                         | Invalidates direct Pod-Service ingress. Use the existing provider exposure and preserve ingress authorization, rather than bypass the network boundary.                                                                               |
| The provider does not accept the requested arbitrary ServiceAccount/token projection.                  | Blocks a launch that actually requests that identity. It is not a blanket explanation for every embedded Agent.                                                                                                                       |

No unavoidable OpenShell limitation preventing Gateway egress has been established. The current unconditional adapter refusal is unfinished integration, not evidence that the objective is impossible or that a provider upgrade is mandatory.

## Lifecycle and acceptance

Use existing Agent authorization, immutable revisions and worker claims. Only the selected Agent's Secret references authorize private delivery. Do not publish secret bytes in specs, arguments, status, logs or evidence.

Stop the predecessor before a successor writes shared state or starts channel consumers. Activate only after native startup, authentication and provider ownership checks. Stop and deletion remove the serving route and canonical workload before owned storage is retired. Retry uncertain provider outcomes with ownership checks, not duplicate launches or manual Pod edits.

Required Linux proof:

1. Deploy an embedded OpenClaw Agent through the normal API and worker, using an authorized native model credential and approved immutable images.
2. Exercise a real Gateway integration/plugin request to an approved destination; correlate its receipt with OpenShell network evidence. Include a policy denial without weakening application TLS or changing model authentication.
3. Complete a genuine model turn and an authenticated native Gateway operation. Confirm that no dedicated Gateway/Harness was substituted.
4. Check retained workspace/private state, replacement exclusivity, startup failure, stop and deletion through the normal lifecycle.

The authored `embedded-containment` scenario currently checks model/tool and lifecycle outcomes, not the required Gateway integration request. Extend it before presenting it as egress acceptance. Missing images, environment or credentials are verification blockers, not provider-capability evidence.

## Alternatives

A Gateway-specific egress proxy duplicates OpenShell's existing enforcement and is not selected. Dedicated execution changes the requested topology. Extending OpenShell may become necessary if a concrete behavior or security boundary has no supported equivalent, but identical Pod representation alone does not justify that work.

## Sources

- [Sandbox contract](../../docs/reference/drivers/sandbox.md), [Compute lifecycle](../../docs/reference/drivers/compute.md), and [OpenShell implementation](../../docs/reference/drivers/openshell-sandbox.md).
- Pinned OpenShell [launch and exec protocol](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/proto/openshell.proto), [Kubernetes driver](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-driver-kubernetes/src/driver.rs), [socket confinement](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-sandbox/src/linux/socket_confinement.rs), and [service routing](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/crates/openshell-server/src/service_routing.rs).
