# Temporary environment verification

This draft has no live-runtime acceptance yet. Use only explicitly authorized disposable infrastructure and approved images. Do not run these procedures against a shared or unassigned cluster.

### Temporary SSH lifecycle extension

Set `OCC_TEST_KUBERNETES_TEMPORARY_SSH_IMAGE` to an approved digest-pinned
image when running `kubernetes-compute-driver-real.test.mjs`. Its optional
subtest extends the deployed Agent fixture with Compute-owned temporary Pod,
private Service, and NetworkPolicy allocation, exact endpoint readiness,
owner-versus-sibling TCP reachability, and UID-preconditioned cleanup. Without
that image the subtest explicitly skips; the HTTP fixture cannot substitute for
an SSH image. This does not prove authenticated SSH command execution or the
workload API/database reservation path.

The selected image must provide `/usr/local/bin/occ-temporary-ssh`, run as
UID/GID 1000, serve user `worker` on port 2222 using only the supplied
`OCC_SSH_AUTHORIZED_KEY`, disable password/root authentication and forwarding,
and enforce `OCC_HARD_EXPIRES_AT` and `OCC_IDLE_TIMEOUT_SECONDS`. Its only
writable paths are bounded `/workspace` and `/tmp`; it receives no Kubernetes
token, private SSH key, host socket, or elevated capability. The source recipe is
`deploy/runtime/temporary-environments/Dockerfile`; it is not a published or
approved image. Build, inspect and approve its digest separately before use.
The entrypoint enforces hard expiry independently of the controller and Pod
deadline. Client-alive checks disconnect unresponsive SSH sessions; controller
activity tracking owns the environment idle deadline.

For the packaged Crabbox path, configure the Compute Driver with
`temporaryEnvironments.defaultProfileId` selecting an approved profile whose
Namespace allowlist includes the Agent. Omit it to keep HTTP profile discovery
without selecting the CLI adapter. Configure `temporaryEnvironmentApiUrl` as
HTTPS and `temporaryEnvironmentApiEgress` with the actual translated IPv4 `/32`
and TCP port; private PKI additionally requires `temporaryEnvironmentApiCaBundle`
containing PEM certificates. Projected workload credentials and the ordinary
single-cluster Agent runtime are required. Enable Helm
`temporaryEnvironments.enabled` for controller TokenReview and tenant-local
worker Pod create/delete permissions; never bind these roles to an Agent.

The Agent image recipe compiles unmodified Crabbox commit
`c41270ea7e6016b497095cb8f0260ed1a2816a06` and bundles its upstream skills in
`/app/skills` (the runtime publishes its normal bundled-skills tree). Agent init
writes the trusted user config at
`/home/node/.config/crabbox/config.yaml` (also `CRABBOX_CONFIG`) and generates
`/home/node/.ssh/occ-temporary`, a mode-0600 Ed25519 key in private Pod-local
home storage. Only the Agent Harness or embedded Agent gateway receives
`OCC_WORKLOAD_SSH_KEY_FILE`, `OCC_WORKLOAD_TEMPORARY_PROFILE`, endpoint, scope
and projected-token path. The config selects `/usr/local/bin/occ-crabbox-provider`,
trusted SSH output and `/workspace`; the separate gateway does not receive it.
Run the real fixture through `/usr/local/bin/crabbox` without a replacement CLI
or a test-only config. Check SSH execution, cleanup and hard expiry using the
approved image. Source conformance alone does not prove the image build, SSH
server, TLS route or network enforcement.

`tests/conformance/kubernetes-temporary-environments.test.mjs` uses SDK doubles
to check Driver security decisions and ambiguous-create cleanup. Passing those
checks is not evidence of live Kubernetes admission or NetworkPolicy enforcement.

## Temporary-environment workload probe

`kubernetes-compute-real.test.mjs` adds workload-probe checks through API-deployed
Agents, the normal worker, PostgreSQL and real TokenReview. Select its disposable
cluster/database and `OCC_TEST_KUBERNETES_RUNTIME_IMAGE` with genuine model
prerequisites; grant the controller TokenReview create permission. The fixture-only
branch does not run these checks. Tokens remain private. Assertions cover exact
IAM grants, revocation, cross-Namespace denial and stop.

`temporary-environment-provider.test.mjs` proves local API credential precedence
and adapter transport only. Live workload verification, authenticated SSH, cleanup and image builds remain
unverified. Nested k3d is unsupported. See the
[draft flow](../flows/temporary-environment-readiness.md).
