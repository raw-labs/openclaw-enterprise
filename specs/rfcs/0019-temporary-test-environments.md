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

OCE would do the lifecycle-management job that a Crabbox coordinator normally
does: keep track of environments, enforce their lifetime and clean them up.
We do not implement Crabbox's server API. Instead, its existing external-provider
protocol connects to a small adapter that calls OCE's own API.

| Part                  | Responsibility                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Crabbox skill and CLI | Choose the remote-test workflow, copy code, run commands and collect results.            |
| OCE adapter           | Translate Crabbox's external-provider requests into OCE API calls.                       |
| OCE core/controller   | Authorize requests, record ownership and deadlines, and retry cleanup until it finishes. |
| ComputeDriver         | Create, inspect, connect to and delete the actual infrastructure; Kubernetes is first.   |

The Driver is not a second lease server. OCE decides when cleanup is due; the
Driver removes the resources and reports whether they are gone. Neither relies
on the LLM remembering a final tool call. The common OCE contract stays independent
of Crabbox, so other callers could use the same capability.

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

Reuse existing persistence, IAM, audit and controller work. The Driver reports
readiness and an authorized SSH route only after applying isolation.

Extend the [ComputeDriver](../../docs/reference/drivers/compute.md) with a
temporary-environment contract and implement it in Kubernetes first. Keep these
operations separate from AgentRevision deployment. Other Compute Drivers can
implement the same contract or explicitly report it unsupported; admission must
reject unsupported requests before creating work. Crabbox calls the OCE API and
does not need to know which Compute implementation the Installation selects.

The [SandboxDriver](../../docs/reference/drivers/sandbox.md) remains responsible
for Harness containment. This proposal does not turn its Harness provisioning
operation into a per-task resource API.

### Enable per Agent; define environments centrally

Temporary environments are disabled for an Agent unless its OCE configuration
selects a profile. Editing that configuration is sufficient; a new console
control is not required. For example, the Agent configuration selects:

```yaml
temporaryEnvironments:
  profileId: tests-small
```

The setting belongs to OCE Agent configuration, not the upstream Harness JSON.
OCC snapshots the selection into the admitted AgentRevision. A saved edit takes
effect when that revision is deployed, not halfway through an existing runtime.
Removing the selection disables the next revision; retirement of the old
revision starts cleanup of its environments. There is no installation-wide
default that silently enables every Agent.

The operator defines `tests-small` in the selected Compute Driver configuration.
That definition chooses the digest-pinned container image, CPU, memory, allowed
network destinations, idle timeout and hard lifetime. Namespace allowlists and
aggregate quotas bound where and how much it may run. Agent configuration
contains only a profile reference; it cannot override the image or resource
limits. Selecting a profile does not grant IAM authority: exact-Agent permission
and current workload identity are still required. Unknown, disallowed or
unsupported selections fail admission for that Agent, not unrelated Agents.

The initial Kubernetes implementation supplies a nonroot Linux Pod/container
with disposable storage and private SSH, **not a VM**. Its image provides the
remote test tools. Different approved images and sizes are different profiles;
no arbitrary Pod manifest, cloud VM type or provisioning credential is exposed
to the Agent. Adding Kubernetes nodes is outside this feature.

Runtime images may contain the unchanged Crabbox CLI and skill files, but only
an opted-in Agent discovers the Crabbox skills and receives trusted provider
configuration and its private SSH identity. Disabled Agents receive no such
setup. Hiding a skill is usability, not security: OCC must also reject direct
acquisition or renewal without the admitted selection. The adapter uses that
selection; caller flags cannot switch to another profile. Keep Crabbox's ordinary
checkout synchronization and SSH command workflow unchanged.

### Reuse Crabbox without a fork

Implement the existing external-provider JSON protocol in a separately invoked
OCE adapter. Initially target Linux and the ordinary SSH lease path:

| Crabbox operation | OCE adapter responsibility                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Acquire           | Submit an authenticated request and wait for an admitted environment with connection details. |
| Resolve and list  | Return only environments the caller may inspect.                                              |
| Touch             | Request bounded renewal; never override the server's maximum lifetime.                        |
| Release           | Request deletion and report success only after deletion is confirmed.                         |
| Cleanup           | Request scoped cleanup without acquiring authority over other owners.                         |
| Doctor            | Check configuration and access without allocating a machine.                                  |

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

Authenticate the Agent through a scoped, revocable workload identity. Derive
ownership from it and authorize every operation through IAM. Do not impersonate
the human requester or substitute a non-Agent service key.

The operator permits selected Agents to request selected profiles. Creation and
quota reservation must be atomic. Knowledge of a lease ID grants no authority.
Caller flags, repository configuration and adapter configuration cannot broaden
server-enforced limits. Denied requests and successful mutations produce audit
evidence without credentials or test-output contents.

Implement temporary environments through Kubernetes first, with private access,
resource limits and disposable storage. The API describes an execution
environment, not necessarily a literal VM. Do not make KubeVirt or another VM
operator a requirement of the platform contract.

Cluster-creating tests need a separately qualified execution profile with its own
container runtime and adequate isolation. Never expose the OCE host's Docker
socket or cluster-admin credentials. Whether that profile needs a VM-backed
runtime is an implementation question; a passing ordinary test in a Pod does
not establish that nested k3d is safely supported.

Enforce approved network destinations and block unauthorized tenant/control-plane
access. Kubernetes placement alone proves neither isolation nor spare capacity;
preserve Harness and controller resource budgets.

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
point. A connected source draft exists, but no live Agent-to-Crabbox
acceptance test has run. Per-Agent selection and its runtime delivery remain
part of that draft, not a supported deployment.

Draft implementation of this Kubernetes-first scope was requested on 2026-10-30.
That permits development of the proposal; it does not mark the RFC accepted or
approve deployment. Review must settle the exact ComputeDriver and workload
identity contracts before merge. Non-Kubernetes implementations are not required
for the initial delivery.

Cluster-creating tests still need a qualified Kubernetes execution profile. If
that requires another runtime or cluster operator, review the dependency before
adding it; it is not a prerequisite for defining the common API.

Delivery requires a real Agent-to-Crabbox-to-OCC test with a dirty checkout,
remote command output, denial checks, duplicate-request recovery, client loss,
controller restart, enforced networking and confirmed deletion. Passing a mock
adapter test is not sufficient.

## Evidence and related work

Reviewed OCE `80725162a` and Crabbox `c41270ea7e`. The pinned Crabbox
[external protocol](https://github.com/openclaw/crabbox/blob/c41270ea7e6016b497095cb8f0260ed1a2816a06/internal/providers/external/protocol.go),
[backend](https://github.com/openclaw/crabbox/blob/c41270ea7e6016b497095cb8f0260ed1a2816a06/internal/providers/external/backend.go)
and [Slurm adapter example](https://github.com/openclaw/crabbox/blob/c41270ea7e6016b497095cb8f0260ed1a2816a06/examples/slurm-external-provider/README.md)
support the proposed integration shape, not its runtime correctness.

The [current architecture](../../docs/design.md#implementation-status) records
OCE's remaining workload-authentication gap.
[Upstream PR #2365](https://github.com/openclaw/openclaw-enterprise/pull/2365)
proposes running an entire development OCE installation inside Crabbox. This
proposal instead lets an existing OCE Agent request a temporary test machine.
