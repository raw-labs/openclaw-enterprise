---
status: Proposed
implementation_status: Partially implemented
author: miguelbranco80
---

# Proposal: Temporarily trial channels in embedded OpenClaw

- **ID:** RFC-0023
- **Created:** 2026-10-14
- **Last updated:** 2026-10-14
- **Related:** [Harness execution](../../docs/reference/harness-execution.md),
  [runtime isolation](../../docs/reference/security/runtime-isolation.md),
  [RFC-0017](0017-agent-egress-0x/index.md).

## Decision requested

Permit an Installation administrator to enable an explicitly temporary evaluation
exception with Kubernetes Compute
`runtime.channels.experimentalEmbeddedChannels: true`. The default continues to
refuse embedded Slack and Teams. This proposal does not establish maintainer
acceptance, production support, or security equivalence with dedicated execution.

The exception belongs to trusted Installation configuration. Agent native JSON
cannot enable it or provision network infrastructure. The selected Compute Driver
also advertises embedded provisioning only when this option is enabled. Regular
API admission, provisioning, immutable revisions, Secret ownership, IAM and audit
remain the callers and owners; no alternate deployment API is introduced.

## Motivation and scope

Embedded OpenClaw can provide the native model loop and native integrations while
the dedicated native path remains experimental. This baseline admits OpenAI and
Anthropic API-key bindings. Other native providers remain blocked by Compute's
authentication resolver; ordinary selection stays within the primary provider.
The experiment does not switch to Codex, native workers or OpenShell, or modify
Assistant tools and Connections.

Fresh Teams packaging, Microsoft destination support, the public callback
listener/certificate and callback lifecycle are shared prerequisites. They are
implemented in a separate commit from this exception. Teams uses the pinned
upstream OpenClaw plugin and Microsoft SDK; it is not an OCE message engine.

## Trust and execution consequences

Every Agent keeps its own Gateway. Embedded execution combines that Gateway,
native model loop, native plugins and tool execution in one workload. Channel
passwords/tokens and the selected model credential consequently share its
environment and process/filesystem trust boundary. OCE cannot keep channel
credentials exclusively with a separate trusted Gateway in this topology.

Channel sender allowlists restrict message admission, not Kubernetes authority
or Secret custody. An admitted sender can influence the model operating in this
shared boundary. Native tool profiles, allow/deny policies and sender policies
can reduce functionality but do not establish credential isolation. The pinned
native exec schema offers `host` and `mode`/`security` controls and native Sandbox
configuration supports Docker-backed isolation; this experiment neither provisions
that engine nor proves its containment. Disabling one tool cannot establish that
all credential readers, plugin callbacks, file access or subprocesses are contained.

Existing Pod controls, Namespace isolation, exact IAM resource grants and revision
fencing continue to apply. The exception grants no other Agent's Secrets, broad
Kubernetes API authority or cross-tenant network access. It does increase exposure
within the opted-in Agent. Treat the entire combined workload as untrusted with
respect to its own projected credentials.

## Networking and lifecycle

The existing `runtime.channels.proxyUrl` and optional `managedProxy` own the route.
Channel enablement applies HTTPS proxy settings to the whole Gateway process,
including native integrations. Stock Slack-only or Microsoft-enabled proxy policy
denies Composio, ClawHub and model endpoints. Broad embedded public TCP/443 does not
make clients using that restrictive proxy succeed. An externally operated approved
proxy can provide the needed destinations without changing the stock policy for
other Installations. Its policy is shared destination authorization, not per-Agent
identity authorization. Embedded execution can also bypass process environment
settings and use its existing direct egress; this is not proxy-enforced containment.

Admission and preparation both consult the trusted option. An operator disabling
it prevents subsequent embedded channel admission/preparation/activation; existing
workloads must be stopped to withdraw their projections. Stop/delete remain
available with the option disabled. Restore default refusal, stop trial workloads,
then revoke/rotate credentials according to their provider procedures.

Teams additionally requires the independently configured public HTTPS listener.
Compute owns the exact Agent POST route, delegates JWT verification to the native
Microsoft SDK and strips OCE identity headers. Candidate preparation cannot claim
a predecessor's callback. Activation and cleanup follow the serving revision.
See the [source-backed flow](../../docs/flows/agent-channel-runtime.md).

## Delivery, verification and removal

The [implementation plan](../plans/0023-temporary-embedded-channel-trial.md)
records separate shared prerequisites, source delivery and qualification holds.

The evaluation implementation and regular API/worker Kubernetes fixture exercise
trusted opt-in, default refusal, Secret scope, credential projection, revision
replacement and stop/delete. Proxy tests exercise the real CONNECT process and
denial policy against loopback upstreams. Fixtures do not prove native provider
authentication, Teams JWT enforcement, public TLS or model execution. Live model
and Slack/Teams verification is excluded at the requesting user's direction.
Native image checks and independent review remain acceptance holds until recorded.

Use [trial setup](../../docs/guides/integrations/embedded-channel-trial.md) for the
trusted setting and [Teams setup](../../docs/guides/integrations/teams.md) for shared
prerequisites. Native plugin installation, approvals and persistence remain separate
gaps. Networking alone does not add packages or universal plugin support.

Remove the option, topology exception, embedded provisioning advertisement and
their trial documentation once a supported dedicated native path supplies the
required models and native integrations. Keep independently useful Teams work.
Responsible maintainers must decide whether any channel boundary exception is
acceptable before adoption; this branch remains an unsupported-production trial.
