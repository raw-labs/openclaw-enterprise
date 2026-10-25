# Experimental OpenShell application containment

Select `workloadTarget: application` to place the Gateway application inside
OpenShell instead of using OpenShell to create the dedicated Harness. This is a
fork experiment for disposable development clusters, not a production-qualified
deployment. Placements that do not select it keep their existing behavior.

## Choose the boundary

| Agent placement   | Application inside OpenShell                       | Separate execution boundary                                                         |
| ----------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Dedicated Codex   | Gateway, plugins, channels, and other Gateway code | Ordinary Kubernetes Codex Harness; its configured internal policy remains unchanged |
| Embedded OpenClaw | Gateway and Harness together                       | None between their processes                                                        |

Application mode does not stack with the OpenShell Harness mode or request
Codex `danger-full-access`. It does not make plugins mutually isolated or prevent
Gateway code from reading the
Gateway's own credentials and state. It limits the application's access to its
surroundings. A dedicated Gateway still has authority to call its Harness.

## Select the development profile

Start with the existing [local OpenShell Installation](../../guides/deploy/local-kubernetes-development.md#start-the-openshell-fail-closed-profile).
Keep its Backend, workspace resources, runtime images, storage, and RuntimeClass.
Set these fields in the Sandbox Driver configuration; this fragment is not a
standalone Installation:

```yaml
workloadTarget: application
application:
  developmentOnly: true
  servicePeer:
    namespace: oce-system
    podLabels:
      app.kubernetes.io/name: openshell
      app.kubernetes.io/instance: openshell-gateway
    port: 8080
kubernetes:
  userNamespaces: false
policy:
  process:
    runAsUser: "10001"
    runAsGroup: "10001"
  networkPolicies: []
```

Use the actual namespace, Pod labels, and port of the Backend's service listener.
The example matches the Kubernetes-only development profile; the Compose variant
uses a different namespace. Do not add Harness provider profiles or Harness
network rules to application mode.

The stock release shares its management and application listener. The frontend's
network route therefore reaches a privileged OpenShell service, even though it
carries no OpenShell operator credential. This shared-listener topology remains
a development limit, not a production authentication boundary.

## Authorize network destinations

The Agent's [Gateway outbound selection](../gateway-outbound.md) remains the
authorization input. Changing it requires `update` and `administer` on that
Agent. Deployment freezes the approved selection and channel requirements.
The Installation supplies the ceiling and infrastructure address exclusions.
To accept restricted grants, also enable Kubernetes Compute's
[Gateway outbound ceiling](../gateway-outbound.md#installation-setup).
Application mode uses its `denyCidrs` but does not start that proxy image.

Application mode accepts `channelsOnly` and `restricted`. It rejects
`publicHttps`. Approved public destinations use TCP/443. Both IPv4 and IPv6 DNS
answers must pass public-address exclusions; names cannot override them. The
first cluster profile targets IPv4 connectivity; IPv6 transport remains
unqualified. TLS stays end to end: the policy does not authorize HTTP methods,
paths, or plugin identities.

Compute also supplies exact runtime peers for a dedicated Gateway and the
configured public HTTPS model host for embedded execution. These are runtime
dependencies, not permission to reach arbitrary private hosts. In dedicated
mode, approving a Gateway destination does not grant it to Codex. In embedded
mode, the Gateway and model-directed code use the same policy, so an agent's
HTTP request to another host fails unless that host is approved.

OpenShell enforces these destinations for the whole application, without relying
on `HTTP_PROXY` support. The existing standalone outbound proxy is not also
created for the contained application.

## Filesystem, process, and credential limits

The Driver requests Landlock with `hard_requirement`. Its filesystem policy
includes image paths, prepared read-only configuration mounts, and Agent-owned
writable state. Application mode forces `include_workdir: false`; the Harness
option `policy.filesystem.includeWorkdir` does not change it.
Operator `policy.filesystem.readOnly` and `readWrite` entries add
to that application baseline. They do not remove required runtime mounts.

The native Kubernetes Driver chooses the actual process identity: normally
`10001:10001`, or the namespace UID-range identity. The `policy.process` strings
do not override that identity in OpenShell `v0.1.5`. The adapter checks the Pod's
actual UID/GID and refuses incompatible state; it does not change ownership of
files created by the earlier UID `1000` placement.

Nonsecret preparation Pods create configuration and writable-state paths before
OpenShell starts. A separate environment PVC is mounted only by the native
payload Pod. The controller sends the exact prepared environment through native
`ExecSandbox` stdin; values do not enter command arguments, Sandbox metadata, or
preparation Pods. The native process publishes owner-only files atomically and
refuses a different Pod identity or changed environment on retry.

Compute retains a fixed-target HTTP/WebSocket frontend for its existing routing.
That frontend receives only the application transport token, not model or
integration credentials. An in-Sandbox guard authenticates that token before
forwarding to the Gateway or its private status listener. This protects the
transport hop; it does not make an in-process plugin untrusted to its Gateway.

## Refused combinations

The initial profile refuses dedicated native OpenClaw, remote execution
clusters, projected workload ServiceAccount tokens, repository credential
delivery, protected Credential Gateway composition, initial workspace files,
Secret file volumes, additional initialization programs, and extra declared
application listeners. MCP Apps' additional listener is outside this experiment.
Missing Agent-owned model credentials still fail; containment does not supply
credentials or repair an unsupported integration protocol.

Stop and retirement remove the native application before deleting its private
environment storage and transport credential. A replacement must not keep two
writers on the Gateway's persistent state.

## Verify before relying on it

Use the [application experiment checks](../../testing/application-sandbox.md).
Source integration and component checks do not qualify real OpenShell routing,
network denial, filesystem denial, model turns, or lifecycle recovery.

- [SandboxDriver contract](sandbox.md#application-workload-provider)
- [Application provisioning flow](../../flows/application-sandbox-provisioning.md)
- [OpenShell Harness mode](openshell-sandbox.md)
