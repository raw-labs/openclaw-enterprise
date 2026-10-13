# Verify Teams channel support

Build the runtime and run its Teams startup test:

```sh
docker build -f deploy/runtime/Dockerfile -t oce-runtime:teams .
OCC_TEST_RUNTIME_IMAGE=oce-runtime:teams node --test \
  --test-name-pattern='bundled Teams' tests/integration/runtime-image-startup.test.mjs
```

This case starts the real bundled plugin and Microsoft Teams SDK in a fresh,
network-disabled runtime container. Synthetic credentials prove dependency
closure, native callback registration, rejection of missing and forged bearer
tokens, and absence of the legacy webhook listener. They do not prove Microsoft
tenant access, proxy connectivity, model execution, or replies.

`tests/browser/console-agent-channels.test.mjs` exercises the regular console
workflow through the development HTTP API: save separate personal and channel
access, bind a Namespace Secret, grant Agent access, and retain the native
plugin selection. Its directory case uses the real API, OCC, IAM, Secret Driver,
and bundled Channel Driver with a local HTTP Microsoft protocol fixture. It
selects names, saves native IDs, and preserves manual entry after consent denial.
`tests/integration/teams-directory.test.mjs` additionally checks Team-scoped
requests, pagination, foreign continuation rejection and response sanitization.
These fixtures do not prove live Graph authentication or RSC consent. Before
qualifying lookup, install the revised app in a disposable Team and verify
channels and members with the two RSC permissions, then confirm a second Team
without consent is denied. Storybook's `Components/Channels/Teams*` stories are simulated
UI evidence, not deployment proof.

Run `node --test tests/integration/production-kubernetes-packaging.test.mjs`
with Helm and yq installed to verify the opt-in TLS listener, explicit ingress
peers, proxy flag, and rejected conflicting settings. This checks real rendered
chart output, not live Envoy policy enforcement.

The existing retirement case in `tests/conformance/kubernetes-compute.test.mjs`
also exercises serving/candidate callback ownership, exact method/path/header
rules, cutover, and disable cleanup through the production Driver with a
substituted Kubernetes transport. Its manifest assertions do not prove public
requests traverse Envoy. `tests/conformance/slack-proxy-tunnel.test.mjs` runs the
actual proxy process; test-only DNS redirects provider names to disposable local
sockets and cannot establish Microsoft connectivity.

Before accepting production support, use a disposable real Teams bot and tenant
with the [operator setup](../guides/integrations/teams.md). Verify a permitted
personal message, a channel mention and threaded reply, denied senders, a
missing mention, wrong app/tenant tokens, and missing password bindings. Verify
through the public Envoy listener that other methods, neighbouring paths,
administrative paths, and forged OCE identity headers cannot grant access.
Repeat messaging after revision cutover and ensure stop/delete removes the
callback and its SecurityPolicy. Confirm the password exists only in the
Agent-owned Gateway, and direct provider egress remains denied.

These live Teams and public-ingress checks remain pending until a test tenant,
public certificate/endpoint, and authorized model credentials are provided.
Do not substitute a fabricated Microsoft request for successful delivery.
