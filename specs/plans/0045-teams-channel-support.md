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

## Current refresh and admission repair (2026-11-05)

The source refresh merges upstream `b891554203643c769f19d71860d03382bb9717bc`
without rewriting published history. It retains the typed Console owners,
serving-revision routing and current runtime source pin. Refresh commit
`24ce51f702664d3f3fc450bb9b1b7c563664e267` records the initial delivery.

The follow-up checks Teams callback routing at deployment admission, before a
worker can stop a predecessor. Draft save remains allowed. The existing native
channel Compute case fails before this repair with a missing expected exception;
the full repaired Compute suite passes 405/405 without skips. The supported real
PostgreSQL/K3d provisioning file passes 2/2 without skips, including refusal of
Teams with missing Installation callback routing through the actual API's
409 conflict contract, before provisioning admission. Its public message is
intentionally generic. The initial assertion expected a private Driver diagnostic
and was corrected to the existing public contract.

An attempted additional callback-Pod case lacked Gateway API/Envoy CRDs in this
fixture lane and was removed in favor of extending the existing supported case.
These results do not prove live public callback delivery or preservation of a
serving callback Pod in this PR's fixture run.

Initial refresh evidence remains recorded in the PR: actual Chromium/WebKit
channel browser checks 41/41; directory/runtime assets 26/26; API compatibility
2/2; native image build checks 35 plus 99 Control UI cases and both type graphs;
selected native Teams SDK rejection/guarded-media checks 2/2. The broad
Compute/proxy/Helm run passed 529/530, then the repaired affected fixture passed
1/1, not a single all-green 530-case run. The
[Console gallery](https://gist.github.com/miguelbranco80/00cb9c549d8533c31eeb77935a9687e1)
contains 14 states and a 21.44-second interaction recording using simulated state.
Console and native image inputs are unchanged by this admission repair.

Independent Codex review of the full refreshed diff at
`95f24e2b12c0075475cb693f00f0cbc3103f1f0a` completed two passes with no
actionable P0–P2 findings. Types, full lint, format, workspace, CI inventory,
docs and flow checks passed; the 17-node flow rendered without errors and was
visually inspected. Later changes record this result only. Exact-final-head native
qualification on both architectures, approved live Teams messages/attachments,
production public Envoy ingress and required CI remain before-merge holds.

## Original local verification record

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
