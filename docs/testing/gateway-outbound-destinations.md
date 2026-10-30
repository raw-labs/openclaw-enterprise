# Verify the experimental Gateway destination proxy

**Experimental — partially verified. Not supported for production.** This is a
contributor procedure for the draft [Gateway destination flow](../flows/gateway-outbound-destinations.md),
not an operator setup guide or passing result. Keep the experiment in draft;
do not merge it. [RFC-0024 acceptance](../../specs/rfcs/0024-gateway-outbound-proxy-reuse.md#required-evidence-and-current-status)
remains incomplete.

## Choose the execution scope

Normal dedicated Codex execution does not require an OpenShell Harness. For
Gateway networking, `drivers.credential_proxy.usage: gateway` selects the paired
proxy capabilities without selecting OpenShell for Harness execution or model
credentials. Kubernetes Compute keeps the Harness and its Agent-owned credential
Secret. The installation profile renderer accepts this pair through `gatewayProxy`;
see the [source flow](../flows/gateway-outbound-destinations.md#execution-trace).

The explicit scenario below currently selects an OpenShell Harness as well as
Gateway networking. Its protected-source prerequisites apply to that combination,
not to normal dedicated execution with a Gateway-only proxy. Do not use a passing
Gateway-only run as proof of protected OpenShell Harness execution. Neither path
is qualified by installation readiness alone.

## Prepare authorized infrastructure and inputs

Run from the repository root in an isolated, disposable environment. Follow
[OpenShell Sandbox preparation](openshell.md#openshell-sandbox) first. The scenario
needs the installed dependency graph, Node.js, the built CLI, container engine,
k3d, kubectl, Helm, PostgreSQL roles and migrations, real OpenShell prerequisites,
and the exact approved Gateway/Harness images. A plain k3d cluster is insufficient.
Preserve the default kubeconfig, unrelated clusters, and shared databases.

Provide an existing authorized Codex credential and model through protected
files, not command arguments or logs. The scenario uses the regular Agent
Credential Gateway for Harness authentication. The selected Credential Proxy also
admits Gateway policy; its separate Gateway proxy Pod must not receive Harness
credentials. Use an enforcing container
network interface (CNI), trusted label/policy writers, and a prepared cluster whose
Service, Pod, node, control-plane, and metadata ranges are known.

Prepare an authenticated TLS OpenShell Backend and an execution-authority
configuration before selecting this scenario. The scenario uses the bundled
Backend and Sandbox implementations directly. It does not install the legacy
fixture's unauthenticated HTTP gateways or inject replacement management clients.
The Backend must be reachable from the test process and its advertised Harness
endpoint must be reachable from the Agent Gateway. Supply certificate and key
**paths**, never PEM private keys or tokens in JSON. Keep the authority listener's
certificate, issuer, and bind address consistent with this test process. If the
run selects protected sources, the prepared supplier must also reach that listener.
The required execution-capable Credential Proxy routes OpenAI API-key sources
through protected source admission. Those sources need negotiated protected
execution middleware; configured authority and Backend TLS do not establish that
capability. Stock OpenShell refuses source registration in this execution-capable profile,
so this scenario requires a reviewed candidate pair. Do not disable capability
negotiation or report a Gateway-only run as proof of this profile. A Gateway-only
run instead uses normal dedicated Harness authentication and tests a different
execution scope.

Create a private JSON file outside the checkout. Set
`OCC_TEST_QA_GATEWAY_DESTINATIONS_CONFIG` to its absolute path. Its fields are:

| Field                                                               | Required value                                                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `credentialProxy`                                                   | Selected OpenShell registration object: `id`, its protected-operation configuration, and `configuration.gatewayDestinations`.                                |
| `credentialProxy.configuration.gatewayDestinations.policyRulesPath` | Absolute controller-readable path to unchanged pinned `deploy/runtime/gateway-proxy/sandbox-policy.rego`. It must exist in both API and worker environments. |
| `credentialProxy.configuration.gatewayDestinations.supervisorImage` | Exact pinned stock supervisor reference in `STOCK_GATEWAY_PROXY`.                                                                                            |
| `credentialProxy.configuration.gatewayDestinations.relayImage`      | Exact pinned stock socat reference in `STOCK_GATEWAY_PROXY`.                                                                                                 |
| `credentialProxy.configuration.gatewayDestinations.blockedCidrs`    | Nonempty IPv4 CIDR list covering actual infrastructure networks, including public-addressed infrastructure where applicable.                                 |
| `infrastructureCidrs`                                               | Independent Compute IPv4 infrastructure ranges; must include actual Pod, Service, node, control-plane, metadata and public-addressed infrastructure.         |
| `allowedUrl`                                                        | Public HTTPS URL on TCP/443 with an exact DNS hostname and an independently controlled response body.                                                        |
| `forbiddenUrl`                                                      | Second Agent's public HTTPS DNS hostname on TCP/443; the first Agent must refuse it until replacement.                                                       |
| `forbiddenPort`                                                     | Integer from 1 to 65535, other than 443, that must be refused for the allowed host.                                                                          |
| `peerResponseMarker`                                                | Second upstream's independent response marker, 8–120 ASCII letters, digits, underscores, or hyphens.                                                         |
| `responseMarker`                                                    | Expected independent upstream marker, 8–120 ASCII letters, digits, underscores, or hyphens.                                                                  |

The same JSON must also include these prepared Installation fields:

- `openShellBackend`: the Backend's configuration object, with its real HTTPS
  endpoint, `mtls` or `bearerTokenFile` identity, and public root certificate path.
- `sandboxConfiguration`: the paired Sandbox's configuration object, including
  operator Workspace resources, tenant networking and actual Harness mount paths.
  Use the maintained launcher's token-free `openshell-sandbox` workload
  ServiceAccount. Omit local `gateway.readiness` and fixed
  `kubernetes.sandboxDataMount.claimName` values: the real health RPC checks the
  shared Backend, and Compute selects each Agent's workspace PVC.
- `providerHarness`: Compute's endpoint object with the OpenShell gateway's
  `namespace`, exact `podLabels`, Service IPv4 `address` and listener `port`.
- `thinkingDefault`: optional explicit reasoning level for the real model turn.
  For a low-reasoning run, set it to `low` and select the model with
  `OCC_TEST_OPENAI_MODEL`.

Read the exact image values from
[the selected implementation](../../apps/controller/src/drivers/egress-proxy/gateway-destinations.ts),
not a moving tag. The stock source pin is
`bdb956f2cd65a635f1294fccf1d138d263bf650f`. Probe URLs must have no credentials,
fragment, IP literal, or wildcard. Use endpoints authorized for these requests.
The test creates both Agents with empty lists, then uses each Agent's API update
to approve its own host. Its current fixture has no enabled Channel contribution.

Prepare the OpenShell lane's private Sandbox file environment and supply:

- `OCC_TEST_QA_SANDBOX_ENV`: absolute path to its Sandbox test `--github-env` output.
- `OCC_TEST_QA_CODEX_TOKEN_FILE`: protected file with the authorized Codex token.
- `OCC_TEST_QA_GATEWAY_DESTINATIONS_CONFIG`: the JSON file above.

Do not interpret a nonempty `blockedCidrs` list as evidence that the ranges are
complete or the cluster enforces them. Inspect all matching NetworkPolicies:
Kubernetes allows are additive, so a deny-all policy cannot cancel a broad allow.

## Run the attachment regression without model credentials

The real Kubernetes attachment test needs an explicit disposable loopback k3d
kubeconfig and context. It uses the production attachment and SDK against the
real API, checks stored ingress peers, and refuses a valid broadened peer rule.
It is registered in the ordinary k3d state lane.

For live traffic, also select an approved Gateway runtime image already imported
into that cluster. Import the pinned supervisor and relay images first. The
selected image must support Node environment proxy settings. No Slack or model
credential is needed:

```sh
OCC_TEST_KUBERNETES_KUBECONFIG="<private kubeconfig path>" \
OCC_TEST_KUBERNETES_CONTEXT="<k3d context>" \
OCC_TEST_KUBERNETES_GATEWAY_IMAGE="<approved imported Gateway image>" \
  node --test tests/integration/gateway-proxy-kubernetes-real.test.ts
```

Without `OCC_TEST_KUBERNETES_GATEWAY_IMAGE`, the case proves only API
creation, read-back and tamper refusal. With it, the case requires stock proxy
readiness, successful ClawHub HTTPS, denied-host refusal, foreign-Pod refusal,
private egress denial with a reachable TCP control, and production attachment
removal. An unavailable selected image or failed control fails the test.
The case deletes its own namespace. The preparation owner must delete the
run-owned cluster and imported layers afterward.

These are attachment component checks with real native clients and networking.
They do not deploy an Agent through the API and worker, run the Gateway server,
or qualify Compute-generated Gateway direct-egress restrictions. Keep the full
workflow and remaining acceptance cases below open.

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
- the Gateway image's default Node fetch and HTTPS clients through Compute-projected
  proxy settings, without a handcrafted CONNECT or injected dispatcher; this does
  not prove the separate native Slack Socket Mode client;
- a reachable public TCP/443 positive control from the proxy Pod followed by
  direct raw-IP TCP/443 denial from the Gateway with proxy variables removed;
- different API-authored hosts on two Agents, mutual host and frontend denial,
  saved policy after a desired-setting edit, and changed grants on replacement;
- stale-revision endpoint withdrawal, workspace access, a real model turn,
  proxy outage with no direct fallback, and stop cleanup.

These describe assertions in source, not successful outcomes. A failed positive
control, pending attachment, or skipped case cannot establish denial enforcement.

## Complete the deferred acceptance cases

Even a passing current scenario does not cover the complete RFC. Keep these
acceptance conditions open until evidence exists for the final implementation:

- Stock image startup, loopback listener restriction, policy asset hash, relay
  compatibility, and exact observed image identity under the selected runtime.
- Approved non-Slack HTTPS that the bundled Slack proxy refuses. For every dedicated single-cluster
  Gateway, prove that its old Slack-proxy route is replaced, not chained, and the
  old Channel egress grant cannot bypass the new policy.
- Preserved Slack messaging and Socket Mode WebSocket rotation through the new
  Gateway route, including single-label wildcard behavior. Independently prove
  API token validation/directory lookup still work before and alongside Agent
  deployment through the existing Slack proxy. This PR does not remove that Deployment.
- Wrong-policy, tampered attachment, missing capability, and changed-registration
  refusal through regular admission, worker retry, and activation.
- Bad upstream certificate rejection; public names resolving to private,
  loopback, link-local, metadata, Service, Pod, node, or control-plane addresses.
- Direct HTTP, UDP/QUIC, IPv6 where enabled, alternate proxy and raw-IP attempts
  from the actual Gateway, with independent reachable positive controls.
- Required Harness/model/workspace transport before and after replacement,
  exact reciprocal selectors, and every additive network grant in the real cluster.

The stock supervisor/relay Docker test passes. Agent API and real PostgreSQL
authoring tests also pass. The [plan](../../specs/plans/0024-gateway-outbound-proxy-reuse.md#verification-evidence)
records current results. The attachment regression provides only the CNI checks
named above; it does not qualify full Agent credential placement or cleanup.
A manual real-cluster run on October 30, 2026 exercised normal dedicated Codex
with Gateway-only proxy selection through the Agent API and worker. It passed a
`gpt-6.1-sol` model turn with low reasoning, Harness-only model credential
projection, native ClawHub search/detail/catalog calls, allowed HTTPS, denied
host and port, and direct-IP denial with a reachable same-address/port control
from the proxy Pod. Proxy outage refused traffic without direct fallback;
recovery restored traffic. Replacement withdrew the old proxy resources, allowed
the new destination, refused the removed destination, and passed another model
turn. These observations do not qualify the separate OpenShell Harness scenario
or the deferred acceptance cases above.

A subsequent normal dedicated run used the launcher-generated Gateway pair,
without an Installation amendment. Two API-created Agents reached their own
approved hosts and were denied each other's hosts and proxy frontends. An external
TLS client held CONNECT/WebSocket tunnels through each actual Gateway network
namespace and revision proxy, with unique upstream echoes before lifecycle actions.
Replacing and stopping one Agent closed its existing tunnels while the other
Agent continued exchanging echoes and reaching its approved host. This measures
client-observed connection closure, not authenticated Slack behavior. The
observer did not add network grants or replace the policy engine.

The normal dedicated lifecycle stops predecessors before preparing replacements;
it does not create simultaneous same-Agent revision workloads. Record source,
image identities, commands, connection timings and cleanup in the PR. These
manual observations do not make the separate OpenShell Harness QA scenario pass.

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
