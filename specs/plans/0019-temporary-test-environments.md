---
rfc: ../rfcs/0019-temporary-test-environments.md
---

# Implementation plan: temporary test environments through Crabbox

- **ID:** RFC-0019
- **Delivery status:** Planned
- **Owner:** OCE maintainers
- **Authority:** [Proposed RFC](../rfcs/0019-temporary-test-environments.md)
- **Source baseline:** OCE `80725162a946f80652b939a32a57ee4e922eeb5c`; Crabbox `c41270ea7e6016b497095cb8f0260ed1a2816a06`

## Outcome and current blocker

An existing Agent uses the unmodified Crabbox skill and CLI to test a dirty
checkout in an OCE-managed temporary Linux environment on Kubernetes. OCC owns authorization and
cleanup; the Agent's Harness stays in place.

**Product implementation is blocked by the active workspace milestone boundary.**
The RFC requests approval for a new temporary-environment resource and scoped
Agent authentication. Approval of those additions must precede deployment code.
The proposed owner is ComputeDriver, with Kubernetes as its first implementation. This document is a draft
implementation plan, not a draft implementation or an accepted RFC.

No infrastructure, dependencies, permissions or admission rules are changed by
this proposal. No runtime proof has run.

## Ordered implementation

### 1. Settle the platform contract

Extend ComputeDriver with temporary-environment creation, observation, connection
and deletion operations, distinct from AgentRevision operations. Implement these
in the bundled Kubernetes Driver. Other Drivers report the capability unsupported
until they implement the same contract; admission rejects it before allocation.

Specify the Kubernetes workload, private SSH route, network enforcement, storage
and capacity accounting. Specify approved image and execution-profile
configuration, including CPU, memory, concurrency, idle timeout and hard lifetime.
Make this operator configuration, not arbitrary manifests supplied by the Agent.

First connect ordinary remote tests through a constrained Kubernetes workload.
Then qualify the cluster-creating profile against its stronger runtime needs.
Do not claim ordinary Pod execution proves nested k3d isolation. Assess any
VM-backed runtime dependency within the Kubernetes implementation, not as a new
provider decision for the Crabbox client or common API.

Keep unsupported profiles disabled. Missing isolation or capacity must fail
closed, not fall back to the Harness host.

### 2. Implement admission, identity and durable lifecycle together

Extend the existing owners rather than building an adapter against invented APIs:

| Existing owner                                    | Required change                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/`                         | Resource, operations, states and selected Driver contract; curated exports through the top-level index.       |
| `apps/controller/src/auth/`                       | Scoped, revocable Agent workload authentication; no human impersonation or shared administrator key.          |
| `apps/controller/src/admission/` and `http/`      | Exact-resource authorization, bounded requests, server-derived ownership and redacted responses.              |
| `packages/occ/src/`                               | Persistent environment ownership, repeat-safe requests, atomic quota reservation, expiry and controller work. |
| `packages/iam/src/` and `packages/audit/src/`     | Resource grants and attributable mutation/denial evidence.                                                    |
| `apps/controller/src/composition/` and `drivers/` | Select the approved implementation; create, observe and delete real resources under durable controller work.  |

Use the existing PostgreSQL transaction and work-claim conventions. Add database
constraints for ownership, request uniqueness and allowed transitions where
appropriate. Preserve the resource identity through uncertain provider outcomes.

Bind workload access to the admitted Agent revision. Define revision retirement,
Agent stop/removal and credential revocation behavior before enabling the caller:
revoked runtimes cannot allocate, renew or reconnect, while controller-owned
cleanup continues. Never rely on the retired caller to delete its resources.

### 3. Connect the real Crabbox caller

Implement the external-provider adapter through the existing Go CLI/client
ownership where practical; confirm its command and packaging location during
contract review. It reads Crabbox protocol v1 JSON, calls the real OCC API and
writes only protocol JSON to stdout. Diagnostics go to stderr without secrets.

Map the supplied lease ID to an owner-scoped request. Implement acquire,
resolve/list, doctor, touch, release and cleanup. Keep request parameters and
connection metadata subject to OCC authorization. Advertise fixed-ID acquisition
only after its retry contract is proved. Bound polling by cancellation and
operation deadlines; report failed or uncertain cleanup rather than success.

Package the reviewed Crabbox CLI, its skill and the adapter into the selected
Agent runtime through normal build/composition. Supply trusted provider config,
scoped credentials and private SSH access. Do not add another provisioning
credential to the Agent. Test the default one-shot run and explicit lease reuse;
neither requires moving the conversation to a cloud worker.

### 4. Document and qualify the connected path

Update the authoritative architecture's implementation status only for behavior
actually delivered. Add the owning resource/Driver reference, operator setup and
source-backed flow. Update API schemas and generated API documentation, permission
and database cheat sheets, layout and navigation as applicable.

Do not mark the RFC implemented because contracts compile or an adapter fixture
passes. Keep the implementation PR draft until the required integration evidence
below exists, and record any approved scope changes explicitly.

## Required verification

Use a disposable database and Kubernetes execution infrastructure, with an
approved workload image and enforced networking. Do not start local k3d clusters as an incidental check.
Infrastructure and credential setup need explicit scope and capacity.

| Outcome                 | Required integration evidence                                                                                                                 | Status  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Normal Agent workflow   | Real deployed Agent invokes unmodified Crabbox and the adapter, transfers an uncommitted change, runs tests and returns output/exit status.   | Not run |
| Repeat-safe acquisition | Interrupt the real response and retry the same identity; observe one allocation and rejection of changed parameters.                          | Not run |
| Authorization           | Another Agent/Namespace, an expired identity and a forbidden profile cannot allocate, inspect, renew, connect or delete outside their grants. | Not run |
| Capacity                | Concurrent requests cannot exceed reserved limits; failed cleanup keeps capacity accounted for.                                               | Not run |
| Crash recovery          | Kill the client, restart the controller and verify deadline-driven deletion without another LLM call.                                         | Not run |
| Deletion semantics      | Interrupt deletion; observe durable retries and no successful release until provider absence is confirmed.                                    | Not run |
| Network boundary        | Exercise permitted SSH/test traffic and denied cross-tenant, control-plane and unapproved egress from the actual execution environment.       | Not run |
| k3d workload            | Run a disposable cluster in the qualified environment; verify no host socket/cluster credential exposure and no residual workload/storage.    | Not run |
| Revision retirement     | Revoke the caller during a retained lease; reject further use and complete controller-owned cleanup.                                          | Not run |

Mocks may isolate unrelated failure inputs, but cannot replace the controller,
provider, SSH transport or network enforcement being proved. Follow the
[testing guide](../../docs/testing/README.md) and repository integration rules.

## Delivery record

RFC and plan drafted from source inspection only. No product code, live-machine
proof or deployment approval is included. The requested code draft remains
blocked on the milestone approval above. Kubernetes is selected as the first
implementation; its cluster-creating profile still needs runtime qualification.

## Manual Notes

## Changelog

- 2026-10-30: Drafted the plan against OCE `80725162a`; no implementation or runtime verification claimed.
