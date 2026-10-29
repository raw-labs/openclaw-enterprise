import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createAuthPrincipalSeed } from "../../packages/iam/src/index.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "an Installation admin controls Gateway managed mode and a deployer applies the saved setting",
  requiresPostgres,
  async (t) => {
    const { controller, inject, state, deployAgent, pool } = await createPostgresAgentApp(t, {
      label: "gateway-managed-mode",
      authSecret: "gateway-managed-mode-postgres-auth-secret-minimum-32",
    });
    const { namespace, secretRef, agent, revision } = await deployAgent("Gateway managed mode");
    assert.equal(agent.gatewayManagedMode, true);
    assert.deepEqual(agent.gatewayOutbound, { mode: "restricted", hosts: [] });
    // The application role cannot persist malformed external authority, even outside the API.
    for (const gatewayOutbound of [
      { mode: "restricted", hosts: ["127.0.0.1"] },
      { mode: "restricted", hosts: ["metadata.google.internal"] },
      { mode: "restricted", hosts: ["*.github.com"] },
      { mode: "publicHttps", hosts: [] },
    ]) {
      await assert.rejects(
        pool.query("UPDATE occ.agents SET gateway_outbound = $2::jsonb WHERE id = $1", [
          agent.id,
          JSON.stringify(gatewayOutbound),
        ]),
        { code: "23514" },
      );
    }
    // Exercise the immutable admitted-spec constraint through inserts as the limited app role:
    // a dedicated candidate needs a frozen ceiling; a host cannot exceed that ceiling.
    const persisted = await pool.query("SELECT * FROM occ.agent_revisions WHERE id = $1", [
      revision.id,
    ]);
    const original = persisted.rows[0].admitted_spec;
    const snapshot = {
      ceiling: { allowPublicHttps: false, hosts: ["api.github.com"] },
      channelDestinations: [{ host: "*.slack.com", ports: [443], protocol: "wss" }],
    };
    const dedicatedSpec = {
      ...original,
      harness: { ...original.harness, mode: "dedicated" },
      gateway_outbound: { mode: "restricted", hosts: ["api.github.com"] },
      gateway_outbound_admission: snapshot,
    };
    const insertCandidate = async (spec: unknown) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        return await client.query(
          "INSERT INTO occ.agent_revisions (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, gateway_managed_mode, admitted_at) VALUES ($1,$2,$3,2,$4,$5::jsonb,true,clock_timestamp()) RETURNING admitted_spec",
          [`rev_${randomUUID()}`, namespace.id, agent.id, revision.backendId, JSON.stringify(spec)],
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    const stored = await insertCandidate(dedicatedSpec);
    assert.deepEqual(stored.rows[0].admitted_spec.gateway_outbound_admission, snapshot);
    for (const invalidSpec of [
      { ...dedicatedSpec, gateway_outbound_admission: undefined },
      { ...dedicatedSpec, gateway_outbound: { mode: "publicHttps" } },
      { ...dedicatedSpec, gateway_outbound: { mode: "restricted", hosts: ["registry.npmjs.org"] } },
      {
        ...dedicatedSpec,
        gateway_outbound_admission: {
          ...snapshot,
          channelDestinations: [{ host: "*.slack.com", ports: [80], protocol: "wss" }],
        },
      },
      { ...original, gateway_outbound_admission: snapshot },
    ]) {
      await assert.rejects(insertCandidate(invalidSpec), { code: "23514" });
    }

    const deniedEmbeddedPolicy = await inject(
      "PATCH",
      `/namespaces/${namespace.id}/agents/${agent.id}`,
      {
        gatewayOutbound: { mode: "publicHttps" },
      },
    );
    assert.equal(deniedEmbeddedPolicy.statusCode, 400, deniedEmbeddedPolicy.body);

    const member = createAuthPrincipalSeed(
      controller.installation.id,
      "https://identity.example.test",
      { id: randomUUID() },
      { grant: "none" },
    );
    await state.appendNativeIAMPrincipal(member);
    const iamPath = `/namespaces/${namespace.id}/iam`;
    const role = await inject("POST", `${iamPath}/roles`, {
      permissions: [
        { action: "administer", resourceKind: "agent" },
        { action: "update", resourceKind: "agent" },
        { action: "deploy", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "operate", resourceKind: "secret" },
      ],
    });
    assert.equal(role.statusCode, 201, role.body);
    for (const [resourceKind, resourceId] of [
      ["agent", agent.id],
      ["configuration", agent.configurationId],
      ["secret", secretRef.id],
    ]) {
      const binding = await inject("POST", `${iamPath}/access-bindings`, {
        subjectKind: "identity",
        subjectId: member.principal.id,
        roleId: role.json().data.id,
        resourceKind,
        resourceId,
      });
      assert.equal(binding.statusCode, 201, binding.body);
    }

    const agentIdentity = { namespaceId: namespace.id, agentId: agent.id };
    await assert.rejects(
      controller.updateAgent(member.principal.id, { ...agentIdentity, gatewayManagedMode: false }),
      {
        name: "AuthorizationDeniedError",
        authorization: {
          action: "administer",
          resource: { kind: "installation", id: controller.installation.id },
        },
      },
    );

    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const saved = await inject("PATCH", agentPath, { gatewayManagedMode: false });
    assert.equal(saved.statusCode, 200, saved.body);
    const ordinarySave = await controller.updateAgent(member.principal.id, {
      ...agentIdentity,
      configurationId: agent.configurationId,
    });
    assert.equal(ordinarySave.gatewayManagedMode, false);
    const admitted = await controller.deployAgent(
      member.principal.id,
      agentIdentity,
      resolveApprovedHarness,
    );
    const versions = await Promise.all(
      [revision, admitted].map(({ id }) => inject("GET", `${agentPath}/revisions/${id}`)),
    );
    assert.deepEqual(
      versions.map((response) => response.json().data.gatewayManagedMode),
      [true, false],
    );
    assert.deepEqual(
      versions.map((response) => response.json().data.gatewayOutbound),
      [
        { mode: "restricted", hosts: [] },
        { mode: "restricted", hosts: [] },
      ],
    );
  },
);
