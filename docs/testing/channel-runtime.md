# Verify channel deployment boundaries

Prepare the [disposable Kubernetes fixture](kubernetes.md#kubernetes-http-fixture)
and its dedicated migrated database. The channel case in
`tests/integration/kubernetes-compute-provisioning-real.test.mjs` uses the actual
authenticated API, PostgreSQL worker, Kubernetes Configuration/Secret Drivers and
Compute lifecycle. It verifies default rejection, trusted embedded opt-in, exact
Secret projections, revision replacement, callback disable/reenable and stop/delete.
Another Agent without Secret grants cannot deploy.

Install Gateway API and Envoy SecurityPolicy CRDs in the selected disposable
cluster before running this file. CI's `k3d-fixture-state` preparation installs
the real schemas from Envoy Gateway v1.6.7. It does not start a callback test
server or grant public access. Manual setup can install the same CRDs with Helm
`show crds oci://docker.io/envoyproxy/gateway-helm --version v1.6.7`, followed by
server-side `kubectl apply` against the explicit fixture kubeconfig/context.
Missing schemas fail the selected case rather than substituting a fake adapter.

The existing OpenClaw fixture CLI supplies model-probe protocol responses.
An explicit closed model endpoint prevents synthetic fixture credentials from
reaching a live provider. This case proves platform admission, persistence,
credential delivery and Kubernetes resource lifecycle. It does not prove genuine
OpenClaw startup, Teams JWT authentication, public TLS, channel delivery or model
execution. Route manifests alone do not prove installed Envoy enforcement.

The channel proxy conformance suite drives the actual CONNECT process against
loopback upstreams. Stock Microsoft denial and explicit Microsoft admission are
checked separately; Composio, ClawHub, model endpoints, private literals and
lookalike hosts remain denied. This is proxy policy proof, not plugin or model proof.

Live qualification requires branch-built native images, enforcing networking,
public callback DNS/certificate and authorized provider credentials and recipients.
Follow [Teams trial setup](../guides/integrations/teams.md) and the
[Slack verification guide](slack.md) before sending provider messages.
