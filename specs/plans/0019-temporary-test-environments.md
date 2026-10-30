---
rfc: ../rfcs/0019-temporary-test-environments.md
---

# Implementation plan: temporary test environments through Crabbox

- **ID:** RFC-0019
- **Delivery status:** In progress
- **Owner:** OCE maintainers
- **Authority:** [Proposed RFC](../rfcs/0019-temporary-test-environments.md)
- **Source baseline:** OCE `80725162a946f80652b939a32a57ee4e922eeb5c`; Crabbox `c41270ea7e6016b497095cb8f0260ed1a2816a06`

## Outcome and authorization

An existing Agent uses the unmodified Crabbox skill and CLI to test a dirty
checkout in an OCE-managed temporary Linux environment on Kubernetes. OCC owns authorization and
cleanup; the Agent's Harness stays in place.

The user explicitly requested the Kubernetes-first draft implementation on
2026-10-30 after confirming the ComputeDriver extension and lifecycle ownership.
This scope includes the temporary-environment resource, scoped Agent access,
controller cleanup and Crabbox adapter. It does not approve deployment, another
cluster operator, weaker isolation or omission of integration tests. The RFC
remains Proposed. This document is the implementation plan, not product code.

The draft changes source, packaging and opt-in permissions only. No deployment
or live-runtime acceptance has run.

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

The first code draft implements only workload authentication and the external
provider readiness probe. Compute verifies provider evidence; OCC checks current
Agent/revision state and IAM grants; the adapter calls the actual API and is
packaged in the runtime image recipe. At that first checkpoint, every lifecycle operation remained refused.
See the [probe contract](../../docs/reference/authentication/agent-workload-probe.md)
and [source flow](../../docs/flows/temporary-environment-readiness.md).

The next bounded checkpoint adds immutable reservation records and atomic
Namespace count/CPU/memory accounting to the existing persistence/UOW owners.
It enforces owner-scoped idempotency, active-revision admission, bounded hard
deadlines, rollback and retained cleanup ownership. The PostgreSQL application
role cannot reset usage or erase reservations. This is an internal storage
capability, not a new public acquisition route.

A later source checkpoint connects workload API admission and audit to durable
work, selected Compute allocation/observation/cleanup, idle renewal, expiry and
owner teardown. Runtime recipes package the pinned unmodified Crabbox CLI/skills,
external-provider adapter and a nonroot SSH image. The adapter polls exact
deleted receipts before acknowledging release. The production Agent workflow
contains a dirty-checkout Crabbox acceptance extension, authored but not run.
This is still a draft, not demonstrated remote test execution.

Local API credential-precedence and adapter transport tests are authored. The
existing Kubernetes API/worker suite is extended to exercise real Pod-bound
TokenReview, PostgreSQL lifecycle checks, IAM revocation and stop, with genuine
runtime selection. The live extension has not run: no authorized disposable
cluster/database/runtime image was supplied. No integration-test waiver or
runtime acceptance is claimed. The cluster-creating profile remains disabled;
deployment has not been authorized.

Draft validation on 2026-10-30: adapter/API boundary suite 4 passed; existing
Kubernetes Compute/runtime credential conformance 326 passed. API security plus
adapter plus real-cluster selection reported 40 passed and one explicitly skipped
cluster case. TypeScript build, lint, formatting, generated OpenAPI, workspace
boundary, CI suite ownership, docs links/length and flow structure checks passed.
These are source/local checks, not live-runtime acceptance.

Persistence checkpoint verification: the new shared UOW integration case passes
on memory; the actual PostgreSQL case is authored but not run because no migrated
disposable `OCC_TEST_DATABASE_URL` was supplied. It covers independent dimensions
and Agents competing for one budget, duplicate replay, rollback, SQL permissions
and a real lifecycle-lock race. No database, cluster or deployment was created.
This does not waive the required live SQL and eventual Agent-workflow proof.

Current connected-draft verification: TypeScript build, whole-repository lint,
formatting, generated OpenAPI, workspace isolation, CI suite ownership and
documentation links/length checks pass. The focused core/adapter/Driver/storage
selection reports 19 passed and two PostgreSQL cases skipped. A broader local
selection reports 392 passed, one process-group fixture failure and 58 skipped
Helm/image cases. The unchanged process-group helper reported a surviving
descendant; this is not a clean regression run. Helm/yq, native image builds,
real SQL and full Agent/SSH acceptance remain unverified. The prior published
commit also has a First Agent Smoke initialization failure; its logs show
BackoffLimitExceeded and cluster startup/network errors, not a resolved cause.
No cluster, database or deployment was created or used for these checks.

## Manual Notes

## Changelog

- 2026-10-30: Connect API, durable worker, selected Compute lifecycle and Crabbox adapter/runtime recipes; retain draft status pending live SQL, image and Agent-workflow proof.

- 2026-10-30: Add the bounded reservation/UOW and atomic-quota checkpoint; public lifecycle remains disabled.
- 2026-10-30: Add the partial workload-readiness code draft and explicit remaining lifecycle work against baseline `51c19ed91`.
- 2026-10-30: Drafted the plan against OCE `80725162a`; no implementation or runtime verification claimed.
