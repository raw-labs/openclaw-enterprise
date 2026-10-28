---
rfc: index.md
---

# Gateway outbound source catalogue

All implementation links below point to upstream main at
`5dae426ec5c591b43609a4b50c154016e2c5483c`. They establish current code and
contracts, not a deployed Gateway destination-control feature. Read the
[RFC](index.md) and [architecture report](report.md) for the proposal.

| Source                                                                                                                                                                                                                       | Evidence                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Architecture and implementation status](https://github.com/openclaw/openclaw-enterprise/blob/5dae426ec5c591b43609a4b50c154016e2c5483c/docs/design.md#implementation-status)                                                 | Current ownership, placement, and remaining platform work.                                                                                                                         |
| [Harness authentication](https://github.com/openclaw/openclaw-enterprise/blob/5dae426ec5c591b43609a4b50c154016e2c5483c/docs/reference/harness-execution.md#harness-authentication)                                           | Embedded model Secrets enter the combined workload. Dedicated Harness authentication uses its existing direct or proxy path; the Gateway receives no Harness inference credential. |
| [Kubernetes network profiles](https://github.com/openclaw/openclaw-enterprise/blob/5dae426ec5c591b43609a4b50c154016e2c5483c/docs/reference/drivers/kubernetes-compute/networking-and-isolation.md#explicit-network-profiles) | Ordinary workload and provider-fenced Harness networking are distinct.                                                                                                             |
| [Bundled Slack CONNECT proxy](https://github.com/openclaw/openclaw-enterprise/blob/5dae426ec5c591b43609a4b50c154016e2c5483c/apps/controller/src/slack-proxy.mjs)                                                             | Fixed Slack host/suffix checks on port 443 and opaque stream forwarding.                                                                                                           |
| [Kubernetes Compute](https://github.com/openclaw/openclaw-enterprise/blob/5dae426ec5c591b43609a4b50c154016e2c5483c/apps/controller/src/drivers/compute/kubernetes/index.ts)                                                  | Gateway workload, credentials, channel proxy routing, isolation, and lifecycle.                                                                                                    |
| [Channel and Sandbox contracts](https://github.com/openclaw/openclaw-enterprise/blob/5dae426ec5c591b43609a4b50c154016e2c5483c/packages/contracts/src/index.ts)                                                               | `ChannelDriver` has setup/directory methods; `SandboxDriver` has Harness provisioning and network-policy operations.                                                               |
| [Credential Proxy contract](https://github.com/openclaw/openclaw-enterprise/blob/5dae426ec5c591b43609a4b50c154016e2c5483c/packages/contracts/src/credential-proxy.ts)                                                        | Current `ProxyPlan`, `CredentialProxyDriver`, configuration, observation, verification, and removal declarations.                                                                  |
| [Protected execution caller](https://github.com/openclaw/openclaw-enterprise/blob/5dae426ec5c591b43609a4b50c154016e2c5483c/apps/controller/src/drivers/compute/protected-execution-driver.ts)                                | Current orchestration requires Harness-specific provisioning and enrollment.                                                                                                       |
| [OpenShell proxy adapter](https://github.com/openclaw/openclaw-enterprise/blob/5dae426ec5c591b43609a4b50c154016e2c5483c/apps/controller/src/drivers/egress-proxy/openshell.ts)                                               | Source-bound protected policy, one-host/one-binding restrictions, and credential/execution middleware.                                                                             |
| [OpenShell capability registration](https://github.com/openclaw/openclaw-enterprise/blob/5dae426ec5c591b43609a4b50c154016e2c5483c/apps/controller/src/drivers/egress-proxy/openshell-registration.ts)                        | Existing selected Backend pairs Sandbox and proxy capabilities.                                                                                                                    |
| [OpenShell destination rules](https://github.com/openclaw/openclaw-enterprise/blob/5dae426ec5c591b43609a4b50c154016e2c5483c/apps/controller/src/drivers/sandbox/openshell-policy.ts)                                         | Ordinary Sandbox network additions use host/port/binary rules with TLS inspection skipped.                                                                                         |
| [OpenShell Sandbox adapter](https://github.com/openclaw/openclaw-enterprise/blob/5dae426ec5c591b43609a4b50c154016e2c5483c/apps/controller/src/drivers/sandbox/openshell.ts)                                                  | Current workload admission, Harness provisioning, and projection limits.                                                                                                           |
| [OpenShell ownership and limits](https://github.com/openclaw/openclaw-enterprise/blob/5dae426ec5c591b43609a4b50c154016e2c5483c/docs/reference/drivers/openshell-sandbox.md)                                                  | Per-Harness sandbox ownership and current qualification boundary.                                                                                                                  |
| [Backend configuration](https://github.com/openclaw/openclaw-enterprise/blob/5dae426ec5c591b43609a4b50c154016e2c5483c/packages/occ/src/backends.ts)                                                                          | One bundled OpenShell Backend selection, not one shared execution sandbox.                                                                                                         |

The proposal adds no implementation declarations to these files. In particular,
the current contracts do not contain the proposed Gateway destination selection,
Channel destination contribution, or Gateway-facing destination-only proxy port.

## Selected OpenShell release

The stock `v0.1.5` source archive matches the checksum selected by main:
`b627a526427197854f8ee1d783996e666e0bfd6b7a785b70df7709304d9b6f62`.

- [TLS-skip forwarding](https://github.com/NVIDIA/OpenShell/blob/v0.1.5/crates/openshell-supervisor-network/src/proxy.rs#L3038)
  uses a raw tunnel without TLS termination or credential injection.
- [Destination policy](https://github.com/NVIDIA/OpenShell/blob/v0.1.5/crates/openshell-supervisor-network/data/sandbox-policy.rego#L107)
  matches hosts and ports within the sandbox's policy.
- [Upstream address validation](https://github.com/NVIDIA/OpenShell/blob/v0.1.5/crates/openshell-supervisor-network/src/proxy/destination.rs#L277)
  connects using the validated addresses.
- [Host-side proxy entry point](https://github.com/NVIDIA/OpenShell/blob/v0.1.5/crates/openshell-supervisor-network/src/host.rs#L80)
  is a Rust integration API with loopback binding and no middleware support, not
  an existing remote Gateway-facing service.

These sources establish the reusable forwarding primitive and its limits. They
do not establish the missing OCE Gateway transport.
