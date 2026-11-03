---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: Temporary channel trial in embedded OpenClaw

- **ID:** RFC-0019
- **Created:** 2026-11-03
- **Draft implementation:** [PR #17](https://github.com/raw-labs/openclaw-enterprise/pull/17)

## Summary

Allow an Installation administrator to opt into a temporary Slack/Teams trial in
embedded OpenClaw. Keep default refusal. The operator must understand that the
Gateway, native model loop, plugins and tools share the Agent's credential boundary.
This is not production support or equivalent isolation to dedicated execution.

## Problem and scope

Embedded OpenClaw lets operators evaluate native models and channel integrations
in one workload. The initial trial supports OpenAI and
Anthropic API keys and model selection within the primary provider. It does not
add arbitrary providers, native Connections/Composio installation or persistence,
a Sandbox engine, or a new deployment API.

Teams requires the native plugin package and a public HTTPS callback with
Microsoft authentication. These must be configured before enabling Teams on an
Agent.

## Proposal

### Trusted opt-in

Add Kubernetes Compute option
`runtime.channels.experimentalEmbeddedChannels: true`. It defaults to false.
Only trusted Installation configuration may enable it; Agent native JSON cannot.
Advertise embedded provisioning only when enabled. Check the option at admission,
preparation and activation, through the ordinary API/worker lifecycle.

Keep exact IAM checks, same-Namespace Secret grants, immutable revision ownership,
Pod controls and audit. The option grants neither another Agent's Secrets nor
new cross-tenant network or Kubernetes authority.

### Accept the shared trust boundary

In embedded mode, the Agent's channel credentials and selected model credential
are available within the same workload as native plugins and tool execution.
An admitted message sender can influence that model. Sender allowlists and native
tool policies limit behavior; they do not isolate those credentials from the
combined workload. The trial does not provision an additional native Sandbox.

Treat the combined workload as able to read its own projected credentials.
Changing a sender or tool allowlist does not create a separate credential boundary.

### Networking and callback ownership

Reuse the trusted channel `proxyUrl` and managed-proxy configuration. Process-wide
proxy settings affect native model and integration clients as well as channels.
A Slack-only or Microsoft-only proxy may deny model, catalog and integration
hosts. Operators must explicitly approve needed destinations; the trial does not
silently widen the stock proxy. Existing direct embedded egress may bypass proxy
environment settings, so this is not proxy-enforced containment.

Teams needs a separately configured public HTTPS listener, exact Agent POST
route and native SDK authentication. Remove OCE identity headers. Route ownership
follows the serving revision; a candidate cannot remove its predecessor's callback.
Enabling the flag alone does not supply certificates, provider registration,
network reachability or plugin packages.

### Disable and remove

Disabling the option refuses later admission/preparation/activation; it does not
revoke a running Pod's credentials. Stop/delete must still work while disabled.
To end the trial, restore default refusal, stop trial Agents and separately revoke
or rotate provider credentials. Stopping retains private Gateway state and
Namespace Secrets; it is not a credential-cache wipe.

Remove the flag, exception, provisioning advertisement and trial documentation
once a supported dedicated native path supplies the needed models/integrations.
Retain Teams support for Dedicated Agents.

## Required verification

Verify default refusal, trusted opt-in, credential placement, Secret denial,
replacement, callback ownership, disablement and stop/delete through the actual
API/worker path.

Verify provider authentication, Teams token rejection, public TLS, native model
execution and Slack/Teams message delivery using the packaged runtime and real
provider endpoints. Lifecycle fixtures and local proxy tests do not replace
these checks.

## Alternatives

Waiting for dedicated native support avoids this exposure but delays evaluation.
Treating embedded mode as fully supported would hide the credential tradeoff.
The proposed opt-in makes the shared boundary explicit and limits its use to
a removable evaluation feature.
