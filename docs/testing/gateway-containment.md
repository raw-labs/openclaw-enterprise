# Dedicated Gateway outbound connectivity verification

## Scope and status

This is an experimental verification procedure, not production qualification.
Prove usable, policy-controlled native Gateway HTTPS and WebSocket traffic
through OpenShell during normal OCE Agent deployment on Linux. The Gateway
runs inside the selected Sandbox; the separate dedicated Harness keeps its
placement, authentication, workspace and model credential. The
[proposal and delivery record](../../specs/plans/0024-dedicated-gateway-containment.md)
track implementation and missing evidence.

A rendered Pod, passing fixture or proxy environment variable does not prove
containment. A successful existing OpenShell Harness test is also insufficient:
that test provisions the Harness through OpenShell and changes the model
credential path.

## Prepare an owned environment

Use the [Kubernetes prerequisites](kubernetes.md) and approved immutable Gateway,
Harness and OpenShell images. Prepare project dependencies deliberately before
verification. Preserve the default kubeconfig/context and unrelated clusters,
services and databases. Capture evidence outside the checkout.

The test must start with the ordinary dedicated Codex Harness and its existing
Secret-backed `codex_pat` authentication. Configure Gateway containment
independently. Do not add a model CredentialSource, Credential Gateway selection
or Credential Proxy registration merely to make containment available.

Supply authorized model credentials through protected regular files. Never
print credentials, Secret data or complete process environments. A live channel
test additionally needs authorized channel credentials and a test destination.
Synthetic channel configuration proves policy contribution only, not provider
login, WebSocket operation or message delivery.

## Required observations

### Outbound enforcement and compatibility

Inspect the real Gateway process tree and its OpenShell boundary. Confirm that
the Gateway and descendants run under the selected containment runtime, with
filesystem and process restrictions active. Check the exact image identity,
command, mounts, init steps, probes, resources and namespace/Agent ownership.
A proxy sidecar beside an otherwise uncontained Gateway fails this requirement.

Exercise native HTTPS and a long-lived WebSocket from an enabled plugin or
channel in the real Gateway. Correlate its executable and destination with the
OpenShell socket mediation, supervisor authorization and upstream connection.
Do not substitute a standalone request helper for the native integration.

Inspect the applied Gateway policy separately for runtime destinations, enabled
channel contributions and compatibility access. For Slack, cover both its API
and the dynamically selected Socket Mode destination. Check private Harness
endpoints, OCC callbacks, DNS and required plugin/package traffic. Record the
actual executable paths, host patterns, ports and private-address allowances.
Successful egress under a permissive policy is not proof of destination isolation.
Exercise direct private-IP dials separately from wildcard DNS destinations; a
broad hostname grant is not evidence that private addresses are denied. Record
UDP/QUIC as unsupported unless separately demonstrated. Verify enabled named
and implicit-default Slack accounts; do not claim full media-host coverage.

Ordinary upstream TLS must remain verified end to end. Containment must not
introduce request rewriting, a new interception CA, placeholder credentials or
model-key projection into the Gateway. Verify explicit OpenShell `tls: skip`
(non-interception), not omission of the TLS setting. Do not disable certificate
checks to make a probe succeed.

### Authenticated ingress

Complete an operator request through the existing authenticated route. Then
try an unauthenticated request with `x-occ-identity: occ-workspace-files` through
each reachable direct or provider-relayed endpoint. The forged header must not
grant operator access. Repeat from a sandbox-local process. Reject invalid,
expired, replayed and wrong-Gateway/revision evidence; verify key-policy changes
revoke old authority. Test HTTP and main/auxiliary WS, original Origin, rewritten
paths and Host handling. Native-admin, workspace-file and enrollment operator
callers must retain intended scopes. Node/bootstrap/device and transfer routes
must not inherit operator identity.

Inspect the source address and identity that the Gateway actually accepts.
Do not enable loopback trust, widen trusted proxy ranges or remove route
authentication to make the contained Gateway respond. A refused legitimate
request is an ingress compatibility failure, not a reason to weaken the check.
Verify private port-18791 status/readiness through the selected Sandbox mapping;
do not expose it on the public operator route.

### Separate Harness and credentials

Before and after opt-in, compare admitted Harness descriptors, authentication
source, runtime image, selected placement, PVCs, projected identity and Secret
references. Values remain redacted. Confirm that only the Harness retains its
model credential and that the Gateway receives only its existing transport and
channel/integration material.

Complete an authenticated Gateway request, unauthenticated rejection, and a real
model/tool turn through that Harness. A healthy supervisor or Gateway HTTP
health endpoint alone does not establish an operational Agent.

### State and lifecycle

Write a nonsecret marker into the Gateway's supported private-state location.
Restart/redeploy normally and read it back through the supported workload path.
Confirm that Harness workspace storage was not mounted into the Gateway.

Replace the revision and inspect routing to the selected candidate. Stop and
start through OCE, then delete the Agent. Verify contained processes and owned
Sandbox effects terminate, while operator infrastructure and unrelated Agents
remain. Use run-owned cleanup even after a failed assertion; retain resources
only when required for explicit recovery.

Exercise a consequential containment failure, such as an unavailable selected
runtime or refused policy setup. The Agent must not become serving through an
uncontained fallback. Record pending/failure evidence and successful recovery
through the normal deployment path.

## Completion boundary

Ingress compatibility, provider source inspection and policy rendering are
prerequisites, not completed outbound experiments. Do not mark delivery complete
until the normal contained Gateway is usable and the observations above pass.
This procedure does not qualify a generic workload platform.

## Evidence record

Record the tested source commit, Linux environment, immutable image identities,
commands, pass/fail/skip counts, artifact locations and remaining gaps. Distinguish
source checks, Kubernetes fixtures, real containment, model execution and live
channel proof. No item can be marked passed because its prerequisite was absent.

The [plan's prerequisite record](../../specs/plans/0024-dedicated-gateway-containment.md#current-linux-prerequisites)
tracks the October 28, 2026 preflight and later tooling changes. Native verified
ingress is unavailable at the pin; genuine runtime images, an owned prepared
environment and authorized credentials remain missing. No Linux containment,
model-turn or live-channel success is recorded.

## Related

- [OpenShell tests](openshell.md)
- [QA matrix](ci.md#qa-matrix)
- [Sandbox Driver](../reference/drivers/sandbox.md)
- [Gateway containment RFC](../../specs/rfcs/0024-dedicated-gateway-containment.md)
