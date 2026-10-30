import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";
import { seedSessionRevision } from "../conformance/repository-sessions.contract.mjs";

function publicKey() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const bytes = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return (
    "ssh-ed25519 " +
    Buffer.concat([
      Buffer.from([0, 0, 0, 11]),
      Buffer.from("ssh-ed25519"),
      Buffer.from([0, 0, 0, 32]),
      bytes,
    ]).toString("base64")
  );
}

test("core admits exact workload-owned reservations with real IAM, policy, atomic audit and pending release", async () => {
  const state = new InMemoryPlatformState();
  const { namespace, agent, revision } = await seedSessionRevision(state);
  // This uses the real Kubernetes policy implementation, not its network client. No cluster is accessed.
  const compute = new KubernetesComputeDriver({
    ...conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["127.0.0.1/32"] }),
    temporaryEnvironments: {
      profiles: [
        {
          id: "small",
          namespaceIds: [namespace.id],
          image: "registry.example/ssh@sha256:" + "a".repeat(64),
          cpuMillis: 100,
          memoryMiB: 128,
          lifetimeSeconds: 600,
          idleTimeoutSeconds: 60,
          egress: [],
        },
        {
          id: "other",
          namespaceIds: [namespace.id],
          image: "registry.example/ssh@sha256:" + "b".repeat(64),
          cpuMillis: 100,
          memoryMiB: 128,
          lifetimeSeconds: 600,
          idleTimeoutSeconds: 60,
          egress: [],
        },
      ],
      quota: { maxEnvironments: 2, maxCpuMillis: 200, maxMemoryMiB: 256 },
    },
  });
  const active = {
    ...revision,
    id: "rev_" + randomUUID(),
    revision: 2,
    temporaryEnvironments: { profileId: "small" },
    compute: { id: compute.id, implementation: compute.implementation },
  };
  await state.transact(async (unit) => {
    await unit.revisions.createRevision(active);
    await unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, active.id);
  });
  const role = {
    id: "workload-role",
    namespaceId: namespace.id,
    permissions: [{ action: "operate", resourceKind: "agent" }],
  };
  let allowed = true;
  const iam = new NativeIAMDriver({
    loadNativeIAMState: async () => ({
      identities: [
        { id: agent.servicePrincipalId, kind: "service_principal", namespaceId: namespace.id },
        { id: "human", kind: "principal", issuer: "tests", subject: "human" },
      ],
      groups: [],
      memberships: [],
      restrictions: [],
      roles: [role],
      bindings: allowed
        ? [agent.servicePrincipalId, "human"].map((id) => ({
            id: "binding-" + id,
            namespaceId: namespace.id,
            subjectKind: "identity",
            subjectId: id,
            roleId: role.id,
            resourceKind: "agent",
            resourceId: agent.id,
          }))
        : [],
    }),
  });
  const installation = await state.read((view) => view.installations.getInstallation());
  const controller = new OpenClawController(installation, { state });
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  controller.registerDriver(compute);
  controller.selectDriver("compute", compute.id);
  const scope = [agent.servicePrincipalId, namespace.id, agent.id, active.id];
  const input = {
    requestId: randomUUID(),
    name: "lease-test",
    slug: "test",
    profileId: "small",
    sshPublicKey: publicKey(),
  };
  const ready = await controller.getTemporaryEnvironmentReadiness(...scope);
  assert.equal(ready.supported, true);
  assert.deepEqual(
    ready.profiles.map((p) => p.id),
    ["small"],
  );
  await assert.rejects(
    controller.acquireTemporaryEnvironment(...scope, { ...input, profileId: "other" }),
    { name: "AuthorizationDeniedError" },
  );
  const saved = await controller.acquireTemporaryEnvironment(...scope, input);
  assert.equal(saved.state, "reserved");
  assert.equal(saved.name, input.name);
  assert.equal(saved.slug, input.slug);
  for (const change of [{ name: "other" }, { slug: "other" }]) {
    await assert.rejects(
      controller.acquireTemporaryEnvironment(...scope, { ...input, ...change }),
      { name: "ResourceConflictError" },
    );
  }
  assert.equal(saved.usable, false);
  assert.equal(saved.ssh, undefined);
  assert.equal(saved.providerRef, undefined);
  assert.equal(saved.sshPublicKey, undefined);
  assert.deepEqual(await controller.acquireTemporaryEnvironment(...scope, input), saved);
  assert.deepEqual(await controller.getTemporaryEnvironment(...scope, input.requestId), saved);
  assert.deepEqual(await controller.listTemporaryEnvironments(...scope), [saved]);
  await assert.rejects(
    controller.acquireTemporaryEnvironment(...scope, { ...input, sshPublicKey: publicKey() }),
    { name: "ResourceConflictError" },
  );
  await assert.rejects(
    controller.acquireTemporaryEnvironment(...scope, {
      ...input,
      requestId: randomUUID(),
      name: "lease-test",
      slug: "test",
      profileId: "forbidden",
    }),
    { name: "AuthorizationDeniedError" },
  );
  await assert.rejects(controller.acquireTemporaryEnvironment("human", ...scope.slice(1), input), {
    name: "AuthorizationDeniedError",
  });
  await assert.rejects(
    controller.getTemporaryEnvironment(...scope.slice(0, 3), revision.id, input.requestId),
    { name: "AuthorizationDeniedError" },
  );
  const beforeAudit = await state.transact((unit) => unit.audit.list());
  assert.ok(
    beforeAudit.some(
      (event) =>
        event.action === "openclaw.agents.temporary_environments.acquire" &&
        event.actorId === agent.servicePrincipalId &&
        event.details.environmentId === saved.id,
    ),
  );
  const aborted = { ...input, requestId: randomUUID() };
  await assert.rejects(
    controller.transact(async () => {
      await controller.acquireTemporaryEnvironment(...scope, aborted);
      throw new Error("abort owning request");
    }),
    /abort owning request/u,
  );
  assert.equal(
    await state.read((view) =>
      view.temporaryEnvironments.findByRequest(namespace.id, agent.id, aborted.requestId),
    ),
    undefined,
  );
  assert.deepEqual(await state.transact((unit) => unit.audit.list()), beforeAudit);
  assert.equal(
    (await state.read((view) => view.temporaryEnvironments.getQuota(namespace.id)))
      .reservedEnvironments,
    1,
  );
  allowed = false;
  for (const operation of [
    "getTemporaryEnvironment",
    "touchTemporaryEnvironment",
    "releaseTemporaryEnvironment",
  ]) {
    await assert.rejects(controller[operation](...scope, input.requestId), {
      name: "AuthorizationDeniedError",
    });
  }
  allowed = true;
  // Removing only the selected profile prevents readiness, acquisition and renewal.
  const originalPolicy = compute.options.temporaryEnvironments;
  compute.options.temporaryEnvironments = {
    ...originalPolicy,
    profiles: originalPolicy.profiles.filter((p) => p.id !== "small"),
  };
  assert.deepEqual(await controller.getTemporaryEnvironmentReadiness(...scope), {
    supported: false,
    profiles: [],
  });
  await assert.rejects(controller.touchTemporaryEnvironment(...scope, input.requestId), {
    name: "AuthorizationDeniedError",
  });
  await assert.rejects(
    controller.acquireTemporaryEnvironment(...scope, { ...input, requestId: randomUUID() }),
    { name: "AuthorizationDeniedError" },
  );
  compute.options.temporaryEnvironments = originalPolicy;
  const touched = await controller.touchTemporaryEnvironment(...scope, input.requestId);
  assert.equal(touched.hardExpiresAt, saved.hardExpiresAt);
  const released = await controller.releaseTemporaryEnvironment(...scope, input.requestId);
  assert.equal(released.state, "deleting");
  assert.equal(released.usable, false);
  assert.equal(
    (await controller.releaseTemporaryEnvironment(...scope, input.requestId)).state,
    "deleting",
  );
  assert.equal(
    (await state.read((view) => view.temporaryEnvironments.getQuota(namespace.id)))
      .reservedEnvironments,
    1,
    "queued release is not provider absence",
  );
  const disabled = { ...active, id: "rev_" + randomUUID(), revision: 3 };
  delete disabled.temporaryEnvironments;
  await state.transact(async (unit) => {
    await unit.revisions.createRevision(disabled);
    await unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, active.id, disabled.id);
  });
  const disabledScope = [...scope.slice(0, 3), disabled.id];
  assert.deepEqual(await controller.getTemporaryEnvironmentReadiness(...disabledScope), {
    supported: false,
    profiles: [],
  });
  await assert.rejects(
    controller.acquireTemporaryEnvironment(...disabledScope, { ...input, requestId: randomUUID() }),
    { name: "AuthorizationDeniedError" },
  );
  await state.transact((unit) =>
    unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, disabled.id, active.id),
  );
});
