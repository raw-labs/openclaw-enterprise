---
status: Proposed
implementation_status: Partially implemented
author: miguelbranco80
---

# Evaluate embedded Teams with per-Agent Envoy egress

An Installation operator wants embedded OpenClaw Agents to enable Teams independently.
The live trial will exercise Teams, a model reply and Connections on one Agent. The
[embedded trial](https://github.com/raw-labs/openclaw-enterprise/pull/17)
establishes the proposed credential boundary. The Gateway, model loop, plugins
and tools can all read the Agent's projected credentials. An operator who
enables the trial accepts that risk for each embedded Agent that enables Teams.

## Proposed decision

Keep the Installation-wide boolean `runtime.proxy.experimentalEmbeddedChannels`
from alpha.22, defaulting to false. With managed Envoy egress enabled, each
embedded Agent can enable Teams through its own Configuration. This setting
requires no Agent IDs. Other embedded channel combinations remain unsupported.

Operators separately approve exact model and plugin hostnames in
`runtime.channelEgress.embeddedHttpsHosts`. Omitting the list grants no additional
destinations. Native Agent JSON cannot change either Installation setting.

Use the existing Teams Driver for Secret validation and Teams destinations.
Compute adds the approved runtime names on port 443 to each Teams-enabled
embedded revision's [Envoy binding](../../docs/reference/drivers/kubernetes-compute/channel-egress.md).
The OCC directory listener and dedicated Gateway continue using their existing rules.
An approved host grants the whole shared process access to that endpoint.
The trial claims neither per-plugin network identity nor isolation of credentials
inside the process.

## Deployment and retirement

Before routing the public callback, Compute must verify the exact Envoy binding
and keep the embedded public TCP/443 grant off the bound Gateway. Preparation
can overlap with a serving revision. Adding or removing Teams must never give a
still-bound Pod the ordinary embedded public grant. Keep exact internal peers,
DNS, loopback and the existing checks for additive NetworkPolicies.

Pass Compute-owned proxy settings to both native model probe subprocesses and
the serving process. The [pinned model transport](https://github.com/openclaw/openclaw/blob/82b682c627ba8bfc2c2bd51cf46ad8f51c583857/src/agents/provider-transport-fetch.ts)
selects the environment proxy for eligible requests. Connections 0.3.1 uses global
fetch for its HTTPS requests. Verify both in the installed runtime.

Use the existing exact Teams callback and its native Microsoft authentication.
Route to the observed serving revision. Preserve the callback through replacement,
release old listener bindings after their source Pods and controllers retire,
and keep stop/delete usable if the operator withdraws the opt-in.

## Interface changes

### APIs

No changes.

### IAM

No changes. Existing grants on each same-Namespace Secret and the Agent apply.

### Database entities

No changes.

### Driver contracts

Kubernetes Compute reads its trusted Installation configuration during admission
and reconciliation. The existing Harness authentication hook suffices. The Channel Driver interface and Teams attachment host settings
retain their current meanings.

## Simplifications

The existing listener already enforces exact CONNECT authorities, restricts resolved
addresses and scopes network grants to a revision. Reusing it avoids a second
proxy or a new credential-handling service. A shared destination list across
all listeners would give unrelated workloads additional access.

## Acceptance Criteria

1. Default admission refuses embedded Teams. Opting in lets two embedded Agents independently enable
   Teams through their own configurations. Dedicated Teams retains its existing route and rules.
2. On a disposable enforcing cluster, verify a genuine signed personal-chat
   message and exact model reply before and after redeploy. Check direct public
   HTTPS, an unlisted destination and another Agent's listener are denied.
3. Add the packaged Connections plugin to the same Agent. Exercise an authorized
   read-only operation through the approved Composio host. Confirm a Teams reply
   and repeat the read with the retained grant after replacing the Gateway.

Record installed proof separately from source checks. Use disposable resources
and report only revision identities, sanitized outcomes and counts.
