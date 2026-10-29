import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

function outboundSandbox() {
  return new OpenShellSandboxDriver(
    {
      gateway: { workspaceMode: "operator" },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "model-egress",
            endpoints: [{ host: "api.openai.com", ports: [443] }],
            binaries: [{ path: "/usr/local/bin/node" }],
          },
        ],
      },
    },
    {
      id: "outbound-sandbox",
      implementation: "openshell",
      backend: {
        id: "outbound-openshell",
        drivers: { sandbox: "outbound-sandbox", credential_gateway: "outbound-credentials" },
        client: new OpenShellGateway({ serviceName: "openshell-gateway" }),
      },
    },
  );
}

const approved = { destinations: [{ host: "api.example.com", port: 443 }] };

test(
  "PostgreSQL Agent outbound API writes survive reload and immutable revisions retain their approved hosts",
  requiresPostgres,
  async (t) => {
    // Real Fastify, OCC, Native IAM and PostgreSQL; the existing Compute fixture does
    // not establish runtime traffic enforcement. The application's limited role executes SQL.
    const { pool, inject, deployAgent } = await createPostgresAgentApp(t, {
      sandboxDriver: outboundSandbox(),
      controllerOptions: {
        driverConfigurations: [
          {
            capability: "sandbox",
            driverId: "outbound-sandbox",
            implementation: "openshell",
            definition: OpenShellSandboxDriver,
          },
        ],
      },
      label: "gateway-outbound",
      authSecret: "gateway-outbound-postgres-auth-secret-minimum-32",
    });
    const { namespace, agent, revision } = await deployAgent("Gateway outbound persistence");
    const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
    assert.deepEqual(agent.gatewayOutbound, { destinations: [] });
    const saved = await inject("PATCH", path, {
      configurationId: agent.configurationId,
      executionMode: "dedicated",
      gatewayOutbound: approved,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().data.gatewayOutbound, approved);
    const reloaded = new PostgresPlatformState(pool);
    const read = await reloaded.read((view) => view.agents.findAgent(namespace.id, agent.id));
    assert.deepEqual(read?.gatewayOutbound, approved);
    const deployed = await inject("POST", path + "/deploy");
    assert.equal(deployed.statusCode, 202, deployed.body);
    const candidate = deployed.json().data;
    assert.deepEqual(candidate.gatewayOutbound, approved);
    const clear = await inject("PATCH", path, { gatewayOutbound: { destinations: [] } });
    assert.equal(clear.statusCode, 200, clear.body);
    const frozen = await inject("GET", path + "/revisions/" + candidate.id);
    assert.deepEqual(frozen.json().data.gatewayOutbound, approved);
    const original = await inject("GET", path + "/revisions/" + revision.id);
    assert.deepEqual(original.json().data.gatewayOutbound, { destinations: [] });

    // Direct application-role writes cannot evade schema invariants through another caller.
    for (const invalid of [
      { destinations: [{ host: "*.example.com", port: 443 }] },
      { destinations: [{ host: "127.0.0.1", port: 443 }] },
      { destinations: [{ host: "API.example.com", port: 443 }] },
      { destinations: [{ host: "api.example.com", port: 80 }] },
      { destinations: [...approved.destinations, ...approved.destinations] },
      { destinations: null },
    ]) {
      await assert.rejects(
        pool.query("UPDATE occ.agents SET gateway_outbound = $2::jsonb WHERE id = $1", [
          agent.id,
          JSON.stringify(invalid),
        ]),
        { code: "23514" },
      );
    }
    await assert.rejects(
      pool.query(
        "UPDATE occ.agents SET execution_mode = 'embedded', gateway_outbound = $2::jsonb WHERE id = $1",
        [agent.id, JSON.stringify(approved)],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      pool.query("UPDATE occ.agent_revisions SET admitted_spec = admitted_spec WHERE id = $1", [
        candidate.id,
      ]),
      { code: "42501" },
    );
    const persisted = await pool.query("SELECT gateway_outbound FROM occ.agents WHERE id = $1", [
      agent.id,
    ]);
    assert.deepEqual(persisted.rows[0].gateway_outbound, { destinations: [] });
    const audit = await pool.query(
      "SELECT actor_id FROM occ.audit_events WHERE resource_id = $1 AND kind = 'mutation'",
      [agent.id],
    );
    assert.ok(audit.rows.some(({ actor_id }) => actor_id));
  },
);
