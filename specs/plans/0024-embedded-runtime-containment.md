---
rfc: ../rfcs/0024-embedded-runtime-containment.md
---

# Embedded runtime containment implementation

- **ID:** RFC-0024 implementation plan
- **Status:** In progress — provider implementation blocked
- **Created:** 2026-10-28
- **Source base:** upstream `33c47d4099ec27d7c73abe50137a95cdf6abdecd`

## Outcome

Implement the [embedded placement proposal](../rfcs/0024-embedded-runtime-containment.md) through the normal Agent lifecycle. Keep the independent PR a draft and unmerged. This plan does not record acceptance of the Driver contract.

## Delivery

- [x] Submit the contract proposal for human review before implementation: [draft #23](https://github.com/raw-labs/openclaw-enterprise/pull/23), initial proposal commit `a0769268509b97b79720df5d1d14f78d491df096`.
- [x] Add the experimental Sandbox contract and generic admission. This source milestone does not establish a working provider.
- [ ] Connect Kubernetes Compute preparation, readiness, ingress activation, replacement, stop, retirement and Namespace cleanup to that contract.
- [ ] Implement OpenShell placement using existing provider and Sandbox owners. Preserve actual credentials, passthrough TLS, approved volumes and startup.
- [x] Update current contract, implementation reference and source-backed flow with the source behavior and provider refusal.
- [x] Author and register an explicitly selected normal real-Agent acceptance case. Execution is blocked; this checkbox records test authoring only.
- [ ] Run source checks and required Linux real-runtime integration without skips.
- [ ] Publish implementation and explicit proof limits in the draft PR.

## Provider implementation blocker

The pinned [OpenShell v0.1.5 Kubernetes driver configuration](https://github.com/NVIDIA/OpenShell/blob/v0.1.5/crates/openshell-driver-kubernetes/src/driver.rs) accepts PVC volumes but cannot express the ordinary embedded workload's per-volume `emptyDir` limits, original initializer container boundaries, or projected workload identity. The Driver refuses embedded configuration and direct capability calls. It does not provision a reduced runtime.

The draft contains generic contract and Compute integration work, not a working OpenShell embedded deployment. Private stdin can carry credential bytes, but does not reproduce read-only Secret mounts or initializer isolation. An aggregate container storage limit is not the requested per-volume bound.

Native embedded channels also remain refused. Their credential and egress path must be implemented without substituting the dedicated channel proxy.

Next dependency: select a provider implementation that can preserve these requirements, with explicit image/build scope and qualification. Do not change runtime defaults, weaken isolation, mutate provider Pods outside their owner, or claim success from the refusal path.

## Verification and prerequisites

Use disposable Linux Kubernetes/OpenShell infrastructure, real PostgreSQL and worker, approved immutable images, and an authorized native model credential. Normal provisioning and authenticated Gateway calls must prove embedded execution, model/tool behavior, workspace/private-state continuity, replacement, failure handling and owned-resource cleanup.

Channel/plugin/integration compatibility needs actual workflow inputs; a permissive policy is not proof. Do not substitute a manually launched Sandbox process or fake provider/model.

Initial host preflight found no JavaScript dependencies, CLI build, k3d, kubectl, Helm, Go, prepared database/cluster, OCE/OpenShell images or model credential. A later `pnpm typecheck` invocation automatically materialized the existing locked root workspace dependency graph; no manifests or lockfile changed. Documentation-site dependencies remain unavailable. The subsequent checks use the local binaries directly.

Rootless Docker works, but required OpenShell isolation is unproven. The missing runtime prerequisites and provider implementation block live verification. Keep the live milestone open.

## Source verification

Checks ran on the accompanying working tree based on proposal commit `a0769268509b97b79720df5d1d14f78d491df096`:

- `node_modules/.bin/tsc --build tsconfig.json tests/tsconfig.json --pretty false`: passed.
- `node_modules/.bin/eslint . --max-warnings 0`: passed.
- Focused Node tests: 570 passed, zero failures/skips across `embedded-sandbox-compute`, `openshell-embedded-runtime`, `kubernetes-compute`, `kubernetes-provider-harness`, `runtime-logs-sandbox`, and `qa-fixture-inputs`. The first five are under `tests/conformance/`; the last is under `tests/integration/`.
- `node scripts/verify-workspace-boundary.mjs` and `node scripts/ci/run-tests.mjs audit`: passed.
- Changed-file Prettier checks, flow structure validation, local link-target checks and `git diff --check`: passed. Mermaid rendering was not available.
- `pnpm docs:check`: blocked by missing documentation-site dependency `@sindresorhus/slugify`. No documentation dependencies were installed.
- Real embedded acceptance: not run. Provider support, runtime infrastructure, images and authorized model credentials are unavailable. Refusal checks do not establish successful deployment.

## Change record

- 2026-10-28: Initial independent proposal against upstream commit `33c47d4099ec27d7c73abe50137a95cdf6abdecd`.
