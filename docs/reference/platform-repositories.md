# Platform repository transactions

The memory and PostgreSQL implementations of `PlatformStateStore` bind every
repository handle to one `read` or `transact` callback. The controller uses this
boundary for resource mutations and audit records; the worker shares it with
its durable work queue.

## Caller contract

Await repository results inside the callback. Once the callback settles, its
handles reject new calls. The owner waits for complete operations accepted
before that point, including internal asynchronous lookups, before committing
or rolling back. Draining does not make an unobserved operation failure a
successful result; callers must await and handle those results.

A `read` callback receives a frozen projection containing only read methods.
It does not expose mutation or row-lock methods at runtime. Repository results
are immutable copies. Retaining a read view or unit of work after the callback
does not extend its lifetime; start a new callback to read or change state.

## Ownership and atomicity

One owner controls each transaction. Resource writes, audit records, and queued
controller work commit together. A failed callback rolls them back and closes
its handles. The memory store publishes its working snapshot only after accepted
operations finish and audit publication succeeds.

PostgreSQL repositories, transaction queries, and the worker's queue use the
same borrowed client. Only the state owner begins, commits, rolls back, and
releases that client. Accepted operations finish before release, and escaped
queue or query handles cannot access it afterward. An uncertain commit outcome
continues to suppress unsafe controller compensation.

These are persistence boundaries; they do not authorize a resource operation.
The controller and worker still enforce the caller's exact resource authority.

## Draft temporary-environment reservations

The `temporaryEnvironments` repository participates in the existing read/UOW
boundary. Trusted admission code can set Namespace count/CPU/memory ceilings and
reserve immutable Agent/revision-owned requests. Workload-only HTTP acquisition
checks exact IAM authority and the admitted AgentRevision profile selection, then commits reservation,
quota, audit and existing controller work together. Persistence alone does not
authorize a caller. The Crabbox adapter preserves the same immutable name, slug
and request identity and waits for confirmed deletion.

PostgreSQL admission locks the Namespace and Agent in lifecycle order, checks
ready/running/current-revision state, then spends quota and inserts one record
in the same transaction. Exact retries preserve identity and deadline; changed
profile fingerprints or resource/lifetime settings conflict. Missing or exhausted
quota fails closed. Lowering ceilings below reserved usage is refused. Count
ceilings are 1–1000; CPU/memory values are positive 32-bit integers; hard lifetimes
are 1–86400 seconds.

Deadlines and stop request cleanup rather than releasing capacity. The regular
worker retains a queued obligation through readiness, expiry and uncertain effects.
Only claim-fenced, Driver-confirmed absence releases counters and detaches live
revision/principal foreign keys; immutable owner snapshots remain. Arbitrary SQL
cannot reset counters or discard cleanup work. Memory mirrors admission and queued
release, but explicitly refuses to emulate durable worker claims. See the
[implementation trace](../flows/temporary-environment-readiness.md#3-durable-admission-and-reconciliation).

See [PostgreSQL testing](../testing/postgresql.md) for contributor setup and
[controller reconciliation](controller.md) for worker behavior.
