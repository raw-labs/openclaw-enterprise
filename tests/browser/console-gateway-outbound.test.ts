import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  apiRequests,
  detailUrl,
  login,
  MEMBER_WRITE,
  nativeValues,
  newPage,
  waitForEnabled,
} from "./console-agents-browser-helpers.mjs";

// These cases use the production Console, Fastify routes, OCC and Native IAM with
// in-memory state. They do not establish PostgreSQL or live Gateway enforcement.
test("dedicated Agent outbound authoring saves and clears hosts without editing native Configuration", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Gateway authoring", { ready: true });
  const values = nativeValues("unchanged");
  const agent = await fixture.createAgent(namespace.id, "Outbound Agent", values, {
    executionMode: "dedicated",
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "gateway-outbound").href,
  );
  const input = page.getByLabel("Additional HTTPS hosts", { exact: true });
  await waitForEnabled(input);
  assert.equal(await input.inputValue(), "");
  await input.fill("https://api.example.com");
  await page.getByRole("button", { name: "Save outbound hosts", exact: true }).click();
  await page
    .getByText(
      "Enter exact DNS hosts, one per line, without a URL, IP address, port or wildcard.",
      { exact: true },
    )
    .waitFor();
  assert.equal(requests.filter((request) => request.method === "PATCH").length, 0);

  await input.fill("api.example.com");
  await page.getByRole("button", { name: "Save outbound hosts", exact: true }).click();
  await page
    .getByText("Gateway outbound hosts saved. Deploy a new version to apply them.", { exact: true })
    .waitFor();
  const saved = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.data.gatewayOutbound, {
    destinations: [{ host: "api.example.com", port: 443 }],
  });
  assert.equal(saved.body.data.configurationId, agent.configurationId);
  const config = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(config.body.data.values, values);

  // Read the saved Agent through a new page load, then remove its manual additions.
  await page.reload();
  await waitForEnabled(input);
  assert.equal(await input.inputValue(), "api.example.com");
  await input.fill("");
  await page.getByRole("button", { name: "Save outbound hosts", exact: true }).click();
  await page
    .getByText("Gateway outbound hosts saved. Deploy a new version to apply them.", { exact: true })
    .waitFor();
  const cleared = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.deepEqual(cleared.body.data.gatewayOutbound, { destinations: [] });
  assert.deepEqual(
    requests.filter((request) => request.method === "PATCH").map((request) => request.body),
    [
      { gatewayOutbound: { destinations: [{ host: "api.example.com", port: 443 }] } },
      { gatewayOutbound: { destinations: [] } },
    ],
  );
});

test("Agent update without exact Agent administer leaves outbound settings read-only", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Gateway permission", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Read-only outbound",
    nativeValues("read"),
    { executionMode: "dedicated" },
  );
  const member = await fixture.createNamespaceMember("outbound-writer", namespace.id, MEMBER_WRITE);
  const { page } = await newPage(t, fixture);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "gateway-outbound").href,
    member.credentials,
  );
  await page
    .getByText(
      "Editing requires update and administer on this Agent. Ask an administrator for both grants, then reload this page.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.getByLabel("Additional HTTPS hosts", { exact: true }).isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Save outbound hosts", exact: true }).isDisabled(),
    true,
  );
});

test("embedded Agent has no outbound host-granting controls", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Embedded unchanged", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Embedded Agent",
    nativeValues("embedded"),
    { executionMode: "embedded" },
  );
  const { page } = await newPage(t, fixture);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").href,
  );
  await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();
  assert.equal(await page.getByRole("tab", { name: "Gateway outbound", exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Additional HTTPS hosts", { exact: true }).count(), 0);
});
