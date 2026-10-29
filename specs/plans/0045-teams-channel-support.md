# Implementation plan: Teams channel support

- **ID:** TASK-0045
- **Delivery status:** In progress
- **Owner:** Kubernetes Compute Driver, native OpenClaw runtime packaging, and console channel editors
- **Authority:** [Platform design](../../docs/design.md), existing Compute-owned gateway routing and Agent-owned Secret delivery
- **Source baseline:** `447c387b63c1b781fec03655f06c318caeb91e36`

## Outcome and scope

A Dedicated Agent can receive Microsoft Teams personal messages and mentions in
selected channels, then reply through the bundled native plugin. OCE exposes
essential access controls and an app-password Secret picker alongside Slack.
The Kubernetes Compute Driver owns the exact callback route, serving-revision
ownership, provider-only authentication override, and cleanup. Platform core
continues to consume the existing Compute and Secret contracts.

This first implementation targets Microsoft Public cloud and password-based
bot credentials. Directory lookup, attachment hosts, SSO, sovereign clouds,
federated credentials, and Teams approvers are deferred. Existing Slack behavior
and the OpenClaw source pin stay in scope for regression verification.

## Delivery and proof

- Bundle `msteams` and its locked dependencies using the same source assembly
  as Slack. Verify plugin discovery and actual SDK callback token rejection in
  the runtime-image integration suite.
- Extend the existing gateway-routing primitive with a separate callback
  listener and exact POST route. Preserve Microsoft Authorization while removing
  OCE administrative headers. Follow the serving Deployment's revision marker
  and remove callback resources during disable, stop, and deletion.
- Extend the chart's existing proxy with an opt-in list of exact Microsoft
  Public cloud hosts. Keep default Slack-only behavior and isolated gateway
  egress. Verify rejected destinations and retained Slack tunnels.
- Add the Teams editor through the shared channel save transaction and Secret
  authorization workflow. Exercise persistence through the real development
  API and inspect rebuilt Storybook states with screenshots and a short video.
- Update the [operator guide](../../docs/guides/integrations/teams.md), current
  configuration references, [flow](../../docs/flows/agent-channel-ingress.md), and
  [verification boundary](../../docs/testing/teams.md).

Full delivery requires live Teams messages and real public Envoy ingress,
including denied requests and lifecycle cutover/cleanup. A missing test tenant
or public endpoint leaves those checks pending and keeps the PR in draft.
Synthetic SDK rejection and fixture Kubernetes tests cannot replace that proof.

## Local verification record

On 2026-10-06, the regular console/API channel suite passed all 16 cases,
including authorized Teams password binding and retained independent access
policies. The real Helm packaging suite passed 34 cases. Kubernetes Compute
and proxy conformance passed 239 cases with one Linux-only argument-limit case skipped on macOS.
The four disposable real-cluster fixture cases passed without skips; they verify
existing API/worker/NetworkPolicy behavior, not native Teams messages or public
callback requests. Runtime-image integration separately verifies bundled SDK
registration and token rejection with networking disabled. Storybook previews
were rebuilt and all eight Teams states inspected; screenshots and a short
interaction video stay outside the checkout for PR attachment.

Build, lint, formatting, workspace/module boundaries, flow structure, and docs
length/navigation/link checks passed. These results do not remove the pending
live Microsoft and public ingress holds above.

## Change record

- 2026-10-06: Created from the verified upstream baseline for the raw-labs fork.
