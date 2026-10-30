import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { InMemoryPlatformState, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { seedSessionRevision } from "../conformance/repository-sessions.contract.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const scopeError = { name: "ScopeViolationError" };
const conflictError = { name: "ResourceConflictError" };
const limits = { maxEnvironments: 2, maxCpuMillis: 1000, maxMemoryMiB: 1024 };

async function owner(store) {
  // Use the existing admitted-revision fixture, then activate through the real repository CAS.
  // This is persistence proof, not a Kubernetes deployment or model-turn claim.
  const seeded = await seedSessionRevision(store);
  await store.transact(async (unit) => {
    const active = await unit.agents.compareAndSetActiveRevision(
      seeded.namespace.id,
      seeded.agent.id,
      undefined,
      seeded.revision.id,
    );
    assert.equal(active.activeRevisionId, seeded.revision.id);
  });
  return seeded;
}

function request(revision, overrides = {}) {
  return {
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revisionId: revision.id,
    requestId: randomUUID(),
    profileId: "ordinary-tests",
    profileFingerprint: "a".repeat(64),
    cpuMillis: 500,
    memoryMiB: 512,
    lifetimeSeconds: 60,
    ...overrides,
  };
}

async function exercise(store, reopened) {
  const { namespace, agent, revision } = await owner(store);
  const input = request(revision, { lifetimeSeconds: 1 });
  const reserve = (value = input) =>
    store.transact((unit) => unit.temporaryEnvironments.reserve(value));
  const quota = () => reopened.read((view) => view.temporaryEnvironments.getQuota(namespace.id));
  await assert.rejects(reserve(), scopeError, "absence of an operator quota fails closed");
  await store.transact((unit) => unit.temporaryEnvironments.setQuota(namespace.id, limits));

  const attempts = await Promise.all(Array.from({ length: 8 }, () => reserve()));
  const saved = attempts[0];
  assert.ok(
    attempts.every((attempt) => attempt.id === saved.id),
    "response-loss retries create exactly one reservation",
  );
  assert.equal(saved.servicePrincipalId, agent.servicePrincipalId);
  assert.equal(saved.state, "reserved");
  assert.equal(Date.parse(saved.hardExpiresAt) - Date.parse(saved.createdAt), 1000);
  assert.deepEqual(await quota(), {
    namespaceId: namespace.id,
    ...limits,
    reservedEnvironments: 1,
    reservedCpuMillis: 500,
    reservedMemoryMiB: 512,
  });
  assert.deepEqual(
    await reopened.read((view) =>
      view.temporaryEnvironments.findByRequest(namespace.id, agent.id, input.requestId),
    ),
    saved,
  );
  assert.equal(
    await reopened.read((view) =>
      view.temporaryEnvironments.findByRequest("ns_" + randomUUID(), agent.id, input.requestId),
    ),
    undefined,
  );
  assert.equal(
    await reopened.read((view) =>
      view.temporaryEnvironments.findByRequest(
        namespace.id,
        "agt_" + randomUUID(),
        input.requestId,
      ),
    ),
    undefined,
  );
  for (const change of [
    { profileFingerprint: "b".repeat(64) },
    { cpuMillis: 501 },
    { lifetimeSeconds: 2 },
  ]) {
    await assert.rejects(reserve({ ...input, ...change }), conflictError);
  }

  // A later failure in the owning unit of work must roll back both admission and capacity.
  const aborted = request(revision);
  await assert.rejects(
    store.transact(async (unit) => {
      await unit.temporaryEnvironments.reserve(aborted);
      throw new Error("abort owning operation");
    }),
    /abort owning operation/u,
  );
  assert.equal(
    await reopened.read((view) =>
      view.temporaryEnvironments.findByRequest(namespace.id, agent.id, aborted.requestId),
    ),
    undefined,
  );
  assert.equal((await quota()).reservedEnvironments, 1);

  // The stored deadline does not release capacity or renew itself on a replay.
  await delay(Math.max(0, Date.parse(saved.hardExpiresAt) - Date.now()) + 30);
  assert.deepEqual(await reserve(), saved);
  const contenders = await Promise.allSettled(
    Array.from({ length: 12 }, () => reserve(request(revision))),
  );
  assert.equal(contenders.filter((outcome) => outcome.status === "fulfilled").length, 1);
  for (const outcome of contenders) {
    if (outcome.status === "rejected") {
      assert.equal(outcome.reason.name, "ScopeViolationError");
    }
  }
  assert.equal((await quota()).reservedEnvironments, 2);
  assert.equal(
    (await reopened.read((view) => view.temporaryEnvironments.listForAgent(namespace.id, agent.id)))
      .length,
    2,
  );
  await assert.rejects(
    store.transact((unit) =>
      unit.temporaryEnvironments.setQuota(namespace.id, { ...limits, maxEnvironments: 1 }),
    ),
    scopeError,
  );
  assert.equal((await quota()).maxEnvironments, 2);

  // Exact active revision and desired-running state are rechecked even on idempotent replay.
  await assert.rejects(reserve({ ...input, revisionId: "rev_" + randomUUID() }), scopeError);
  await store.transact((unit) =>
    unit.agents.transitionAgentDesiredRuntimeState(namespace.id, agent.id, "running", "stopped"),
  );
  await assert.rejects(reserve(), scopeError);
  assert.equal(
    (await quota()).reservedEnvironments,
    2,
    "stop does not erase cleanup ownership or free reserved usage",
  );
  await reopened.read(async (view) => {
    assert.equal(view.temporaryEnvironments.reserve, undefined);
    assert.equal(view.temporaryEnvironments.setQuota, undefined);
  });
  return { namespace, agent, saved };
}

async function independentCeilings(store) {
  // Each dimension must independently refuse admission; a count-only implementation must fail.
  for (const [dimension, policy, resources] of [
    [
      "count",
      { maxEnvironments: 1, maxCpuMillis: 1000, maxMemoryMiB: 1024 },
      { cpuMillis: 1, memoryMiB: 1 },
    ],
    [
      "cpu",
      { maxEnvironments: 8, maxCpuMillis: 1000, maxMemoryMiB: 4096 },
      { cpuMillis: 600, memoryMiB: 1 },
    ],
    [
      "memory",
      { maxEnvironments: 8, maxCpuMillis: 4000, maxMemoryMiB: 100 },
      { cpuMillis: 1, memoryMiB: 60 },
    ],
  ]) {
    const { namespace, agent, revision } = await owner(store);
    // A second Agent shares the Namespace budget; identity-local counters would over-admit.
    const otherAgent = {
      ...agent,
      id: "agt_" + randomUUID(),
      name: "second owner " + randomUUID(),
      servicePrincipalId: "service-agent-" + randomUUID(),
    };
    const otherRevision = {
      ...revision,
      id: "rev_" + randomUUID(),
      agentId: otherAgent.id,
      servicePrincipalId: otherAgent.servicePrincipalId,
    };
    await store.transact(async (unit) => {
      await unit.agents.createAgent(otherAgent);
      await unit.revisions.createRevision(otherRevision);
      await unit.agents.transitionAgentDesiredRuntimeState(
        namespace.id,
        otherAgent.id,
        "stopped",
        "running",
      );
      await unit.agents.compareAndSetActiveRevision(
        namespace.id,
        otherAgent.id,
        undefined,
        otherRevision.id,
      );
      await unit.temporaryEnvironments.setQuota(namespace.id, policy);
    });
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        store.transact((unit) =>
          unit.temporaryEnvironments.reserve(
            request(index % 2 === 0 ? revision : otherRevision, resources),
          ),
        ),
      ),
    );
    assert.equal(
      attempts.filter((result) => result.status === "fulfilled").length,
      1,
      dimension + " must be an atomic Namespace-wide ceiling",
    );
    for (const outcome of attempts) {
      if (outcome.status === "rejected") {
        assert.equal(outcome.reason.name, "ScopeViolationError", dimension);
      }
    }
    const quota = await store.read((view) => view.temporaryEnvironments.getQuota(namespace.id));
    assert.equal(quota.reservedEnvironments, 1);
    assert.equal(quota.reservedCpuMillis, resources.cpuMillis);
    assert.equal(quota.reservedMemoryMiB, resources.memoryMiB);
  }
}

test("memory UOW preserves reservation identity, rollback, expiry accounting and independent quota ceilings", async () => {
  const state = new InMemoryPlatformState();
  const { namespace, agent, saved } = await exercise(state, state);
  await independentCeilings(state);
  // Stage the stopped/deleting owner and durable deletion work used by the finalizer.
  // Reservations must keep their owner present until confirmed cleanup can release them.
  await state.transact(async (unit) => {
    await unit.agents.transitionAgentStatus(namespace.id, agent.id, "active", "deleting");
    await unit.operations.append({
      kind: "agent",
      action: "reconcile",
      target: "deleted",
      namespaceId: namespace.id,
      resourceId: agent.id,
      actorId: agent.servicePrincipalId,
    });
  });
  assert.equal(await state.completeAgentDeletion(namespace.id, agent.id), false);
  assert.ok(await state.read((view) => view.agents.findAgent(namespace.id, agent.id)));
  assert.equal(
    (
      await state.read((view) =>
        view.temporaryEnvironments.findByRequest(namespace.id, agent.id, saved.requestId),
      )
    ).id,
    saved.id,
  );
});

test(
  "PostgreSQL UOW persists reservations and serializes aggregate quota across connections",
  { ...requiresPostgres, timeout: 60000 },
  async (context) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    const contenderName = "temporary-environment-" + randomUUID();
    const otherPool = new pg.Pool({
      connectionString: databaseUrl,
      max: 4,
      application_name: contenderName,
    });
    context.after(() => Promise.all([pool.end(), otherPool.end()]));
    assert.equal(
      (await pool.query("SELECT current_user AS name")).rows[0].name,
      "occ_app",
      "proof must use the limited application role",
    );
    const state = new PostgresPlatformState(pool);
    const reopened = new PostgresPlatformState(otherPool);
    const { namespace, saved } = await exercise(state, reopened);
    await independentCeilings(state);

    // The application role cannot forge immutable reservations, reset counters, or free capacity.
    for (const sql of [
      "UPDATE occ.temporary_environments SET hard_expires_at = hard_expires_at + interval '1 hour' WHERE id = $1",
      "DELETE FROM occ.temporary_environments WHERE id = $1",
    ]) {
      await assert.rejects(pool.query(sql, [saved.id]), { code: "42501" });
    }
    await assert.rejects(
      pool.query(
        "UPDATE occ.temporary_environment_quotas SET reserved_environments = 0 WHERE namespace_id = $1",
        [namespace.id],
      ),
      { code: "42501" },
    );
    await assert.rejects(
      pool.query("DELETE FROM occ.temporary_environment_quotas WHERE namespace_id = $1", [
        namespace.id,
      ]),
      { code: "42501" },
    );

    const fresh = await owner(state);
    await state.transact((unit) => unit.temporaryEnvironments.setQuota(fresh.namespace.id, limits));
    // SQL CHECK failure happens after tentative counter update inside the function; it must undo it.
    await assert.rejects(
      state.transact((unit) =>
        unit.temporaryEnvironments.reserve(
          request(fresh.revision, { profileFingerprint: "invalid" }),
        ),
      ),
      scopeError,
    );
    assert.equal(
      (await reopened.read((view) => view.temporaryEnvironments.getQuota(fresh.namespace.id)))
        .reservedEnvironments,
      0,
    );

    // A committed stop wins against an admission waiting on the same real lifecycle locks.
    let release;
    let locked;
    const held = new Promise((resolve) => {
      locked = resolve;
    });
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    const stopping = state.transact(async (unit) => {
      await unit.namespaces.lockNamespace(fresh.namespace.id);
      await unit.agents.transitionAgentDesiredRuntimeState(
        fresh.namespace.id,
        fresh.agent.id,
        "running",
        "stopped",
      );
      locked();
      await barrier;
    });
    // Release the held transaction even when the observation/assertion fails.
    // A query observed waiting on a real lock proves contention, not merely call ordering.
    let refused;
    try {
      await Promise.race([held, stopping]);
      const waiting = reopened.transact((unit) =>
        unit.temporaryEnvironments.reserve(request(fresh.revision)),
      );
      refused = assert.rejects(waiting, scopeError);
      const deadline = Date.now() + 1000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        const observed = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
          [contenderName],
        );
        blocked = observed.rows.length > 0;
        if (!blocked) {
          await delay(10);
        }
      }
      assert.equal(blocked, true, "the competing admission must reach the database lifecycle lock");
    } finally {
      release();
      await stopping;
      if (refused !== undefined) {
        await refused;
      }
    }
    assert.equal(
      (await reopened.read((view) => view.temporaryEnvironments.getQuota(fresh.namespace.id)))
        .reservedEnvironments,
      0,
    );
  },
);
