# Verify the application-containment experiment

Use an owned disposable OpenShell development cluster to compare a contained
dedicated Gateway with combined embedded execution. This checks the
[experimental application profile](../reference/drivers/application-sandbox.md),
not the separate OpenShell Harness profile. A component check or successful
catalog fallback does not prove this workflow.

## Prepare the environment

Follow the [OpenShell cluster prerequisites](openshell.md#start-a-reusable-development-environment)
and select `workloadTarget: application` in its Installation. Keep the generated
kubeconfig explicit and preserve unrelated clusters. Record the fork commit,
Gateway/Codex image digests, OpenShell release, and selected model with the result.

Use existing authorized model credentials through the normal Agent credential
workflow. Dedicated Codex and embedded OpenClaw need their own supported
authentication; one credential type does not establish the other. If a
credential is unavailable, report the missing model-turn proof. Do not replace
the real runtime with a fixture.

First confirm that the unmodified placement is not selected accidentally:

- The native application Pod has the Agent revision's ownership and application
  role, not the ordinary Gateway's networking labels.
- The ordinary Gateway Deployment runs only the fixed-target frontend. It has
  the transport token, but no model, channel, or integration Secret projection.
- The environment PVC is mounted only by the native application Pod. Neither
  preparation phase mounts it. Preparation Pods terminate before private
  environment delivery.
- Dedicated Codex remains an ordinary Kubernetes Harness with its internal
  sandbox; embedded OpenClaw has one combined application boundary.

The real Agent-workflow case is
`tests/integration/application-sandbox-k3d-real.test.ts`. After its required
cluster and database inputs are prepared, select it explicitly:

| Input                                                                  | Required value                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `OCC_TEST_APPLICATION_SANDBOX_ENV`                                     | Private JSON descriptor for the owned, running native development fixture         |
| `OCC_TEST_DATABASE_URL`                                                | Limited application role in a fresh migrated `openclaw_k8s_*` PostgreSQL database |
| `OCC_MIGRATION_DATABASE_URL`                                           | Separate migrator role for that same database                                     |
| `OCC_TEST_KUBERNETES_GATEWAY_IMAGE`, `OCC_TEST_KUBERNETES_AGENT_IMAGE` | Imported immutable image references from the real-runtime setup                   |
| `OCC_TEST_OPENAI_MODEL`                                                | Authorized model shared by the selected cases                                     |
| `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`                                 | Existing model credentials for embedded and dedicated execution respectively      |

Both modes run by default. Set `OCC_TEST_APPLICATION_SANDBOX_MODES` to `embedded`
or `dedicated` for a partial run and report that scope. Dedicated mode also needs
the prepared Gateway routing, private `OCC_TEST_APPLICATION_GATEWAY_API_KEY_FILE`
and `OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS` required by the Kubernetes
runtime fixture. Keep credentials out of command arguments and result artifacts.

The JSON descriptor records `status: ready`, `networkPolicyProof.denied: true`,
the owned cluster's `environment` variables, and the native manager's
`namespaceName`, `namespaceUid`, `gatewayPodName`, `gatewayServiceName` and loopback
`endpoint`. The test verifies these identities against the selected cluster. It
does not create the manager or accept a shared production cluster.

```sh
OCC_TEST_APPLICATION_SANDBOX_REAL=1 \
  node --test tests/integration/application-sandbox-k3d-real.test.ts
```

A selected case must fail when its prerequisites are missing. No skip, bundled
catalog fallback, or component-only pass substitutes for that run.

## Exercise the regular Agent workflow

Create and deploy Agents through OCC, not by calling the provider directly.
Changing `gatewayOutbound` requires both Agent `update` and `administer`.
Saving a new draft alone must not alter the running Agent revision.

| Check                 | Required observation                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| Default denial        | An unapproved public HTTPS destination fails in both placements                                              |
| Approved destination  | A newly deployed restricted grant permits that host, but not a second host                                   |
| Embedded tool request | A real model-directed HTTP request follows the same allow/deny result                                        |
| Dedicated separation  | A Gateway grant does not become an additional Codex network grant                                            |
| Infrastructure denial | A public-host grant cannot reach excluded private, metadata, or infrastructure addresses                     |
| Filesystem denial     | The application cannot write a configured read-only path or read a path outside its filesystem policy        |
| Missing credential    | Removing required Agent-owned model credentials prevents execution; no inherited fallback credential appears |
| Private transport     | A caller without the application transport token cannot use the exposed Gateway or status guard              |
| Replacement and stop  | Native application termination precedes state reuse and environment-PVC deletion                             |

Keep network probes within the owned environment. Record the actual denied
operation and enforcing layer. A timeout by itself does not distinguish policy
denial from DNS, TLS, or application failure. Inspect native policy decisions
and Kubernetes events before attributing the result to OpenShell.

## Check ClawHub without accepting fallback

Use a real remote search or `plugins.catalog.browse` request. A nonempty response
is insufficient: the Gateway can return bundled results after remote access
fails. Require no `remoteError` and identify a result received from the remote
catalog. A bundled-only catalog request does not exercise outbound HTTPS.

Test denied and approved destinations with a new deployed revision for each
policy. Treat package installation as a separate check: download, workspace
tracking, extraction, and installation can fail after a successful HTTPS fetch.
Do not label those failures network denial or claim that catalog access proves
installation support.

## Record results and clean up

Keep exact commands, observed outcomes, skipped prerequisites, and image identity
in the experiment's [implementation plan](../../specs/plans/0025-openshell-workload-containment.md).
Do not put credentials or captured Secret contents in evidence. Use the
development environment's normal cleanup after stopping its Agents; verify that
the native Sandboxes, bootstrap/environment PVCs, frontend, and transport
credentials are gone before deleting the owned cluster.

The shared unauthenticated OpenShell listener, infrastructure ServiceAccount,
and unqualified storage/admission requirements still prevent production
qualification even when these development checks pass.
