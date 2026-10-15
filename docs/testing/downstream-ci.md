# Configure downstream CI runners

The `codex/raw-integration` branch runs CI and CodeQL on pushes. Keep `main`
aligned with upstream; qualify combined topic changes before downstream release.

Configure runner labels through repository Actions variables:

| Variable                     | Default                            | Downstream setting           |
| ---------------------------- | ---------------------------------- | ---------------------------- |
| `CI_COMPAT_RUNNER`           | selected lane default              | `depot-ubuntu-22.04-8`       |
| `CI_RUNNER`                  | `blacksmith-16vcpu-ubuntu-2404`    | `depot-ubuntu-24.04-8`       |
| `CI_LARGE_RUNNER`            | selected lane default              | `depot-ubuntu-24.04-16`      |
| `CI_RUNNER_FILE_CONCURRENCY` | lane default                       | `1` (configuration fixtures) |
| `CONTAINER_AMD64_RUNNER`     | `blacksmith-16vcpu-ubuntu-2404`    | `depot-ubuntu-24.04-16`      |
| `CONTAINER_ARM64_RUNNER`     | `blacksmith-8vcpu-ubuntu-2404-arm` | `depot-ubuntu-24.04-arm-16`  |

The runner app and runner group must admit the repository, including public
repositories when applicable. `CI_COMPAT_RUNNER` selects the Ubuntu 22.04 host
for Kubernetes fixtures, observability, sandboxed Chromium and
first-Agent smoke. Remaining automatic lanes use `CI_RUNNER`, except runtime image startup and the repository
platform lanes, which use `CI_LARGE_RUNNER`. Absent variables retain each lane
table's upstream runner; capacity overrides must satisfy the selected proof. The small runtime-image fixture stays
on GitHub-hosted Ubuntu 22.04: its existing host-admission contract requires it.
Use ephemeral VMs with sudo, Docker and enforcing NetworkPolicies.

The concurrency override applies only to Kubernetes configuration fixture files.
Native image checks use `CONTAINER_NODE_BASE_IMAGE`; follow the
[container operator setup](../../.github/containers.md#operator-setup). A manual
`container-check.yml` dispatch can set `node_base_image` to the reviewed
source pin instead, without changing repository variables. Integration checks
build and smoke images without publication.

The startup lane and native runtime-image smoke load the
[job-owned container policy](../../.github/actions/run-ci-lane/codex-sandbox.apparmor)
when Docker advertises AppArmor support. Both use the same
[setup and cleanup helper](../../.github/actions/run-ci-lane/codex-sandbox.sh).
`OCC_TEST_CODEX_APPARMOR_PROFILE=oce-ci-codex-sandbox` is forwarded through prepared state and verifies the enforced
policy only for the stock Codex broker probe. It admits nested mounts, retaining
Docker's proc/sys denials. Digest-verified seccomp limits mount flags; non-root,
read-only, dropped-capability and no-new-privileges settings remain. Existing
filesystem and network denials must pass. Cleanup unloads the job-owned profile; global
AppArmor and namespace restrictions stay enabled.

Protect integration history against force pushes and deletion. Verify `CI Required`
at the selected integration head; branch protection alone does not establish a result.
Existing upstream PRs retain their topic branches.
Downstream release packaging belongs to the release bundle: the upstream
publication workflows enforce upstream repository and branch identity and do
not publish downstream images. Credentialed qualification remains separate
from ordinary CI.
