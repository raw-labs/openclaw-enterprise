# Verify the experimental Gateway destination proxy

**Experimental — UNVERIFIED. Not supported for production.** This is a
contributor procedure for the draft [Gateway destination flow](../flows/gateway-outbound-destinations.md),
not an operator setup guide or passing result. Keep the experiment in draft;
do not merge it. [RFC-0024 acceptance](../../specs/rfcs/0024-gateway-outbound-proxy-reuse.md#required-evidence-and-current-status)
remains incomplete.

## Prepare authorized infrastructure and inputs

Run from the repository root in an isolated, disposable environment. Follow
[OpenShell Sandbox preparation](openshell.md#openshell-sandbox) first. The scenario
needs the installed dependency graph, Node.js, the built CLI, container engine,
k3d, kubectl, Helm, PostgreSQL roles and migrations, real OpenShell prerequisites,
and the exact approved Gateway/Harness images. A plain k3d cluster is insufficient.
Preserve the default kubeconfig, unrelated clusters, and shared databases.

Provide an existing authorized Codex credential and model through protected
files, not command arguments or logs. The scenario uses the regular Agent
Credential Gateway for Harness authentication; destination-only Credential Proxy
selection must not receive or mint that credential. Use an enforcing container
network interface (CNI), trusted label/policy writers, and a prepared cluster whose
Service, Pod, node, control-plane, and metadata ranges are known.

Create a private JSON file outside the checkout. Set
`OCC_TEST_QA_GATEWAY_DESTINATIONS_CONFIG` to its absolute path. Its fields are:

| Field                                                               | Required value                                                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `credentialProxy`                                                   | Selected registration object: `id` and `configuration.gatewayDestinations`; the bundled parser selects OpenShell.                                            |
| `credentialProxy.configuration.gatewayDestinations.policyRulesPath` | Absolute controller-readable path to unchanged pinned `deploy/runtime/gateway-proxy/sandbox-policy.rego`. It must exist in both API and worker environments. |
| `credentialProxy.configuration.gatewayDestinations.supervisorImage` | Exact pinned stock supervisor reference in `STOCK_GATEWAY_PROXY`.                                                                                            |
| `credentialProxy.configuration.gatewayDestinations.relayImage`      | Exact pinned stock socat reference in `STOCK_GATEWAY_PROXY`.                                                                                                 |
| `credentialProxy.configuration.gatewayDestinations.blockedCidrs`    | Nonempty IPv4 CIDR list covering actual infrastructure networks, including public-addressed infrastructure where applicable.                                 |
| `allowedUrl`                                                        | Public HTTPS URL on TCP/443 with an exact DNS hostname and an independently controlled response body.                                                        |
| `forbiddenUrl`                                                      | Different public HTTPS DNS hostname on TCP/443 that must be refused.                                                                                         |
| `forbiddenPort`                                                     | Integer from 1 to 65535, other than 443, that must be refused for the allowed host.                                                                          |
| `responseMarker`                                                    | Expected independent upstream marker, 8–120 ASCII letters, digits, underscores, or hyphens.                                                                  |

Read the exact image values from
[the selected implementation](../../apps/controller/src/drivers/egress-proxy/gateway-destinations.ts),
not a moving tag. The stock source pin is
`bdb956f2cd65a635f1294fccf1d138d263bf650f`. Probe URLs must have no credentials,
fragment, IP literal, or wildcard. Use endpoints authorized for these requests.
The test adds only `allowedUrl`'s host to trusted Compute administrator destinations;
its current fixture has no enabled Channel contribution.

Prepare the OpenShell lane's private Sandbox file environment and supply:

- `OCC_TEST_QA_SANDBOX_ENV`: absolute path to its Sandbox test `--github-env` output.
- `OCC_TEST_QA_CODEX_TOKEN_FILE`: protected file with the authorized Codex token.
- `OCC_TEST_QA_GATEWAY_DESTINATIONS_CONFIG`: the JSON file above.

Do not interpret a nonempty `blockedCidrs` list as evidence that the ranges are
complete or the cluster enforces them. Inspect all matching NetworkPolicies:
Kubernetes allows are additive, so a deny-all policy cannot cancel a broad allow.

## Run the explicit scenario

This scenario is excluded from `OCC_TEST_QA_SCENARIOS=all` and is not an automatic
advisory qualification. Select it explicitly after preparation:

```sh
OCC_TEST_QA_MATRIX=1 OCC_TEST_QA_INSTALLATION=kubernetes \
OCC_TEST_QA_PRESET=Codex OCC_TEST_QA_SCENARIOS=gateway-destinations \
  node --test tests/integration/qa-matrix-real.test.mjs
```

The matrix helper passes the JSON path to
`OCC_TEST_OPENSHELL_GATEWAY_DESTINATIONS_CONFIG`, selects
`OCC_TEST_OPENSHELL_SCENARIO=gateway-destinations`, and runs the real case
`OpenShell Agent Gateway destination proxy lifecycle` in
[the Sandbox integration file](../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs).
This is a separate process using the prepared file environment, not a simulated
proxy. Missing selected prerequisites must fail. Omitting the matrix opt-in skips
the suite and provides no evidence.

Expected completion: the selected real case passes with zero skips. The wrapper
requires `# pass 1` and `# skipped 0` and stores a sanitized
`gateway-destinations-runtime.log` in the matrix artifacts directory. Record the
source commit, dirty-source status, actual image digests, cluster/CNI configuration,
command, case counts, and cleanup result with the evidence. Keep logs private
until reviewed for credentials and private data.

The fixture contains assertions for:

- persisted revision admission and exact policy files; separate Gateway, Harness,
  and proxy Pods without moving workloads or copying model credentials;
- CONNECT from the Gateway to the allowed HTTPS upstream, certificate-verified
  forwarding, and the independent response marker; forbidden host/port refusal;
- a reachable public TCP/443 positive control from the proxy Pod followed by
  direct raw-IP TCP/443 denial from the Gateway with proxy variables removed;
- cross-Agent frontend denial and stale-revision endpoint withdrawal, replacement, workspace
  access, a real model turn, proxy outage with no direct fallback, and stop cleanup.

These describe assertions in source, not successful outcomes. A failed positive
control, pending attachment, or skipped case cannot establish denial enforcement.

## Complete the deferred acceptance cases

Even a passing current scenario does not cover the complete RFC. Keep these
acceptance conditions open until evidence exists for the final implementation:

- Stock image startup, loopback listener restriction, policy asset hash, relay
  compatibility, and exact observed image identity under the selected runtime.
- Real Channel traffic, including Slack Socket Mode WebSocket rotation and
  single-label wildcard behavior, with exact administrator hosts still enforced.
- Wrong-policy, tampered attachment, missing capability, and changed-registration
  refusal through regular admission, worker retry, and activation.
- Bad upstream certificate rejection; public names resolving to private,
  loopback, link-local, metadata, Service, Pod, node, or control-plane addresses.
- Direct HTTP, UDP/QUIC, IPv6 where enabled, alternate proxy and raw-IP attempts
  from the actual Gateway, with independent reachable positive controls.
- Long-lived CONNECT/WebSocket termination during replacement and stop, measured
  after fencing; no old or foreign revision can retain or regain access.
- Required Harness/model/workspace transport before and after replacement,
  exact reciprocal selectors, and every additive network grant in the real cluster.

The stock supervisor/relay Docker test passes, and Compute conformance, typecheck,
lint, and scoped formatting run with the local dependency graph. These checks
do not qualify CNI enforcement, credential placement, or Agent cleanup.
Real Agent execution is **not run**: no prepared cluster, kubectl, k3d, authorized
model credentials, or public probe endpoints are available. The normal dedicated
lifecycle stops predecessors before preparing replacements; the scenario proves
stale-endpoint withdrawal, not simultaneous cross-revision CNI isolation.

## Clean up and diagnose failures

The scenario owns its Agent resources; the preparation owner owns the disposable
lane. Always run the [OpenShell cleanup command](openshell.md#openshell-sandbox),
including after a failed run. Verify Gateway and proxy Pods, revision Services,
ConfigMaps, Deployments, NetworkPolicies, Harnesses, and run-owned data are gone.
Remove only the run's cluster and files. Never remove unrelated infrastructure.

If preparation waits, inspect stock proxy/relay logs, readiness, policy hashes,
image identities, and peer labels. A denied readiness CONNECT is expected; it
must not be mistaken for a working allowed upstream. If allowed traffic fails,
check reciprocal selectors and the complete CNI policy set before changing policy.
Do not broaden egress to make a failing scenario pass. Retain redacted failure
and cleanup evidence, and record the missing acceptance condition in the
[implementation plan](../../specs/plans/0024-gateway-outbound-proxy-reuse.md).
