---
status: Proposed
implementation_status: Not implemented
author: miguelbranco80
---

# Proposal: temporary test environments through Crabbox

- **ID:** RFC-0019
- **Created:** 2026-10-30
- **Last updated:** 2026-10-30
- **Implementation plan:** [Temporary test environments](../plans/0019-temporary-test-environments.md)

## Summary

Let an Agent run expensive tests on a temporary machine without moving its
Harness or conversation. Keep Crabbox's existing skill and CLI. Add an external
Crabbox provider adapter that asks OpenClaw Control Plane (OCC) to create and
manage the machine.

OpenClaw Enterprise (OCE) would own authorization, resource limits, isolation,
expiry and deletion. Crabbox would synchronize the checkout, execute commands
and return results. This is a proposed platform extension, not a supported
configuration today.

## Why this is useful

An Agent may need to build a large project or start a disposable k3d cluster
halfway through a conversation. Doing that on the Harness host competes with
other work for memory and CPU. Moving the entire session is unnecessary: only
the test needs another machine.

The intended user experience remains simple:

1. The user asks the Agent to test a change.
2. The Agent follows the Crabbox skill and invokes its CLI.
3. Crabbox obtains an OCE-managed environment, copies the current checkout and
   runs the test there.
4. The Agent receives the exit status and outputs. The environment is released,
   or retained within its allowed lifetime for debugging.

A skill guides the Agent; it is not an authorization or resource-limit boundary.

## What changes

All OCE connections below are proposed:

	the Agent's existing Harness
	  -> Crabbox CLI and external OCE adapter
	  -> OCC admission and durable lifecycle
	  -> selected infrastructure implementation
	  -> temporary test machine

The CLI then synchronizes files and runs commands over a private SSH connection
to that machine. Provisioning credentials stay with the controller-side
implementation, never in the Harness or test machine.

### A small platform resource, not another Agent

Introduce an Agent-owned temporary environment within the Agent's Namespace.
An Agent can own several environments, subject to operator-set concurrency and
capacity limits. An environment is not an AgentRevision, and creating one does
not redeploy the Agent.

OCC records the owner, admitted execution profile, caller-scoped request ID,
provider resource identity, deadlines and lifecycle state. The profile fixes
allowed image, CPU, memory, placement, network access and maximum lifetime.
Admission snapshots those settings so later configuration changes cannot
silently broaden an existing environment's authority.

Extend existing platform ownership, persistence, IAM, audit and controller work
rather than adding a second scheduler. The selected infrastructure Driver
creates, observes and deletes the resource. It reports an authorized SSH route
and readiness only after isolation is applied.

The current [ComputeDriver](../../docs/reference/drivers/compute.md) owns Agent
deployments. The [SandboxDriver](../../docs/reference/drivers/sandbox.md) owns
Harness containment and explicitly excludes per-tool Sandbox creation. Neither
is already the required temporary-environment contract. Maintainers must approve
its resource and Driver ownership before product implementation.

### Reuse Crabbox without a fork

Implement the existing external-provider JSON protocol in a separately invoked
OCE adapter. Initially target Linux and the ordinary SSH lease path:

| Crabbox operation | OCE adapter responsibility |
| --- | --- |
| Acquire | Submit an authenticated request and wait for an admitted environment with connection details. |
| Resolve and list | Return only environments the caller may inspect. |
| Touch | Request bounded renewal; never override the server's maximum lifetime. |
| Release | Request deletion and report success only after deletion is confirmed. |
| Cleanup | Request scoped cleanup without acquiring authority over other owners. |
| Doctor | Check configuration and access without allocating a machine. |

Use stable, caller-scoped request IDs for repeat-safe acquisition. A repeated
request with different settings is a conflict, not a new allocation. Connection
information comes from the admitted resource, not a caller-selected destination.

Crabbox's external provider accepts SSH connection and proxy metadata. A public
SSH port is not required. OCC must authorize access to the exact environment;
SSH credentials and routing must not allow another tenant's endpoint. Do not
forward OCC credentials, model credentials or the whole local environment into
the test command. Export requested outputs before deleting the environment.

Crabbox's coordinator is not required for this path. OCC owns server-side
lifecycle; Crabbox retains only the client state needed for its workflow.

## Authorization and isolation

The first caller is the Agent, not an impersonation of the human who sent a
chat message. Add a scoped, revocable workload authentication path tied to the
Agent and its admitted runtime identity. OCC derives ownership from that identity
and authorizes each exact operation through IAM. Existing non-Agent service keys
are not a substitute for this binding.

The operator permits selected Agents to request selected profiles. Creation and
quota reservation must be atomic. Knowledge of a lease ID grants no authority.
Caller flags, repository configuration and adapter configuration cannot broaden
server-enforced limits. Denied requests and successful mutations produce audit
evidence without credentials or test-output contents.

Start with one operator-controlled execution backend, not arbitrary cloud
providers. For cluster-creating tests, require a disposable VM with its own
container runtime and bounded capacity. Never expose the OCE host's Docker
socket or cluster-admin credentials. A container-only test lane cannot stand in
for proof of this VM use case.

The backend must enforce the approved network destinations and prevent access
to other tenants and control-plane services except explicitly permitted routes.
Running a VM under Kubernetes does not itself prove network enforcement. A new
VM on an exhausted host also does not create capacity: placement and admission
must preserve the Harness and controller resource budgets.

## Lifecycle and failures

OCC admits a request, records durable work, provisions the resource and marks it
ready. Its lifecycle distinguishes provisioning, ready, deleting and deleted;
failures retain enough information for recovery. Deleted means confirmed provider
absence, not merely a queued delete request.

- Client cancellation or a lost response does not erase ownership. A retry
  resolves the same request; OCC cleans up an abandoned allocation by deadline.
- Provisioning failure keeps any known provider resource tracked until deletion
  is confirmed. Do not allocate replacements while ownership is uncertain.
- Explicit release, expiry or Agent removal starts deletion. Stop access, remove
  the machine and its disposable storage, then record completion. Namespace
  teardown waits for its owned resources to be removed.
- Cleanup survives controller restart. Failed deletion remains retryable and
  visible; it cannot release capacity accounting prematurely.
- Renewal cannot revive a deleting environment or exceed the hard deadline.
  Client activity and keep-for-debugging flags do not disable that deadline.

The adapter translates asynchronous OCC work into Crabbox's calls. In particular,
a queued deletion is not a successful Crabbox release. If waiting times out, it
returns an actionable error while OCC retains cleanup responsibility.

## Scope and alternatives

This proposal covers task-level test execution. It does not move sessions,
replace Harness deployment, add a console UI, provide a general VM marketplace,
or implement every Crabbox capability. Reuse of a retained environment is in
scope; shared warm pools and persistent user storage are not.

Giving the Agent direct cloud credentials would bypass OCC's ownership and
policy. Hosting Crabbox's coordinator instead could reuse more lifecycle code,
but its OCE identity and policy integration has not been established. Building
another remote-testing CLI would duplicate Crabbox's usable workflow. The
external-provider adapter keeps that workflow while making the infrastructure
boundary explicit.

## Delivery and decisions requested

The [plan](../plans/0019-temporary-test-environments.md) specifies the connected
implementation and real proof. Source review found a compatible Crabbox extension
point; no OCE integration or live-machine test has run.

Maintainers must decide:

1. Approve temporary environments and scoped Agent authentication as an explicit
   implementation milestone; the current repository boundary does not admit
   these new resource and deployment behaviors.
2. Select the platform owner and Driver extension for temporary environments.
3. Select the first VM backend, enforcing network topology and disposable test
   infrastructure. Do not silently introduce a new cluster operator.

Delivery requires a real Agent-to-Crabbox-to-OCC test with a dirty checkout,
remote command output, denial checks, duplicate-request recovery, client loss,
controller restart, enforced networking and confirmed deletion. Passing a mock
adapter test is not sufficient.

## Evidence and related work

Source review used OCE `80725162a946f80652b939a32a57ee4e922eeb5c` and Crabbox
`c41270ea7e6016b497095cb8f0260ed1a2816a06`. Crabbox's implemented
[external protocol](https://github.com/openclaw/crabbox/blob/c41270ea7e6016b497095cb8f0260ed1a2816a06/internal/providers/external/protocol.go),
[backend](https://github.com/openclaw/crabbox/blob/c41270ea7e6016b497095cb8f0260ed1a2816a06/internal/providers/external/backend.go)
and [Slurm adapter example](https://github.com/openclaw/crabbox/blob/c41270ea7e6016b497095cb8f0260ed1a2816a06/examples/slurm-external-provider/README.md)
support the proposed integration shape, not its runtime correctness.

The [current architecture](../../docs/design.md#implementation-status) records
OCE's remaining workload-authentication gap.
[Upstream PR #2365](https://github.com/openclaw/openclaw-enterprise/pull/2365)
proposes running an entire development OCE installation inside Crabbox. This
proposal instead lets an existing OCE Agent request a temporary test machine.
