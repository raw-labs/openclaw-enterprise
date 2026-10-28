# Dedicated Gateway containment verification

## Scope and status

This is an experimental verification procedure, not production qualification.
Prove containment through normal OCE Agent deployment on Linux while the
separate dedicated Harness keeps its placement, authentication and model
credential. The [proposal and delivery record](../../specs/plans/0024-dedicated-gateway-containment.md)
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

### Containment and compatibility

Inspect the real Gateway process tree and its OpenShell boundary. Confirm that
the Gateway and descendants run under the selected containment runtime, with
filesystem and process restrictions active. Check the exact image identity,
command, mounts, init steps, probes, resources and namespace/Agent ownership.
A proxy sidecar beside an otherwise uncontained Gateway fails this requirement.

Exercise native HTTPS and a long-lived connection from the contained process.
Inspect enabled channel contributions in the applied authorization policy.
Check any runtime-required private endpoints, DNS and plugin/package traffic.
Record the compatibility policy's actual breadth: successful egress under a
permissive policy is not proof of destination isolation.

Ordinary upstream TLS must remain verified end to end. Containment must not
introduce request rewriting, a new interception CA, placeholder credentials or
model-key projection into the Gateway. Do not disable certificate checks to make
a probe succeed.

### Authenticated ingress

Complete an operator request through the existing authenticated route. Then
try an unauthenticated request with `x-occ-identity: occ-workspace-files` through
each reachable direct or provider-relayed endpoint. The forged header must not
grant operator access. Node routes must not inherit operator identity.

Inspect the source address and identity that the Gateway actually accepts.
Do not enable loopback trust, widen trusted proxy ranges or remove route
authentication to make the contained Gateway respond. A refused legitimate
request is an ingress compatibility failure, not a reason to weaken the check.

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

## Evidence record

Record the tested source commit, Linux environment, immutable image identities,
commands, pass/fail/skip counts, artifact locations and remaining gaps. Distinguish
source checks, Kubernetes fixtures, real containment, model execution and live
channel proof. No item can be marked passed because its prerequisite was absent.

The initial October 28, 2026 preflight found no project dependencies, Go, k3d,
kubectl, Helm, built CLI, runtime images, prepared cluster/database or authorized
model/channel credentials on the task host. Runtime verification is blocked
until those prerequisites are deliberately supplied. No Linux containment,
model-turn or live-channel success is recorded.

## Related

- [OpenShell tests](openshell.md)
- [QA matrix](ci.md#qa-matrix)
- [Sandbox Driver](../reference/drivers/sandbox.md)
- [Gateway containment RFC](../../specs/rfcs/0024-dedicated-gateway-containment.md)
