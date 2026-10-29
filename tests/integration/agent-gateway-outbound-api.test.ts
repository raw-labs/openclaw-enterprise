import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEvent } from "../../packages/contracts/src/index.ts";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { grantRole } from "../helpers/iam-grants.mjs";

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

test("Agent outbound authoring requires exact update and administer and preserves revision snapshots", async (t) => {
  // Fastify, OCC, Native IAM and in-memory State are real. Compute is the existing fixture;
  // this proves authoring and admission state, not proxy enforcement or database persistence.
  const f = await createConsoleAppFixture(t, {
    computeDriver: createRuntimeLogComputeDriver({ id: "outbound-authoring-compute" }),
    driverConfigurations: [
      {
        capability: "sandbox",
        driverId: "outbound-sandbox",
        implementation: "openshell",
        definition: OpenShellSandboxDriver,
      },
    ],
  });
  await f.bootstrap();
  const sandbox = outboundSandbox();
  f.controller.registerDriver(sandbox);
  f.controller.selectDriver("sandbox", sandbox.id);
  const namespace = await f.createNamespace("Gateway outbound", { ready: true });
  const agent = await f.createAgent(
    namespace.id,
    "Gateway outbound A",
    createHarnessConfiguration("codex", "gpt-4.1"),
    { executionMode: "dedicated" },
  );
  const other = await f.createAgent(
    namespace.id,
    "Gateway outbound B",
    createHarnessConfiguration("codex", "gpt-4.1"),
    { executionMode: "dedicated" },
  );
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  assert.deepEqual(agent.gatewayOutbound, { destinations: [] });

  const member = await f.createAccountWithPolicy("outbound-editor", (principal) => {
    grantRole(f.policy, principal.id, {
      id: "outbound-editor",
      namespaceId: namespace.id,
      permissions: { agent: ["update"] },
      resource: { kind: "agent", id: agent.id },
    });
    // Administer on another Agent must never authorize this one's host list.
    grantRole(f.policy, principal.id, {
      id: "other-outbound-admin",
      namespaceId: namespace.id,
      permissions: { agent: ["administer"] },
      resource: { kind: "agent", id: other.id },
    });
  });
  const session = await f.signIn(member.credentials);
  const denied = await f.request("PATCH", path, { session, body: { gatewayOutbound: approved } });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  const denial = f.auditSink.events.find(
    (event: AuditEvent) =>
      event.kind === "authorization_denial" && event.actor?.principalId === member.principal.id,
  );
  assert.ok(denial);
  assert.equal(denial.authorization.action, "administer");
  assert.deepEqual(denial.authorization.resource, {
    kind: "agent",
    id: agent.id,
    namespaceId: namespace.id,
  });
  assert.deepEqual((await f.request("GET", path)).data.gatewayOutbound, { destinations: [] });

  const saved = await f.request("PATCH", path, { body: { gatewayOutbound: approved } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.data.gatewayOutbound, approved);
  const before = await f.request("POST", path + "/deploy");
  assert.equal(before.status, 202, JSON.stringify(before.body));
  assert.deepEqual(before.data.gatewayOutbound, approved);
  const cleared = await f.request("PATCH", path, {
    body: { gatewayOutbound: { destinations: [] } },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const frozen = await f.request("GET", path + "/revisions/" + before.data.id);
  assert.deepEqual(frozen.data.gatewayOutbound, approved);
  assert.ok(
    f.auditSink.events.some(
      (event: AuditEvent) =>
        event.kind === "mutation" && event.resource?.id === agent.id && event.actor?.principalId,
    ),
  );

  for (const host of [
    "*.example.com",
    "API.example.com",
    "api.example.com.",
    "127.0.0.1",
    "https://api.example.com",
    "api..example.com",
    "-api.example.com",
  ]) {
    const refused = await f.request("PATCH", path, {
      body: { gatewayOutbound: { destinations: [{ host, port: 443 }] } },
    });
    assert.equal(refused.status, 400, host + ": " + JSON.stringify(refused.body));
  }
  const wrongPort = await f.request("PATCH", path, {
    body: { gatewayOutbound: { destinations: [{ host: "api.example.com", port: 80 }] } },
  });
  assert.equal(wrongPort.status, 400);
  const duplicate = await f.request("PATCH", path, {
    body: {
      gatewayOutbound: { destinations: [...approved.destinations, ...approved.destinations] },
    },
  });
  assert.equal(duplicate.status, 400);
  const embeddedFixture = await createConsoleAppFixture(t);
  await embeddedFixture.bootstrap();
  const embeddedNamespace = await embeddedFixture.createNamespace("Embedded unchanged", {
    ready: true,
  });
  const embedded = await embeddedFixture.createAgent(embeddedNamespace.id, "Embedded unchanged");
  const embeddedWrite = await embeddedFixture.request(
    "PATCH",
    "/namespaces/" + embeddedNamespace.id + "/agents/" + embedded.id,
    { body: { gatewayOutbound: approved } },
  );
  assert.equal(embeddedWrite.status, 404, JSON.stringify(embeddedWrite.body));
  const create = await f.request("POST", "/namespaces/" + namespace.id + "/agents", {
    body: {
      name: "Unassigned authority",
      configurationId: agent.configurationId,
      executionMode: "dedicated",
      gatewayOutbound: approved,
    },
  });
  assert.equal(create.status, 404, JSON.stringify(create.body));
  const validate = await f.request("POST", "/namespaces/" + namespace.id + "/agents/validate", {
    body: {
      executionMode: "dedicated",
      configuration: { kind: "agent", values: {} },
      gatewayOutbound: approved,
    },
  });
  assert.equal(validate.status, 404, JSON.stringify(validate.body));
});
