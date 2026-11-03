---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: Managed outbound HTTPS for dedicated Gateways

- **ID:** RFC-0019
- **Created:** 2026-11-03
- **Implementation candidate:** [Fork PR #18](https://github.com/raw-labs/openclaw-enterprise/pull/18)

## Summary

Let administrators approve external TCP/443 connectivity for trusted software
inside a dedicated Gateway. Kubernetes Compute supplies a mandatory HTTP CONNECT
proxy for each revision that needs it. Replace the Slack-specific route with
this generic transport while keeping model credentials and Harness networking
with their existing owners.

## Problem and scope

Native plugins and integrations need external destinations that the existing
Slack-only proxy does not admit. Plugin manifests do not describe every host
that their code may contact. OpenClaw Enterprise (OCE) needs an explicit Agent
network policy, not an implicit grant caused by installing a plugin.

This is the proxy-based proposal in implementation #18, not the later experiments
that place a Gateway inside OpenShell. Plugins remain trusted Gateway code with
native credentials. This does not isolate plugins, mediate credentials, add Teams
support or change embedded networking.

## Proposal

### Access and authority

Store `gatewayOutbound` on the OCE Agent, outside native Configuration JSON:

| Mode                     | Gateway access                                                 |
| ------------------------ | -------------------------------------------------------------- |
| `channelsOnly` (default) | Only requirements declared by enabled supported channels.      |
| `restricted`             | Channel requirements plus exact approved DNS hosts on TCP/443. |
| `publicHttps`            | Public TCP/443, subject to address exclusions.                 |

The Installation sets the ceiling, disables public mode by default, and supplies
infrastructure exclusions. Operators must include actual cluster, API-server,
node and database addresses, including infrastructure with public addresses.
There is no private-network exception.

Trusted Channel Drivers declare management and Gateway destinations. Disabling
a channel removes its contribution on the next deployment; it does not remove
separately approved hosts. Compute declares and validates supported capabilities;
OpenClaw Control Plane (OCC) does not hardcode Kubernetes or vendor host lists.

Changing the selection requires both `update` and `administer` on the exact Agent.
Deployment retains `deploy`, credential/reference checks and current worker
authorization. Agent JSON and plugin installation cannot widen network access.

### Revision routing

Deployment freezes the selection, channel requirements and Installation exclusions
in the immutable revision. Compute prepares a revision-owned proxy Deployment,
Service, nonsecret policy and NetworkPolicies before starting the Gateway. Only
that Gateway may use it; Agents do not pool permissions. The proxy gets no
provider credentials, workspace, persistent state or Kubernetes API token.

Give the Gateway one mandatory external proxy route and exact exceptions for
approved internal endpoints. Do not grant direct public TCP/443. Caller-supplied
proxy settings cannot replace the route. Clients that ignore it fail rather than
bypass policy; unsupported selections or failed preparation have no fallback.

CONNECT accepts only port 443. Check the destination policy, resolve trusted DNS,
reject the whole answer set if any address is forbidden, and connect to a checked
public IPv4 address. Exclude private, loopback, link-local, metadata, shared,
multicast and reserved ranges plus Installation exclusions. Restricted mode uses
exact DNS names; public mode may also use checked public IPv4 literals. IPv6-only
targets are unsupported. Each new tunnel, including one needed after a redirect,
repeats admission.

TLS stays end-to-end with native certificate checks. The proxy cannot inspect
HTTP actions or encrypted WebSocket traffic. Port 443 permission is not proof of
HTTPS and does not prevent disclosure to an allowed host.

### Changes and cleanup

Saving updates desired state; deployment applies a new revision. The Console
shows required channel destinations, additional access, saved versus deployed
policy and useful readiness/denial results, without exposing infrastructure knobs
or credentials.

Combine admitted exclusions with current restrictions. Loosening Installation
policy must not broaden old revisions. Tightening it closes affected established
tunnels before reporting the change applied; a reconciliation interval alone is
not a withdrawal deadline.

On terminal loss of required deployer, credential, backend or Sandbox authority,
record withdrawal durably before removing infrastructure. Retries/restarts must
finish it even if authority returns; restoration requires a newly authorized
revision. Preserve related public-GitHub-reader withdrawal obligations where
admitted. Normal stop keeps the proxy while the Gateway drains, then removes it.
Cleanup acts only on its revision and must not delete a successor or leave old
Agent-wide channel connections alive.

### Requests before Gateway creation

Credential checks and directory lookup need a separate, restricted OCC API proxy
using the same transport implementation. Only trusted Driver management
requirements set its destinations; Agent grants cannot widen them. Preserve
existing internal/database transports and Slack behavior when replacing the
vendor-specific proxy.

## Alternatives and operating cost

A revision proxy makes policy and tunnel ownership explicit, at the cost of an
extra process and Kubernetes objects per live/prepared revision. Replacement
interrupts connections; clients must reconnect. A shared proxy reduces overhead
but needs trustworthy client-to-policy mapping and selective tunnel withdrawal.
Direct public egress cannot express hostname rules with standard NetworkPolicy.
Gateway containment through OpenShell is a different placement/lifecycle design.

Prefer the revision topology for this proposal. The forwarding engine remains a
review choice: a maintained proxy is preferable if it meets the same address,
DNS-pinning, shutdown and logging requirements. The existing Node prototype is
not evidence that Envoy or Squid is already an equivalent configured replacement.

## Delivery, proof and open decision

The [existing plan](https://github.com/raw-labs/openclaw-enterprise/blob/a50b14647d4311764cce3359150149bc81f23431/specs/plans/0023-gateway-outbound.md) owns implementation work. Prove exact authorization,
PostgreSQL persistence, immutable admission, native proxy-aware requests, direct
socket denial, forbidden/mixed DNS answers, address pinning, cross-Agent isolation
and unchanged Harness credentials/networking. Tightening must close an established
tunnel; stale cleanup must preserve a successor. Qualify the API proxy separately.

Native clients with custom transports, live Slack/Teams, model execution and
protected Harness/credential-proxy composition need their own qualification.
Networking alone does not provide plugin installation or persistence.
Compute/network owners must approve the topology, operating cost and forwarding
engine; source availability or a clean merge does not establish that decision.

## Source and review status

Prepared from [candidate source `a50b14647`](https://github.com/raw-labs/openclaw-enterprise/blob/a50b14647d4311764cce3359150149bc81f23431) and its current documentation.
Candidate code exists in the linked implementation PR, not in this documentation
branch. `Not implemented` describes this review baseline; it does not erase the
candidate's delivery history or certify that the candidate meets this proposal.
Design approval and implementation qualification remain separate. This PR changes
neither the existing implementation nor the integration bundle.
