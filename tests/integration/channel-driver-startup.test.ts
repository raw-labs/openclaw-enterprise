import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { resolveChannelRouting } from "../../apps/controller/src/drivers/channel/routing.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";

async function load(t: TestContext, channel?: unknown) {
  const configuration = createInstallationDriverConfiguration();
  if (channel !== undefined) {
    Object.assign(configuration.drivers, { channel });
  }
  const loaded = await loadInstallationFile(t, configuration);
  assert.ok(loaded);
  return loaded;
}

const hosts = (rules: ReturnType<typeof resolveChannelRouting>["destinations"]) =>
  rules.flatMap(({ destination }) => (destination.kind === "dns" ? [destination.name] : []));

test("Installation startup installs every bundled Channel Driver when drivers.channel is omitted", async (t) => {
  const loaded = await load(t);
  assert.deepEqual(
    loaded.channelDrivers?.map(({ provider, driver }) => [provider, driver.id]),
    [
      ["slack", "slack-channel"],
      ["msteams", "teams-channel"],
    ],
  );
  // Startup inspection reports the resolved default selections like any other Driver.
  assert.deepEqual(
    loaded.installation.drivers.channel.map(({ id, configuration }) => [id, configuration]),
    [
      ["slack-channel", {}],
      ["teams-channel", {}],
    ],
  );
  // Without configured storage hosts, Teams Gateways reach only Microsoft service endpoints.
  assert.ok(
    !hosts(resolveChannelRouting(["msteams"], loaded.channelDrivers ?? []).destinations).some(
      (name) => name.endsWith(".sharepoint.com"),
    ),
  );
});

test("drivers.channel selects the installed providers and owns Teams storage hosts", async (t) => {
  const loaded = await load(t, [
    { id: "teams-channel", configuration: { fileHosts: ["tenant.sharepoint.com"] } },
  ]);
  assert.ok(loaded.channelDrivers);
  assert.deepEqual(
    loaded.channelDrivers.map(({ provider }) => provider),
    ["msteams"],
  );
  assert.deepEqual(loaded.installation.drivers.channel[0]?.configuration, {
    fileHosts: ["tenant.sharepoint.com"],
  });
  // Compute admission resolves enabled providers through this same set.
  assert.ok(
    hosts(resolveChannelRouting(["msteams"], loaded.channelDrivers).destinations).some(
      (host) => host === "tenant.sharepoint.com",
    ),
  );
  // Slack is not selected, so an Agent that enables it cannot be admitted.
  assert.throws(
    () => resolveChannelRouting(["slack"], loaded.channelDrivers ?? []),
    /exactly one installed Channel Driver/,
  );
});

test("drivers.channel rejects unknown, duplicate and malformed selections at startup", async (t) => {
  await assert.rejects(load(t, { id: "slack-channel" }), /drivers\.channel must be an array/);
  await assert.rejects(
    load(t, [{ id: "discord-channel", configuration: {} }]),
    /drivers\.channel\[0\]\.id must select slack-channel or teams-channel/,
  );
  await assert.rejects(
    load(t, [
      { id: "slack-channel", configuration: {} },
      { id: "slack-channel", configuration: {} },
    ]),
    /duplicates another Channel Driver/,
  );
  // Closed schemas: Teams storage hosts are a Teams setting, never a Slack one.
  for (const selection of [
    { id: "slack-channel", configuration: { fileHosts: ["tenant.sharepoint.com"] } },
    { id: "teams-channel", configuration: { fileHosts: ["tenant.example.com"] } },
    { id: "teams-channel", configuration: { fileHosts: ["*.sharepoint.com"] } },
    { id: "teams-channel", configuration: { fileHosts: ["Tenant.sharepoint.com"] } },
  ]) {
    await assert.rejects(load(t, [selection]), JSON.stringify(selection));
  }
});
